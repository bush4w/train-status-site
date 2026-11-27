// 运行图（时间-距离图）数据构建 — 纯函数，可测试
// 样式依据经典铁路运行图（参考 qETRC / 铁路运行图要素公开资料）：
//   横轴 = 时间（0–24h），纵轴 = 车站按公里标比例排列
//   每趟车一条折线：运行=斜线（斜率=速度），停站=水平线段
//   下行（沿走廊站序）↘，上行 ↗；交点 = 会让/越行

import { CORRIDORS } from '../../scripts/data/corridors.mjs'

export { CORRIDORS }

const toMin = (hm) => (hm == null ? null : Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)))
/** 时刻 + 天数 → 相对数据日的绝对分钟（可 >1440） */
export function absMinutes(hm, day = 0) {
  return hm == null ? null : (day ?? 0) * 1440 + toMin(hm)
}
const toAbs = absMinutes

/** 球面距离（km） */
export function haversineKm(a, b) {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const la = (a.lat * Math.PI) / 180
  const lb = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * 走廊解析：站名 → 实际车站对象（过滤未收录站），累计公里标
 * @param {object} corridor {id, name, stations: [站名...]}
 * @param {Record<string,object>} byName 站名 → 车站
 */
export function resolveCorridor(corridor, byName) {
  const raw = corridor.stations.map((n) => byName[n]).filter(Boolean)
  let km = 0
  const stations = raw.map((s, i) => {
    if (i > 0) km += haversineKm(raw[i - 1], s)
    return { name: s.name, code: s.code, lat: s.lat, lng: s.lng, km: +km.toFixed(1) }
  })
  return { id: corridor.id, name: corridor.name, stations, maxKm: +km.toFixed(1) }
}

/**
 * 车次与走廊的有序匹配（下行=走廊索引递增，上行=递减）
 * 要求匹配站占「首末匹配站之间的全部停站」的比例够高：否则像 南京南—重庆北—成都东
 * 这种经由别的线路、只在走廊上蹭到三个站的车次会被误判成整条走廊。
 * @returns {{matched: {stopIdx:number, ci:number}[], direction:'down'|'up'}|null}
 */
export function matchCorridorTrain(train, corridor) {
  const idxByCode = new Map(corridor.stations.map((s, i) => [s.code, i]))
  const need = Math.min(3, corridor.stations.length)
  const run = (dir) => {
    const matched = []
    let last = dir > 0 ? -1 : Infinity
    train.stops.forEach((st, si) => {
      const ci = idxByCode.get(st.code)
      if (ci == null) return
      if (dir > 0 ? ci > last : ci < last) {
        matched.push({ stopIdx: si, ci })
        last = ci
      }
    })
    return matched
  }
  const density = (matched) => {
    if (matched.length < 2) return 0
    const span = matched[matched.length - 1].stopIdx - matched[0].stopIdx + 1
    return matched.length / span
  }
  const down = run(1)
  const up = run(-1)
  const best = down.length >= up.length ? { matched: down, direction: 'down' } : { matched: up, direction: 'up' }
  // 匹配站要在自己的停站序列里连成一段（允许少量中间站不在走廊上）
  return best.matched.length >= need && density(best.matched) >= 0.35 ? best : null
}

/** 走廊上的全部在图车次 */
export function assignCorridorTrains(trains, corridor) {
  const out = []
  for (const t of trains) {
    const m = matchCorridorTrain(t, corridor)
    if (m) out.push({ train: t, ...m })
  }
  return out
}

/**
 * 构建运行图序列
 * @returns {{stations, maxKm, trains: [{no, direction, color, pts:[{x:分钟,y:km}], labels}]}}
 */
export function buildDiagram(corridor, assigned) {
  const trains = assigned
    .map(({ train, matched, direction }) => {
      const pts = []
      for (const m of matched) {
        const st = train.stops[m.stopIdx]
        const y = corridor.stations[m.ci].km
        const arr = toAbs(st.arr, st.arrDay)
        const dep = toAbs(st.dep, st.depDay)
        // 运行图横轴固定 0–24h：跨零点车只画当日段，避免超出画布
        if (arr != null && arr >= 0 && arr <= 1440) pts.push({ x: arr, y, station: st.code, kind: 'arr' })
        if (dep != null && dep !== arr && dep >= 0 && dep <= 1440) pts.push({ x: dep, y, station: st.code, kind: 'dep' })
        else if (dep != null && arr == null && dep >= 0 && dep <= 1440) {
          pts.push({ x: dep, y, station: st.code, kind: 'dep' })
        }
      }
      pts.sort((a, b) => a.x - b.x)
      if (pts.length < 2) return null
      return { no: train.no, delay: train.delay, direction, pts }
    })
    .filter(Boolean)
  return { stations: corridor.stations, maxKm: corridor.maxKm, name: corridor.name, id: corridor.id, trains }
}

/** 找到某车次所属的第一个走廊（详情面板入口用） */
export function corridorOfTrain(train, corridors) {
  for (const c of corridors) {
    if (matchCorridorTrain(train, c)) return c
  }
  return null
}

/**
 * 全程运行图（车次视角）：一辆车会跨多条线路，按它自己的停站铺 y 轴，
 * 不依赖走廊定义是否齐全；能匹配到的走廊只用来给区段标线路名。
 * @param {object} train 车次（stops 含 code/arr/dep/arrDay/depDay）
 * @param {Record<string,object>} stationsMap 电报码 → 车站
 * @param {Array} corridors resolveCorridor 产物
 * @returns {{train:string, stations:Array, maxKm:number, timeStart:number, timeEnd:number,
 *            lineBands:Array, segments:Array}|null}
 */
export function buildTrainJourney(train, stationsMap, corridors = []) {
  const stations = []
  let km = 0
  train.stops.forEach((st, stopIdx) => {
    const s = stationsMap[st.code]
    if (!s) return
    const prev = stations[stations.length - 1]
    if (prev) km += haversineKm(prev, s)
    stations.push({
      stopIdx,
      code: st.code,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      km: +km.toFixed(1),
      arr: toAbs(st.arr, st.arrDay),
      dep: toAbs(st.dep, st.depDay),
    })
  })
  if (stations.length < 2) return null

  const times = stations.flatMap((s) => [s.arr, s.dep]).filter((v) => v != null)
  if (!times.length) return null
  // 时间窗按半小时取整；跨日车（次日到达）自动扩展到 >1440
  const timeStart = Math.floor(Math.min(...times) / 30) * 30
  const timeEnd = Math.ceil(Math.max(...times) / 30) * 30

  // 停站序号 → 站序（缺站时索引会错位，这里显式映射）
  const axisOfStop = new Map(stations.map((s, i) => [s.stopIdx, i]))

  // 匹配到的走廊 → 区段色带；同一段被多条走廊覆盖时保留匹配更长的那条
  const bands = []
  for (const c of corridors) {
    const m = matchCorridorTrain(train, c)
    if (!m) continue
    const a = axisOfStop.get(m.matched[0].stopIdx)
    const b = axisOfStop.get(m.matched[m.matched.length - 1].stopIdx)
    if (a == null || b == null || b - a < 1) continue
    bands.push({ id: c.id, name: c.name, fromStop: a, toStop: b, direction: m.direction })
  }
  bands.sort((x, y) => x.fromStop - y.fromStop || y.toStop - y.fromStop - (x.toStop - x.fromStop))
  const lineBands = []
  for (const b of bands) {
    const last = lineBands[lineBands.length - 1]
    if (last && b.fromStop < last.toStop) {
      if (b.toStop <= last.toStop) continue // 完全被上一条覆盖
      b.fromStop = last.toStop // 裁掉重叠，衔接处用上一条
    }
    if (b.toStop - b.fromStop >= 1) lineBands.push(b)
  }

  const segments = []
  for (let i = 0; i < stations.length - 1; i++) {
    const band = lineBands.find((b) => b.fromStop <= i && i < b.toStop)
    segments.push({ fromStop: i, toStop: i + 1, line: band?.name ?? null })
  }

  return {
    train: train.no,
    stations,
    maxKm: +km.toFixed(1),
    timeStart,
    timeEnd,
    lineBands,
    segments,
  }
}
