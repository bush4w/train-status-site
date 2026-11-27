// M4 全国站点地理编码：精确坐标 / 补充站坐标 / 城市级坐标 + 按站名确定性微偏移
// 背景：12306 车站表无坐标；OSM 实测覆盖大部分站，少量小站/境外站需要补充表。
// 精度：OSM/人工整理为站址级；城市级为城市中心（±0.3°）+ 同城多站 ±0.05° 确定性散布
// 全部为纯函数，可测试、可重复

import { CITY_COORDS } from '../data/city-coords.mjs'
import { STATION_COORDS_EXTRA } from '../data/station-coords-extra.mjs'
import { normalizeStationName } from './station-name.mjs'

// FNV-1a 哈希 → [0,1)
export function hash01(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

// 确定性微偏移（±0.05°）：同名城市多站不重叠，且每次运行结果一致
export function jitter(name) {
  return {
    dLat: (hash01(name) - 0.5) * 0.1,
    dLng: (hash01(name + '#salt') - 0.5) * 0.1,
  }
}

/**
 * 城市坐标解析：城市键 → 站名键 → 规范化站名 → 最长前缀
 * 解决 12306 的 city 字段与坐标表键名不完全一致（如 石柱 vs 石柱县）
 */
export function resolveCityCoord(station) {
  const name = normalizeStationName(station.name)
  const keys = [station.city, station.name, name].filter(Boolean)
  for (const k of keys) {
    if (CITY_COORDS[k]) return { coord: CITY_COORDS[k], key: k, kind: 'city-exact' }
  }
  let best = null
  for (const k of Object.keys(CITY_COORDS)) {
    if (k.length < 2) continue
    if (name.startsWith(k) || String(station.city || '').startsWith(k)) {
      if (!best || k.length > best.length) best = k
    }
  }
  return best ? { coord: CITY_COORDS[best], key: best, kind: 'city-prefix' } : null
}

/**
 * 对车站列表做地理编码
 * @param {{name:string, code:string, city:string}[]} stations station-parser 输出
 * @param {Record<string,{lat:number,lng:number}>} preciseMap 站名→精确坐标（OSM / 京沪整理）
 * @returns {{geocoded: object[], missing: string[], byName: Record<string,object>, sources: object}}
 */
export function geocodeStations(stations, preciseMap = {}) {
  const geocoded = []
  const missing = []
  const sources = { precise: 0, extra: 0, city: 0, prefix: 0 }
  for (const s of stations) {
    if (preciseMap[s.name]) {
      const p = preciseMap[s.name]
      geocoded.push({ code: s.code, name: s.name, city: s.city, lat: p.lat, lng: p.lng, precise: true })
      sources.precise++
      continue
    }
    const norm = normalizeStationName(s.name)
    const extra = STATION_COORDS_EXTRA[norm]
    if (extra) {
      geocoded.push({ code: s.code, name: s.name, city: s.city, lat: extra[0], lng: extra[1], precise: false })
      sources.extra++
      continue
    }
    const city = resolveCityCoord(s)
    if (!city) {
      missing.push(`${s.name}(${s.city})`)
      continue
    }
    const j = jitter(s.name)
    geocoded.push({
      code: s.code,
      name: s.name,
      city: s.city,
      lat: +(city.coord[0] + j.dLat).toFixed(4),
      lng: +(city.coord[1] + j.dLng).toFixed(4),
      precise: false,
    })
    sources[city.kind === 'city-prefix' ? 'prefix' : 'city']++
  }
  return {
    geocoded,
    missing,
    byName: Object.fromEntries(geocoded.map((s) => [normalizeStationName(s.name), s])),
    sources,
  }
}
