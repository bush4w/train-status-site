// 位置推算算法
// 依据：车次时刻表（各站到发时刻）+ 当前时间 + 正晚点延迟
//
// computeTrainStatus  → 状态 + 区间序号 k + 区间进度 progress（供"沿真实线位吸附"使用）
// computeTrainPosition → 兼容版：站间弦线插值出经纬度（无几何数据/测试用）

function toMinutes(hm) {
  if (hm == null) return null
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}

/**
 * @param {object} train     车次对象 { no, delay, stops: [{code, arr, dep}] }
 * @param {object} stationsMap  { code: { name, lat, lng } }
 * @param {number} nowMinutes 当前模拟时间（当天分钟数，可含小数）
 * @returns {{status:string, k:number, progress:number, label:string, delay:number,
 *            stopIndex:number, nextIndex?:number, nextStation?:string, arrTime?:string}}
 */
export function computeTrainStatus(train, stationsMap, nowMinutes) {
  const delay = train.delay || 0
  const t = nowMinutes - delay // 晚点 delay 分钟 => 实际位置落后 delay 分钟

  const stops = train.stops
  const firstDep = toMinutes(stops[0].dep)
  const lastArr = toMinutes(stops[stops.length - 1].arr)

  // 未发车（严格早于发车时刻；恰在发车时刻视为进入区间，进度 0）
  if (t < firstDep) {
    const s = stationsMap[stops[0].code]
    return { status: 'pending', k: 0, progress: 0, label: `待发车 · ${s.name}`, delay, stopIndex: 0 }
  }

  // 已终到
  if (t >= lastArr) {
    const s = stationsMap[stops[stops.length - 1].code]
    return {
      status: 'arrived',
      k: stops.length - 1,
      progress: 1,
      label: `已到达 · ${s.name}`,
      delay,
      stopIndex: stops.length - 1,
    }
  }

  // 区间运行 / 中间站停靠
  for (let i = 0; i < stops.length - 1; i++) {
    const cur = stops[i]
    const next = stops[i + 1]
    const dep = toMinutes(cur.dep)
    const arr = toMinutes(next.arr)

    if (t >= dep && t < arr) {
      const s1 = stationsMap[cur.code]
      const s2 = stationsMap[next.code]
      const span = arr - dep
      const progress = span > 0 ? (t - dep) / span : 0
      return {
        status: 'running',
        k: i,
        progress,
        label: `${s1.name} → ${s2.name}`,
        nextStation: s2.name,
        arrTime: next.arr,
        delay,
        stopIndex: i,
        nextIndex: i + 1,
      }
    } else if (next.dep != null && t >= arr && t < toMinutes(next.dep)) {
      const s2 = stationsMap[next.code]
      return { status: 'stopped', k: i + 1, progress: 0, label: `停靠 · ${s2.name}`, delay, stopIndex: i + 1 }
    }
  }

  const s = stationsMap[stops[stops.length - 1].code]
  return {
    status: 'arrived',
    k: stops.length - 1,
    progress: 1,
    label: `已到达 · ${s.name}`,
    delay,
    stopIndex: stops.length - 1,
  }
}

/**
 * 兼容版：站间弦线插值出经纬度
 * （有线位几何时由 TrainMap 用 computeTrainStatus + snap.posAtKm 替代）
 */
export function computeTrainPosition(train, stationsMap, nowMinutes) {
  const st = computeTrainStatus(train, stationsMap, nowMinutes)
  if (st.status === 'running') {
    const a = stationsMap[train.stops[st.k].code]
    const b = stationsMap[train.stops[st.k + 1].code]
    return {
      ...st,
      lat: a.lat + (b.lat - a.lat) * st.progress,
      lng: a.lng + (b.lng - a.lng) * st.progress,
    }
  }
  const s = stationsMap[train.stops[st.k].code]
  return { ...st, lat: s.lat, lng: s.lng }
}
