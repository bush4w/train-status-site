// 线位吸附（磁吸）：让列车沿真实铁路几何移动，而非站间直线
// 思路：站对弦线上采样 → 每个采样点投影到最近铁路线段（连续性约束优先同一条线）
//      → 得到贴着真实线位的路径；运行时按里程插值位置
// 纯函数（网格索引由 buildRailIndex 构建，可缓存），可测试

const CELL = 0.05 // 索引网格边长（度）
const KM_PER_DEG = 111.32
const SNAP_KM = 25 // 吸附搜索半径上限（km）

// 本地平面投影：x = lng·cosLat（东西向），y = lat（南北向），返回最近点与距离
function projectOnSeg(lat, lng, s, cosLat) {
  const ax = s.ay * cosLat
  const ay = s.ax
  const bx = s.by * cosLat
  const by = s.bx
  const px = lng * cosLat
  const py = lat
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const x = ax + dx * t
  const y = ay + dy * t
  return { t, lat: y, lng: x / cosLat, d2: (px - x) ** 2 + (py - y) ** 2 }
}

/**
 * 构建线位网格索引
 * @param {{hsr:number[][][], conv:number[][][]}} railLines [[[lat,lng],...],...]
 */
export function buildRailIndex(railLines) {
  const segs = [] // {ax,ay,bx,by,line,si}
  const linePts = [] // 线序 → 顶点（供同线补点，避免弦线采样跳拐角）
  const grid = new Map()
  const addLine = (pts, lineId) => {
    linePts[lineId] = pts
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const idx = segs.length
      segs.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], line: lineId, si: i - 1 })
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
  return { segs, grid, linePts }
}

/**
 * 投影到最近线段：从中心格逐环外扩，直到已找到的最近点比更远环的下界还近
 * （站对弦线偏离真实线位十几公里是常态，固定 3×3 邻格会整段 miss）
 * preferLine 优先，距离不超过最优 1.5 倍时采纳
 * @returns {{lat:number,lng:number,d2:number,line:number,si:number}|null}
 */
export function nearestOnIndex(index, lat, lng, preferLine = -1, maxKm = SNAP_KM) {
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const la = Math.floor(lat / CELL)
  const ln = Math.floor(lng / CELL)
  const ringKm = CELL * KM_PER_DEG * Math.min(1, cosLat) // 每多查一环至少覆盖的距离
  const maxRing = Math.max(1, Math.ceil(maxKm / ringKm))
  let best = null
  let pref = null
  for (let r = 0; r <= maxRing; r++) {
    for (let da = -r; da <= r; da++) {
      for (let db = -r; db <= r; db++) {
        if (r > 0 && Math.abs(da) !== r && Math.abs(db) !== r) continue // 只查外环
        const arr = index.grid.get(`${la + da}_${ln + db}`)
        if (!arr) continue
        for (const si of arr) {
          const s = index.segs[si]
          const p = projectOnSeg(lat, lng, s, cosLat)
          if (!best || p.d2 < best.d2) best = { lat: p.lat, lng: p.lng, d2: p.d2, line: s.line, si: s.si }
          if (s.line === preferLine && (!pref || p.d2 < pref.d2)) {
            pref = { lat: p.lat, lng: p.lng, d2: p.d2, line: s.line, si: s.si }
          }
        }
      }
    }
    if (best && Math.sqrt(best.d2) * KM_PER_DEG <= r * ringKm) break
  }
  if (pref && best && pref.d2 <= best.d2 * 2.25) return pref // 1.5× 距离内保持同线（防跳线锯齿）
  return best
}

/**
 * 站对弦线 → 吸附路径
 * 采样数按弦线长度自适应（约每 6 km 一点），逐点贴线并保持同线；
 * 任一采样点离铁路超过 maxKm 则放弃，交调用方路由/弦线兜底
 * @param {number[]} a [lat,lng]
 * @param {number[]} b [lat,lng]
 * @param {object} index buildRailIndex 产物
 * @param {number} samples 采样段数（0 = 按长度自适应）
 * @param {number} maxKm 吸附距离上限
 * @returns {number[][]|null}
 */
export function snapChord(a, b, index, samples = 0, maxKm = SNAP_KM) {
  const chordKm = distKm(a, b)
  const n = samples > 0 ? Math.round(samples) : Math.min(240, Math.max(8, Math.ceil(chordKm / 6)))
  const jumpLimit = Math.max(2, (chordKm / n) * 1.5)
  const picked = []
  let lastLine = -1
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const lat = a[0] + (b[0] - a[0]) * t
    const lng = a[1] + (b[1] - a[1]) * t
    const p = nearestOnIndex(index, lat, lng, lastLine, maxKm)
    if (!p) return null
    if (Math.sqrt(p.d2) * KM_PER_DEG > maxKm) return null
    // 跨线跳得过远 = 采样间隔处切了大弯，交路由重算（同一条线由 densify 沿线补点）
    if (picked.length) {
      const last = picked[picked.length - 1]
      if (last.line !== p.line && distKm([last.lat, last.lng], [p.lat, p.lng]) > jumpLimit) return null
    }
    picked.push(p)
    lastLine = p.line
  }
  return densify(picked, index)
}

// 同一条线上相邻投影点之间补回线位顶点，避免采样间隔处“切拐角”；
// 补点路程明显长于两点直连时说明投影落在折返/相邻支线上，改回直线连接
function densify(picked, index) {
  const out = [[picked[0].lat, picked[0].lng]]
  for (let i = 1; i < picked.length; i++) {
    const prev = picked[i - 1]
    const cur = picked[i]
    if (prev.line >= 0 && prev.line === cur.line && prev.si !== cur.si) {
      const pts = index.linePts[prev.line] ?? []
      const step = cur.si > prev.si ? 1 : -1
      const budget = distKm([prev.lat, prev.lng], [cur.lat, cur.lng]) * 2 + 5
      const run = []
      let last = [prev.lat, prev.lng]
      let len = 0
      let ok = true
      for (let s = prev.si; s !== cur.si; s += step) {
        const p = pts[step > 0 ? s + 1 : s]
        if (!p) {
          ok = false
          break
        }
        len += distKm(last, p)
        if (len > budget) {
          ok = false
          break
        }
        run.push(p)
        last = p
      }
      if (ok) out.push(...run)
      else return null // 补点走不通（多为投影落到折返段），交调用方走路由
    }
    out.push([cur.lat, cur.lng])
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
      // 优先弦线采样（快）；吸附跑偏/失败 → 路由图兜底（Dijkstra）→ 弦线
      let snapped = snapChord(a, b, index)
      if (snapped) {
        let len = 0
        for (let j = 1; j < snapped.length; j++) len += distKm(snapped[j - 1], snapped[j])
        // 误吸附到相邻走廊会来回跳线，路径长度会明显超出弦线
        if (len > distKm(a, b) * 2.5 + 30) snapped = null
      }
      seg = snapped || (router ? router(a, b) : null) || [a, b]
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
