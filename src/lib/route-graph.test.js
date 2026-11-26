import { describe, it, expect } from 'vitest'
import { buildRouteGraph, nearestNode, findRoute, routePair } from './route-graph'

// L 形线位：西 → 转角 → 北（坐标系 [lat, lng]）
const L_LINE = [[0, 0], [0, 0.02], [0.01, 0.02]]
const G = buildRouteGraph({ hsr: [L_LINE], conv: [] })

describe('buildRouteGraph / findRoute', () => {
  it('图包含路径节点，端到端可达且路径经过转角', () => {
    const from = nearestNode(G, 0, 0)
    const to = nearestNode(G, 0.01, 0.02)
    expect(from).not.toBeNull()
    expect(to).not.toBeNull()
    const route = findRoute(G, from, to)
    expect(route).not.toBeNull()
    expect(route.pts.length).toBeGreaterThanOrEqual(3)
    // 经过转角 (0,0.02)
    const hasCorner = route.pts.some(([lat, lng]) => Math.abs(lat) < 1e-4 && Math.abs(lng - 0.02) < 1e-4)
    expect(hasCorner).toBe(true)
  })

  it('断链修复：相距 ~55m 的两段线可路由', () => {
    const a = [[0, 0], [0, 0.02]]
    const b = [[0.0005, 0.02], [0.0005, 0.03]]
    const g = buildRouteGraph({ hsr: [a, b], conv: [] })
    const route = routePair(g, [0, 0], [0.0005, 0.03])
    expect(route).not.toBeNull()
    expect(route.length).toBeGreaterThanOrEqual(3)
  })

  it('不可达返回 null', () => {
    const g = buildRouteGraph({ hsr: [[[0, 0], [0, 0.01]], [[1, 1], [1, 1.01]]], conv: [] })
    expect(routePair(g, [0, 0], [1, 1.01])).toBeNull()
  })

  it('maxKm 限制生效', () => {
    const from = nearestNode(G, 0, 0)
    const to = nearestNode(G, 0.01, 0.02)
    expect(findRoute(G, from, to, 0.5)).toBeNull() // 总里程约 3.3km > 0.5km
  })
})

describe('routePair 绕行校验', () => {
  it('绕行超过弦线 2.5 倍 + 余量时拒绝（短弦严格）', () => {
    // 环线：弦线 2.2km（两端相距 0.02° > 近端连接半径），沿环走约 24km
    const loop = [[0, 0], [0, 0.1], [0.02, 0.1], [0.02, 0]]
    const g = buildRouteGraph({ hsr: [loop], conv: [] })
    expect(routePair(g, [0, 0], [0.02, 0])).toBeNull()
  })

  it('正常绕行（如穿山线路）可通过', () => {
    // 弦线直连不存在，沿线绕弯但比例合理
    const curve = [[0, 0], [0.005, 0.01], [0.01, 0.02]]
    const g = buildRouteGraph({ hsr: [curve], conv: [] })
    const r = routePair(g, [0, 0], [0.01, 0.02])
    expect(r).not.toBeNull()
    expect(r.length).toBeGreaterThanOrEqual(3)
  })
})
