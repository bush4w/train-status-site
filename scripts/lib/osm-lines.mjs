// OSM 铁路 way → 连续折线（纯函数，可测试）
// Overpass `out geom` 的 way 元素自带 geometry:[{lat,lon},...]；
// 相邻 way 端点常差几米到几十米（并非逐位相等），按容差就近串联，
// 得到连续长线，供前端绘制与路由图使用。

const CHAIN_TOL = 0.001 // 端点串联容差（度，约 110m）

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

  // 尾部/头部就近找未使用的另一段（同一段两端相邻的极小环除外）
  const findNext = (lat, lng, excludeSeg) => {
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
          if (d2 <= bestD) {
            best = e
            bestD = d2
          }
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
      const next = findNext(tail[0], tail[1], -1)
      if (!next) break
      used[next.seg] = 1
      const seg = segments[next.seg]
      const arr = next.end === 0 ? seg : [...seg].reverse() // arr[0] 贴近 tail
      for (let i = 1; i < arr.length; i++) pts.push(arr[i])
    }
    // 向前延伸：头部就近接上一段
    for (;;) {
      const head = pts[0]
      const prev = findNext(head[0], head[1], -1)
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
