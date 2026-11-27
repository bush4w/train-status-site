// OSM 铁路 way → 连续折线（纯函数，可测试）
// Overpass `out geom` 的 way 元素自带 geometry:[{lat,lon},...]；
// 相邻 way 端点常差几米到几十米（并非逐位相等），按容差就近串联，
// 得到连续长线，供前端绘制与路由图使用。

const CHAIN_TOL = 0.001 // 端点串联容差（度，约 110m）
const DIR_WIN = 0.0015 // 方向判定窗口（度，约 170m）
const DIR_WIN_PTS = 12 // 方向判定最多回看/前看点数
const DIR_MIN = 0.0003 // 窗口太短（点很密/线很短）时方向不可靠，放弃判定
const DIR_TURN = -0.85 // 接线时切向点积下限（≈160° 以上视为 U 形折返，不接）

const KM_PER_DEG = 111.32
const segKm = (a, b) => Math.hypot((b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180), b[0] - a[0]) * KM_PER_DEG

/**
 * 某点沿 step 方向（+1 向前 / −1 向后）的切向单位向量与窗口长度
 * 窗口按累计度数取到 ~DIR_WIN，避免长直线段只取到相邻两点噪声
 */
function dirWindow(line, i, step) {
  let acc = 0
  let j = i
  while (j + step >= 0 && j + step < line.length && Math.abs(j - i) < DIR_WIN_PTS && acc < DIR_WIN) {
    const a = line[j]
    const b = line[j + step]
    acc += Math.hypot(b[0] - a[0], (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180))
    j += step
  }
  if (j === i) return null
  const a = line[i]
  const b = line[j]
  const dx = (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180)
  const dy = b[0] - a[0]
  const n = Math.hypot(dx, dy)
  if (!n) return null
  return { x: dx / n, y: dy / n, len: acc }
}

/** 从接点出发的切向（arr[0] 为接点，指向段内） */
function outgoingDir(arr) {
  if (arr.length < 2) return null
  const d = dirWindow(arr, 0, 1)
  return d && d.len >= DIR_MIN ? d : null
}

/** 到达 line[i] 的行进方向（dirWindow 取的是“指向来路”，取反即行进方向） */
function incomingDir(line, i) {
  const d = dirWindow(line, i, -1)
  if (!d || d.len < DIR_MIN) return null
  return { x: -d.x, y: -d.y, len: d.len }
}

/**
 * 拆折返：串联后的长线若在车站/尽头把上行、下行接成一条「去—回」折线，
 * 会在 i 处出现 180° 原地折返：指向来路的向量与离开方向**同向**（≈ +1；直线时 ≈ −1）。
 * 在该点拆成两条线，前端不会沿原路返回。
 * @param {number[][]} line
 * @param {{minSpurKm?:number}} opts minSpurKm：被拆掉的一段至少多长（太短的锯齿不拆）
 * @returns {number[][][]}
 */
export function splitAtReversals(line, { minSpurKm = 0.5 } = {}) {
  if (!Array.isArray(line) || !line.length) return []
  if (line.length < 3) return [line]
  const parts = []
  let start = 0
  let len = 0
  for (let i = 1; i < line.length; i++) {
    len += segKm(line[i - 1], line[i])
    if (i < 2 || i >= line.length - 1) continue
    const back = dirWindow(line, i, -1)
    const fwd = dirWindow(line, i, 1)
    if (!back || !fwd || back.len < DIR_MIN || fwd.len < DIR_MIN) continue
    // 折返：来路方向与去向同向（都指向“去的那一边”），说明是在原地掉头
    if (back.x * fwd.x + back.y * fwd.y > 0.7 && len >= minSpurKm) {
      if (i - start >= 2) parts.push(line.slice(start, i))
      start = i
      len = 0
    }
  }
  if (line.length - start >= 2) parts.push(line.slice(start))
  return parts.length ? parts : [line]
}

/** 从 Overpass elements 提取 way 几何段 */
export function waysToSegments(elements) {
  const segs = []
  for (const el of elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue
    segs.push(el.geometry.map((p) => [p.lat, p.lon]))
  }
  return segs
}

/**
 * 端点串联：端点按容差就近匹配（空间桶索引），得到尽量长的连续折线
 * @param {number[][][]} segments [[[lat,lng],...],...]
 * @param {{tol?:number}} opts tol：端点匹配容差（度）
 * @returns {number[][][]} 串联后的折线集合
 */
export function chainSegments(segments, { tol = CHAIN_TOL } = {}) {
  const n = segments.length
  const used = new Uint8Array(n)
  if (!n) return []
  const cell = Math.max(tol, 1e-5) * 2 // 桶边长略大于容差，查 3×3 桶即覆盖 ±tol
  const buckets = new Map()
  const ends = []
  for (let i = 0; i < n; i++) {
    const s = segments[i]
    ends.push({ seg: i, end: 0, lat: s[0][0], lng: s[0][1] })
    ends.push({ seg: i, end: 1, lat: s[s.length - 1][0], lng: s[s.length - 1][1] })
  }
  for (const e of ends) {
    const k = `${Math.floor(e.lat / cell)}_${Math.floor(e.lng / cell)}`
    let arr = buckets.get(k)
    if (!arr) buckets.set(k, (arr = []))
    arr.push(e)
  }

  // 尾部/头部就近找未使用的另一段；dir 为期望的“离开接点方向”，
  // 候选段按接线方向算切向，与 dir 接近相反说明是把上下行接成 U 形，跳过
  const findNext = (lat, lng, excludeSeg, dir = null) => {
    const cosLat = Math.cos((lat * Math.PI) / 180)
    const la = Math.floor(lat / cell)
    const ln = Math.floor(lng / cell)
    let best = null
    let bestD = tol * tol
    for (let da = -1; da <= 1; da++) {
      for (let db = -1; db <= 1; db++) {
        const arr = buckets.get(`${la + da}_${ln + db}`)
        if (!arr) continue
        for (const e of arr) {
          if (e.seg === excludeSeg || used[e.seg]) continue
          const dLat = e.lat - lat
          const dLng = (e.lng - lng) * cosLat
          const d2 = dLat * dLat + dLng * dLng
          if (d2 > bestD) continue // 远了，或已有更近的候选
          if (dir) {
            const seg = segments[e.seg]
            const out = outgoingDir(e.end === 0 ? seg : [...seg].reverse())
            if (out && out.x * dir.x + out.y * dir.y < DIR_TURN) continue
          }
          best = e
          bestD = d2
        }
      }
    }
    return best
  }

  const walk = (startSeg) => {
    used[startSeg] = 1
    const pts = [...segments[startSeg]]
    // 向后延伸：尾部就近接下一段（共享端点附近去重）
    for (;;) {
      const tail = pts[pts.length - 1]
      const next = findNext(tail[0], tail[1], -1, incomingDir(pts, pts.length - 1))
      if (!next) break
      used[next.seg] = 1
      const seg = segments[next.seg]
      const arr = next.end === 0 ? seg : [...seg].reverse() // arr[0] 贴近 tail
      for (let i = 1; i < arr.length; i++) pts.push(arr[i])
    }
    // 向前延伸：头部就近接上一段（方向与现有头段相反，才算继续向前）
    for (;;) {
      const head = pts[0]
      const back = dirWindow(pts, 0, 1)
      const dir = back ? { x: -back.x, y: -back.y } : null
      const prev = findNext(head[0], head[1], -1, dir)
      if (!prev) break
      used[prev.seg] = 1
      const seg = segments[prev.seg]
      const arr = prev.end === 1 ? seg : [...seg].reverse() // arr 末端贴近 head
      for (let i = arr.length - 2; i >= 0; i--) pts.unshift(arr[i])
    }
    return pts
  }

  const lines = []
  for (let i = 0; i < n; i++) {
    if (used[i]) continue
    const line = walk(i)
    if (line.length >= 2) lines.push(line)
  }
  return lines
}
