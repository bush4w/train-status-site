// OSM 车站 ↔ 12306 车站匹配（纯函数，可测试）
// OSM 名称形态：北京南站 / 北京南 / Beijing South Railway Station / name:zh=北京南站
// 匹配策略：中文名规范化（去尾缀"站"）→ 精确匹配 → 多候选/单候选都用城市级参考坐标做距离消歧

/** 规范化站名：去空白、去尾缀"站" */
export function normalizeStationName(name) {
  if (!name) return ''
  return String(name).trim().replace(/\s+/g, '').replace(/站$/, '')
}

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
 * @returns {{lat:number, lon:number, km:number}|null}
 */
export function matchStation(name, refLat, refLng, osmIndex, maxKm = 80) {
  const cands = osmIndex.get(normalizeStationName(name))
  if (!cands?.length) return null
  let best = null
  for (const c of cands) {
    const km = approxKm(refLat, refLng, c.lat, c.lon)
    if (!best || km < best.km) best = { lat: c.lat, lon: c.lon, km }
  }
  return best && best.km <= maxKm ? best : null
}
