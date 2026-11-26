// OSM 铁路几何构建：.cache/osm/*.osm.json → src/data/lines.js + 精确站点坐标
//
// 用法：
//   node scripts/build-lines.mjs                     # 全量（高铁+普速+车站匹配）
//   node scripts/build-lines.mjs --hsr-tol=0.002 --conv-tol=0.004
//
// 流程：
//   1. 车站：OSM station/halt 节点 × 12306 车站表 → 名称规范化匹配 + 城市坐标消歧
//      → .cache/osm/osm-station-coords.json（fetch-railway-data 优先采用）
//   2. 线路：way 几何 → 端点串联 → Douglas-Peucker 简化 → src/data/lines.js
//
// 数据归属：© OpenStreetMap contributors — ODbL（前端与 meta 必须署名）

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { parseStationNameJs } from './lib/station-parser.mjs'
import { geocodeStations } from './lib/geocode.mjs'
import { JINGHU_STATIONS } from './data/jinghu-line.mjs'
import { buildOsmStationIndex, matchStation } from './lib/station-match.mjs'
import { waysToSegments, chainSegments } from './lib/osm-lines.mjs'
import { simplify, roundPts } from './lib/simplify.mjs'

const OSM_DIR = '.cache/osm'
const TILES_DIR = '.cache/osm/tiles'
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
    .filter((f) => f.startsWith(`${prefix}_s`) && f.endsWith('.json'))
    .sort()
}

function collectElements(prefix) {
  const files = tileFiles(prefix)
  const elements = []
  for (const f of files) {
    const j = loadJson(`${TILES_DIR}/${f}`)
    elements.push(...(j.elements ?? []))
  }
  console.log(`  · ${files.length} 个瓦片，共 ${elements.length} 元素`)
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
      coords[s.name] = { lat: +m.lat.toFixed(6), lng: +m.lon.toFixed(6) }
      matched++
    }
  }
  writeFileSync(`${OSM_DIR}/osm-station-coords.json`, JSON.stringify(coords))
  console.log(`  12306 车站匹配 OSM 精确坐标: ${matched}/${geocoded.length} (${((matched / geocoded.length) * 100).toFixed(1)}%)`)
}

// ---------- 主流程 ----------
function main() {
  if (!existsSync(OSM_DIR)) throw new Error('缺少 .cache/osm/，请先运行 node scripts/fetch-osm-geom.mjs')

  buildStationCoords()
  if (args['stations-only']) {
    console.log('✓ --stations-only：仅更新站点坐标，跳过线路构建')
    return
  }

  const hsr = buildLines('hsr_', HSR_TOL, '高铁线路')
  const conv = buildLines('conv_', CONV_TOL, '普速干线')

  const lines = {
    attribution: '© OpenStreetMap contributors — ODbL',
    generatedAt: new Date().toISOString().slice(0, 10),
    tolerances: { hsr: HSR_TOL, conv: CONV_TOL },
    counts: { hsr: hsr.length, conv: conv.length },
    hsr,
    conv,
  }
  const header = `// 由 scripts/build-lines.mjs 生成（${lines.generatedAt}）——请勿手改\n// 数据 ${lines.attribution}（https://www.openstreetmap.org/copyright）\n`
  const js = header + `export const railLines = ${JSON.stringify(lines)}\n`
  writeFileSync('src/data/lines.js', js)
  const mb = statSync('src/data/lines.js').size / 1048576
  console.log(`✓ 已生成 src/data/lines.js（${mb.toFixed(2)}MB，高铁 ${hsr.length} 条 / 普速 ${conv.length} 条）`)
  if (mb > 4) console.warn('⚠ 文件超 4MB，建议加大容差（--hsr-tol/--conv-tol）或改为 public/ 运行时加载')
}

main()
