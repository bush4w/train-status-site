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
import { buildOsmStationIndex, matchStation, matchStationNearRail, approxKm } from './lib/station-match.mjs'
import { waysToSegments, chainSegments, splitAtReversals } from './lib/osm-lines.mjs'
import { simplify, roundPts } from './lib/simplify.mjs'
import { buildWayGraph, routeLeg } from './lib/corridor-route.mjs'
import { buildRailIndex, snapChord, nearestOnIndex } from '../src/lib/snap.js'

const OSM_DIR = '.cache/osm'
const TILES_DIR = '.cache/osm/tiles'
const PATCH_DIR = '.cache/osm/patch'
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

/** 同一 way/node 会同时命中相邻瓦片（跨 6° 边界），按 type:id 去重 */
function dedupeElements(elements) {
  const seen = new Set()
  const out = []
  for (const el of elements) {
    if ((el.type === 'way' || el.type === 'node') && el.id != null) {
      const k = `${el.type}:${el.id}`
      if (seen.has(k)) continue
      seen.add(k)
    }
    out.push(el)
  }
  return out
}

// 缺口补片（fetch-osm-gaps.mjs 产物）按需加载一次，供两层线路与走廊共用。
// 补片是按 railway=rail 全量抓的，会带进站线/货场/专用线：只保留可能的正线，
// 否则 lines.json 会膨胀、站场还会多出一堆支线噪声
const PATCH_DROP_USAGE = new Set(['industrial', 'military', 'test'])
let patchCache = null
function loadPatchElements() {
  if (patchCache) return patchCache
  const out = []
  let skipped = 0
  if (existsSync(PATCH_DIR)) {
    for (const f of readdirSync(PATCH_DIR).filter((x) => x.startsWith('patch_') && x.endsWith('.json'))) {
      try {
        const j = loadJson(`${PATCH_DIR}/${f}`)
        for (const el of j.elements ?? []) {
          if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue
          const tags = el.tags ?? {}
          if (tags.service || PATCH_DROP_USAGE.has(tags.usage)) {
            skipped++
            continue
          }
          out.push(el)
        }
      } catch {
        console.warn(`  ⚠ 跳过损坏补片: ${f}`)
      }
    }
  }
  patchCache = dedupeElements(out)
  if (patchCache.length) console.log(`→ 缺口补片：${patchCache.length} 个 way${skipped ? `（过滤站线/专用线 ${skipped}）` : ''}`)
  return patchCache
}

function buildLines(prefix, tol, label, skipIds = new Set(), extras = []) {
  if (!tileFiles(prefix).length && !extras.length) {
    console.warn(`⚠ 无 ${prefix}_s*.json 瓦片，跳过 ${label}`)
    return { lines: [], wayIds: new Set(), deduped: 0, split: 0, patched: 0 }
  }
  console.log(`→ ${label}：`)
  const elements = dedupeElements([...collectElements(prefix), ...extras])
  // 高铁 way 也带 usage=main，会同时命中两个层；hsr 优先，conv 跳过去重
  const wayIds = new Set()
  const kept = []
  let deduped = 0
  let patched = 0
  const extraIds = new Set(extras.map((el) => el.id))
  for (const el of elements) {
    if (el.type === 'way' && el.id != null) {
      if (skipIds.has(el.id)) {
        deduped++
        continue
      }
      wayIds.add(el.id)
      if (extraIds.has(el.id)) patched++
    }
    kept.push(el)
  }
  const segments = waysToSegments(kept)
  console.log(
    `  way 段数: ${segments.length}${deduped ? `（跨层去重 ${deduped}）` : ''}${patched ? `，其中补片 ${patched}` : ''}`,
  )
  const chained = chainSegments(segments)
  // 串联可能在车站/尽头把上下行接成「去—回」折线：拆掉原地折返，前端才不会沿原路返回
  const split = chained.flatMap((l) => splitAtReversals(l))
  const ptsBefore = split.reduce((s, l) => s + l.length, 0)
  const simplified = split.map((l) => roundPts(simplify(l, tol))).filter((l) => l.length >= 2)
  const ptsAfter = simplified.reduce((s, l) => s + l.length, 0)
  console.log(
    `  串联: ${chained.length} 条 → 拆折返 ${split.length} 条，${ptsBefore} 点 → 简化(${tol}°): ${simplified.length} 条, ${ptsAfter} 点 (${((ptsAfter / ptsBefore) * 100).toFixed(1)}%)`,
  )
  return { lines: simplified, wayIds, deduped, split: split.length - chained.length, patched }
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
const STATION_LINE_KM = 5 // 车站离铁路线位超过此距离，视为匹配到了同名村镇
const STATION_NEAR_LINE_KM = 3 // 线位兜底时，候选点到铁路的最大距离
const STATION_CITY_KM = 350 // 线位兜底时，候选点到城市参考坐标的上限（挡同名异地）

function nearestRailKm(railIndex, lat, lng) {
  const p = nearestOnIndex(railIndex, lat, lng, -1, STATION_LINE_KM * 2)
  return p ? Math.sqrt(p.d2) * 111.32 : Infinity
}

/**
 * 车站坐标匹配
 * 1) 常规：OSM 站名 + 城市级参考坐标消歧
 * 2) 兜底：候选站名里挑「贴着铁路线位」的
 * @param {{hsr:number[][][], conv:number[][][]}} railLines 已建好的线位（用于就近判定）
 */
function buildStationCoords(railLines) {
  if (!tileFiles('stations').length) {
    console.warn('⚠ 无 stations 瓦片，跳过车站匹配')
    return
  }
  console.log('→ 车站坐标匹配：')
  const osmElements = dedupeElements(collectElements('stations'))
  const osmIndex = buildOsmStationIndex(osmElements)
  console.log(`  OSM 车站索引: ${osmIndex.size} 个规范化名（元素 ${osmElements.length}）`)
  const railIndex = buildRailIndex(railLines ?? { hsr: [], conv: [] })

  // 站点表：优先用 public/data/stations.json（含 12306 车站表之外的补充站），
  // 没有时退回 12306 station_name.js。直接按站名匹配 OSM：
  // 城市级坐标只当参考，不因城市表缺项被跳过（geocodeStations 会丢站）
  let all
  if (existsSync(STATIONS_FILE)) {
    all = loadJson(STATIONS_FILE).map((s) => ({ code: s.code, name: s.name, city: s.city, lat: s.lat, lng: s.lng }))
  } else {
    const jinghuPrecise = Object.fromEntries(JINGHU_STATIONS.map((s) => [s.name, { lat: s.lat, lng: s.lng }]))
    all = geocodeStations(parseStationNameJs(readFileSync('.cache/railway/station_name.js', 'utf8')), jinghuPrecise).geocoded
  }

  const coords = {}
  let viaRail = 0
  const put = (name, p) => {
    coords[name] = { lat: +p.lat.toFixed(5), lng: +p.lon.toFixed(5) } // 5 位小数≈1m，省体积
  }
  for (const s of all) {
    const m = matchStation(s.name, s.lat, s.lng, osmIndex)
    if (m && nearestRailKm(railIndex, m.lat, m.lon) <= STATION_LINE_KM) {
      put(s.name, m)
      continue
    }
    const alt = matchStationNearRail(s.name, s.lat, s.lng, osmIndex, (lat, lng) => nearestRailKm(railIndex, lat, lng), {
      maxCityKm: STATION_CITY_KM,
      maxLineKm: STATION_NEAR_LINE_KM,
    })
    if (alt) {
      put(s.name, alt)
      viaRail++
      continue
    }
    if (m) put(s.name, m) // 线位数据缺失时保留常规匹配
  }
  const total = Object.keys(coords).length
  writeFileSync(`${OSM_DIR}/osm-station-coords.json`, JSON.stringify(coords))
  console.log(
    `  车站匹配 OSM 精确坐标: ${total}/${all.length} (${((total / all.length) * 100).toFixed(1)}%)，其中按线位就近修正 ${viaRail}`,
  )
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
  // 缺口补片也参与走廊线位（否则补出来的线在走廊图里仍是直线）
  for (const el of loadPatchElements()) {
    if (!el.geometry) continue
    if (el.geometry.some((p) => p.lat >= bbox.s && p.lat <= bbox.n && p.lon >= bbox.w && p.lon <= bbox.e)) {
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

  // 只更新车站坐标：用现有 lines.json 的线位做「就近铁路」判定，不重建线路
  if (args['stations-only']) {
    const old = existsSync('public/data/lines.json') ? loadJson('public/data/lines.json') : { hsr: [], conv: [] }
    buildStationCoords({ hsr: old.hsr ?? [], conv: old.conv ?? [] })
    console.log('✓ --stations-only：仅更新站点坐标，跳过线路构建')
    return
  }

  const patches = loadPatchElements()
  const patchHsr = patches.filter((el) => el.tags?.highspeed === 'yes')
  const patchConv = patches.filter((el) => el.tags?.highspeed !== 'yes')
  if (patches.length) console.log(`→ 缺口补片：高铁 ${patchHsr.length} 个 way / 普速 ${patchConv.length} 个 way`)
  const hsrRes = buildLines('hsr', HSR_TOL, '高铁线路', new Set(), patchHsr)
  const convRes = buildLines('conv', CONV_TOL, '普速干线', hsrRes.wayIds, patchConv)
  const hsr = hsrRes.lines
  const conv = convRes.lines
  // 车站坐标放在线路之后：只有拿到线位才能判断候选站名是否真的在铁路旁
  buildStationCoords({ hsr, conv })
  const corridors = buildCorridors({ hsr, conv })

  const lines = {
    attribution: '© OpenStreetMap contributors — ODbL',
    generatedAt: new Date().toISOString().slice(0, 10),
    tolerances: { hsr: HSR_TOL, conv: CONV_TOL, corridor: CORRIDOR_TOL },
    counts: { hsr: hsr.length, conv: conv.length },
    // 构建质量指标：跨层去重 way 数、拆掉的折返线数、补片 way 数（回归用）
    stats: {
      dedupedWays: convRes.deduped,
      splitLines: hsrRes.split + convRes.split,
      patchWays: hsrRes.patched + convRes.patched,
    },
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
