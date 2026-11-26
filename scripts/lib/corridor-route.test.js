import { describe, it, expect } from 'vitest'
import { buildWayGraph, nearestNodes, routeMulti, routeLeg, distKm } from './corridor-route.mjs'

const way = (geom) => ({ type: 'way', geometry: geom.map(([lat, lon]) => ({ lat, lon })) })

describe('buildWayGraph', () => {
  it('相邻点成边，道岔端点共享同一节点', () => {
    const g = buildWayGraph([way([[0, 0], [0, 0.02]]), way([[0, 0.02], [0.01, 0.02]])])
    expect(g.nodes.length).toBe(3)
    expect(g.adj[0].length).toBe(1)
    expect(g.adj[1].length).toBe(2) // 转角处两条 way 共用节点
    expect(g.adj[2].length).toBe(1)
  })

  it('忽略几何不足的 way', () => {
    const g = buildWayGraph([way([[0, 0]]), { type: 'way' }, null])
    expect(g.nodes.length).toBe(0)
  })

  it('近端连接修复 ~55m 断链', () => {
    const g = buildWayGraph([way([[0, 0], [0, 0.02]]), way([[0.0005, 0.02], [0.0005, 0.03]])])
    const r = routeMulti(g, [0, 0], [0.0005, 0.03], { maxKm: 2 })
    expect(r).not.toBeNull()
    expect(r.pts.length).toBeGreaterThanOrEqual(3)
  })
})

describe('routeMulti / routeLeg', () => {
  // 0.1° ≈ 11km 的 L 形线位；站点在离线 ~1km 处
  const JUNCTION = buildWayGraph([
    way([[0, 0], [0, 0.1]]),
    way([[0, 0.1], [0.1, 0.1]]),
  ])

  it('多源吸附：站点略微离线仍可连通', () => {
    const r = routeMulti(JUNCTION, [0, -0.01], [0.1, 0.11], { maxKm: 2 })
    expect(r).not.toBeNull()
    expect(r.pts.length).toBeGreaterThanOrEqual(3)
    expect(r.km).toBeGreaterThan(20)
  })

  it('两端无邻近线位时返回 null', () => {
    expect(routeMulti(JUNCTION, [1, 1], [1, 1.01], { maxKm: 2 })).toBeNull()
  })

  it('routeLeg 补上站坐标作为接驳', () => {
    const r = routeLeg(JUNCTION, [0, -0.01], [0.1, 0.11], { maxKm: 2 })
    expect(r).not.toBeNull()
    expect(r.pts[0]).toEqual([0, -0.01])
    expect(r.pts[r.pts.length - 1]).toEqual([0.1, 0.11])
  })

  it('绕行超过弦线 2.5 倍时拒绝', () => {
    const loop = buildWayGraph([way([[0, 0], [0, 0.1], [0.001, 0.1], [0.001, 0]])])
    expect(routeLeg(loop, [0, 0], [0.001, 0], { maxKm: 2 })).toBeNull()
  })

  it('合理绕行可通过并给出比例', () => {
    const curve = buildWayGraph([way([[0, 0], [0.005, 0.008], [0.01, 0.02]])])
    const r = routeLeg(curve, [0, 0], [0.01, 0.02], { maxKm: 2 })
    expect(r).not.toBeNull()
    expect(r.ratio).toBeGreaterThan(1)
    expect(r.ratio).toBeLessThan(2.5)
  })
})

describe('nearestNodes', () => {
  it('按距离升序取前 k 个', () => {
    const g = buildWayGraph([way([[0, 0], [0, 0.02]])])
    const near = nearestNodes(g, 0.0001, 0.001, 40, 2)
    expect(near.length).toBe(2)
    expect(near[0][1]).toBeLessThanOrEqual(near[1][1])
  })
})

describe('distKm', () => {
  it('1° 纬度约 111km', () => {
    expect(distKm([0, 0], [1, 0])).toBeCloseTo(111.32, 0)
  })
})
