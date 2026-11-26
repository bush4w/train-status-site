// 走廊线位求解：原始 OSM way → 局部路网 → 多源最短路（构建期专用，纯函数）
//
// 背景：前端 lines.json 为控体积按 ~400m 简化，道岔节点会在简化中丢失，
//       运行时路由图因此碎成多个连通分量，长而弯的站对（青藏线等）退化成直线。
//       构建期改用未简化的原始 way 建局部图，按站对求真实线路，预计算进 lines.json。

const KM_PER_DEG = 111.32

/** 两点球面近似距离（km） */
export function distKm(a, b) {
  const cosLat = Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180)
  return Math.hypot((b[1] - a[1]) * cosLat, b[0] - a[0]) * KM_PER_DEG
}

/** 二叉最小堆 */
class MinHeap {
  constructor() {
    this.a = []
  }
  push(item, pri) {
    const a = this.a
    a.push([pri, item])
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p][0] <= a[i][0]) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop() {
    const a = this.a
    if (!a.length) return null
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l][0] < a[m][0]) m = l
        if (r < a.length && a[r][0] < a[m][0]) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
  get size() {
    return this.a.length
  }
}

/**
 * 由原始 way 几何建局部路网（不做简化，道岔节点天然共享）
 * 末尾做一次近端连接，修补 OSM 断链/站场与正线之间的小间隙
 * @param {Array} ways Overpass way 元素（需带 geometry）
 * @param {{nearDeg?:number}} opts nearDeg：近端连接半径（度），默认 0.0006°≈66m
 * @returns {{nodes:number[][], adj:Array<Array<[number,number]>>}}
 */
export function buildWayGraph(ways, { nearDeg = 0.0006 } = {}) {
  const nodes = []
  const adj = []
  const idByKey = new Map()
  const nodeOf = (lat, lng) => {
    const k = `${lat.toFixed(5)},${lng.toFixed(5)}`
    let id = idByKey.get(k)
    if (id === undefined) {
      id = nodes.length
      nodes.push([lat, lng])
      adj.push([])
      idByKey.set(k, id)
    }
    return id
  }
  const addEdge = (a, b) => {
    const w = distKm(nodes[a], nodes[b])
    if (w <= 0) return
    adj[a].push([b, w])
    adj[b].push([a, w])
  }
  for (const w of ways ?? []) {
    const geom = w?.geometry
    if (!Array.isArray(geom) || geom.length < 2) continue
    let prev = -1
    for (const p of geom) {
      const id = nodeOf(p.lat, p.lon)
      if (prev >= 0 && prev !== id) addEdge(prev, id)
      prev = id
    }
  }
  // 近端连接（网格邻格）：修复断链，避免站场碎片与正线差几米却不可达
  if (nearDeg > 0 && nodes.length) {
    const CELL = 0.02
    const grid = new Map()
    nodes.forEach((n, id) => {
      const k = `${Math.floor(n[0] / CELL)}_${Math.floor(n[1] / CELL)}`
      let arr = grid.get(k)
      if (!arr) grid.set(k, (arr = []))
      arr.push(id)
    })
    nodes.forEach((n, id) => {
      const la = Math.floor(n[0] / CELL)
      const ln = Math.floor(n[1] / CELL)
      for (let da = -1; da <= 1; da++) {
        for (let db = -1; db <= 1; db++) {
          const arr = grid.get(`${la + da}_${ln + db}`)
          if (!arr) continue
          for (const other of arr) {
            if (other <= id) continue
            const o = nodes[other]
            if (Math.abs(o[0] - n[0]) > nearDeg || Math.abs(o[1] - n[1]) > nearDeg) continue
            if (distKm(n, o) <= nearDeg * KM_PER_DEG) addEdge(id, other)
          }
        }
      }
    })
  }
  return { nodes, adj }
}

/**
 * 最近候选节点（按距离升序，最多 k 个）
 * @returns {Array<[number, number]>} [nodeId, km]
 */
export function nearestNodes(graph, lat, lng, maxKm = 40, k = 8) {
  const { nodes } = graph
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const out = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const km = Math.hypot((n[1] - lng) * cosLat, n[0] - lat) * KM_PER_DEG
    if (km <= maxKm) out.push([i, km])
  }
  out.sort((x, y) => x[1] - y[1])
  return out.slice(0, k)
}

/**
 * 多源最短路：两端各取若干候选节点，吸附距离按 snapPenalty 计入代价，
 * 避免最近节点落在站场/支线碎片上导致无法连通。
 * @returns {{pts:number[][], km:number}|null}
 */
export function routeMulti(graph, a, b, { maxKm = 40, candidates = 8, snapPenalty = 1.2, maxKmRoute = 3000 } = {}) {
  const { nodes, adj } = graph
  if (!nodes.length) return null
  const start = nearestNodes(graph, a[0], a[1], maxKm, candidates)
  const goal = nearestNodes(graph, b[0], b[1], maxKm, candidates)
  if (!start.length || !goal.length) return null
  const goalCost = new Map(goal.map(([id, d]) => [id, d * snapPenalty]))
  const dist = new Float64Array(nodes.length).fill(Infinity)
  const prev = new Int32Array(nodes.length).fill(-1)
  const done = new Uint8Array(nodes.length)
  const heap = new MinHeap()
  for (const [id, d] of start) {
    const c = d * snapPenalty
    if (c < dist[id]) {
      dist[id] = c
      heap.push(id, c)
    }
  }
  let bestId = -1
  let bestCost = Infinity
  while (heap.size) {
    const [d, u] = heap.pop()
    if (done[u]) continue
    done[u] = 1
    const endCost = goalCost.get(u)
    if (endCost !== undefined && d + endCost < bestCost) {
      bestCost = d + endCost
      bestId = u
    }
    if (bestId >= 0 && d >= bestCost) break
    if (d > maxKmRoute) break
    for (const [v, w] of adj[u]) {
      if (done[v]) continue
      const nd = d + w
      if (nd < dist[v]) {
        dist[v] = nd
        prev[v] = u
        heap.push(v, nd)
      }
    }
  }
  if (bestId < 0) return null
  const pts = []
  for (let u = bestId; u !== -1; u = prev[u]) pts.push(nodes[u])
  pts.reverse()
  let km = 0
  for (let i = 1; i < pts.length; i++) km += distKm(pts[i - 1], pts[i])
  return { pts, km }
}

/**
 * 站对路径：路由 + 绕行校验（与运行时 routePair 同规则），成功时补上站坐标作接驳
 * @returns {{pts:number[][], km:number, ratio:number}|null}
 */
export function routeLeg(graph, a, b, { maxRatio = 2.5, slackKm = 30, ...opts } = {}) {
  const chord = distKm(a, b)
  const r = routeMulti(graph, a, b, opts)
  if (!r || r.pts.length < 2) return null
  if (r.km > chord * maxRatio + Math.min(slackKm, chord)) return null
  const pts = [[a[0], a[1]], ...r.pts, [b[0], b[1]]]
  return { pts, km: r.km, ratio: chord > 0 ? r.km / chord : Infinity }
}
