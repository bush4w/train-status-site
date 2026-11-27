// 区县边界数据管道（M6a / F11）
//
// 数据源：阿里云 DataV.GeoAtlas 行政区划边界（公开、免 key，GCJ-02）
//   国家 → 省 → 市 → 区县 逐级请求 {adcode}_full.json，本地缓存可续跑。
// 产出：public/data/counties.json
//   { generatedAt, source, coordSystem, cities:[{code,name,province,center,polys,stations}],
//     counties:[{code,name,city,cityCode,province,center,polys,stations}] }
//
// 车站归属：用「点在多边形内」把 public/data/stations.json 的车站坐标落到区县，
// 供 F13 铁路可达查询直接使用（12306 无区县字段，这一步自动建立映射）。
//
// 用法：
//   node scripts/build-counties.mjs                     # 全国（缓存续跑，约 370 请求）
//   node scripts/build-counties.mjs --provinces=320000  # 只做一个省（烟测）
//   node scripts/build-counties.mjs --refresh           # 忽略缓存重抓
//   node scripts/build-counties.mjs --out=.cache/county/sample.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { simplify } from './lib/simplify.mjs'
import { wgs84ToGcj02 } from '../src/lib/coord.js'

const CACHE_DIR = '.cache/county'
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound'
const STATIONS_FILE = 'public/data/stations.json'
const SIMP_COUNTY = 0.006 // ~600m：点击命中与体积的平衡
const SIMP_CITY = 0.012
const MIN_RING_PTS = 4
const MIN_RING_AREA = 1e-5 // 度²，丢掉碎岛
const DELAY_MIN = 120
const DELAY_JITTER = 180

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)
const OUT = args.out ?? 'public/data/counties.json'
const REFRESH = Boolean(args.refresh)
const ONLY = args.provinces ? String(args.provinces).split(',').map(Number) : null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pad = (n) => String(n).padStart(2, '0')
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function getBound(adcode) {
  const file = `${CACHE_DIR}/${adcode}_full.json`
  if (!REFRESH && existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      /* 损坏缓存：重抓 */
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/${adcode}_full.json`, {
        headers: { 'User-Agent': 'train-status-site/0.1 (personal demo; low-frequency)' },
        signal: AbortSignal.timeout(30000),
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      writeFileSync(file, JSON.stringify(j))
      await sleep(DELAY_MIN + Math.random() * DELAY_JITTER)
      return j
    } catch (e) {
      console.warn(`  ⚠ ${adcode} 第 ${attempt + 1} 次失败：${e.message}`)
      await sleep(800 * (attempt + 1))
    }
  }
  return null
}

// DataV 几何：MultiPolygon [ring][pt][lng,lat] → 外环 [[lat,lng],...] 列表（保留洞以外的所有外环）
function outerRings(geometry) {
  if (!geometry) return []
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  return polys.map((rings) => (rings[0] ?? []).map(([lng, lat]) => [lat, lng])).filter((r) => r.length >= MIN_RING_PTS)
}

function ringArea(ring) {
  let s = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][1] + ring[i][1]) * (ring[j][0] - ring[i][0])
  }
  return Math.abs(s / 2)
}

function round3(pts) {
  return pts.map(([lat, lng]) => [Math.round(lat * 1e3) / 1e3, Math.round(lng * 1e3) / 1e3])
}

function packPolys(rings, tol) {
  const out = []
  for (const r of rings) {
    const simp = round3(simplify(r, tol))
    if (simp.length < MIN_RING_PTS) continue
    if (ringArea(r) < MIN_RING_AREA) continue
    out.push(simp)
  }
  return out
}

// ---------- 点面归属 ----------
function bboxOf(polys) {
  let minLat = 90
  let maxLat = -90
  let minLng = 180
  let maxLng = -180
  for (const ring of polys) {
    for (const [lat, lng] of ring) {
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
    }
  }
  return [minLat, minLng, maxLat, maxLng]
}

function pointInRing(lat, lng, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i]
    const [yj, xj] = ring[j]
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function pointInPolys(lat, lng, polys) {
  for (const ring of polys) if (pointInRing(lat, lng, ring)) return true
  return false
}

// 网格索引：0.5° 格 → 候选区县下标（写入时用原始环，保证边界准确）
function gridIndex(items) {
  const grid = new Map()
  const key = (i, j) => `${i}:${j}`
  items.forEach((item, idx) => {
    const [minLat, minLng, maxLat, maxLng] = item.bbox
    for (let i = Math.floor(minLat / 0.5); i <= Math.floor(maxLat / 0.5); i++) {
      for (let j = Math.floor(minLng / 0.5); j <= Math.floor(maxLng / 0.5); j++) {
        const k = key(i, j)
        if (!grid.has(k)) grid.set(k, [])
        grid.get(k).push(idx)
      }
    }
  })
  return (lat, lng) => grid.get(key(Math.floor(lat / 0.5), Math.floor(lng / 0.5))) ?? []
}

// ---------- 主流程 ----------
function featureProps(f) {
  const p = f.properties ?? {}
  const center = p.centroid ?? p.center
  return {
    code: p.adcode,
    name: p.name,
    level: p.level,
    center: Array.isArray(center) ? [center[1], center[0]] : null,
    rings: outerRings(f.geometry),
  }
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true })
  const stations = JSON.parse(readFileSync(STATIONS_FILE, 'utf8'))

  const country = await getBound(100000)
  if (!country) throw new Error('国家边界获取失败')
  let provinces = country.features.map(featureProps).filter((p) => p.code && p.name)
  if (ONLY) provinces = provinces.filter((p) => ONLY.includes(p.code))
  console.log(`→ 省级 ${provinces.length} 个`)

  const cities = []
  const counties = []
  const countyRaw = [] // 与 counties 同下标的原始环（仅用于车站归属，不写入产物）
  let reqCount = 0

  for (const prov of provinces) {
    const pj = await getBound(prov.code)
    reqCount++
    let subs = (pj?.features ?? []).map(featureProps).filter((f) => f.code && f.rings.length)
    // 直辖市 / 无下级：省级本身当作城市 + 区县来源
    if (!subs.length) subs = [prov]

    for (const city of subs) {
      let units = []
      if (city.level === 'district' || city.level === 'province') {
        // 省直辖县级单位：本身即区县级
        const isCity = city.level === 'province'
        if (isCity) {
          const cj = await getBound(city.code)
          reqCount++
          units = (cj?.features ?? []).map(featureProps).filter((f) => f.code && f.rings.length)
        } else {
          units = [city]
        }
      } else {
        const cj = await getBound(city.code)
        reqCount++
        units = (cj?.features ?? []).map(featureProps).filter((f) => f.code && f.rings.length)
        if (!units.length) units = [city] // 无下级（如省直辖）时城市自身作为最小单元
      }

      // 城市中心：优先用城市自身中心，缺失时取区县中心均值
      const center =
        city.center ??
        (units.length
          ? [
              units.reduce((s, u) => s + (u.center?.[0] ?? 0), 0) / units.length,
              units.reduce((s, u) => s + (u.center?.[1] ?? 0), 0) / units.length,
            ]
          : null)

      const cityItem = {
        code: city.code,
        name: city.name,
        province: prov.name,
        center,
        polys: packPolys(city.rings, SIMP_CITY),
        stations: [],
      }
      cities.push(cityItem)

      for (const u of units) {
        // 城市自身被当作单元时避免重复
        if (u.code === city.code && units.length > 1) continue
        countyRaw.push(u.rings)
        counties.push({
          code: u.code,
          name: u.name,
          cityCode: city.code,
          city: city.name,
          province: prov.name,
          center: u.center ?? center,
          polys: packPolys(u.rings, SIMP_COUNTY),
          stations: [],
        })
      }
    }
    console.log(`  ✓ ${prov.name}：省下单元 ${subs.length}，累计区县 ${counties.length}`)
  }

  // ---------- 车站归属（GCJ 优先，命中率过低时回退 WGS 再测） ----------
  const assign = (toGcj) => {
    // 用原始（未简化）环建索引，避免简化把边界内缩导致误判
    const items = counties.map((c, idx) => {
      const raw = countyRaw[idx] ?? []
      return { idx, bbox: raw.length ? bboxOf(raw) : [0, 0, 0, 0] }
    })
    const lookup = gridIndex(items)
    const hits = new Map() // countyIdx → [站码]，先不写入 counties，便于两套坐标系比较
    let hit = 0
    const miss = []
    for (const s of stations) {
      const p = toGcj ? wgs84ToGcj02(s.lat, s.lng) : { lat: s.lat, lng: s.lng }
      let found = -1
      for (const idx of lookup(p.lat, p.lng)) {
        const raw = countyRaw[idx]
        if (raw && pointInPolys(p.lat, p.lng, raw)) {
          found = idx
          break
        }
      }
      if (found >= 0) {
        if (!hits.has(found)) hits.set(found, [])
        hits.get(found).push(s.code)
        hit++
      } else {
        miss.push(s.name)
      }
    }
    return { hit, miss, hits }
  }

  // 先按 GCJ 归属；整体命中率 <90% 说明坐标系判断可能相反，再按 WGS 比一次，取命中多的
  let best = assign(true)
  let coordSystem = 'gcj02'
  if (best.hit / stations.length < 0.9) {
    const wgs = assign(false)
    if (wgs.hit > best.hit) {
      best = wgs
      coordSystem = 'wgs84'
    }
  }
  for (const c of counties) c.stations = []
  for (const [idx, codes] of best.hits) counties[idx].stations = codes
  const assigned = best.hit
  const misses = best.miss

  // 城市级车站汇总
  const byCity = new Map()
  for (const c of counties) {
    const arr = byCity.get(c.cityCode) ?? []
    arr.push(...c.stations)
    byCity.set(c.cityCode, arr)
  }
  for (const c of cities) c.stations = byCity.get(c.code) ?? []

  for (const c of counties) delete c.__rawRings

  const totalPts = [...cities, ...counties].reduce(
    (n, c) => n + c.polys.reduce((m, r) => m + r.length, 0),
    0,
  )
  const out = {
    generatedAt: today(),
    source: '阿里云 DataV.GeoAtlas 行政区划边界（公开数据，仅示意，不具法律效力）',
    coordSystem,
    stationsAssigned: assigned,
    stationsTotal: stations.length,
    stats: { cities: cities.length, counties: counties.length, points: totalPts, requests: reqCount },
    cities,
    counties,
  }
  writeFileSync(OUT, JSON.stringify(out))
  const mb = (JSON.stringify(out).length / 1048576).toFixed(2)
  console.log(
    `✓ 已生成 ${OUT}（${mb}MB，市 ${cities.length} / 区县 ${counties.length} / 点 ${totalPts}）`,
  )
  console.log(
    `✓ 车站归属：${assigned}/${stations.length}（${((assigned / stations.length) * 100).toFixed(1)}%，${coordSystem}）`,
  )
  if (misses.length) console.log(`  · 未归属 ${misses.length} 站，例：${misses.slice(0, 8).join('、')}`)
}

main().catch((e) => {
  console.error('✗ 失败:', e.message)
  process.exit(1)
})
