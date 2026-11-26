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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { parseStationNameJs, indexByName } from './lib/station-parser.mjs'
import {
  isEncryptedResult,
  parseLeftTicketEntry,
  parseTrainStops,
  parseTrainNameList,
  parseDelayMessage,
} from './lib/otn-parser.mjs'
import { JINGHU_STATIONS, JINGHU_TRAINS, DATA_SOURCES } from './data/jinghu-line.mjs'
import { CORRIDORS } from './data/corridors.mjs'
import { CITY_COORDS } from './data/city-coords.mjs'
import { geocodeStations } from './lib/geocode.mjs'
import { shuffled } from './lib/schedule.mjs'

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

// 当日（本地时区 = 北京时间）：与 zwdch 正晚点（恒查当日）同日，消除班次错位
function todayStr() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const toMin = (hm) => (hm == null ? null : Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)))

// ---------- 车站表 ----------
async function loadStationTable() {
  const cachePath = `${CACHE_DIR}/station_name.js`
  let text
  if (args.offline) {
    if (!existsSync(cachePath)) throw new Error('--offline 需要 .cache/railway/station_name.js，请先在线运行一次')
    text = readFileSync(cachePath, 'utf8')
    console.log('✓ 车站表：使用本地缓存')
  } else {
    const res = await fetch(STATION_URL, { headers: { 'User-Agent': UA } })
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
    const official = byName[s.name]
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
  const { geocoded, missing } = geocodeStations(allStations, preciseMap)
  console.log(`✓ 全国地理编码：${geocoded.length} 站（精确 ${geocoded.filter((s) => s.precise).length}，城市级 ${geocoded.filter((s) => !s.precise).length}），未覆盖 ${missing.length}`)
  return { geocoded, osmCount: Object.keys(osmCoords).length }
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
  const res = await fetch(`https://kyfw.12306.cn/otn/queryTrainInfo/getTrainName?date=${date}`, { headers: QTI_HEADERS })
  if (!res.ok) throw new Error(`getTrainName HTTP ${res.status}`)
  const json = await res.json()
  const list = parseTrainNameList(json)
  if (list.length < 1000) throw new Error(`车次目录解析异常：仅 ${list.length} 条`)
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cachePath, JSON.stringify(json))
  console.log(`✓ 车次目录：在线抓取 ${list.length} 趟（免 cookie）`)
  return list
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
  const ok = (name) => Boolean(geocodedByName[name])
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

// ---------- 时刻表抓取（queryTrainInfo，带逐车缓存） ----------
async function fetchTimetableForTrain(t, date) {
  const cachePath = `${CACHE_DIR}/nat/${t.train_no}_${date}.json`
  if (existsSync(cachePath) && !args['refresh-timetables']) {
    return JSON.parse(readFileSync(cachePath, 'utf8'))
  }
  if (args.offline) throw new Error(`离线且无 ${t.code} 时刻表缓存`)
  await politeDelay()
  const url = `https://kyfw.12306.cn/otn/queryTrainInfo/query?leftTicketDTO.train_no=${t.train_no}&leftTicketDTO.train_date=${date}&rand_code=`
  const res = await fetch(url, { headers: QTI_HEADERS })
  const json = await res.json().catch(() => null)
  mkdirSync(`${CACHE_DIR}/nat`, { recursive: true })
  writeFileSync(cachePath, JSON.stringify(json))
  return json
}

// 经停全部可定位 + 当日不跨零点（前端单位置模型限制，跨零点车跳过并计数）
// 区段车兼容：12306 对部分跨局长途车只返回区段站表（首站带到达时刻，如 G1372
// 昆明南—上海虹桥仅返回长沙南起段）→ 首站视同始发（arr 置 null），按区段呈现
function buildTrain(t, json, geocodedByName) {
  const stops = parseTrainStops(json)
  if (stops.length < 2) return { skip: 'empty' }
  const mapped = []
  let prev = -1
  for (const s of stops) {
    const st = geocodedByName[s.name]
    if (!st) return { skip: 'ungeocoded' }
    for (const hm of [s.arr, s.dep]) {
      if (hm == null) continue
      const m = toMin(hm)
      if (m < prev) return { skip: 'overnight' } // 跨零点（到站时间回绕）；相等=0 分钟停点，合法
      prev = m
    }
    mapped.push({ code: st.code, arr: s.arr, dep: s.dep })
  }
  let segmented = false
  if (mapped[0].arr != null) {
    mapped[0].arr = null
    segmented = true
  }
  return { train: { no: t.code, route: t.route, train_no: t.train_no, delay: 0, stops: mapped }, segmented }
}

async function fetchNationalTimetables(selected, date, geocodedByName) {
  const trains = []
  const skipStat = { empty: 0, ungeocoded: 0, overnight: 0 }
  let segmentedCount = 0
  let done = 0
  for (const t of selected) {
    done++
    if (done % 25 === 0) console.log(`  …时刻表进度 ${done}/${selected.length}`)
    let json
    try {
      json = await fetchTimetableForTrain(t, date)
    } catch (e) {
      if (!args.offline) throw e
      skipStat.empty++
      continue
    }
    const r = buildTrain(t, json, geocodedByName)
    if (r.skip) skipStat[r.skip]++
    else {
      trains.push(r.train)
      if (r.segmented) segmentedCount++
    }
  }
  console.log(
    `✓ 全国时刻表：${trains.length} 趟可用（区段车 ${segmentedCount}；跳过：跨零点 ${skipStat.overnight}，站点未覆盖 ${skipStat.ungeocoded}，空/失败 ${skipStat.empty}）`,
  )
  if (trains.length < 30) throw new Error(`可用车次过少（${trains.length}），放弃全国模式`)
  return trains
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
    const mapped = stops.map((s) => ({ code: byName[s.name]?.code, arr: s.arr, dep: s.dep }))
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
    const res = await fetch(url, { headers, redirect: 'manual' })
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
    const res = await fetch(url, { headers: { ...headers, Referer: 'https://kyfw.12306.cn/otn/czxx/init' } })
    const json = await res.json().catch(() => null)
    writeFileSync(`${CACHE_DIR}/qbtn_${e.station_train_code}.json`, JSON.stringify(json, null, 2))
    const stops = parseTrainStops(json)
    if (!stops.length) continue
    const mapped = stops.map((s) => ({ code: byName[s.name]?.code, arr: s.arr, dep: s.dep }))
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
      const st = byName[s.name]
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
  if (toMin(stops[0].dep) > nowMin) return { stop: stops[0], sched: toMin(stops[0].dep) }
  for (const s of stops) {
    if (s.dep != null && toMin(s.dep) > nowMin) return { stop: s, sched: toMin(s.dep) }
  }
  const last = stops[stops.length - 1]
  return { stop: last, sched: toMin(last.arr) }
}

async function establishZwdSession() {
  const pairs = []
  let url = 'https://kyfw.12306.cn/otn/zwdch/init'
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA_EDGE, Cookie: pairs.join('; ') }, redirect: 'manual' })
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
  const first = toMin(train.stops[0].dep)
  const last = toMin(train.stops[train.stops.length - 1].arr)
  return last > first && nowMin >= first && nowMin < last
}

// 对在途车次随机抽样查真实晚点；不足时用即将发车的补齐（返回图定=正点，无害）
function sampleDelayTargets(trains, nowMin, size) {
  const running = trains.filter((t) => isRunningNow(t, nowMin))
  const upcoming = trains
    .filter((t) => !isRunningNow(t, nowMin) && toMin(t.stops[0].dep) > nowMin)
    .sort((a, b) => toMin(a.stops[0].dep) - toMin(b.stops[0].dep))
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

  for (const t of shuffled(targets)) {
    await politeDelay()
    const { stop, sched } = pickDelayQueryStop(t, nowMin)
    const st = byCode[stop.code]
    if (!st) continue
    const cookie = `${jar}; _jc_save_zwdch_fromStation=${escapeU(st.name)}%2C${stop.code}; _jc_save_zwdch_cxlx=1`
    const body = `cxlx=1&cz=${encodeURIComponent(st.name)}&cc=${t.no}&czEn=${czEn(st.name)}`
    const res = await fetch('https://kyfw.12306.cn/otn/zwdch/query', {
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
    if (!parsed) continue // 未发车/不受理等：保留原 delay
    const realMin = Number(parsed.time.slice(0, 2)) * 60 + Number(parsed.time.slice(3, 5))
    t.delay = Math.max(0, realMin - sched)
    realCount++
    if (t.delay > 0 || realCount <= 3) {
      const schedStr = `${String(Math.floor(sched / 60)).padStart(2, '0')}:${String(sched % 60).padStart(2, '0')}`
      console.log(`✓ 正晚点：${t.no}@${st.name} ${parsed.predicted ? '预计' : '实际'} ${parsed.time} / 图定 ${schedStr} → 晚点 ${t.delay} 分`)
    }
  }
  if (!realCount) throw new Error('所有车次正晚点均不可解析')
  const late = targets.filter((t) => t.delay > 0).length
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  console.log(`✓ 正晚点抽样：${realCount}/${targets.length} 车次实测（在途优先），其中晚点 ${late} 趟`)
  return stamp
}

// ---------- 校验 ----------
function validate(stations, trains) {
  const codes = new Set(stations.map((s) => s.code))
  if (stations.length < 20) throw new Error(`车站数 ${stations.length} < 20`)
  for (const s of stations) {
    if (!/^[A-Z]{3}$/.test(s.code)) throw new Error(`电报码格式异常: ${s.name}=${s.code}`)
    if (s.lat < 15 || s.lat > 55 || s.lng < 70 || s.lng > 140) throw new Error(`坐标越界: ${s.name}`)
  }
  for (const t of trains) {
    if (t.stops.length < 2) throw new Error(`${t.no} 经停站不足`)
    if (t.stops[0].arr != null) throw new Error(`${t.no} 始发站不应有到站时刻`)
    if (t.stops[t.stops.length - 1].dep != null) throw new Error(`${t.no} 终到站不应有发车时刻`)
    let prev = -1
    for (const s of t.stops) {
      if (!codes.has(s.code)) throw new Error(`${t.no} 经停码 ${s.code} 不在车站表中`)
      for (const hm of [s.arr, s.dep]) {
        if (hm == null) continue
        const m = toMin(hm)
        if (m < prev) throw new Error(`${t.no} 时刻非单调递增: ${s.code} ${hm}`)
        prev = m
      }
      if (!Number.isInteger(t.delay) || t.delay < 0) throw new Error(`${t.no} delay 非法: ${t.delay}`)
    }
  }
}

// ---------- 生成前端数据 ----------
function emit(stations, trains, meta) {
  mkdirSync('src/data', { recursive: true })
  const header = `// 由 scripts/fetch-railway-data.mjs 生成（${meta.generatedAt}）——请勿手改，重跑脚本更新\n`
  const metaJs = header + `export const meta = ${JSON.stringify(meta, null, 2)}\n`
  // 车站/车次体积大（全量时数 MB），走 public/data 运行时加载，不进主包
  mkdirSync('public/data', { recursive: true })
  writeFileSync('public/data/stations.json', JSON.stringify(stations))
  writeFileSync('public/data/trains.json', JSON.stringify(trains))
  writeFileSync('src/data/meta.js', metaJs)
  // 实时晚点数据文件：前端轮询用（配合 auto-refresh 定时刷新，dev/preview/静态部署均生效）
  mkdirSync('public/live', { recursive: true })
  writeFileSync(
    'public/live/delays.json',
    JSON.stringify({
      generatedAt: meta.generatedAt,
      delayAsOf: meta.delayAsOf ?? null,
      delays: Object.fromEntries(trains.map((t) => [t.no, t.delay])),
    }),
  )
  console.log(
    `✓ 已生成 public/data/{stations,trains}.json + src/data/meta.js + public/live/delays.json（车站 ${stations.length}，车次 ${trains.length}）`,
  )
}

function saveSnapshot(data) {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(SNAPSHOT, JSON.stringify(data))
}

// ---------- 主流程 ----------
async function main() {
  const date = args.date || todayStr()

  // 模式 1：仅正晚点抽样刷新（定时任务）
  if (args['delays-only']) {
    if (!existsSync(SNAPSHOT)) throw new Error('无快照，请先跑一次完整模式')
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    console.log(`→ 正晚点抽样刷新（快照 ${snap.date}，${snap.trains.length} 车次）`)
    let delayAsOf = snap.delayAsOf
    let delaySource = snap.sources.delay
    try {
      delayAsOf = await fetchRealDelays(snap.trains, snap.stations, Number(args['delay-sample'] ?? 24))
      delaySource = '12306 正晚点实测（zwdch 抽样）'
    } catch (e) {
      console.warn(`⚠ 正晚点刷新失败：${e.message}（保留上轮数据）`)
    }
    validate(snap.stations, snap.trains)
    const meta = { ...snap.metaBase, generatedAt: todayStr(), delayAsOf, sources: { ...snap.sources, delay: delaySource } }
    saveSnapshot({ ...snap, delayAsOf, sources: meta.sources })
    emit(snap.stations, snap.trains, meta)
    return
  }

  const allStations = await loadStationTable()
  const scope = args.scope === 'jinghu' ? 'jinghu' : 'national'

  let stations
  let trains = null
  let timetableSource
  let delayAsOf = null
  let delaySource
  let osmCount = 0

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
        delayAsOf = await fetchRealDelays(trains, stations, trains.length)
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
    const geocodedByName = Object.fromEntries(stations.map((s) => [s.name, s]))
    const catalog = await loadCatalog(date)
    const selected = selectNationalTrains(catalog, geocodedByName)
    console.log(`→ 候选车次 ${selected.length} 趟（新编排字头配额 + 等距采样，京沪标杆动态选取）`)
    try {
      trains = await fetchNationalTimetables(selected, date, geocodedByName)
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
    delaySource = DATA_SOURCES.delay
    if (!args.offline && !args['no-delay']) {
      try {
        delayAsOf = await fetchRealDelays(trains, stations, Number(args['delay-sample'] ?? 24))
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
    counts: { stations: stations.length, trains: trains.length },
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
  const meta = { generatedAt: todayStr(), ...metaBase, sources, delayAsOf }
  saveSnapshot({ scope, date, stations, trains, sources, metaBase, delayAsOf })
  emit(stations, trains, meta)
}

main().catch((e) => {
  console.error('✗ 失败:', e.message)
  process.exit(1)
})
