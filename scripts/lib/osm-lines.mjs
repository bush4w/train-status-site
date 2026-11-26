// OSM 铁路 way → 连续折线（纯函数，可测试）
// Overpass `out geom` 的 way 元素自带 geometry:[{lat,lon},...]；
// 相邻 way 共享端点，按端点串联成连续线路，减少前端要素数量并利于简化。

const keyOf = (pt) => `${pt[0].toFixed(5)},${pt[1].toFixed(5)}` // ~1m 容差端点键

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
 * 端点串联：优先从度为 1 的端点起走（得到长线），剩余成环段任意起点
 * @param {number[][][]} segments [[[lat,lng],...],...]
 * @returns {number[][][]} 串联后的折线集合
 */
export function chainSegments(segments) {
  const n = segments.length
  const used = new Uint8Array(n)
  // 邻接表：端点键 → [{seg, end: 0|1}]
  const adj = new Map()
  const addAdj = (k, seg, end) => {
    let list = adj.get(k)
    if (!list) adj.set(k, (list = []))
    list.push({ seg, end })
  }
  const degree = new Map()
  for (let i = 0; i < n; i++) {
    const s = segments[i]
    const a = keyOf(s[0])
    const b = keyOf(s[s.length - 1])
    addAdj(a, i, 0)
    if (b !== a) addAdj(b, i, 1)
    degree.set(a, (degree.get(a) ?? 0) + 1)
    if (b !== a) degree.set(b, (degree.get(b) ?? 0) + 1)
  }

  const walk = (startSeg) => {
    const s0 = segments[startSeg]
    used[startSeg] = 1
    const pts = [...s0]
    // 向后延伸：找触及尾键的未用段，定向后追加（共享端点去重）
    let endKey = keyOf(pts[pts.length - 1])
    for (;;) {
      const next = (adj.get(endKey) ?? []).find((c) => !used[c.seg])
      if (!next) break
      used[next.seg] = 1
      const seg = segments[next.seg]
      const arr = next.end === 0 ? seg : [...seg].reverse() // arr[0] 触及 endKey
      const skip = keyOf(arr[0]) === endKey ? 1 : 0
      for (let i = skip; i < arr.length; i++) pts.push(arr[i])
      endKey = keyOf(pts[pts.length - 1])
    }
    // 向前延伸：找触及头键的未用段，定向后前插（共享端点去重）
    let headKey = keyOf(pts[0])
    for (;;) {
      const next = (adj.get(headKey) ?? []).find((c) => !used[c.seg])
      if (!next) break
      used[next.seg] = 1
      const seg = segments[next.seg]
      const arr = next.end === 1 ? seg : [...seg].reverse() // arr 末端触及 headKey
      const drop = keyOf(arr[arr.length - 1]) === headKey ? 1 : 0
      for (let i = 0; i < arr.length - drop; i++) pts.unshift(arr[i])
      headKey = keyOf(pts[0])
    }
    return pts
  }

  const lines = []
  // 第一轮：从度 1 端点起走
  for (let i = 0; i < n; i++) {
    if (used[i]) continue
    const s = segments[i]
    const a = keyOf(s[0])
    const b = keyOf(s[s.length - 1])
    if ((degree.get(a) ?? 0) === 1 || (degree.get(b) ?? 0) === 1) {
      const line = walk(i)
      if (line.length >= 2) lines.push(line)
    }
  }
  // 第二轮：剩余（成环）段
  for (let i = 0; i < n; i++) {
    if (used[i]) continue
    const line = walk(i)
    if (line.length >= 2) lines.push(line)
  }
  return lines
}
