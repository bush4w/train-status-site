// 运行图（时间-距离图）数据构建 — 纯函数，可测试
// 样式依据经典铁路运行图（参考 qETRC / 铁路运行图要素公开资料）：
//   横轴 = 时间（0–24h），纵轴 = 车站按公里标比例排列
//   每趟车一条折线：运行=斜线（斜率=速度），停站=水平线段
//   下行（沿走廊站序）↘，上行 ↗；交点 = 会让/越行

import { CORRIDORS } from '../../scripts/data/corridors.mjs'

export { CORRIDORS }

const toMin = (hm) => (hm == null ? null : Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)))

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
  const down = run(1)
  const up = run(-1)
  const best = down.length >= up.length ? { matched: down, direction: 'down' } : { matched: up, direction: 'up' }
  return best.matched.length >= need ? best : null
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
  const trains = assigned.map(({ train, matched, direction }) => {
    const pts = []
    for (const m of matched) {
      const st = train.stops[m.stopIdx]
      const y = corridor.stations[m.ci].km
      const arr = toMin(st.arr)
      const dep = toMin(st.dep)
      if (arr != null) pts.push({ x: arr, y, station: st.code, kind: 'arr' })
      if (dep != null && dep !== arr) pts.push({ x: dep, y, station: st.code, kind: 'dep' })
      else if (dep != null && arr == null) pts.push({ x: dep, y, station: st.code, kind: 'dep' })
    }
    pts.sort((a, b) => a.x - b.x)
    return { no: train.no, delay: train.delay, direction, pts }
  })
  return { stations: corridor.stations, maxKm: corridor.maxKm, name: corridor.name, id: corridor.id, trains }
}

/** 找到某车次所属的第一个走廊（详情面板入口用） */
export function corridorOfTrain(train, corridors) {
  for (const c of corridors) {
    if (matchCorridorTrain(train, c)) return c
  }
  return null
}
