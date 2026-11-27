// M4 数据管道：全国路网 / 京沪高精 / 正晚点抽样刷新
//
// 用法：
//   node scripts/fetch-railway-data.mjs                    # 全国模式（默认）：目录+时刻表(带缓存)+正晚点抽样
//   node scripts/fetch-railway-data.mjs --delays-only      # 仅正晚点抽样刷新（定时任务用，~25 请求/轮）
//   node scripts/fetch-railway-data.mjs --scope=jinghu     # 京沪模式（快，5 车，高精坐标）
//   node scripts/fetch-railway-data.mjs --refresh-timetables  # 强制重抓时刻表（忽略缓存）
//   node scripts/fetch-railway-data.mjs --offline          # 全离线（缓存+快照兜底）
//   node scripts/fetch-railway-data.mjs --cookie="..."     # 备用：浏览器态 leftTicket+czxx 链（京沪）
//   --date=YYYY-MM-DD --delay-sample=N
//
// 数据源策略（PRD §5/§6.3）：
//   电报码 ← 12306 station_name.js（实测抓取）
//   坐标   ← 京沪 23 站精确整理；全国其余 = 城市级坐标 + 站名哈希微偏移（geocode.mjs）
//   时刻表 ← queryTrainInfo 免 cookie 链（主）→ 浏览器态链（备）→ 快照（兜底）
//   正晚点 ← zwdch/query 实测配方（对在途车次随机抽样，跨零点车次不参与抽样）
//
// 合规：请求间隔 1–3s 随机 + 轮次随机间隔（auto-refresh.mjs）+ 车次顺序洗牌；仅限个人学习/演示。

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs'
import { parseStationNameJs, indexByName, normalizeStationName } from './lib/station-parser.mjs'
import {
  isEncryptedResult,
  parseLeftTicketEntry,
  parseTrainStops,
  parseTrainNameList,
  parseDelayMessage,
} from './lib/otn-parser.mjs'
import { JINGHU_STATIONS, JINGHU_TRAINS, DATA_SOURCES } from './data/jinghu-line.mjs'
import { CORRIDORS } from './data/corridors.mjs'
import { geocodeStations, jitter } from './lib/geocode.mjs'
import { shuffled } from './lib/schedule.mjs'
import { mergeCatalogEntries, groupByTrainNo, catalogStats, pickBaselineDate } from './lib/catalog.mjs'
import { acquireLock, releaseLock, isLocked } from './lib/lock.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UA_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0'
const CACHE_DIR = '.cache/railway'
const STATION_URL = 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js'
const SNAPSHOT = `${CACHE_DIR}/snapshot.json`
const QTI_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://kyfw.12306.cn/otn/queryTrainInfo/init',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const politeDelay = () => sleep(1000 + Math.random() * 2000) // 限流：1–3s 随机

// 单请求超时：12306 偶发长连接不返回，避免一个请求拖住整轮
const FETCH_TIMEOUT_MS = Number(args['timeout-ms'] ?? 30000)
function fetchWithTimeout(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

// ---------- 抓取进度（前端轮询 public/live/fetch-status.json） ----------
const FETCH_STATUS_FILE = 'public/live/fetch-status.json'
let FETCH_STATUS = {}

function writeFetchStatus(patch = {}) {
  FETCH_STATUS = { ...FETCH_STATUS, ...patch, updatedAt: new Date().toISOString() }
  try {
    mkdirSync('public/live', { recursive: true })
    const tmp = `${FETCH_STATUS_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(FETCH_STATUS))
    // Windows 上浏览器轮询/杀毒可能短暂占用目标文件，rename 会抛 EPERM；重试后直接覆盖
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(tmp, FETCH_STATUS_FILE)
        return
      } catch {
        /* 重试 */
      }
    }
    writeFileSync(FETCH_STATUS_FILE, JSON.stringify(FETCH_STATUS))
  } catch {
    /* 状态文件失败不影响抓取 */
  }
}

// 当日（本地时区 = 北京时间）：与 zwdch 正晚点（恒查当日）同日，消除班次错位
function todayStr() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const toMin = (hm) => (hm == null ? null : Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)))
const toAbs = (hm, day = 0) => (hm == null ? null : (day ?? 0) * 1440 + toMin(hm))

// ---------- 车站表 ----------
async function loadStationTable() {
  const cachePath = `${CACHE_DIR}/station_name.js`
  let text
  if (args.offline) {
    if (!existsSync(cachePath)) throw new Error('--offline 需要 .cache/railway/station_name.js，请先在线运行一次')
    text = readFileSync(cachePath, 'utf8')
    console.log('✓ 车站表：使用本地缓存')
  } else {
    const res = await fetchWithTimeout(STATION_URL, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`车站表抓取失败: HTTP ${res.status}`)
    text = await res.text()
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(cachePath, text)
    console.log(`✓ 车站表：在线抓取 ${text.length} 字符`)
  }
  const stations = parseStationNameJs(text)
  if (stations.length < 1000) throw new Error(`车站表解析异常：仅 ${stations.length} 站`)
  console.log(`✓ 解析车站 ${stations.length} 个`)
  return stations
}

// ---------- 京沪 23 站（精确坐标 + 真实电报码） ----------
function mergeTelecodes(allStations) {
  const byName = indexByName(allStations)
  return JINGHU_STATIONS.map((s) => {
    const official = byName[normalizeStationName(s.name)]
    if (!official) throw new Error(`12306 车站表中找不到「${s.name}」`)
    return { code: official.code, name: s.name, city: official.city, lat: s.lat, lng: s.lng, precise: true }
  })
}

// ---------- 全国地理编码 ----------
// 坐标优先级：OSM 实测站点坐标（build-lines.mjs 产物）> 京沪整理精确坐标 > 城市级近似
function geocodeNational(allStations) {
  const jinghuPrecise = Object.fromEntries(JINGHU_STATIONS.map((s) => [s.name, { lat: s.lat, lng: s.lng }]))
  const osmFile = '.cache/osm/osm-station-coords.json'
  let osmCoords = {}
  if (existsSync(osmFile)) {
    osmCoords = JSON.parse(readFileSync(osmFile, 'utf8'))
    console.log(`✓ OSM 精确站点坐标：${Object.keys(osmCoords).length} 站可用`)
  }
  const preciseMap = { ...jinghuPrecise, ...osmCoords }
  const { geocoded, missing, byName, sources } = geocodeStations(allStations, preciseMap)
  console.log(
    `✓ 全国地理编码：${geocoded.length} 站（OSM/京沪精确 ${sources.precise}，补充站 ${sources.extra}，城市级 ${sources.city + sources.prefix}），未覆盖 ${missing.length}`,
  )
  if (missing.length) console.warn(`  未覆盖：${missing.slice(0, 20).join('、')}${missing.length > 20 ? ' …' : ''}`)
  return { geocoded, osmCount: Object.keys(osmCoords).length, missing, byName, sources }
}

// ---------- 车次目录（getTrainName，免 cookie 明文） ----------
async function loadCatalog(date) {
  const cachePath = `${CACHE_DIR}/gettrainname_${date}.json`
  if (existsSync(cachePath) && (args.offline || !args['refresh-timetables'])) {
    const list = parseTrainNameList(JSON.parse(readFileSync(cachePath, 'utf8')))
    if (list.length > 1000) {
      console.log(`✓ 车次目录：缓存 ${list.length} 条（${date}）`)
      return list
    }
  }
  if (args.offline) throw new Error('--offline 且无当日车次目录缓存')
  const res = await fetchWithTimeout(`https://kyfw.12306.cn/otn/queryTrainInfo/getTrainName?date=${date}`, { headers: QTI_HEADERS })
  if (!res.ok) throw new Error(`getTrainName HTTP ${res.status}`)
  const json = await res.json()
  const list = parseTrainNameList(json)
  if (list.length < 1000) throw new Error(`车次目录解析异常：仅 ${list.length} 条`)
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cachePath, JSON.stringify(json))
  console.log(`✓ 车次目录：在线抓取 ${list.length} 趟（免 cookie）`)
  return list
}

// ---------- 目录并集（全量模式） ----------
// getTrainName 单次响应会缺条目：同日多次抓取并集 + 磁盘同日缓存，
// 显著提高目录完整度（实测单次 10.6k–17.2k 条，并集可稳定在 15k+ 班次）。
function catalogCacheFiles(date) {
  if (!existsSync(CACHE_DIR)) return []
  const out = []
  for (const f of readdirSync(CACHE_DIR)) {
    if (!/^gettrainname.*\.json$/.test(f)) continue
    const m = f.match(/(\d{4}-\d{2}-\d{2})/)
    if (m) {
      if (m[1] === date) out.push(`${CACHE_DIR}/${f}`)
      continue
    }
    // gettrainname.json 无日期：按文件修改日期归属
    try {
      const st = statSync(`${CACHE_DIR}/${f}`)
      const d = new Date(st.mtimeMs)
      const pad = (n) => String(n).padStart(2, '0')
      const fileDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      if (fileDate === date) out.push(`${CACHE_DIR}/${f}`)
    } catch {
      /* 忽略不可读文件 */
    }
  }
  return out
}

async function loadCatalogUnion(date, samples = 3) {
  const entries = []
  const files = catalogCacheFiles(date)
  for (const f of files) {
    try {
      entries.push(...parseTrainNameList(JSON.parse(readFileSync(f, 'utf8'))))
    } catch {
      /* 忽略损坏缓存 */
    }
  }
  const fromCache = entries.length
  if (!args.offline) {
    for (let i = 0; i < samples; i++) {
      try {
        const res = await fetchWithTimeout(`https://kyfw.12306.cn/otn/queryTrainInfo/getTrainName?date=${date}`, { headers: QTI_HEADERS })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        entries.push(...parseTrainNameList(json))
        // 当日样本落盘：同日多份响应互补；次日凌晨抓取时也能作为基线
        try {
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
          writeFileSync(`${CACHE_DIR}/gettrainname_${date}_${stamp}_${i}.json`, JSON.stringify(json))
        } catch {
          /* 缓存失败不影响主流程 */
        }
      } catch (e) {
        console.warn(`⚠ 目录在线抓取第 ${i + 1} 次失败：${e.message}`)
      }
      if (i < samples - 1) await politeDelay()
    }
  }

  // 基线：最近一个完整日的目录。凌晨抓当天时单次目录只有 ~9.8k train_no，
  // 直接采信会让快照从 12.5k 缩水；用基线补齐候选，时刻表多为 7 天缓存复用。
  let baselineDate = null
  let baselineEntries = 0
  if (!args['no-baseline'] && existsSync(CACHE_DIR)) {
    const dates = []
    for (const f of readdirSync(CACHE_DIR)) {
      const m = f.match(/^gettrainname_(\d{4}-\d{2}-\d{2})/)
      if (m) dates.push(m[1])
    }
    baselineDate = pickBaselineDate(dates, date, Number(args['baseline-days'] ?? 7))
    if (baselineDate) {
      for (const f of readdirSync(CACHE_DIR).filter((x) => x.startsWith(`gettrainname_${baselineDate}`))) {
        try {
          const list = parseTrainNameList(JSON.parse(readFileSync(`${CACHE_DIR}/${f}`, 'utf8')))
          baselineEntries += list.length
          entries.push(...list)
        } catch {
          /* 忽略损坏缓存 */
        }
      }
    }
  }

  const merged = mergeCatalogEntries(entries)
  if (merged.length < 1000) throw new Error(`目录并集解析异常：仅 ${merged.length} 条`)
  const groups = groupByTrainNo(merged)
  const stats = catalogStats(groups)
  stats.baselineDate = baselineDate
  stats.baselineEntries = baselineEntries
  console.log(
    `✓ 车次目录并集：当日缓存 ${files.length} 份 / ${fromCache} 条 + 在线 ${args.offline ? 0 : samples} 次 + 基线 ${baselineDate ?? '无'}（${baselineEntries} 条）→ 唯一班次 ${merged.length}，列车 ${stats.trainNo}，班次 ${stats.services}（动车 ${stats.emuServices} / 普速 ${stats.convServices}）`,
  )
  return { entries: merged, groups, stats }
}

// ---------- 全国车次选择：类型配额 + 等距采样（确定性、地域分散） ----------
// 京沪标杆车：从当日目录动态选取（2026-12 下旬动车组字头换编后自动适应，不写死车次号）
// 新版编排规定字头：X/G/T/K/D/C/S = 动车组族（央视新闻 2026-10-16）
const EMU_LETTERS = new Set(['X', 'G', 'T', 'K', 'D', 'C', 'S'])
const NATIONAL_QUOTAS = { X: 8, G: 60, T: 16, K: 20, D: 40, C: 8, S: 4, Z: 12, N: 8, V: 14, Y: 4, L: 2 }

const codeNum = (code) => parseInt(String(code).replace(/^\D+/, ''), 10) || 0

function pickJinghuFlagships(catalog, count = 5) {
  const onRoute = catalog.filter((t) => t.route === '北京南-上海虹桥')
  const emu = onRoute
    .filter((t) => EMU_LETTERS.has(String(t.code[0] ?? '').toUpperCase()))
    .sort((a, b) => codeNum(a.code) - codeNum(b.code))
  const picked = emu.slice(0, count)
  for (const t of onRoute) {
    if (picked.length >= count) break
    if (!picked.includes(t)) picked.push(t)
  }
  return picked
}

function trainType(code) {
  const m = String(code).match(/^([A-Z]+)/)
  return m ? m[1] : 'OTHER'
}

function selectNationalTrains(catalog, geocodedByName) {
  const ok = (name) => Boolean(geocodedByName[normalizeStationName(name)])
  const eligible = catalog.filter((t) => {
    const [a, b] = t.route.split('-')
    return a && b && ok(a) && ok(b)
  })
  const selected = []
  const seen = new Set()
  const push = (t) => {
    if (t && !seen.has(t.train_no)) {
      seen.add(t.train_no)
      selected.push(t)
    }
  }

  // --all-emu：全量动车（X/G/T/K/D/C/S 字头全部收录），普速仍按配额抽样
  if (args['all-emu']) {
    for (const t of eligible) {
      if (EMU_LETTERS.has(String(t.code[0] ?? '').toUpperCase())) push(t)
    }
    const convQuotas = { Z: 12, N: 8, V: 14, Y: 4, L: 2 }
    for (const [ty, quota] of Object.entries(convQuotas)) {
      const pool = eligible.filter((t) => trainType(t.code) === ty && !seen.has(t.train_no))
      if (!pool.length) continue
      const stride = Math.max(1, Math.floor(pool.length / quota))
      let count = 0
      for (let i = 0; i < pool.length && count < quota; i += stride) {
        const before = selected.length
        push(pool[i])
        if (selected.length > before) count++
      }
    }
    return selected
  }

  // 固定包含京沪标杆（动态选取，适应车次换编）
  for (const t of pickJinghuFlagships(eligible)) push(t)
  // 走廊端点 OD 加密：每条客运走廊选至多 5 趟起讫匹配车次（运行图有车可画）
  for (const c of CORRIDORS) {
    const a = c.stations[0]
    const b = c.stations[c.stations.length - 1]
    const pairs = eligible.filter((t) => t.route === `${a}-${b}` || t.route === `${b}-${a}`)
    if (!pairs.length) continue
    const stride = Math.max(1, Math.floor(pairs.length / 5))
    let count = 0
    for (let i = 0; i < pairs.length && count < 5; i += stride) {
      const before = selected.length
      push(pairs[i])
      if (selected.length > before) count++
    }
  }
  // 按类型配额等距采样（目录按车次号排序 ≈ 路局/地域聚簇，等距取样保证分散）
  for (const [ty, quota] of Object.entries(NATIONAL_QUOTAS)) {
    const pool = eligible.filter((t) => trainType(t.code) === ty && !seen.has(t.train_no))
    if (!pool.length) continue
    const stride = Math.max(1, Math.floor(pool.length / quota))
    let count = 0
    for (let i = 0; i < pool.length && count < quota; i += stride) {
      push(pool[i])
      count++
    }
  }
  return selected
}

// 全量模式：不做配额/端点过滤，所有 train_no 入队；无法定位的经停站由 buildTrain 统计并在收尾报告。
// 目录里有少量「同车次号、不同 train_no」的变体（如 Z105 两个内部编号），
// 前端以 no 为唯一键，这里按 no 去重，保留首个变体，避免收尾校验失败。
function selectAllTrains(groups) {
  const seen = new Set()
  const out = []
  for (const g of shuffled(groups)) {
    if (!g?.train_no || !g?.no || seen.has(g.no)) continue
    seen.add(g.no)
    out.push({ ...g })
  }
  return out
}

// ---------- 时刻表抓取（queryTrainInfo，带逐车缓存 + 跨日期复用） ----------
const TIMETABLE_STATS = { exact: 0, reused: 0, fetched: 0, failed: 0 }
let CACHE_INDEX = null

function timetableCacheIndex() {
  if (CACHE_INDEX) return CACHE_INDEX
  const index = new Map()
  const dir = `${CACHE_DIR}/nat`
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const cut = f.lastIndexOf('_')
      if (cut <= 0) continue
      const trainNo = f.slice(0, cut)
      const d = f.slice(cut + 1, -5)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
      let list = index.get(trainNo)
      if (!list) index.set(trainNo, (list = []))
      list.push(d)
    }
  }
  CACHE_INDEX = index
  return index
}

function daysApart(a, b) {
  const toMs = (s) => new Date(`${s}T00:00:00`).getTime()
  return Math.abs((toMs(a) - toMs(b)) / 86400000)
}

function isEmptyTimetable(json) {
  return !Array.isArray(json?.data?.data) || json.data.data.length < 2
}

function findReusableCache(trainNo, date, reuseDays) {
  if (!reuseDays) return null
  const list = timetableCacheIndex().get(trainNo)
  if (!list?.length) return null
  const candidates = list
    .filter((d) => d !== date && daysApart(d, date) <= reuseDays)
    .sort((a, b) => daysApart(a, date) - daysApart(b, date))
  return candidates[0] ?? null
}

async function fetchTimetableForTrain(t, date) {
  const cachePath = `${CACHE_DIR}/nat/${t.train_no}_${date}.json`
  if (existsSync(cachePath) && !args['refresh-timetables']) {
    const json = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (!isEmptyTimetable(json)) {
      TIMETABLE_STATS.exact++
      return json
    }
  }
  if (!args['refresh-timetables']) {
    const reuseDays = args['no-reuse'] ? 0 : Number(args['reuse-days'] ?? 7)
    const d = findReusableCache(t.train_no, date, reuseDays)
    if (d) {
      const p = `${CACHE_DIR}/nat/${t.train_no}_${d}.json`
      try {
        const json = JSON.parse(readFileSync(p, 'utf8'))
        if (!isEmptyTimetable(json)) {
          TIMETABLE_STATS.reused++
          return json
        }
      } catch {
        /* 缓存损坏，继续在线抓取 */
      }
    }
  }
  if (args.offline) throw new Error(`离线且无 ${t.no} 时刻表缓存`)
  const retry = Number(args.retry ?? 2)
  let lastErr = null
  for (let attempt = 0; attempt <= retry; attempt++) {
    if (attempt > 0) await sleep(5000 * attempt)
    await politeDelay()
    try {
      const url = `https://kyfw.12306.cn/otn/queryTrainInfo/query?leftTicketDTO.train_no=${t.train_no}&leftTicketDTO.train_date=${date}&rand_code=`
      const res = await fetchWithTimeout(url, { headers: QTI_HEADERS })
      if (res.status === 403 || res.status === 429) {
        console.warn(`  ↳ HTTP ${res.status}，暂停 60s 后重试`)
        await sleep(60000)
        lastErr = new Error(`HTTP ${res.status}`)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      mkdirSync(`${CACHE_DIR}/nat`, { recursive: true })
      writeFileSync(cachePath, JSON.stringify(json))
      if (isEmptyTimetable(json)) {
        TIMETABLE_STATS.failed++
        return json
      }
      TIMETABLE_STATS.fetched++
      return json
    } catch (e) {
      lastErr = e
    }
  }
  TIMETABLE_STATS.failed++
  throw lastErr ?? new Error('时刻表抓取失败')
}

// 经停全部可定位 + 当日不跨零点（前端单位置模型限制，跨零点车跳过并计数）
// 区段车兼容：12306 对部分跨局长途车只返回区段站表（首站带到达时刻，如 G1372
// 昆明南—上海虹桥仅返回长沙南起段）→ 首站视同始发（arr 置 null），按区段呈现
function buildTrain(t, json, geocodedByName) {
  const stops = parseTrainStops(json)
  if (stops.length < 2) return { skip: 'empty' }
  const mapped = []
  const unknown = []
  for (const s of stops) {
    const st = geocodedByName[normalizeStationName(s.name)]
    if (!st) {
      unknown.push(normalizeStationName(s.name))
      continue
    }
    mapped.push({ code: st.code, arr: s.arr, dep: s.dep, arrDay: s.arrDay, depDay: s.depDay })
  }
  if (unknown.length) return { skip: 'ungeocoded', unknown: [...new Set(unknown)] }
  // 区段车：首站带到达时刻 → 视同始发（先归一，避免首站到/发倒挂误判）
  let segmented = false
  if (mapped[0].arr != null) {
    mapped[0].arr = null
    mapped[0].arrDay = null
    segmented = true
  }
  // 绝对分钟单调校验（跨零点用 arrDay/depDay 展开，不再丢弃 overnight）
  let prev = -1
  let maxDay = 0
  for (const s of mapped) {
    for (const [hm, day] of [[s.arr, s.arrDay], [s.dep, s.depDay]]) {
      if (hm == null) continue
      const m = toAbs(hm, day)
      if (m < prev) return { skip: 'nonmonotonic', at: s.code, time: hm }
      prev = m
      maxDay = Math.max(maxDay, day ?? 0)
    }
  }
  const first = toAbs(mapped[0].dep, mapped[0].depDay) ?? 0
  const last = toAbs(mapped[mapped.length - 1].arr, mapped[mapped.length - 1].arrDay) ?? first
  return {
    train: {
      no: t.no,
      aliases: t.aliases ?? [],
      route: t.route,
      train_no: t.train_no,
      delay: 0,
      crossDay: maxDay > 0,
      durationMin: Math.max(0, last - first),
      startOffset: 0,
      stops: mapped,
    },
    segmented,
  }
}

// 生成内部电报码（仅用于时刻表经停站；不参与 12306 查询）
function syntheticStationCode(name, used) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let h = 2166136261
  for (const ch of String(name)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619)
  }
  let n = h >>> 0
  for (let attempt = 0; attempt < 30000; attempt++) {
    const code = alphabet[n % 26] + alphabet[Math.floor(n / 26) % 26] + alphabet[Math.floor(n / 676) % 26]
    if (!used.has(code)) {
      used.add(code)
      return code
    }
    n = (n + 1) >>> 0
  }
  throw new Error(`无法为经停站「${name}」生成电报码`)
}

// 时刻表经停站对账：客运站表未收录的小站，用同车次前后已知站的坐标插值，
// 生成内部电报码后补进车站表，从而把「站点未覆盖」的车次救回来。
function reconcileUnknownStations(unknownNames, skipped, geocodedByName, stations) {
  if (!skipped.length || !unknownNames.size) return { added: 0 }
  const used = new Set(stations.map((s) => s.code))
  const acc = new Map() // name -> { lat, lng, n }
  for (const { json } of skipped) {
    const stops = parseTrainStops(json)
    if (!Array.isArray(stops) || stops.length < 2) continue
    const known = stops.map((s) => geocodedByName[normalizeStationName(s.name)] ?? null)
    for (let i = 0; i < stops.length; i++) {
      const name = normalizeStationName(stops[i].name)
      if (!name || known[i] || !unknownNames.has(name)) continue
      let li = -1
      let ri = -1
      for (let j = i - 1; j >= 0; j--) if (known[j]) { li = j; break }
      for (let j = i + 1; j < stops.length; j++) if (known[j]) { ri = j; break }
      let lat
      let lng
      if (li >= 0 && ri >= 0) {
        const a = known[li]
        const b = known[ri]
        const t = (i - li) / (ri - li)
        lat = a.lat + (b.lat - a.lat) * t
        lng = a.lng + (b.lng - a.lng) * t
      } else if (li >= 0 || ri >= 0) {
        const a = known[li >= 0 ? li : ri]
        const j = jitter(name)
        lat = a.lat + j.dLat
        lng = a.lng + j.dLng
      } else {
        continue // 整条支线都不在站表：留给报告，不强行编造
      }
      const o = acc.get(name) ?? { lat: 0, lng: 0, n: 0 }
      o.lat += lat
      o.lng += lng
      o.n++
      acc.set(name, o)
    }
  }
  let added = 0
  for (const [name, o] of acc) {
    if (!o.n) continue
    const st = {
      code: syntheticStationCode(name, used),
      name,
      city: '',
      lat: +(o.lat / o.n).toFixed(4),
      lng: +(o.lng / o.n).toFixed(4),
      precise: false,
      synthetic: true,
    }
    stations.push(st)
    geocodedByName[name] = st
    unknownNames.delete(name)
    added++
  }
  return { added }
}

async function fetchNationalTimetables(selected, date, geocodedByName, ctx = {}) {
  const trains = ctx.trains ?? []
  const skipStat = ctx.skipStat ?? { empty: 0, ungeocoded: 0, nonmonotonic: 0 }
  const unknownStations = ctx.unknownStations ?? new Set()
  const stations = ctx.stations ?? []
  const skippedUngeocoded = ctx.skippedUngeocoded ?? []
  const seenNo = ctx.seenNo ?? new Set(trains.map((t) => t.no))
  const seenTrainNo = ctx.seenTrainNo ?? new Set()
  let segmentedCount = ctx.segmentedCount ?? 0
  let done = ctx.done ?? 0
  const total = (ctx.total ?? 0) + selected.length
  const startedAt = ctx.startedAt ?? Date.now()
  let lastError = ctx.lastError ?? null

  // 默认单 worker（1–3s/请求）；--concurrency=2 可显式提高吞吐（约 0.6–1 请求/秒）
  const concurrency = Math.max(1, Math.min(4, Number(args.concurrency ?? 1)))
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= selected.length) return
      const t = selected[i]
      done++
      if (seenTrainNo.has(t.train_no) || seenNo.has(t.no)) continue
      seenTrainNo.add(t.train_no)
      if (done % 25 === 0 || done === total) {
        console.log(`  …时刻表进度 ${done}/${total}（已入库 ${trains.length}）`)
        writeFetchStatus({
          running: true,
          phase: 'timetables',
          done,
          total,
          dataDate: date,
          trains: trains.length,
          errors: skipStat.empty,
          startedAt,
        })
      }
      let json
      try {
        json = await fetchTimetableForTrain(t, date)
      } catch (e) {
        skipStat.empty++
        lastError = `${t.no}: ${e.message}`
        continue
      }
      const r = buildTrain(t, json, geocodedByName)
      if (r.skip) {
        skipStat[r.skip] = (skipStat[r.skip] ?? 0) + 1
        if (r.skip === 'ungeocoded') skippedUngeocoded.push({ t, json })
        if (r.unknown) for (const n of r.unknown) unknownStations.add(n)
      } else {
        trains.push(r.train)
        seenNo.add(r.train.no)
        if (r.segmented) segmentedCount++
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  // 对账：补齐经停站（前后已知站坐标插值）并重建被「站点未覆盖」跳过的车次
  let resolvedStations = ctx.resolvedStations ?? 0
  if (skippedUngeocoded.length && unknownStations.size) {
    const rec = reconcileUnknownStations(unknownStations, skippedUngeocoded, geocodedByName, stations)
    resolvedStations += rec.added
    if (rec.added) console.log(`✓ 经停站对账：补齐 ${rec.added} 个插值站，重建 ${skippedUngeocoded.length} 趟`)
    for (const { t, json } of skippedUngeocoded) {
      const r = buildTrain(t, json, geocodedByName)
      if (r.skip) {
        if (r.unknown) for (const n of r.unknown) unknownStations.add(n)
        continue
      }
      if (seenNo.has(r.train.no)) continue
      trains.push(r.train)
      seenNo.add(r.train.no)
      if (skipStat.ungeocoded > 0) skipStat.ungeocoded--
      if (r.segmented) segmentedCount++
    }
  }

  console.log(
    `✓ 全国时刻表：${trains.length} 趟可用（区段车 ${segmentedCount}；补齐经停站 ${resolvedStations}；跳过：空/失败 ${skipStat.empty}，站点未覆盖 ${skipStat.ungeocoded}，时刻非单调 ${skipStat.nonmonotonic ?? 0}）`,
  )
  if (trains.length < 30) throw new Error(`可用车次过少（${trains.length}），放弃全国模式`)
  return {
    trains,
    skipStat,
    unknownStations,
    stations,
    resolvedStations,
    skippedUngeocoded: [],
    segmentedCount,
    done,
    total,
    startedAt,
    lastError,
    seenNo,
    seenTrainNo,
  }
}

// ---------- 京沪模式（保留：高精演示 + 备用链验证） ----------
const DEMO_DELAY = { G9: 15 } // 兜底演示值：仅正晚点抓取失败/离线时使用（meta 披露）

async function fetchTimetablesQTI(stations, date) {
  const byName = indexByName(stations)
  const catalog = await loadCatalog(date)
  const targets = pickJinghuFlagships(catalog) // 动态选标杆车（自动适应 12 月下旬车次换编）
  if (targets.length < 3) throw new Error(`目录中仅匹配到 ${targets.length} 趟京沪标杆车`)
  const trains = []
  for (const t of targets) {
    const json = await fetchTimetableForTrain(t, date)
    const stops = parseTrainStops(json)
    if (!stops.length) {
      console.warn(`⚠ ${t.code} 时刻表为空，跳过`)
      continue
    }
    const mapped = stops.map((s) => ({ code: byName[normalizeStationName(s.name)]?.code, arr: s.arr, dep: s.dep }))
    if (mapped.some((s) => !s.code)) {
      console.warn(`⚠ ${t.code} 含线路表外车站，跳过`)
      continue
    }
    trains.push({ no: t.code, route: t.route, train_no: t.train_no, delay: DEMO_DELAY[t.code] || 0, stops: mapped })
    console.log(`✓ 真实时刻表：${t.code}（${stops.length} 站，免 cookie）`)
  }
  if (!trains.length) throw new Error('queryTrainInfo 无可用时刻表')
  return trains
}

async function fetchTimetables12306(stations, cookie, date) {
  const byName = indexByName(stations)
  const headers = {
    'User-Agent': UA,
    Cookie: cookie,
    Referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'X-Requested-With': 'XMLHttpRequest',
  }
  const from = byName['北京南'].code
  const to = byName['上海虹桥'].code
  const entriesCache = `${CACHE_DIR}/leftticket_entries_${date}.json`

  let path = 'leftTicket/query'
  let result = null
  let rejected = false
  for (let hop = 0; hop < 6; hop++) {
    const url = `https://kyfw.12306.cn/otn/${path}?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${from}&leftTicketDTO.to_station=${to}&purpose_codes=ADULT`
    const res = await fetchWithTimeout(url, { headers, redirect: 'manual' })
    const text = await res.text()
    const json = (() => { try { return JSON.parse(text) } catch { return null } })()
    if (json?.c_url) {
      path = json.c_url.startsWith('leftTicket/') ? json.c_url : `leftTicket/${json.c_url}`
      await politeDelay()
      continue
    }
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      if (/error\.html|passport|login/.test(loc)) {
        console.warn('  ↳ leftTicket 会话被风控拒绝')
        rejected = true
        break
      }
      path = loc.replace(/^https?:\/\/kyfw\.12306\.cn\/otn\//, '').replace(/^\//, '').split('?')[0]
      await politeDelay()
      continue
    }
    result = json?.data?.result
    break
  }

  let entries
  if (result?.length && !isEncryptedResult(result)) {
    entries = result.map(parseLeftTicketEntry)
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(entriesCache, JSON.stringify(entries, null, 2))
  } else if (!rejected && existsSync(entriesCache)) {
    entries = JSON.parse(readFileSync(entriesCache, 'utf8'))
    console.warn(`⚠ leftTicket 不可用，使用同日 train_no 缓存（${entries.length} 条）走 czxx 域`)
  } else if (existsSync(entriesCache)) {
    entries = JSON.parse(readFileSync(entriesCache, 'utf8'))
    console.warn(`⚠ leftTicket 被拒，使用同日 train_no 缓存（${entries.length} 条）走 czxx 域`)
  } else {
    throw new Error('余票查询不可用且无同日缓存')
  }

  const seen = new Set()
  const unique = entries.filter(
    (e) =>
      e.start_station_telecode === from &&
      e.end_station_telecode === to &&
      !seen.has(e.station_train_code) &&
      seen.add(e.station_train_code),
  )
  // 备用链目标车次：取自验证快照的车次号（换编后如失效，主链 QTI 动态选取仍可用）
  const targets = JINGHU_TRAINS.map((t) => t.no)
  let found = targets.map((no) => unique.find((e) => e.station_train_code === no)).filter(Boolean)
  if (found.length < 3) {
    for (const e of unique) {
      if (found.length >= 5) break
      if (e.station_train_code.startsWith('G') && !found.includes(e)) found.push(e)
    }
  }
  if (!found.length) throw new Error('余票结果中未找到可用 G 字头车次')

  const trains = []
  for (const e of found) {
    await politeDelay()
    const url = `https://kyfw.12306.cn/otn/czxx/queryByTrainNo?train_no=${e.train_no}&from_station_telecode=${e.start_station_telecode}&to_station_telecode=${e.end_station_telecode}&depart_date=${date}`
    const res = await fetchWithTimeout(url, { headers: { ...headers, Referer: 'https://kyfw.12306.cn/otn/czxx/init' } })
    const json = await res.json().catch(() => null)
    writeFileSync(`${CACHE_DIR}/qbtn_${e.station_train_code}.json`, JSON.stringify(json, null, 2))
    const stops = parseTrainStops(json)
    if (!stops.length) continue
    const mapped = stops.map((s) => ({ code: byName[normalizeStationName(s.name)]?.code, arr: s.arr, dep: s.dep }))
    if (mapped.some((s) => !s.code)) continue
    trains.push({ no: e.station_train_code, delay: DEMO_DELAY[e.station_train_code] || 0, stops: mapped })
    console.log(`✓ 真实时刻表：${e.station_train_code}（${stops.length} 站，备用链）`)
  }
  if (!trains.length) throw new Error('备用链无可用时刻表')
  return trains
}

function curatedTimetables(stations) {
  const byName = indexByName(stations)
  return JINGHU_TRAINS.map((t) => ({
    no: t.no,
    delay: t.delay,
    stops: t.stops.map((s) => {
      const st = byName[normalizeStationName(s.name)]
      if (!st) throw new Error(`时刻表站名「${s.name}」不在线路车站中`)
      return { code: st.code, arr: s.arr, dep: s.dep }
    }),
  }))
}

// ---------- 真实正晚点（zwdch/query，2026-11-26 实测配方） ----------
// 配方：cxlx=1；不带 randCode；Content-Type 含 charset=UTF-8；
//       cookie 含页面 JS 写入的 _jc_save_zwdch_*；cz=查询目标站
// 语义：在途→前方站"预计"；已过站→实际；未发车→不受理（跳过）
const escapeU = (s) => [...s].map((c) => '%u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')
const czEn = (s) => encodeURIComponent(s).replace(/%/g, '-')

function pickDelayQueryStop(train, nowMin) {
  const stops = train.stops
  // 前方最近一个未发车站（停站中即本站发车）；跨日车次按 arrDay/depDay 展开
  for (const s of stops) {
    const dep = toAbs(s.dep, s.depDay)
    if (dep != null && dep > nowMin) return { stop: s, sched: dep }
  }
  const last = stops[stops.length - 1]
  return { stop: last, sched: toAbs(last.arr, last.arrDay) }
}

async function establishZwdSession() {
  const pairs = []
  let url = 'https://kyfw.12306.cn/otn/zwdch/init'
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA_EDGE, Cookie: pairs.join('; ') }, redirect: 'manual' })
    for (const c of res.headers.getSetCookie?.() ?? []) pairs.push(c.split(';')[0])
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href
      await sleep(500)
      continue
    }
    break
  }
  if (!pairs.some((p) => p.startsWith('JSESSIONID='))) throw new Error('zwdch 会话建立失败（无 JSESSIONID）')
  return pairs.join('; ')
}

function isRunningNow(train, nowMin) {
  const stops = train.stops
  const first = toAbs(stops[0].dep, stops[0].depDay)
  const lastStop = stops[stops.length - 1]
  const last = toAbs(lastStop.arr, lastStop.arrDay)
  return first != null && last != null && last > first && nowMin >= first && nowMin < last
}

// 对在途车次随机抽样查真实晚点；不足时用即将发车的补齐
function sampleDelayTargets(trains, nowMin, size) {
  const running = trains.filter((t) => isRunningNow(t, nowMin))
  const upcoming = trains
    .filter((t) => !isRunningNow(t, nowMin) && toAbs(t.stops[0].dep, t.stops[0].depDay) > nowMin)
    .sort((a, b) => toAbs(a.stops[0].dep, a.stops[0].depDay) - toAbs(b.stops[0].dep, b.stops[0].depDay))
  const picked = shuffled(running).slice(0, size)
  for (const t of upcoming) {
    if (picked.length >= size) break
    picked.push(t)
  }
  return picked
}

async function fetchRealDelays(trains, stations, sampleSize) {
  const byCode = Object.fromEntries(stations.map((s) => [s.code, s]))
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const targets = sampleDelayTargets(trains, nowMin, sampleSize)
  if (!targets.length) throw new Error('无可查询车次')
  const jar = await establishZwdSession()
  let realCount = 0
  let rejected = 0
  let streak = 0
  let firstReject = null
  const measured = []

  for (const t of shuffled(targets)) {
    await politeDelay()
    const { stop, sched } = pickDelayQueryStop(t, nowMin)
    const st = byCode[stop.code]
    if (!st) continue
    const cookie = `${jar}; _jc_save_zwdch_fromStation=${escapeU(st.name)}%2C${stop.code}; _jc_save_zwdch_cxlx=1`
    const body = `cxlx=1&cz=${encodeURIComponent(st.name)}&cc=${t.no}&czEn=${czEn(st.name)}`
    const res = await fetchWithTimeout('https://kyfw.12306.cn/otn/zwdch/query', {
      method: 'POST',
      headers: {
        'User-Agent': UA_EDGE,
        Cookie: cookie,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Cache-Control': 'no-cache',
        'If-Modified-Since': '0',
        Origin: 'https://kyfw.12306.cn',
        Referer: 'https://kyfw.12306.cn/otn/view/onTimeOrLate.html',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body,
    })
    const json = await res.json().catch(() => null)
    const parsed = parseDelayMessage(json)
    if (!parsed) {
      // 未发车/查询失败/风控：记录下来，方便判断配方是否失效
      rejected++
      streak++
      if (!firstReject) firstReject = json?.message || json?.ErrMsg || '未受理'
      if (streak >= 5) {
        console.warn(`⚠ 连续 ${streak} 趟未受理，疑似限流/配方失效，提前结束本轮`)
        break
      }
      continue
    }
    streak = 0
    const realMin = Number(parsed.time.slice(0, 2)) * 60 + Number(parsed.time.slice(3, 5))
    t.delay = Math.max(0, realMin - sched)
    realCount++
    measured.push(t.no)
    if (t.delay > 0 || realCount <= 3) {
      const schedStr = `${String(Math.floor(sched / 60)).padStart(2, '0')}:${String(sched % 60).padStart(2, '0')}`
      console.log(`✓ 正晚点：${t.no}@${st.name} ${parsed.predicted ? '预计' : '实际'} ${parsed.time} / 图定 ${schedStr} → 晚点 ${t.delay} 分`)
    }
  }
  if (!realCount) throw new Error('所有车次正晚点均不可解析')
  const late = targets.filter((t) => t.delay > 0).length
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  console.log(
    `✓ 正晚点抽样：${realCount}/${targets.length} 车次实测（在途优先），其中晚点 ${late} 趟` +
      (rejected ? `；${rejected} 趟未受理（${firstReject}）` : ''),
  )
  return { stamp, measured }
}

// ---------- 校验 ----------
function validate(stations, trains) {
  const codes = new Set(stations.map((s) => s.code))
  if (stations.length < 20) throw new Error(`车站数 ${stations.length} < 20`)
  for (const s of stations) {
    if (!/^[A-Z]{3}$/.test(s.code)) throw new Error(`电报码格式异常: ${s.name}=${s.code}`)
    if (s.lat < 15 || s.lat > 55 || s.lng < 70 || s.lng > 140) throw new Error(`坐标越界: ${s.name}`)
  }
  const seenNo = new Set()
  for (const t of trains) {
    if (seenNo.has(t.no)) throw new Error(`${t.no} 车次号重复`)
    seenNo.add(t.no)
    if (t.stops.length < 2) throw new Error(`${t.no} 经停站不足`)
    if (t.stops[0].arr != null) throw new Error(`${t.no} 始发站不应有到站时刻`)
    if (t.stops[t.stops.length - 1].dep != null) throw new Error(`${t.no} 终到站不应有发车时刻`)
    let prev = -1
    for (const s of t.stops) {
      if (!codes.has(s.code)) throw new Error(`${t.no} 经停码 ${s.code} 不在车站表中`)
      for (const [hm, day] of [[s.arr, s.arrDay], [s.dep, s.depDay]]) {
        if (hm == null) continue
        if (day != null && (!Number.isInteger(day) || day < 0 || day > 3)) throw new Error(`${t.no} 天数非法: ${s.code} day=${day}`)
        const m = toAbs(hm, day)
        if (m < prev) throw new Error(`${t.no} 时刻非单调递增: ${s.code} ${hm}`)
        prev = m
      }
      if (!Number.isInteger(t.delay) || t.delay < 0) throw new Error(`${t.no} delay 非法: ${t.delay}`)
    }
  }
}

// ---------- 生成前端数据 ----------
function writeAtomic(path, content) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

function writeLiveDelays(generatedAt, delayAsOf, sampled, trains) {
  mkdirSync('public/live', { recursive: true })
  const measured = Array.isArray(sampled)
  const list = measured ? trains.filter((t) => sampled.includes(t.no)) : trains
  writeAtomic(
    'public/live/delays.json',
    JSON.stringify({
      generatedAt,
      delayAsOf: delayAsOf ?? null,
      // sampled 只列本轮真实查询成功的车次；前端据此把其余车次标为「未实测」
      ...(measured ? { sampled: list.map((t) => t.no) } : {}),
      delays: Object.fromEntries(list.map((t) => [t.no, t.delay])),
    }),
  )
}

function emit(stations, trains, meta, sampled = null) {
  const services = trains.reduce((n, t) => n + 1 + (t.aliases?.length ?? 0), 0)
  meta.counts = { ...(meta.counts ?? {}), stations: stations.length, trains: trains.length, services }
  const header = `// 由 scripts/fetch-railway-data.mjs 生成（${meta.generatedAt}）——请勿手改，重跑脚本更新\n`
  const metaJs = header + `export const meta = ${JSON.stringify(meta, null, 2)}\n`
  // 车站/车次体积大（全量时数 MB），走 public/data 运行时加载，不进主包
  mkdirSync('src/data', { recursive: true })
  mkdirSync('public/data', { recursive: true })
  writeAtomic('public/data/stations.json', JSON.stringify(stations))
  writeAtomic('public/data/trains.json', JSON.stringify(trains))
  writeAtomic('src/data/meta.js', metaJs)
  const dataDate = meta.dataDate ?? meta.generatedAt
  writeAtomic(
    'public/data/status.json',
    JSON.stringify({
      dataDate,
      generatedAt: meta.generatedAt,
      complete: meta.complete === true,
      counts: meta.counts,
      lastError: null,
    }),
  )
  // 实时晚点数据文件：前端轮询用（配合 auto-refresh 定时刷新，dev/preview/静态部署均生效）
  writeLiveDelays(meta.generatedAt, meta.delayAsOf, sampled, trains)
  console.log(
    `✓ 已生成 public/data/{stations,trains,status}.json + src/data/meta.js + public/live/delays.json（车站 ${stations.length}，车次 ${trains.length}，班次 ${services}）`,
  )
}

function saveSnapshot(data) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const tmp = `${SNAPSHOT}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, SNAPSHOT)
}

// ---------- 主流程 ----------
async function main() {
  const date = args.date || todayStr()

  // 全量模式：跨进程锁（predev / 手动 / 定时任务只允许一个抓取进程）
  if (args.full) {
    const got = acquireLock({ date })
    if (!got.ok) {
      console.log(`全量抓取已在运行（pid ${got.owner?.pid}，日期 ${got.owner?.date}），本次退出`)
      return
    }
    process.on('exit', () => releaseLock())
    process.on('SIGINT', () => {
      releaseLock()
      process.exit(130)
    })
    writeFetchStatus({ running: true, phase: 'start', dataDate: date, done: 0, total: 0, startedAt: Date.now(), errors: 0 })
  }

  // 模式 1：仅正晚点抽样刷新（定时任务）
  if (args['delays-only']) {
    if (!existsSync(SNAPSHOT)) throw new Error('无快照，请先跑一次完整模式')
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    const lockState = isLocked()
    const fullRunning = lockState.running && lockState.lock.pid !== process.pid
    console.log(`→ 正晚点抽样刷新（快照 ${snap.date}，${snap.trains.length} 车次${fullRunning ? '；全量抓取中，仅更新 delays.json' : ''}）`)
    let delayAsOf = snap.delayAsOf
    let delaySource = snap.sources.delay
    let sampled = null
    try {
      const info = await fetchRealDelays(snap.trains, snap.stations, Number(args['delay-sample'] ?? 24))
      delayAsOf = info.stamp
      sampled = info.measured
      delaySource = '12306 正晚点实测（zwdch 抽样）'
    } catch (e) {
      // 失败时保留上一轮 delays.json 原样（不要用全 0 覆盖已有实测值）
      console.warn(`⚠ 正晚点刷新失败：${e.message}（保留上轮 delays.json）`)
      return
    }
    if (fullRunning) {
      // 不覆盖正在被全量抓取重写的主数据
      writeLiveDelays(todayStr(), delayAsOf, sampled, snap.trains)
      return
    }
    validate(snap.stations, snap.trains)
    const meta = {
      ...snap.metaBase,
      generatedAt: todayStr(),
      delayAsOf,
      delaySampled: sampled.length,
      sources: { ...snap.sources, delay: delaySource },
    }
    saveSnapshot({ ...snap, delayAsOf, delaySampled: sampled.length, sources: meta.sources })
    emit(snap.stations, snap.trains, meta, sampled)
    return
  }

  const allStations = await loadStationTable()
  const scope = args.scope === 'jinghu' ? 'jinghu' : 'national'

  let stations
  let trains = null
  let timetableSource
  let delayAsOf = null
  let delaySampled = null
  let delaySource
  let osmCount = 0
  let coverage = null
  let dataComplete = false

  if (scope === 'jinghu') {
    stations = mergeTelecodes(allStations)
    console.log(`✓ 京沪线 ${stations.length} 站（精确坐标）`)
    timetableSource = DATA_SOURCES.timetable
    try {
      trains = await fetchTimetablesQTI(stations, date)
      timetableSource = `12306 queryTrainInfo 抓取（${date} 发车日，免 cookie）`
    } catch (e) {
      console.warn(`⚠ queryTrainInfo 链路失败：${e.message}`)
      if (args.cookie) {
        try {
          trains = await fetchTimetables12306(stations, args.cookie, date)
          timetableSource = `12306 浏览器态抓取（${date}）`
        } catch (e2) {
          console.warn(`⚠ 浏览器态链路失败：${e2.message}`)
        }
      }
    }
    if (!trains) {
      console.warn('⚠ 降级为已验证快照时刻表')
      trains = curatedTimetables(stations)
    }
    delaySource = DATA_SOURCES.delay
    if (!args.offline && !args['no-delay']) {
      try {
        const info = await fetchRealDelays(trains, stations, trains.length)
        delayAsOf = info.stamp
        delaySampled = info.measured
        delaySource = '12306 正晚点实测（zwdch）'
      } catch (e) {
        console.warn(`⚠ 真实正晚点抓取失败：${e.message}（保留兜底 delay 值）`)
      }
    }
  } else {
    // 全国模式
    const geo = geocodeNational(allStations)
    stations = geo.geocoded
    osmCount = geo.osmCount
    // 站名索引统一用规范化键（去空白/尾「站」），解决「合肥 南」类目录条目
    const geocodedByName = geo.byName
    if (args.full) {
      // ---------- 全量模式：目录并集 + 全量队列 + 动态复查 ----------
      const union = await loadCatalogUnion(date, Number(args['catalog-samples'] ?? 3))
      let queue = selectAllTrains(union.groups)
      if (args.limit) queue = queue.slice(0, Number(args.limit))
      console.log(`→ 全量候选 ${queue.length} 趟（无配额）`)
      writeFetchStatus({ running: true, phase: 'timetables', total: queue.length, dataDate: date })
      let ctx = {
        trains: [],
        skipStat: { empty: 0, ungeocoded: 0, nonmonotonic: 0 },
        unknownStations: new Set(),
        stations,
        skippedUngeocoded: [],
        seenNo: new Set(),
        seenTrainNo: new Set(),
        done: 0,
        total: 0,
        startedAt: Date.now(),
      }
      try {
        ctx = await fetchNationalTimetables(queue, date, geocodedByName, ctx)
        if (!args.limit) {
          // 目录快照会随后台刷新补齐：收尾前复查 2 次，新出现的 train_no 动态入队
          for (let pass = 0; pass < 2; pass++) {
            let more = []
            try {
              const again = await loadCatalogUnion(date, 1)
              more = again.groups.filter((g) => !ctx.seenTrainNo.has(g.train_no))
            } catch (e) {
              console.warn(`⚠ 目录复查失败：${e.message}`)
              break
            }
            if (!more.length) break
            console.log(`→ 目录复查新增 ${more.length} 趟`)
            ctx = await fetchNationalTimetables(selectAllTrains(more), date, geocodedByName, ctx)
          }
        }
        trains = ctx.trains
        stations = ctx.stations
        timetableSource = `12306 queryTrainInfo 抓取（${date} 发车日，免 cookie，全量模式）`
        const services = trains.reduce((n, t) => n + 1 + (t.aliases?.length ?? 0), 0)
        coverage = {
          catalogTrainNo: union.stats.trainNo,
          catalogServices: union.stats.services,
          emuServices: union.stats.emuServices,
          convServices: union.stats.convServices,
          capturedTrains: trains.length,
          capturedServices: services,
        }
        // 完整度：抓到 ≥95% 目录列车才标记 complete；剩余缺口（幽灵车/无法定位支线）
        // 写入 fetch-report.json，避免每次启动都为少数不可得车次反复全量。
        dataComplete = trains.length >= union.stats.trainNo * 0.95
        const report = {
          date,
          generatedAt: new Date().toISOString(),
          catalog: union.stats,
          capturedTrains: trains.length,
          capturedServices: services,
          syntheticStations: stations.filter((s) => s.synthetic).length,
          resolvedStations: ctx.resolvedStations ?? 0,
          skip: ctx.skipStat,
          unknownStations: [...ctx.unknownStations],
          timetable: TIMETABLE_STATS,
        }
        mkdirSync('public/data', { recursive: true })
        writeAtomic('public/data/fetch-report.json', JSON.stringify(report, null, 2))
        if (ctx.unknownStations.size) {
          console.warn(`⚠ 未定位站名 ${ctx.unknownStations.size} 个：${[...ctx.unknownStations].slice(0, 10).join('、')}`)
        }
        writeFetchStatus({
          running: false,
          phase: 'done',
          done: ctx.done,
          total: ctx.total,
          trains: trains.length,
          dataDate: date,
          errors: ctx.skipStat.empty,
          lastError: ctx.lastError ?? null,
        })
      } catch (e) {
        writeFetchStatus({ running: false, phase: 'error', dataDate: date, lastError: e.message })
        throw e
      }
    } else {
      const catalog = await loadCatalog(date)
      const selected = selectNationalTrains(catalog, geocodedByName)
      console.log(`→ 候选车次 ${selected.length} 趟（新编排字头配额 + 等距采样，京沪标杆动态选取）`)
      try {
        const res = await fetchNationalTimetables(selected, date, geocodedByName)
        trains = res.trains
        timetableSource = `12306 queryTrainInfo 抓取（${date} 发车日，免 cookie，城市级坐标）`
      } catch (e) {
        console.warn(`⚠ 全国时刻表失败：${e.message}`)
      }
      if (!trains) {
        // 降级京沪
        console.warn('⚠ 降级为京沪线数据')
        stations = mergeTelecodes(allStations)
        try {
          trains = await fetchTimetablesQTI(stations, date)
          timetableSource = `12306 queryTrainInfo 抓取（${date}，京沪降级）`
        } catch {
          trains = curatedTimetables(stations)
          timetableSource = DATA_SOURCES.timetable
        }
      }
    }
    delaySource = DATA_SOURCES.delay
    if (!args.offline && !args['no-delay']) {
      try {
        const info = await fetchRealDelays(trains, stations, Number(args['delay-sample'] ?? 24))
        delayAsOf = info.stamp
        delaySampled = info.measured
        delaySource = '12306 正晚点实测（zwdch 抽样）'
      } catch (e) {
        console.warn(`⚠ 真实正晚点抓取失败：${e.message}`)
      }
    }
  }

  validate(stations, trains)
  console.log('✓ 数据校验通过（电报码/坐标/时刻单调性/delay 合法性）')

  const metaBase = {
    line: scope === 'jinghu' ? '京沪高铁' : '全国路网（京沪高铁精确坐标，其余城市级近似）',
    dataDate: date,
    complete: dataComplete,
    counts: { stations: stations.length, trains: trains.length },
    ...(coverage ? { coverage } : {}),
    disclaimer: '非官方实时数据，仅供参考；时刻以 12306 为准，不得作为行程决策依据',
  }
  const sources = {
    telecode: DATA_SOURCES.telecode,
    coord:
      scope === 'jinghu'
        ? DATA_SOURCES.coord
        : osmCount > 0
          ? `OSM 实测站点坐标 ${osmCount} 站（© OpenStreetMap contributors, ODbL）；其余城市级近似（公开地理信息整理）`
          : '京沪23站精确整理；其余城市级坐标+站名哈希微偏移（公开地理信息整理）',
    timetable: timetableSource,
    delay: delaySource,
  }
  const meta = {
    generatedAt: todayStr(),
    ...metaBase,
    sources,
    delayAsOf,
    ...(delaySampled ? { delaySampled: delaySampled.length } : {}),
  }
  saveSnapshot({ scope, date, stations, trains, sources, metaBase, delayAsOf, delaySampled })
  emit(stations, trains, meta, delaySampled)
}

main().catch((e) => {
  console.error('✗ 失败:', e.message)
  writeFetchStatus({ running: false, phase: 'error', lastError: e.message })
  releaseLock()
  process.exit(1)
})
