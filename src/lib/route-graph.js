// 铁路线网图路由：沿真实线位做最短路径（Dijkstra + 二叉堆）
// 用途：绕行严重的线路（如西成高铁穿秦岭）站对弦线采样会失败，
//       改在这张图上求两端站之间的真实线路路径
// 纯函数，可测试

const KM_PER_DEG = 111.32
const KEY = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`
const CELL = 0.02 // 节点近端连接网格（°）
const NEAR_DEG = 0.0006 // 近端连接半径（≈66m），修复 OSM 线位断链

function dkm(a, b) {
  const cosLat = Math.cos((((a.lat ?? a[0]) + (b.lat ?? b[0])) / 2) * Math.PI / 180)
  const la = a.lat ?? a[0]
  const lb = b.lat ?? b[0]
  const ga = a.lng ?? a[1]
  const gb = b.lng ?? b[1]
  return Math.hypot((gb - ga) * cosLat, lb - la) * KM_PER_DEG
}

/** 二叉最小堆 */
class Heap {
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
 * 由线位几何构建可路由的铁路图
 * @param {{hsr:number[][][], conv:number[][][]}} railLines
 */
export function buildRouteGraph(railLines) {
  const nodes = [] // {lat,lng,adj:[[toId,wKm]]}
  const idByKey = new Map()
  const nodeOf = (lat, lng) => {
    const k = KEY(lat, lng)
    let id = idByKey.get(k)
    if (id === undefined) {
      id = nodes.length
      nodes.push({ lat, lng, adj: [] })
      idByKey.set(k, id)
    }
    return id
  }
  const addEdge = (a, b) => {
    const w = dkm(nodes[a], nodes[b])
    if (w <= 0) return
    nodes[a].adj.push([b, w])
    nodes[b].adj.push([a, w])
  }
  const addLine = (pts) => {
    let prev = -1
    for (const p of pts) {
      const id = nodeOf(p[0], p[1])
      if (prev >= 0 && prev !== id) addEdge(prev, id)
      prev = id
    }
  }
  ;(railLines.hsr ?? []).forEach(addLine)
  ;(railLines.conv ?? []).forEach(addLine)

  // 近端连接：网格内相距 ≤ NEAR_DEG 的节点互连（OSM 断链修复）
  const grid = new Map()
  nodes.forEach((n, id) => {
    const k = `${Math.floor(n.lat / CELL)}_${Math.floor(n.lng / CELL)}`
    let arr = grid.get(k)
    if (!arr) grid.set(k, (arr = []))
    arr.push(id)
  })
  nodes.forEach((n, id) => {
    const la = Math.floor(n.lat / CELL)
    const ln = Math.floor(n.lng / CELL)
    for (let da = -1; da <= 1; da++) {
      for (let db = -1; db <= 1; db++) {
        const arr = grid.get(`${la + da}_${ln + db}`)
        if (!arr) continue
        for (const other of arr) {
          if (other <= id) continue
          const o = nodes[other]
          if (Math.abs(o.lat - n.lat) > NEAR_DEG || Math.abs(o.lng - n.lng) > NEAR_DEG) continue
          if (dkm(n, o) <= NEAR_DEG * KM_PER_DEG) addEdge(id, other)
        }
      }
    }
  })

  // 节点网格（供最近节点查询，0.05°）
  const nodeGrid = new Map()
  nodes.forEach((n, id) => {
    const k = `${Math.floor(n.lat / 0.05)}_${Math.floor(n.lng / 0.05)}`
    let arr = nodeGrid.get(k)
    if (!arr) nodeGrid.set(k, (arr = []))
    arr.push(id)
  })

  return { nodes, nodeGrid }
}

/** 最近节点（搜索半径 maxKm，按 3×3 邻格逐级扩大） */
export function nearestNode(graph, lat, lng, maxKm = 30) {
  const { nodes, nodeGrid } = graph
  const la = Math.floor(lat / 0.05)
  const ln = Math.floor(lng / 0.05)
  let best = -1
  let bestKm = Infinity
  for (let r = 0; r <= 2; r++) {
    for (let da = -r; da <= r; da++) {
      for (let db = -r; db <= r; db++) {
        if (r > 0 && Math.abs(da) !== r && Math.abs(db) !== r) continue // 只查外环
        const arr = nodeGrid.get(`${la + da}_${ln + db}`)
        if (!arr) continue
        for (const id of arr) {
          const km = dkm({ lat, lng }, nodes[id])
          if (km < bestKm) {
            bestKm = km
            best = id
          }
        }
      }
    }
    if (best >= 0 && bestKm <= maxKm * 0.5) break // 足够近就不再扩环
  }
  return best >= 0 && bestKm <= maxKm ? best : null
}

/**
 * Dijkstra 最短路径（到目标即止）
 * @returns {{pts:number[][], km:number}|null}
 */
export function findRoute(graph, fromId, toId, maxKm = 3000) {
  if (fromId == null || toId == null) return null
  const { nodes } = graph
  if (fromId === toId) return { pts: [[nodes[fromId].lat, nodes[fromId].lng]], km: 0 }
  const dist = new Float64Array(nodes.length).fill(Infinity)
  const prev = new Int32Array(nodes.length).fill(-1)
  const done = new Uint8Array(nodes.length)
  const heap = new Heap()
  dist[fromId] = 0
  heap.push(fromId, 0)
  while (heap.size) {
    const [d, u] = heap.pop()
    if (done[u]) continue
    done[u] = 1
    if (u === toId) break
    if (d > maxKm) return null
    for (const [v, w] of nodes[u].adj) {
      if (done[v]) continue
      const nd = d + w
      if (nd < dist[v]) {
        dist[v] = nd
        prev[v] = u
        heap.push(v, nd)
      }
    }
  }
  if (!done[toId]) return null
  const ids = []
  for (let u = toId; u !== -1; u = prev[u]) ids.push(u)
  if (ids[ids.length - 1] !== fromId) return null
  ids.reverse()
  const pts = ids.map((id) => [nodes[id].lat, nodes[id].lng])
  return { pts, km: dist[toId] }
}

/**
 * 站对路由：两端吸附到图上节点，求真实线路路径
 * 校验：路径长度不得超过弦线的 3 倍（防绕行到无关网络）；否则返回 null
 * @param {object} graph buildRouteGraph 产物
 * @param {number[]} a [lat,lng]
 * @param {number[]} b [lat,lng]
 */
export function routePair(graph, a, b) {
  const fromId = nearestNode(graph, a[0], a[1])
  const toId = nearestNode(graph, b[0], b[1])
  if (fromId == null || toId == null) return null
  const route = findRoute(graph, fromId, toId)
  if (!route || route.pts.length < 2) return null
  const chordKm = dkm({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] })
  // 绕行校验：路径不超过弦线 2.5 倍 + 小额余量（短弦对同样严格，防错误绕行）
  if (route.km > chordKm * 2.5 + Math.min(30, chordKm)) return null
  return route.pts
}
