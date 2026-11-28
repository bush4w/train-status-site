// OSM 车站 ↔ 12306 车站匹配（纯函数，可测试）
// OSM 名称形态：北京南站 / 北京南 / Beijing South Railway Station / name:zh=北京南站
// 匹配策略：中文名规范化（去尾缀"站"）→ 精确匹配 → 多候选/单候选都用城市级参考坐标做距离消歧

import { normalizeStationName } from './station-name.mjs'

export { normalizeStationName }

export function isLatinName(name) {
  return /^[\x20-\x7E]+$/.test(String(name || ''))
}

/** 平面近似距离（km），80km 内精度足够 */
export function approxKm(lat1, lng1, lat2, lng2) {
  const kx = 111.32 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180)
  return Math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * 110.57)
}

/**
 * 从 Overpass 车站 elements 构建 规范化名 → 坐标候选 索引
 * node 用 lat/lon；way/relation 用 center
 */
export function buildOsmStationIndex(elements) {
  const idx = new Map()
  for (const el of elements ?? []) {
    const lat = el.lat ?? el.center?.lat
    const lon = el.lon ?? el.center?.lon
    if (lat == null || lon == null) continue
    const names = [el.tags?.name, el.tags?.['name:zh']]
    for (const n of names) {
      if (!n || isLatinName(n)) continue
      const norm = normalizeStationName(n)
      if (!norm) continue
      let list = idx.get(norm)
      if (!list) idx.set(norm, (list = []))
      // 同名同坐标去重（node 与 way center 重复）
      if (!list.some((p) => p.lat === lat && p.lon === lon)) list.push({ lat, lon })
    }
  }
  return idx
}

/**
 * 匹配单个 12306 车站
 * @param {string} name 12306 站名
 * @param {number} refLat 参考纬度（城市级坐标）
 * @param {number} refLng 参考经度
 * @param {Map} osmIndex buildOsmStationIndex 产物
 * @param {number} maxKm 消歧半径（默认 80km；城市级坐标误差 ±30km 内）
 * @param {number} maxKmUnique 唯一同名候选的放宽半径（默认 350km）
 *        县级市/远郊站常被地理编码到上级市（如玉门 → 酒泉 150km、柳园南 → 酒泉 300km），
 *        若 OSM 里该站名只有一个候选坐标，放宽半径即可救回，避免退回城市级坐标。
 * @returns {{lat:number, lon:number, km:number}|null}
 */
export function matchStation(name, refLat, refLng, osmIndex, maxKm = 80, maxKmUnique = 350) {
  const cands = osmIndex.get(normalizeStationName(name))
  if (!cands?.length) return null
  let best = null
  for (const c of cands) {
    const km = approxKm(refLat, refLng, c.lat, c.lon)
    if (!best || km < best.km) best = { lat: c.lat, lon: c.lon, km }
  }
  // 同一车站在 OSM 里常有 node + way center 两条记录（相差几米），按 ≤2km 视为同一候选
  const unique = cands.every((c) => approxKm(cands[0].lat, cands[0].lon, c.lat, c.lon) <= 2)
  const limit = unique ? maxKmUnique : maxKm
  return best && best.km <= limit ? best : null
}

/**
 * 线位就近匹配：候选站名里挑「贴着铁路线位」的那个。
 * 县级站/远郊站常被地理编码到上级市（兴山 → 宜昌市区约 90km），
 * 常规 80km 半径会拒掉正确坐标；这里改用「在线位旁」作为首要判据。
 * @param {string} name
 * @param {number} refLat 参考纬度（城市级或现有坐标）
 * @param {number} refLng
 * @param {Map} osmIndex buildOsmStationIndex 产物
 * @param {(lat:number,lng:number)=>number} railKmAt 点到最近铁路线位的距离（km）
 * @returns {{lat:number, lon:number, cityKm:number, lineKm:number}|null}
 */
export function matchStationNearRail(name, refLat, refLng, osmIndex, railKmAt, { maxCityKm = 350, maxLineKm = 3 } = {}) {
  const cands = osmIndex.get(normalizeStationName(name))
  if (!cands?.length) return null
  const scored = []
  for (const c of cands) {
    const cityKm = approxKm(refLat, refLng, c.lat, c.lon)
    if (cityKm > maxCityKm) continue // 同名异地（如「白果」相距 650km）
    const lineKm = railKmAt(c.lat, c.lon)
    if (!(lineKm <= maxLineKm)) continue
    scored.push({ lat: c.lat, lon: c.lon, cityKm, lineKm })
  }
  if (!scored.length) return null
  scored.sort((a, b) => a.cityKm - b.cityKm || a.lineKm - b.lineKm)
  return scored[0]
}
