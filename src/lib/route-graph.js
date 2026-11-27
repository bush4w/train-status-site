// 铁路线网图路由：沿真实线位做最短路径（Dijkstra + 二叉堆）
// 用途：绕行严重的线路（如西成高铁穿秦岭）站对弦线采样会失败，
//       改在这张图上求两端站之间的真实线路路径
// 纯函数，可测试

const KM_PER_DEG = 111.32
const KEY = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`
const CELL = 0.02 // 节点近端连接网格（°）
const NEAR_DEG = 0.008 // 近端连接半径（≈800m），修复简化几何/OSM 线位在站场、桥隧处的断链
const DENSIFY_KM = 2 // 长直边按 2km 插节点：简化后一条边可能横跨几十公里，
// 不插点的话车站附近没有图节点，路由会整段找不到起终点

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
export function buildRouteGraph(railLines, { nearDeg = NEAR_DEG } = {}) {
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
    if (a === b) return
    const w = dkm(nodes[a], nodes[b])
    if (w <= 0) return
    nodes[a].adj.push([b, w])
    nodes[b].adj.push([a, w])
  }
  // 长边按 DENSIFY_KM 插节点（插点在对角线上，不改变线位），
  // 否则一条简化后的长直边附近没有节点，车站就吸附不上、路由整段失败
  const addSeg = (a, b) => {
    const km = dkm(nodes[a], nodes[b])
    const parts = Math.min(400, Math.floor(km / DENSIFY_KM))
    if (parts <= 0) {
      addEdge(a, b)
      return
    }
    let prev = a
    const la = nodes[a].lat
    const ga = nodes[a].lng
    const db = nodes[b].lat - la
    const dg = nodes[b].lng - ga
    for (let i = 1; i < parts; i++) {
      const t = i / parts
      const id = nodeOf(la + db * t, ga + dg * t)
      if (id !== prev) {
        addEdge(prev, id)
        prev = id
      }
    }
    if (prev !== b) addEdge(prev, b)
  }
  const addLine = (pts) => {
    let prev = -1
    for (const p of pts) {
      const id = nodeOf(p[0], p[1])
      if (prev >= 0 && prev !== id) addSeg(prev, id)
      prev = id
    }
  }
  ;(railLines.hsr ?? []).forEach(addLine)
  ;(railLines.conv ?? []).forEach(addLine)

  // 近端连接：网格内相距 ≤ nearDeg 的节点互连（OSM 断链修复）
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
          if (Math.abs(o.lat - n.lat) > nearDeg || Math.abs(o.lng - n.lng) > nearDeg) continue
          if (dkm(n, o) <= nearDeg * KM_PER_DEG) addEdge(id, other)
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

  // 连通分量：站点附近常有几节站线/支线碎片自成一块，路由端点要避开它们
  const comp = new Int32Array(nodes.length).fill(-1)
  const stack = []
  let nc = 0
  for (let i = 0; i < nodes.length; i++) {
    if (comp[i] >= 0) continue
    comp[i] = nc
    stack.push(i)
    while (stack.length) {
      const u = stack.pop()
      for (const [v] of nodes[u].adj) {
        if (comp[v] < 0) {
          comp[v] = nc
          stack.push(v)
        }
      }
    }
    nc++
  }
  const sizes = new Int32Array(nc)
  for (let i = 0; i < nodes.length; i++) sizes[comp[i]]++
  const compSize = new Int32Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) compSize[i] = sizes[comp[i]]

  return { nodes, nodeGrid, comp, compSize }
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

const MIN_COMP = 30 // 连通块节点数低于此值视为站线/支线碎片

/**
 * 最近若干候选节点（按距离升序）
 * 站点附近常有多条支线/站线碎片，优先取主线连通块上的节点，
 * 否则最近节点落在 2 几个节点的碎块上，路由会整段不可达
 */
export function nearNodes(graph, lat, lng, maxKm = 8, k = 6) {
  const { nodes, nodeGrid, compSize } = graph
  const la = Math.floor(lat / 0.05)
  const ln = Math.floor(lng / 0.05)
  const all = []
  for (let r = 0; r <= 2; r++) {
    for (let da = -r; da <= r; da++) {
      for (let db = -r; db <= r; db++) {
        if (r > 0 && Math.abs(da) !== r && Math.abs(db) !== r) continue
        const arr = nodeGrid.get(`${la + da}_${ln + db}`)
        if (!arr) continue
        for (const id of arr) {
          const km = dkm({ lat, lng }, nodes[id])
          if (km <= maxKm) all.push([id, km])
        }
      }
    }
  }
  all.sort((x, y) => x[1] - y[1])
  const big = all.filter(([id]) => compSize[id] >= MIN_COMP)
  return (big.length && big[0][1] <= 5 ? big : all).slice(0, k)
}

/**
 * 站对路由：两端各取若干候选节点做多源最短路（吸附距离计入代价），
 * 避免最近节点落在站场碎片上导致绕行到无关网络；
 * 路径长度超过弦线 2.5 倍 + 余量时拒绝
 * @param {object} graph buildRouteGraph 产物
 * @param {number[]} a [lat,lng]
 * @param {number[]} b [lat,lng]
 */
export function routePair(graph, a, b) {
  // 先只用车站 4km 内的节点起步：起点太远会在路径开头拉出一条反向长直线；
  // 找不到再放宽到 8km（站场偏离主线的情况）
  return routePairOnce(graph, a, b, 4) ?? routePairOnce(graph, a, b, 8)
}

function routePairOnce(graph, a, b, startKm) {
  const { nodes } = graph
  const chordKm = dkm({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] })
  const starts = nearNodes(graph, a[0], a[1], startKm)
  const goals = nearNodes(graph, b[0], b[1], startKm)
  if (!starts.length || !goals.length) return null
  const snapPenalty = 1.8 // 吸附距离按 1.8 折入代价，优先离车站近的节点起步
  const limit = chordKm * 2.5 + Math.min(30, chordKm)
  const goalCost = new Map(goals.map(([id, d]) => [id, d * snapPenalty]))
  const dist = new Float64Array(nodes.length).fill(Infinity)
  const prev = new Int32Array(nodes.length).fill(-1)
  const done = new Uint8Array(nodes.length)
  const heap = new Heap()
  for (const [id, d] of starts) {
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
    if (d > limit) break
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
  if (bestId < 0) return null
  const ids = []
  for (let u = bestId; u !== -1; u = prev[u]) ids.push(u)
  ids.reverse()
  const pts = ids.map((id) => [nodes[id].lat, nodes[id].lng])
  if (pts.length < 2) return null
  let km = 0
  for (let i = 1; i < pts.length; i++) km += dkm({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: pts[i][0], lng: pts[i][1] })
  if (km > limit) return null
  return pts
}
