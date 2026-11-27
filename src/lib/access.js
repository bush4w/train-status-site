// 铁路可达查询（M6a / F13）
// 纯函数：在已有全国时刻表里找「起点城市/车站 → 目标区县车站」的直达车次。
// 时间口径与前端一致：相对数据日的绝对分钟（跨零点用 arrDay/depDay 展开）。

export function absMin(hm, day = 0) {
  if (hm == null) return null
  return (day ?? 0) * 1440 + Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
}

const RAD = Math.PI / 180

export function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD
  const dLng = (b.lng - a.lng) * RAD
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** 距给定坐标最近的 n 个车站 */
export function nearestStations(stations, lat, lng, n = 8) {
  return stations
    .map((s) => ({ ...s, km: distanceKm({ lat, lng }, s) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, n)
}

/**
 * 枢纽站：停靠车次 ≥ minStops 的车站（用于「起点」下拉，避免几百个乘降所）
 * @param {Array} trains 车次数组
 * @param {number} minStops
 * @returns {Map<string, number>} code → 停靠车次数
 */
export function countStops(trains, minStops = 12) {
  const counts = new Map()
  for (const t of trains) {
    for (const s of t.stops) counts.set(s.code, (counts.get(s.code) ?? 0) + 1)
  }
  const out = new Map()
  for (const [code, n] of counts) {
    if (n >= minStops) out.set(code, n)
  }
  return out
}

/**
 * 直达车次
 * @param {Array} trains 车次（stops 含 code/arr/dep/arrDay/depDay）
 * @param {string[]} fromCodes 起点站码集合（同城多站）
 * @param {string[]} toCodes 目标站码集合（区县内多站）
 * @param {number} nowAbs 当前绝对分钟
 * @param {{limit?:number, horizonMin?:number}} [opts]
 * @returns {Array<{no,delay,delayKnown,dep,arr,durationMin,depDay,arrDay,from,to}>}
 */
export function findDirectTrains(trains, fromCodes, toCodes, nowAbs, opts = {}) {
  const { limit = 40, horizonMin = 36 * 60, graceMin = 5 } = opts
  const from = new Set(fromCodes ?? [])
  const to = new Set(toCodes ?? [])
  if (!from.size || !to.size) return []
  const earliest = nowAbs - graceMin
  const latestDep = nowAbs + horizonMin
  const out = []

  for (const t of trains) {
    let best = null
    for (let i = 0; i < t.stops.length; i++) {
      const a = t.stops[i]
      if (!from.has(a.code)) continue
      const dep = absMin(a.dep ?? a.arr, a.depDay ?? a.arrDay)
      if (dep == null) continue
      for (let j = i + 1; j < t.stops.length; j++) {
        const b = t.stops[j]
        if (!to.has(b.code)) continue
        const arr = absMin(b.arr ?? b.dep, b.arrDay ?? b.depDay)
        if (arr == null || arr <= dep) break
        // 同一城市多个起点站时，取「最后一个能赶上目标方向」的上车站
        if (!best || dep > best.dep) {
          best = { dep, arr, from: a.code, to: b.code }
        }
        break
      }
    }
    if (!best) continue
    if (best.dep < earliest || best.dep > latestDep) continue
    out.push({
      no: t.no,
      delay: t.delay ?? 0,
      delayKnown: t.delayKnown !== false,
      dep: best.dep,
      arr: best.arr,
      durationMin: best.arr - best.dep,
      depDay: Math.floor(best.dep / 1440),
      arrDay: Math.floor(best.arr / 1440),
      from: best.from,
      to: best.to,
    })
  }

  out.sort((x, y) => x.dep - y.dep || x.arr - y.arr || (x.no < y.no ? -1 : 1))
  return out.slice(0, limit)
}

/** 把绝对分钟格式化为「次日 08:05」样式 */
export function fmtAbsMin(min) {
  if (min == null) return '—'
  const day = Math.floor(min / 1440)
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return day > 0 ? `次日 ${hm}` : hm
}

/** 距离给定点最近的枢纽站（默认取 1 个），用于「起点」默认值 */
export function nearestHubStation(stations, trains, point, n = 1, minStops = 12) {
  const hubs = countStops(trains, minStops)
  const list = []
  for (const code of hubs.keys()) {
    const st = stations.find((s) => s.code === code)
    if (st) list.push(st)
  }
  return nearestStations(list, point.lat, point.lng, n)
}
