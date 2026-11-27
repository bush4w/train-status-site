// 车站坐标同步：把 .cache/osm/osm-station-coords.json（build-lines 产物）
// 里的 OSM 实测坐标写回 public/data/stations.json。
//
// 用途：只修正车站坐标，不重跑全量时刻表抓取（后者要数小时）。
// 车站表本身（新增/删站）仍以抓取脚本为准。
//
// 用法：
//   node scripts/build-lines.mjs --stations-only   # 先更新坐标缓存
//   node scripts/apply-station-coords.mjs          # 再同步进 stations.json

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const COORDS = '.cache/osm/osm-station-coords.json'
const FILE = 'public/data/stations.json'

if (!existsSync(COORDS)) {
  console.error(`缺少 ${COORDS}，先运行 node scripts/build-lines.mjs --stations-only`)
  process.exit(1)
}
if (!existsSync(FILE)) {
  console.error(`缺少 ${FILE}`)
  process.exit(1)
}

const coords = JSON.parse(readFileSync(COORDS, 'utf8'))
const stations = JSON.parse(readFileSync(FILE, 'utf8'))
let updated = 0
let upgraded = 0
const out = stations.map((s) => {
  const c = coords[s.name]
  if (!c) return s
  if (s.lat === c.lat && s.lng === c.lng && s.precise) return s
  if (!s.precise) upgraded++
  updated++
  return { ...s, lat: c.lat, lng: c.lng, precise: true }
})

writeFileSync(FILE, JSON.stringify(out))
console.log(`✓ stations.json 坐标同步：更新 ${updated} 站（其中原为城市级近似 ${upgraded} 站），共 ${out.length} 站`)
