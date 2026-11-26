// M4 全国站点地理编码：城市级坐标 + 按站名确定性微偏移
// 背景：12306 车站表无坐标，外部坐标源（GitHub/OSM/高德web）实测不可达（PRD §5）
// 精度：城市中心级（±0.3°）+ 同城多站 ±0.05° 确定性散布；京沪高铁 23 站为精确坐标覆盖
// 全部为纯函数，可测试、可重复

import { CITY_COORDS } from '../data/city-coords.mjs'

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
 * 对车站列表做地理编码
 * @param {{name:string, code:string, city:string}[]} stations station-parser 输出
 * @param {Record<string,{lat:number,lng:number}>} preciseMap 站名→精确坐标（如京沪 23 站）
 * @returns {{geocoded: object[], missing: string[], byName: Record<string,object>}}
 */
export function geocodeStations(stations, preciseMap = {}) {
  const geocoded = []
  const missing = []
  for (const s of stations) {
    if (preciseMap[s.name]) {
      const p = preciseMap[s.name]
      geocoded.push({ code: s.code, name: s.name, city: s.city, lat: p.lat, lng: p.lng, precise: true })
      continue
    }
    const c = CITY_COORDS[s.city]
    if (!c) {
      missing.push(`${s.name}(${s.city})`)
      continue
    }
    const j = jitter(s.name)
    geocoded.push({
      code: s.code,
      name: s.name,
      city: s.city,
      lat: +(c[0] + j.dLat).toFixed(4),
      lng: +(c[1] + j.dLng).toFixed(4),
      precise: false,
    })
  }
  return {
    geocoded,
    missing,
    byName: Object.fromEntries(geocoded.map((s) => [s.name, s])),
  }
}
