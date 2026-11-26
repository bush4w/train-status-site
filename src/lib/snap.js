// 线位吸附（磁吸）：让列车沿真实铁路几何移动，而非站间直线
// 思路：站对弦线上采样 → 每个采样点投影到最近铁路线段（连续性约束优先同一条线）
//      → 得到贴着真实线位的路径；运行时按里程插值位置
// 纯函数（网格索引由 buildRailIndex 构建，可缓存），可测试

const CELL = 0.05 // 索引网格边长（度）
const KM_PER_DEG = 111.32

function pointSegDist2(px, py, ax, ay, bx, by, cosLat) {
  const dx = (bx - ax) * cosLat
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : (((px - ax) * cosLat) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const x = ax + (bx - ax) * t
  const y = ay + (by - ay) * t
  return { t, x, y, d2: ((px - x) * cosLat) ** 2 + (py - y) ** 2 }
}

/**
 * 构建线位网格索引
 * @param {{hsr:number[][][], conv:number[][][]}} railLines [[[lat,lng],...],...]
 */
export function buildRailIndex(railLines) {
  const segs = [] // {ax,ay,bx,by,line}
  const grid = new Map()
  const addLine = (pts, lineId) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const idx = segs.length
      segs.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], line: lineId })
      const minLat = Math.min(a[0], b[0])
      const maxLat = Math.max(a[0], b[0])
      const minLng = Math.min(a[1], b[1])
      const maxLng = Math.max(a[1], b[1])
      const la0 = Math.floor(minLat / CELL)
      const la1 = Math.floor(maxLat / CELL)
      const ln0 = Math.floor(minLng / CELL)
      const ln1 = Math.floor(maxLng / CELL)
      for (let la = la0; la <= la1; la++) {
        for (let ln = ln0; ln <= ln1; ln++) {
          const k = `${la}_${ln}`
          let arr = grid.get(k)
          if (!arr) grid.set(k, (arr = []))
          arr.push(idx)
        }
      }
    }
  }
  ;(railLines.hsr ?? []).forEach((pts, i) => addLine(pts, i))
  const convOffset = (railLines.hsr ?? []).length
  ;(railLines.conv ?? []).forEach((pts, i) => addLine(pts, convOffset + i))
  return { segs, grid }
}

/**
 * 投影到最近线段（3×3 邻格查询；preferLine 优先，距离不超过最优 1.5 倍时采纳）
 * @returns {{lat:number,lng:number,d2:number,line:number}|null}
 */
export function nearestOnIndex(index, lat, lng, preferLine = -1) {
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const la = Math.floor(lat / CELL)
  const ln = Math.floor(lng / CELL)
  let best = null
  let pref = null
  for (let da = -1; da <= 1; da++) {
    for (let db = -1; db <= 1; db++) {
      const arr = index.grid.get(`${la + da}_${ln + db}`)
      if (!arr) continue
      for (const si of arr) {
        const s = index.segs[si]
        const r = pointSegDist2(lat, lng, s.ax, s.ay, s.bx, s.by, cosLat)
        if (!best || r.d2 < best.d2) best = { lat: r.x, lng: r.y, d2: r.d2, line: s.line }
        if (s.line === preferLine && (!pref || r.d2 < pref.d2)) {
          pref = { lat: r.x, lng: r.y, d2: r.d2, line: s.line }
        }
      }
    }
  }
  if (pref && best && pref.d2 <= best.d2 * 2.25) return pref // 1.5× 距离内保持同线（防跳线锯齿）
  return best
}

/**
 * 站对弦线 → 吸附路径
 * @param {number[]} a [lat,lng]
 * @param {number[]} b [lat,lng]
 * @param {object} index buildRailIndex 产物
 * @param {number} samples 采样数
 * @param {number} maxKm 吸附距离上限（超出则返回 null，调用方用弦线兜底）
 * @returns {number[][]|null}
 */
export function snapChord(a, b, index, samples = 12, maxKm = 25) {
  const out = []
  let lastLine = -1
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const lat = a[0] + (b[0] - a[0]) * t
    const lng = a[1] + (b[1] - a[1]) * t
    const p = nearestOnIndex(index, lat, lng, lastLine)
    if (!p) return null
    if (Math.sqrt(p.d2) * KM_PER_DEG > maxKm) return null
    out.push([p.lat, p.lng])
    lastLine = p.line
  }
  return out
}

export function distKm(a, b) {
  const cosLat = Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180)
  return Math.hypot((b[1] - a[1]) * cosLat, b[0] - a[0]) * KM_PER_DEG
}

/**
 * 为整趟列车构建沿线路路径
 * @param {object} train 车次（stops 含 code/arr/dep）
 * @param {Record<string,object>} stationsMap 电报码 → 车站（含 lat/lng）
 * @param {object} index buildRailIndex 产物
 * @param {Map} pairCache 站对缓存（跨车次复用）
 * @returns {{pts:number[][], kmAt:number[], stopKm:number[], totalKm:number}|null}
 */
export function buildTrainPath(train, stationsMap, index, pairCache = new Map(), router = null) {
  const stops = train.stops.map((s) => stationsMap[s.code]).filter(Boolean)
  if (stops.length < 2) return null
  const pts = []
  const kmAt = []
  const stopKm = [0]
  let km = 0
  const pushPt = (p) => {
    if (pts.length) km += distKm(pts[pts.length - 1], p)
    pts.push(p)
    kmAt.push(km)
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const a = [stops[i].lat, stops[i].lng]
    const b = [stops[i + 1].lat, stops[i + 1].lng]
    const key = `${a[0].toFixed(3)},${a[1].toFixed(3)}|${b[0].toFixed(3)},${b[1].toFixed(3)}`
    let seg
    if (pairCache.has(key)) {
      seg = pairCache.get(key)
    } else {
      // 优先弦线采样（快）；绕行严重的线路采样会失败 → 路由图兜底（Dijkstra）
      seg = snapChord(a, b, index) || (router ? router(a, b) : null) || [a, b]
      pairCache.set(key, seg)
    }
    const start = pts.length === 0 ? 0 : 1
    for (let j = start; j < seg.length; j++) pushPt(seg[j])
    stopKm.push(km)
  }
  return { pts, kmAt, stopKm, totalKm: km }
}

/**
 * 按路径里程取坐标（二分查找 + 线性插值）
 * @returns {number[]} [lat,lng]
 */
export function posAtKm(path, km) {
  const { pts, kmAt } = path
  if (!pts.length) return null
  const target = Math.max(0, Math.min(km, kmAt[kmAt.length - 1]))
  let lo = 0
  let hi = kmAt.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (kmAt[mid] <= target) lo = mid
    else hi = mid
  }
  const segLen = kmAt[hi] - kmAt[lo]
  const t = segLen > 0 ? (target - kmAt[lo]) / segLen : 0
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t]
}

/**
 * 由列车运行状态换算路径里程
 * @param {object} path buildTrainPath 产物
 * @param {{status:string,k:number,progress:number}} st computeTrainStatus 产物
 */
export function kmFromStatus(path, st) {
  const k = Math.max(0, Math.min(st.k, path.stopKm.length - 1))
  if (st.status === 'running' && k + 1 < path.stopKm.length) {
    return path.stopKm[k] + (path.stopKm[k + 1] - path.stopKm[k]) * st.progress
  }
  return path.stopKm[k]
}
