// M2 数据管道：生成前端真实静态数据
//
// 用法：
//   node scripts/fetch-railway-data.mjs                 # 在线抓车站表 + 整理时刻表
//   node scripts/fetch-railway-data.mjs --offline       # 用 .cache 已下载的车站表
//   node scripts/fetch-railway-data.mjs --cookie="RAIL_DEVICEID=...; ..." [--date=2026-11-26]
//                                                       # 浏览器态：尝试 12306 真实时刻表
//
// 数据源策略（PRD §5/§6.3）：
//   电报码 ← 12306 station_name.js（实测可达，明文）
//   坐标   ← 公开地理信息整理（外部坐标源实测不可达）
//   时刻表 ← 浏览器态管道优先，失败降级为公开资料整理（诚实标注）
//
// 合规：请求间隔 1–3s 随机延时；仅限个人学习/演示。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { parseStationNameJs, indexByName } from './lib/station-parser.mjs'
import {
  isEncryptedResult,
  parseLeftTicketEntry,
  parseTrainStops,
  parseTrainNameList,
  matchTrainByName,
  parseDelayMessage,
} from './lib/otn-parser.mjs'
import { JINGHU_STATIONS, JINGHU_TRAINS, DATA_SOURCES } from './data/jinghu-line.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const CACHE_DIR = '.cache/railway'
const STATION_URL = 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const politeDelay = () => sleep(1000 + Math.random() * 2000) // 限流：1–3s

function tomorrow() {
  const d = new Date(Date.now() + 86400000)
  return d.toISOString().slice(0, 10)
}

// ---------- 步骤 1：车站表 ----------
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
    console.log(`✓ 车站表：在线抓取 ${text.length} 字节`)
  }
  const stations = parseStationNameJs(text)
  if (stations.length < 1000) throw new Error(`车站表解析异常：仅 ${stations.length} 站`)
  console.log(`✓ 解析车站 ${stations.length} 个`)
  return stations
}

// ---------- 步骤 2：合并真实电报码 ----------
function mergeTelecodes(allStations) {
  const byName = indexByName(allStations)
  return JINGHU_STATIONS.map((s) => {
    const official = byName[s.name]
    if (!official) throw new Error(`12306 车站表中找不到「${s.name}」，请核对站名`)
    return { code: official.code, name: s.name, lat: s.lat, lng: s.lng }
  })
}

// 目标车次：2026 运行图实际开行、终到上海虹桥的京沪标杆车
// （G101/G103 已停运；G3/G5 终到上海站——既有线站，不在高铁本线表，实测确认）
const REAL_TARGETS = ['G1', 'G7', 'G9', 'G11', 'G13']
// 兜底晚点值：仅当真实正晚点抓取失败/离线时使用（meta.js 披露来源）
const DEMO_DELAY = { G9: 15 }

// ---------- 步骤 3a：queryTrainInfo 免 cookie 链（主路径，2026-11-26 实测打通） ----------
// getTrainName: 全国车次目录（含内部 train_no，明文，普通会话即可）
// query:        全程时刻表（图定时刻，无正晚点字段——实测在途车与图定零差异）
// 完全替代"加密 leftTicket → train_no → czxx"脆弱链路
const QTI_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://kyfw.12306.cn/otn/queryTrainInfo/init',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
}

async function fetchTimetablesQTI(stations, date) {
  const byName = indexByName(stations)
  const cachePath = `${CACHE_DIR}/gettrainname_${date}.json`
  let list
  if (args.offline && existsSync(cachePath)) {
    list = parseTrainNameList(JSON.parse(readFileSync(cachePath, 'utf8')))
    console.log(`✓ 车次目录：本地缓存 ${list.length} 条`)
  } else {
    const res = await fetch(
      `https://kyfw.12306.cn/otn/queryTrainInfo/getTrainName?date=${date}`,
      { headers: QTI_HEADERS },
    )
    if (!res.ok) throw new Error(`getTrainName HTTP ${res.status}`)
    const json = await res.json()
    list = parseTrainNameList(json)
    if (list.length < 1000) throw new Error(`车次目录解析异常：仅 ${list.length} 条`)
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(cachePath, JSON.stringify(json))
    console.log(`✓ 车次目录：在线抓取 ${list.length} 趟（免 cookie）`)
  }

  const targets = REAL_TARGETS.map((no) => matchTrainByName(list, no, '北京南', '上海虹桥')).filter(Boolean)
  if (targets.length < 3) throw new Error(`目录中仅匹配到 ${targets.length} 趟目标车次`)

  const trains = []
  for (const t of targets) {
    await politeDelay()
    const url = `https://kyfw.12306.cn/otn/queryTrainInfo/query?leftTicketDTO.train_no=${t.train_no}&leftTicketDTO.train_date=${date}&rand_code=`
    const res = await fetch(url, { headers: QTI_HEADERS })
    const json = await res.json().catch(() => null)
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(`${CACHE_DIR}/qti_${t.code}.json`, JSON.stringify(json, null, 2))
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
    trains.push({ no: t.code, delay: DEMO_DELAY[t.code] || 0, stops: mapped })
    console.log(`✓ 真实时刻表：${t.code}（${stops.length} 站，免 cookie）`)
  }
  if (!trains.length) throw new Error('queryTrainInfo 无可用时刻表')
  return trains
}

// ---------- 步骤 3b：浏览器态时刻表管道（备用，--cookie 启用，2026-11-25 实测打通） ----------

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

  // 3a. 余票查询（端点轮转：c_url JSON 指引 + HTTP Location 重定向都要跟随）
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
      console.log(`  ↳ 端点轮转 → ${path}`)
      await politeDelay()
      continue
    }
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      // 错误页/登录页重定向 = 会话被风控拒绝，不再跟随
      if (/error\.html|passport|login/.test(loc)) {
        console.warn(`  ↳ 会话被拒绝（重定向 ${loc.slice(0, 60)}...）`)
        rejected = true
        break
      }
      path = loc.replace(/^https?:\/\/kyfw\.12306\.cn\/otn\//, '').replace(/^\//, '').split('?')[0]
      console.log(`  ↳ 重定向 → ${path}`)
      await politeDelay()
      continue
    }
    result = json?.data?.result
    break
  }

  // 3b. 明文结果 → train_no 映射；leftTicket 被拒时用同日缓存兜底
  //     （czxx/queryByTrainNo 域不受 JS 挑战限制，train_no 映射同日稳定）
  let entries
  if (result?.length && !isEncryptedResult(result)) {
    entries = result.map(parseLeftTicketEntry)
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(entriesCache, JSON.stringify(entries, null, 2))
  } else {
    if (!rejected && result?.length) console.warn('⚠ 余票结果为密文')
    if (existsSync(entriesCache)) {
      entries = JSON.parse(readFileSync(entriesCache, 'utf8'))
      console.warn(`⚠ leftTicket 不可用，使用同日 train_no 缓存（${entries.length} 条）走 czxx 域`)
    } else {
      throw new Error('余票查询不可用且无同日缓存（需新鲜浏览器态 cookies）')
    }
  }

  const seen = new Set()
  const unique = entries.filter(
    (e) =>
      e.start_station_telecode === from &&
      e.end_station_telecode === to &&
      !seen.has(e.station_train_code) &&
      seen.add(e.station_train_code),
  )
  let found = REAL_TARGETS.map((no) => unique.find((e) => e.station_train_code === no)).filter(Boolean)
  if (found.length < 3) {
    for (const e of unique) {
      if (found.length >= 5) break
      if (e.station_train_code.startsWith('G') && !found.includes(e)) found.push(e)
    }
  }
  if (!found.length) throw new Error('余票结果中未找到可用 G 字头车次')

  // 3c. 逐车次查全程时刻表（限流；原始响应存档供 M3 校准）
  const trains = []
  for (const e of found) {
    await politeDelay()
    const url = `https://kyfw.12306.cn/otn/czxx/queryByTrainNo?train_no=${e.train_no}&from_station_telecode=${e.start_station_telecode}&to_station_telecode=${e.end_station_telecode}&depart_date=${date}`
    const res = await fetch(url, { headers: { ...headers, Referer: 'https://kyfw.12306.cn/otn/czxx/init' } })
    const json = await res.json().catch(() => null)
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(`${CACHE_DIR}/qbtn_${e.station_train_code}.json`, JSON.stringify(json, null, 2))
    const stops = parseTrainStops(json)
    if (!stops.length) {
      console.warn(`⚠ ${e.station_train_code} 时刻表为空，跳过`)
      continue
    }
    const mapped = stops.map((s) => ({ code: byName[s.name]?.code, arr: s.arr, dep: s.dep }))
    if (mapped.some((s) => !s.code)) {
      console.warn(`⚠ ${e.station_train_code} 含线路表外车站，跳过`)
      continue
    }
    trains.push({ no: e.station_train_code, delay: DEMO_DELAY[e.station_train_code] || 0, stops: mapped })
    console.log(`✓ 真实时刻表：${e.station_train_code}（${stops.length} 站）`)
  }
  if (!trains.length) throw new Error('所有车次时刻表均不可用')
  return trains
}

// ---------- 步骤 3c：真实正晚点（zwdch/query，2026-11-26 实测打通） ----------
// 成功配方（用户提供浏览器成功样本 + 复现验证 4/4）：
//   cxlx=1；不带 randCode；Content-Type 含 charset=UTF-8；
//   cookie 含 _jc_save_zwdch_fromStation(%uXXXX 格式) 与 _jc_save_zwdch_cxlx=1；
//   cz 必须是"想查的站"：未发车→始发站（图定）；在途→前方站（预计）或已过站（实际）
// 晚点分钟 = 返回时刻 − 图定时刻（早于图定按正点计，钳为 0）
const UA_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0'

// JS escape() 风格 %uXXXX 编码（_jc_save cookie 用）
const escapeU = (s) => [...s].map((c) => '%u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')
// czEn：encodeURIComponent 后 % → -
const czEn = (s) => encodeURIComponent(s).replace(/%/g, '-')

// 选择查询站：在途→最近未发站（预计）；未发车→始发站；已终到→终到站（实际到达）
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
  // GET zwdch/init（302 → view/onTimeOrLate.html），手动跟随以收集全部 Set-Cookie
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

async function fetchRealDelays(trains, stations) {
  const byCode = Object.fromEntries(stations.map((s) => [s.code, s]))
  const jar = await establishZwdSession()
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  let realCount = 0

  for (const t of trains) {
    await politeDelay()
    const { stop, sched } = pickDelayQueryStop(t, nowMin)
    const st = byCode[stop.code]
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
    if (!parsed) {
      console.warn(`⚠ ${t.no}@${st.name}: 正晚点响应不可解析（${json?.data?.message ?? '无消息'}），保留原 delay`)
      continue
    }
    const realMin = Number(parsed.time.slice(0, 2)) * 60 + Number(parsed.time.slice(3, 5))
    t.delay = Math.max(0, realMin - sched) // 早于图定按正点计
    realCount++
    const schedStr = `${String(Math.floor(sched / 60)).padStart(2, '0')}:${String(sched % 60).padStart(2, '0')}`
    console.log(
      `✓ 正晚点：${t.no}@${st.name} ${parsed.predicted ? '预计' : '实际'} ${parsed.time} / 图定 ${schedStr} → 晚点 ${t.delay} 分`,
    )
  }
  if (!realCount) throw new Error('所有车次正晚点均不可解析')
  const pad = (n) => String(n).padStart(2, '0')
  const localStamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  return `${localStamp}（${realCount}/${trains.length} 车次实测）`
}

// ---------- 步骤 4：整理时刻表 → 电报码 ----------
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

// ---------- 步骤 5：校验 ----------
const toMin = (hm) => (hm == null ? null : Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)))

function validate(stations, trains) {
  const codes = new Set(stations.map((s) => s.code))
  if (stations.length < 20) throw new Error(`线路车站数 ${stations.length} < 20`)
  for (const s of stations) {
    if (!/^[A-Z]{3}$/.test(s.code)) throw new Error(`电报码格式异常: ${s.name}=${s.code}`)
    if (s.lat < 18 || s.lat > 54 || s.lng < 73 || s.lng > 135) throw new Error(`坐标越界: ${s.name}`)
  }
  for (const t of trains) {
    if (t.stops.length < 2) throw new Error(`${t.no} 经停站不足`)
    if (t.stops[0].arr != null) throw new Error(`${t.no} 始发站不应有到站时刻`)
    if (t.stops[t.stops.length - 1].dep != null) throw new Error(`${t.no} 终到站不应有发车时刻`)
    let prev = -1
    for (const s of t.stops) {
      if (!codes.has(s.code)) throw new Error(`${t.no} 经停码 ${s.code} 不在线路中`)
      for (const hm of [s.arr, s.dep]) {
        if (hm == null) continue
        const m = toMin(hm)
        if (m <= prev) throw new Error(`${t.no} 时刻非单调递增: ${s.code} ${hm}`)
        prev = m
      }
    }
  }
}

// ---------- 步骤 6：生成前端数据 ----------
function emit(stations, trains, meta) {
  const header = `// 由 scripts/fetch-railway-data.mjs 生成（${meta.generatedAt}）——请勿手改，重跑脚本更新\n`
  const stationJs =
    header +
    `// 京沪高铁本线车站（电报码来自 12306 实测；坐标为公开地理信息整理，WGS-84）\n\n` +
    `export const stations = ${JSON.stringify(stations, null, 2)}\n\n` +
    `export const stationsMap = Object.fromEntries(stations.map((s) => [s.code, s]))\n\n` +
    `// 线路连线点（车站间直线，M4 可替换为沿线采样点）\n` +
    `export const linePoints = stations.map((s) => ({ lat: s.lat, lng: s.lng }))\n`
  const trainJs =
    header +
    `// 京沪线代表性车次（时刻表来源见 meta.js；delay 为演示值，M3 接入真实正晚点）\n\n` +
    `export const trains = ${JSON.stringify(trains, null, 2)}\n`
  const metaJs = header + `export const meta = ${JSON.stringify(meta, null, 2)}\n`
  writeFileSync('src/data/stations.js', stationJs)
  writeFileSync('src/data/trains.js', trainJs)
  writeFileSync('src/data/meta.js', metaJs)
  console.log('✓ 已生成 src/data/stations.js / trains.js / meta.js')
}

// ---------- 主流程 ----------
async function main() {
  const allStations = await loadStationTable()
  const stations = mergeTelecodes(allStations)
  console.log(`✓ 京沪线 ${stations.length} 站合并真实电报码`)

  const date = args.date || tomorrow()
  let trains = null
  let timetableSource = DATA_SOURCES.timetable

  // 优先级 1：queryTrainInfo 免 cookie 链（2026-11-26 验证，最稳）
  console.log(`→ 主链路：queryTrainInfo 免 cookie 抓取（${date}）`)
  try {
    trains = await fetchTimetablesQTI(stations, date)
    timetableSource = `12306 queryTrainInfo 抓取（${date} 发车日，免 cookie）`
  } catch (e) {
    console.warn(`⚠ queryTrainInfo 链路失败：${e.message}`)
    // 优先级 2：浏览器态 leftTicket+czxx 链（2026-11-25 验证，需用户提供 cookies）
    if (args.cookie) {
      console.log(`→ 备用链路：浏览器态抓取（${date}）`)
      try {
        trains = await fetchTimetables12306(stations, args.cookie, date)
        timetableSource = `12306 浏览器态抓取（${date}）`
      } catch (e2) {
        console.warn(`⚠ 浏览器态链路失败：${e2.message}`)
      }
    }
  }
  // 优先级 3：已验证快照（jinghu-line.mjs，来源见 DATA_SOURCES）
  if (!trains) {
    console.warn('⚠ 降级为已验证快照时刻表（已在 meta.js 标注）')
    trains = curatedTimetables(stations)
  }

  validate(stations, trains)
  console.log('✓ 数据校验通过（电报码/坐标/时刻单调性）')

  // 真实正晚点（zwdch 实测，2026-11-26 打通）；离线或 --no-delay 跳过
  let delaySource = DATA_SOURCES.delay
  let delayAsOf = null
  if (!args.offline && !args['no-delay']) {
    try {
      delayAsOf = await fetchRealDelays(trains, stations)
      delaySource = '12306 正晚点实测（zwdch）'
    } catch (e) {
      console.warn(`⚠ 真实正晚点抓取失败：${e.message}（保留兜底 delay 值，meta 已披露）`)
    }
  }

  emit(stations, trains, {
    generatedAt: new Date().toISOString().slice(0, 10),
    line: '京沪高铁',
    sources: { ...DATA_SOURCES, timetable: timetableSource, delay: delaySource },
    delayAsOf,
    disclaimer: '非官方实时数据，仅供参考；时刻以 12306 为准，不得作为行程决策依据',
  })
}

main().catch((e) => {
  console.error('✗ 失败:', e.message)
  process.exit(1)
})
