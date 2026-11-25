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
import { isEncryptedResult, parseLeftTicketEntry, parseTrainStops } from './lib/otn-parser.mjs'
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

// ---------- 步骤 3：浏览器态时刻表管道（预留，--cookie 启用） ----------
async function fetchTimetables12306(stations, cookie, date) {
  const byName = indexByName(stations)
  const headers = {
    'User-Agent': UA,
    Cookie: cookie,
    Referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
  }
  const from = byName['北京南'].code
  const to = byName['上海虹桥'].code

  // 3a. 余票查询（端点轮转：302 返回 c_url 时跟随）
  let path = 'leftTicket/query'
  let result = null
  for (let hop = 0; hop < 3; hop++) {
    const url = `https://kyfw.12306.cn/otn/${path}?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${from}&leftTicketDTO.to_station=${to}&purpose_codes=ADULT`
    const res = await fetch(url, { headers, redirect: 'manual' })
    const json = await res.json().catch(() => null)
    if (json?.c_url) {
      path = json.c_url.startsWith('leftTicket/') ? json.c_url : `leftTicket/${json.c_url}`
      console.log(`  ↳ 端点轮转 → ${path}`)
      await politeDelay()
      continue
    }
    result = json?.data?.result
    break
  }
  if (!result?.length) throw new Error('余票查询无结果（cookies 可能失效）')
  if (isEncryptedResult(result)) throw new Error('余票结果为密文（需完整浏览器态 cookies，见 PRD §5）')

  // 3b. 明文结果 → 目标车次 train_no
  const entries = result.map(parseLeftTicketEntry)
  const targets = JINGHU_TRAINS.map((t) => t.no)
  const found = entries.filter((e) => targets.includes(e.station_train_code))
  if (!found.length) throw new Error(`余票结果中未找到目标车次 ${targets.join('/')}`)

  // 3c. 逐车次查全程时刻表（限流）
  const trains = []
  for (const e of found) {
    await politeDelay()
    const url = `https://kyfw.12306.cn/otn/czxx/queryByTrainNo?train_no=${e.train_no}&from_station_telecode=${e.start_station_telecode}&to_station_telecode=${e.end_station_telecode}&depart_date=${date}`
    const res = await fetch(url, { headers: { ...headers, Referer: 'https://kyfw.12306.cn/otn/czxx/init' } })
    const json = await res.json().catch(() => null)
    const stops = parseTrainStops(json)
    if (!stops.length) throw new Error(`${e.station_train_code} 时刻表为空（响应格式可能已变，需校准 otn-parser）`)
    trains.push({
      no: e.station_train_code,
      delay: 0, // 真实正晚点属 M3 范围
      stops: stops.map((s) => ({ code: byName[s.name]?.code, name: s.name, arr: s.arr, dep: s.dep })),
    })
    console.log(`✓ 真实时刻表：${e.station_train_code}（${stops.length} 站）`)
  }
  return trains
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

  let trains
  let timetableSource = DATA_SOURCES.timetable
  if (args.cookie) {
    const date = args.date || tomorrow()
    console.log(`→ 浏览器态模式：尝试 12306 真实时刻表（${date}）`)
    try {
      trains = await fetchTimetables12306(stations, args.cookie, date)
      timetableSource = `12306 浏览器态抓取（${date}）`
    } catch (e) {
      console.warn(`⚠ 真实时刻表抓取失败：${e.message}`)
      console.warn('⚠ 降级为公开资料整理时刻表（已在 meta.js 标注）')
      trains = curatedTimetables(stations)
    }
  } else {
    trains = curatedTimetables(stations)
  }

  validate(stations, trains)
  console.log('✓ 数据校验通过（电报码/坐标/时刻单调性）')

  emit(stations, trains, {
    generatedAt: new Date().toISOString().slice(0, 10),
    line: '京沪高铁',
    sources: { ...DATA_SOURCES, timetable: timetableSource },
    disclaimer: '非官方实时数据，仅供参考；时刻以 12306 为准，不得作为行程决策依据',
  })
}

main().catch((e) => {
  console.error('✗ 失败:', e.message)
  process.exit(1)
})
