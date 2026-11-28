// OSM 缺线位补片抓取：找出前端会退化成「站点直线」的站对，
// 只抓这些站对弦线覆盖的 0.5° 网格（railway=rail，不限定 usage），
// 补进 .cache/osm/patch/，由 build-lines.mjs 合并进 lines.json。
//
// 背景：全国瓦片抓取用的是 highspeed=yes / usage=main 两个过滤条件，
//       池黄、湖杭等只有 usage=branch 或没有 usage 的线路整段缺失，
//       前端吸附失败、路由也找不到，只能画站点直线。这里按缺口补抓。
//
// 用法：
//   node scripts/fetch-osm-gaps.mjs --dry-run          # 只列出要补的网格
//   node scripts/fetch-osm-gaps.mjs                    # 抓取（默认 60 分钟预算）
//   node scripts/fetch-osm-gaps.mjs --min-km=10 --cell=0.5
//   --proxy=http://127.0.0.1:10808
//
// 归属：数据 © OpenStreetMap contributors，ODbL 许可（lines.json 中已署名）。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs'
import { buildRailIndex, snapChord, distKm } from '../src/lib/snap.js'
import { buildRouteGraph, routePair } from '../src/lib/route-graph.js'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)

const PATCH_DIR = '.cache/osm/patch'
const CELL = Number(args.cell ?? 0.5) // 补片网格边长（度）
const MIN_KM = Number(args['min-km'] ?? 3) // 短于此的站对不补（视觉上只是一小段直线）
const MAX_WAIT_MIN = Number(args['max-wait-min'] ?? 60)
const PROXY = args.proxy ?? null
const UA = 'train-status-site/1.0 (personal learning project; low-frequency gap patching)'
// 2026-11-28 实测：overpass-api.de 长时间 502 限容；openstreetmap.fr 可用且数据完整；
// kumi.systems / private.coffee / osm.jp 不可达；osm.ch 对中国区返回空（不可用）
const MIRRORS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const politeWait = () => sleep(3000 + Math.random() * 5000)

function patchName(lat, lon) {
  return `patch_s${CELL}_${lat}_${lon}.json`
}

function validJsonFile(f) {
  try {
    if (!existsSync(f) || statSync(f).size < 50) return false
    const head = Buffer.alloc(1)
    const fd = openSync(f, 'r')
    readSync(fd, head, 0, 1, 0)
    closeSync(fd)
    return head[0] === 0x7b // '{'
  } catch {
    return false
  }
}

function loadData() {
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'))
  return {
    stations: read('public/data/stations.json'),
    trains: read('public/data/trains.json'),
    lines: read('public/data/lines.json'),
  }
}

/**
 * 与前端 buildTrainPath 同一套判定：吸附（含 25→45km 重试）→ 路由 → 仍失败即「直线兜底」
 * @returns {{total:number, pairs:number, degraded:Array<{a:number[],b:number[],chord:number}>}}
 */
function findGaps({ stations, trains, lines }) {
  const byCode = Object.fromEntries(stations.map((s) => [s.code, s]))
  const index = buildRailIndex(lines)
  const graph = buildRouteGraph(lines)
  const router = (a, b) => routePair(graph, a, b)
  const cache = new Map()
  const degraded = []
  let total = 0
  let pairs = 0
  for (const t of trains) {
    const stops = t.stops.map((s) => byCode[s.code]).filter(Boolean)
    for (let i = 0; i < stops.length - 1; i++) {
      const a = [stops[i].lat, stops[i].lng]
      const b = [stops[i + 1].lat, stops[i + 1].lng]
      const key = `${a[0].toFixed(3)},${a[1].toFixed(3)}|${b[0].toFixed(3)},${b[1].toFixed(3)}`
      total++
      if (cache.has(key)) continue
      pairs++
      const chord = distKm(a, b)
      if (chord < MIN_KM) {
        cache.set(key, 'short')
        continue
      }
      let snapped = snapChord(a, b, index)
      if (!snapped && chord > 15) snapped = snapChord(a, b, index, 0, 45)
      if (snapped) {
        let len = 0
        for (let j = 1; j < snapped.length; j++) len += distKm(snapped[j - 1], snapped[j])
        if (len > chord * 2.5 + 30) snapped = null
      }
      const routed = snapped ? 'snap' : router(a, b) ? 'route' : null
      cache.set(key, routed ?? 'degraded')
      if (!routed) degraded.push({ a, b, chord })
    }
  }
  return { total, pairs, degraded, cache }
}

/** 站对弦线覆盖的 0.5° 网格 */
function gapCells(degraded) {
  const cells = new Map()
  for (const { a, b } of degraded) {
    const km = distKm(a, b)
    const n = Math.max(1, Math.ceil(km / 4)) // 每 ~4km 取样
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const lat = a[0] + (b[0] - a[0]) * t
      const lng = a[1] + (b[1] - a[1]) * t
      const la = Math.floor(lat / CELL) * CELL
      const ln = Math.floor(lng / CELL) * CELL
      cells.set(`${la.toFixed(2)}_${ln.toFixed(2)}`, { lat: +la.toFixed(2), lon: +ln.toFixed(2) })
    }
  }
  return [...cells.values()]
}

async function tryCellOnce({ lat, lon }) {
  const outFile = `${PATCH_DIR}/${patchName(lat.toFixed(2), lon.toFixed(2))}`
  if (validJsonFile(outFile)) return 'cached'
  const bbox = `(${lat},${lon},${Math.min(lat + CELL, 54.5)},${Math.min(lon + CELL, 136)})`
  const q = `way["railway"="rail"]${bbox};out geom;`
  const timeout = 60
  for (const mirror of MIRRORS) {
    const host = new URL(mirror).host
    const curlArgs = ['-s', '--max-time', String(timeout + 60), '-A', UA, '-X', 'POST', mirror,
      '--data-urlencode', `data=[out:json][timeout:${timeout}];${q}`, '-o', outFile, '-w', '%{http_code}']
    if (PROXY) curlArgs.splice(1, 0, '-x', PROXY)
    let status = 0
    try {
      status = Number(execFileSync('curl', curlArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    } catch {
      status = 0
    }
    if (status === 200 && validJsonFile(outFile)) {
      const j = JSON.parse(readFileSync(outFile, 'utf8'))
      const n = Array.isArray(j.elements) ? j.elements.length : 0
      // 空结果：主站返回空说明该网格确实没有铁路（可信），落盘避免反复重试；
      // 其他镜像（如 osm.ch 只服务本国）返回空不可信，继续换镜像
      if (n === 0) {
        if (host === 'overpass-api.de') {
          console.log(`∅ ${patchName(lat.toFixed(2), lon.toFixed(2))} 该网格无铁路`)
          return 'empty'
        }
        try { unlinkSync(outFile) } catch { /* 忽略 */ }
        continue
      }
      const kb = Math.round(statSync(outFile).size / 1024)
      console.log(`✓ ${patchName(lat.toFixed(2), lon.toFixed(2))} ${kb}KB ${n} 个 way @${host}`)
      return 'ok'
    }
    try {
      if (existsSync(outFile)) unlinkSync(outFile)
    } catch { /* 忽略 */ }
    console.warn(`· patch (${lat},${lon}) HTTP ${status || 'ERR'} @${host}`)
  }
  return 'failed'
}

async function main() {
  console.log('→ 读取数据并找出直线兜底的站对…')
  const data = loadData()
  const t0 = Date.now()
  const { total, pairs, degraded } = findGaps(data)
  const cells = gapCells(degraded)
  const kmSum = degraded.reduce((s, x) => s + x.chord, 0)
  console.log(
    `  区间 ${total} 个 / 唯一站对 ${pairs} 个 → 直线兜底 ${degraded.length} 个站对（合计 ${kmSum.toFixed(0)}km，判定 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
  )
  for (const g of degraded.slice(0, 20)) {
    console.log(`   · ${g.chord.toFixed(0)}km ${g.a.map((v) => v.toFixed(3))} → ${g.b.map((v) => v.toFixed(3))}`)
  }
  if (degraded.length > 20) console.log(`   · … 其余 ${degraded.length - 20} 个`)
  console.log(`  需要补片网格：${cells.length} 个（${CELL}°）`)

  if (args['dry-run']) {
    for (const c of cells) console.log(`   patch ${c.lat},${c.lon}`)
    return
  }
  if (!cells.length) {
    console.log('✓ 没有需要补的网格')
    return
  }

  mkdirSync(PATCH_DIR, { recursive: true })
  const deadline = Date.now() + MAX_WAIT_MIN * 60000
  // 服务器经常 502，按「整轮重试 + 递增等待」跑，避免单个网格把预算耗在重试上
  const waits = [0, 45, 90, 180, 300]
  let pending = cells.filter((c) => !validJsonFile(`${PATCH_DIR}/${patchName(c.lat.toFixed(2), c.lon.toFixed(2))}`))
  const cached = cells.length - pending.length
  let ok = 0
  let empty = 0
  let pass = 0
  while (pending.length && Date.now() < deadline) {
    const wait = waits[Math.min(pass, waits.length - 1)]
    if (wait) {
      console.log(`… 第 ${pass + 1} 轮：${pending.length} 个网格待补，等待 ${wait}s 后重试`)
      await sleep(wait * 1000)
    }
    const next = []
    for (const c of pending) {
      if (Date.now() > deadline) {
        next.push(c)
        continue
      }
      const r = await tryCellOnce(c)
      if (r === 'ok') ok++
      else if (r === 'empty') empty++
      else if (r === 'failed') next.push(c)
      await politeWait()
    }
    pending = next
    pass++
  }
  const failed = pending.length

  console.log(`\n=== 补片完成：新增 ${ok}，无铁路网格 ${empty}，已存在 ${cached}，未拿到 ${failed}，共 ${cells.length} 个网格 ===`)
  console.log('下一步：node scripts/build-lines.mjs（会把 patch 合并进 lines.json）')
  writeFileSync(
    `${PATCH_DIR}/gap-report.json`,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), degradedPairs: degraded.length, cells: cells.length, ok, empty, cached, failed },
      null,
      2,
    ),
  )
  if (failed) process.exitCode = 1
}

main()
