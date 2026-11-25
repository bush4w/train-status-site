// 位置推算算法（M1 前端版）
// 依据：车次时刻表（各站到发时刻）+ 当前时间 + 正晚点延迟
// 输出：推算出的经纬度与状态

function toMinutes(hm) {
  if (hm == null) return null
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}

/**
 * @param {object} train     车次对象 { no, color, delay, stops: [{code, arr, dep}] }
 * @param {object} stationsMap  { code: { name, lat, lng } }
 * @param {number} nowMinutes 当前模拟时间（当天分钟数，可含小数）
 */
export function computeTrainPosition(train, stationsMap, nowMinutes) {
  const delay = train.delay || 0
  const t = nowMinutes - delay // 晚点 delay 分钟 => 实际位置落后 delay 分钟

  const stops = train.stops
  const firstDep = toMinutes(stops[0].dep)
  const lastArr = toMinutes(stops[stops.length - 1].arr)

  // 未发车
  if (t <= firstDep) {
    const s = stationsMap[stops[0].code]
    return { lat: s.lat, lng: s.lng, status: 'pending', label: `待发车 · ${s.name}`, delay }
  }

  // 已终到
  if (t >= lastArr) {
    const s = stationsMap[stops[stops.length - 1].code]
    return { lat: s.lat, lng: s.lng, status: 'arrived', label: `已到达 · ${s.name}`, delay }
  }

  // 区间运行 / 中间站停靠
  for (let i = 0; i < stops.length - 1; i++) {
    const cur = stops[i]
    const next = stops[i + 1]
    const dep = toMinutes(cur.dep)
    const arr = toMinutes(next.arr)

    if (t >= dep && t < arr) {
      // 在 cur → next 区间运行，线性插值
      const s1 = stationsMap[cur.code]
      const s2 = stationsMap[next.code]
      const progress = (t - dep) / (arr - dep)
      return {
        lat: s1.lat + (s2.lat - s1.lat) * progress,
        lng: s1.lng + (s2.lng - s1.lng) * progress,
        status: 'running',
        label: `${s1.name} → ${s2.name}`,
        nextStation: s2.name,
        arrTime: next.arr,
        delay,
      }
    } else if (next.dep != null && t >= arr && t < toMinutes(next.dep)) {
      // 在 next 站停靠
      const s2 = stationsMap[next.code]
      return { lat: s2.lat, lng: s2.lng, status: 'stopped', label: `停靠 · ${s2.name}`, delay }
    }
  }

  const s = stationsMap[stops[stops.length - 1].code]
  return { lat: s.lat, lng: s.lng, status: 'arrived', label: `已到达 · ${s.name}`, delay }
}
