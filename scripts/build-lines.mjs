// OSM 铁路几何构建：.cache/osm/*.osm.json → public/data/lines.json + 精确站点坐标
//
// 用法：
//   node scripts/build-lines.mjs                     # 全量（高铁+普速+车站匹配+走廊线位）
//   node scripts/build-lines.mjs --hsr-tol=0.002 --conv-tol=0.004
//   node scripts/build-lines.mjs --stations-only     # 只更新站点坐标
//
// 流程：
//   1. 车站：OSM station/halt 节点 × 12306 车站表 → 名称规范化匹配 + 城市坐标消歧
//      → .cache/osm/osm-station-coords.json（fetch-railway-data 优先采用）
//   2. 线路：way 几何 → 端点串联 → Douglas-Peucker 简化 → lines.json 的 hsr/conv
//   3. 走廊：原始 way（不简化）建局部路网 → 站对最短路 → lines.json 的 corridors
//      （前端 400m 简化图会丢道岔节点，运行时长站对会退化成直线，故构建期先算好）
//
// 数据归属：© OpenStreetMap contributors — ODbL（前端与 meta 必须署名）

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { parseStationNameJs } from './lib/station-parser.mjs'
import { isLayerTile } from './lib/tile-files.mjs'
import { geocodeStations } from './lib/geocode.mjs'
import { JINGHU_STATIONS } from './data/jinghu-line.mjs'
import { CORRIDORS } from './data/corridors.mjs'
import { buildOsmStationIndex, matchStation } from './lib/station-match.mjs'
import { waysToSegments, chainSegments } from './lib/osm-lines.mjs'
import { simplify, roundPts } from './lib/simplify.mjs'
import { buildWayGraph, routeLeg } from './lib/corridor-route.mjs'
import { buildRailIndex, snapChord } from '../src/lib/snap.js'

const OSM_DIR = '.cache/osm'
const TILES_DIR = '.cache/osm/tiles'
const STATIONS_FILE = 'public/data/stations.json'
const CORRIDOR_TOL = 0.004 // 走廊折线存储容差（~400m）
const CORRIDOR_MARGIN = 1.5 // 走廊站点 bbox 外扩（度），覆盖长大绕行（如青藏线德令哈弯）
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)
const HSR_TOL = Number(args['hsr-tol'] ?? 0.002) // ~200m
const CONV_TOL = Number(args['conv-tol'] ?? 0.004) // ~400m

function loadJson(f) {
  return JSON.parse(readFileSync(f, 'utf8'))
}

function tileFiles(prefix) {
  if (!existsSync(TILES_DIR)) return []
  return readdirSync(TILES_DIR)
    .filter((f) => isLayerTile(f, prefix))
    .sort()
}

function tileOrigin(filename) {
  const m = filename.match(/_s([0-9.]+)_(-?[0-9.]+)_(-?[0-9.]+)\.json$/)
  if (!m) return null
  return { size: Number(m[1]), lat: Number(m[2]), lon: Number(m[3]) }
}

function collectElements(prefix, files = tileFiles(prefix), quiet = false) {
  const elements = []
  let bad = 0
  for (const f of files) {
    let j
    try {
      j = loadJson(`${TILES_DIR}/${f}`)
    } catch {
      bad++
      console.warn(`  ⚠ 跳过损坏瓦片（非 JSON，可能是错误页残留）: ${f}`)
      continue
    }
    if (!Array.isArray(j.elements)) {
      bad++
      console.warn(`  ⚠ 跳过无 elements 的瓦片: ${f}`)
      continue
    }
    elements.push(...j.elements)
  }
  if (files.length && !quiet) console.log(`  · ${files.length - bad}/${files.length} 个瓦片有效，共 ${elements.length} 元素`)
  return elements
}

function buildLines(prefix, tol, label) {
  if (!tileFiles(prefix).length) {
    console.warn(`⚠ 无 ${prefix}_s*.json 瓦片，跳过 ${label}`)
    return []
  }
  console.log(`→ ${label}：`)
  const elements = collectElements(prefix)
  const segments = waysToSegments(elements)
  console.log(`  way 段数: ${segments.length}`)
  const chained = chainSegments(segments)
  const ptsBefore = chained.reduce((s, l) => s + l.length, 0)
  const simplified = chained.map((l) => roundPts(simplify(l, tol))).filter((l) => l.length >= 2)
  const ptsAfter = simplified.reduce((s, l) => s + l.length, 0)
  console.log(
    `  串联: ${chained.length} 条线, ${ptsBefore} 点 → 简化(${tol}°): ${simplified.length} 条, ${ptsAfter} 点 (${((ptsAfter / ptsBefore) * 100).toFixed(1)}%)`,
  )
  return simplified
}

// ---------- 瓦片覆盖自检 ----------
// 瓦片抓取和构建常分两次跑：若构建时西侧瓦片还没下载完，lines.json 会缺掉整片线网。
// 覆盖度写进产物并在缺失时告警，避免"生成太早"再次静默发生。
function tileCoverage(layer) {
  const tiles = tileFiles(layer)
    .map(tileOrigin)
    .filter(Boolean)
  const missing = []
  for (let lat = 17.5; lat < 54.5; lat += 6) {
    for (let lon = 73; lon < 136; lon += 6) {
      const covered = tiles.some(
        (t) => lat + 0.001 >= t.lat && lat + 0.001 < t.lat + t.size && lon + 0.001 >= t.lon && lon + 0.001 < t.lon + t.size,
      )
      if (!covered) missing.push(`${lat},${lon}`)
    }
  }
  return { tiles: tiles.length, missing }
}
function reportCoverage(name, cov) {
  if (cov.missing.length) {
    console.warn(`⚠ ${name} 瓦片覆盖不全：缺 ${cov.missing.length} 个 6° 格（${cov.missing.slice(0, 6).join(' ')}…）`)
  }
}

// ---------- 车站精确坐标 ----------
function buildStationCoords() {
  if (!tileFiles('stations').length) {
    console.warn('⚠ 无 stations 瓦片，跳过车站匹配')
    return
  }
  console.log('→ 车站坐标匹配：')
  const osmElements = collectElements('stations')
  const osmIndex = buildOsmStationIndex(osmElements)
  console.log(`  OSM 车站索引: ${osmIndex.size} 个规范化名（元素 ${osmElements.length}）`)

  // 12306 车站表 + 城市级参考坐标
  const all = parseStationNameJs(readFileSync('.cache/railway/station_name.js', 'utf8'))
  const jinghuPrecise = Object.fromEntries(JINGHU_STATIONS.map((s) => [s.name, { lat: s.lat, lng: s.lng }]))
  const { geocoded } = geocodeStations(all, jinghuPrecise)

  const coords = {}
  let matched = 0
  for (const s of geocoded) {
    const m = matchStation(s.name, s.lat, s.lng, osmIndex)
    if (m) {
      coords[s.name] = { lat: +m.lat.toFixed(5), lng: +m.lon.toFixed(5) } // 5 位小数≈1m，省体积
      matched++
    }
  }
  writeFileSync(`${OSM_DIR}/osm-station-coords.json`, JSON.stringify(coords))
  console.log(`  12306 车站匹配 OSM 精确坐标: ${matched}/${geocoded.length} (${((matched / geocoded.length) * 100).toFixed(1)}%)`)
}

// ---------- 走廊线位（构建期预计算） ----------
function bboxOfStations(stations, margin) {
  const lats = stations.map((s) => s.lat)
  const lngs = stations.map((s) => s.lng)
  return {
    s: Math.min(...lats) - margin,
    n: Math.max(...lats) + margin,
    w: Math.min(...lngs) - margin,
    e: Math.max(...lngs) + margin,
  }
}

/** 读取与 bbox 相交的 hsr/conv 瓦片中的原始 way（按 way id 去重，保留完整几何） */
function readWaysInBBox(bbox) {
  const ways = new Map()
  for (const layer of ['hsr', 'conv']) {
    const files = tileFiles(layer).filter((f) => {
      const t = tileOrigin(f)
      return t && t.lat < bbox.n && t.lat + t.size > bbox.s && t.lon < bbox.e && t.lon + t.size > bbox.w
    })
    for (const el of collectElements(layer, files, true)) {
      if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue
      if (!ways.has(el.id)) ways.set(el.id, el)
    }
  }
  return [...ways.values()]
}

function buildCorridors({ hsr, conv }) {
  if (!existsSync(STATIONS_FILE)) {
    console.warn(`⚠ 缺 ${STATIONS_FILE}，跳过走廊线位预计算`)
    return null
  }
  const allStations = loadJson(STATIONS_FILE)
  const byName = Object.fromEntries(allStations.map((s) => [s.name, s]))
  const index = buildRailIndex({ hsr, conv })
  const out = {}
  console.log('→ 走廊线位：')
  for (const corridor of CORRIDORS) {
    const resolved = corridor.stations.map((n) => byName[n]).filter(Boolean)
    const stations = resolved.filter((s) => s.precise)
    if (stations.length !== resolved.length) {
      const skipped = resolved.filter((s) => !s.precise).map((s) => s.name)
      console.warn(`  ⚠ ${corridor.name}: 跳过无精确坐标站 ${skipped.join('、')}（城市级兜底会把线路拉成回折）`)
    }
    if (stations.length < 2) {
      console.warn(`  ⚠ ${corridor.name}: 站表不足（${corridor.stations.join('、')}），跳过`)
      continue
    }
    const bbox = bboxOfStations(stations, CORRIDOR_MARGIN)
    const ways = readWaysInBBox(bbox)
    const graph = buildWayGraph(ways)
    const pts = []
    const degraded = []
    let nSnap = 0
    let nRoute = 0
    for (let i = 0; i < stations.length - 1; i++) {
      const a = [stations[i].lat, stations[i].lng]
      const b = [stations[i + 1].lat, stations[i + 1].lng]
      // 与前端运行逻辑同源：先吸附，吸附失败再走局部路网
      const snapped = snapChord(a, b, index)
      let seg
      if (snapped && snapped.length >= 2) {
        seg = [[a[0], a[1]], ...snapped, [b[0], b[1]]]
        nSnap++
      } else {
        const leg = routeLeg(graph, a, b)
        if (leg) {
          seg = leg.pts
          nRoute++
        } else {
          seg = [a, b]
          degraded.push([stations[i].name, stations[i + 1].name])
        }
      }
      for (let k = pts.length ? 1 : 0; k < seg.length; k++) pts.push(seg[k])
    }
    const points = roundPts(simplify(pts, CORRIDOR_TOL))
    out[corridor.id] = { name: corridor.name, points, degraded }
    const tag = degraded.length ? `⚠ ${degraded.length} 段回退直线` : '✓'
    console.log(
      `  ${tag} ${corridor.name}: ${stations.length} 站 / ${stations.length - 1} 段（吸附 ${nSnap}，路由 ${nRoute}），简化后 ${points.length} 点`,
    )
    if (degraded.length) console.warn(`    ${degraded.map(([x, y]) => `${x}—${y}`).join('，')}`)
  }
  return out
}

// ---------- 主流程 ----------
function main() {
  if (!existsSync(OSM_DIR)) throw new Error('缺少 .cache/osm/，请先运行 node scripts/fetch-osm-geom.mjs')
  const hsrCov = tileCoverage('hsr')
  const convCov = tileCoverage('conv')
  reportCoverage('hsr', hsrCov)
  reportCoverage('conv', convCov)

  buildStationCoords()
  if (args['stations-only']) {
    console.log('✓ --stations-only：仅更新站点坐标，跳过线路构建')
    return
  }

  const hsr = buildLines('hsr', HSR_TOL, '高铁线路')
  const conv = buildLines('conv', CONV_TOL, '普速干线')
  const corridors = buildCorridors({ hsr, conv })

  const lines = {
    attribution: '© OpenStreetMap contributors — ODbL',
    generatedAt: new Date().toISOString().slice(0, 10),
    tolerances: { hsr: HSR_TOL, conv: CONV_TOL, corridor: CORRIDOR_TOL },
    counts: { hsr: hsr.length, conv: conv.length },
    tiles: {
      hsr: hsrCov,
      conv: convCov,
      stations: { tiles: tileFiles('stations').length },
    },
    hsr,
    conv,
  }
  if (corridors) lines.corridors = corridors
  // 线位几何体积大（数 MB），走 public/data/lines.json 运行时加载，不进主包
  mkdirSync('public/data', { recursive: true })
  writeFileSync('public/data/lines.json', JSON.stringify(lines))
  const mb = statSync('public/data/lines.json').size / 1048576
  const corridorPts = Object.values(corridors ?? {}).reduce((s, c) => s + c.points.length, 0)
  console.log(
    `✓ 已生成 public/data/lines.json（${mb.toFixed(2)}MB，高铁 ${hsr.length} 条 / 普速 ${conv.length} 条 / 走廊 ${Object.keys(corridors ?? {}).length} 条 ${corridorPts} 点）`,
  )
  if (mb > 4) console.warn('⚠ 文件超 4MB，建议加大容差（--hsr-tol/--conv-tol）')
}

main()
