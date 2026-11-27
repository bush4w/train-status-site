import { describe, it, expect } from 'vitest'
import { waysToSegments, chainSegments, splitAtReversals } from './osm-lines.mjs'

// Overpass out geom 格式 fixture：3 段首尾相接 A-B-C-D + 1 段孤立 E-F
const ELEMENTS = [
  { type: 'way', id: 1, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] },
  { type: 'way', id: 2, geometry: [{ lat: 0, lon: 1 }, { lat: 0, lon: 2 }] },
  { type: 'way', id: 3, geometry: [{ lat: 0, lon: 3 }, { lat: 0, lon: 2 }] }, // 反向相接
  { type: 'way', id: 4, geometry: [{ lat: 5, lon: 5 }, { lat: 5, lon: 6 }] }, // 孤立
  { type: 'node', id: 9 }, // 非 way 应忽略
]

describe('waysToSegments', () => {
  it('提取 way 几何，忽略非 way 与短几何', () => {
    const segs = waysToSegments(ELEMENTS)
    expect(segs).toHaveLength(4)
    expect(segs[0]).toEqual([[0, 0], [0, 1]])
  })
})

describe('chainSegments', () => {
  it('首尾相接的段串联为一条线（含反向段），孤立段单独成线', () => {
    const segs = waysToSegments(ELEMENTS)
    const lines = chainSegments(segs)
    expect(lines).toHaveLength(2)
    const long = lines.find((l) => l.length > 2)
    const solo = lines.find((l) => l.length === 2)
    expect(long).toEqual([[0, 0], [0, 1], [0, 2], [0, 3]]) // 共享端点已去重
    expect(solo).toEqual([[5, 5], [5, 6]])
  })

  it('成环线路可闭合处理（不死循环）', () => {
    const ring = [
      [[0, 0], [0, 1]],
      [[0, 1], [1, 1]],
      [[1, 1], [0, 0]],
    ]
    const lines = chainSegments(ring)
    expect(lines).toHaveLength(1)
    const pts = lines[0]
    expect(pts.length).toBeGreaterThanOrEqual(3)
    // 环上所有原始点都在
    for (const p of [[0, 0], [0, 1], [1, 1]]) {
      expect(pts.some((q) => q[0] === p[0] && q[1] === p[1])).toBe(true)
    }
  })

  it('空输入安全', () => {
    expect(chainSegments([])).toEqual([])
  })

  it('端点相距 ~100m（非逐位相等）也能串联', () => {
    const a = [
      [0, 0],
      [0, 0.01],
    ]
    const b = [
      [0.0009, 0.01],
      [0.0009, 0.02],
    ] // 端点间距 0.0009° ≈ 100m
    const lines = chainSegments([a, b])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(3) // 接缝去重：两段各贡献一个端点
    expect(lines[0][2][1]).toBe(0.02)
  })

  it('超过容差的端点不串联', () => {
    const a = [
      [0, 0],
      [0, 0.01],
    ]
    const b = [
      [0.02, 0.01],
      [0.02, 0.02],
    ]
    expect(chainSegments([a, b])).toHaveLength(2)
  })

  it('不把上下行接成 U 形折返（端点相接但方向相反）', () => {
    const up = [
      [0, 0],
      [0, 0.5],
      [0, 1],
    ]
    const down = [
      [0.0003, 1],
      [0.0003, 0.5],
      [0.0003, 0],
    ]
    const lines = chainSegments([up, down])
    expect(lines).toHaveLength(2)
    expect(lines.every((l) => l.length === 3)).toBe(true)
  })
})

describe('splitAtReversals', () => {
  it('原地掉头的折返线拆成两条', () => {
    const line = [
      [0, 0],
      [0, 0.5],
      [0, 1],
      [0.0003, 1],
      [0.0003, 0.5],
      [0.0003, 0],
    ]
    const parts = splitAtReversals(line)
    expect(parts.length).toBe(2)
    expect(parts[0][0]).toEqual([0, 0])
    expect(parts[1][parts[1].length - 1]).toEqual([0.0003, 0])
  })

  it('直线不拆', () => {
    const line = [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ]
    expect(splitAtReversals(line)).toHaveLength(1)
  })

  it('很短的折返（小于 minSpurKm）不拆，避免锯齿', () => {
    const line = [
      [0, 0],
      [0, 0.2],
      [0, 0.2],
      [0, 0.1],
    ]
    expect(splitAtReversals(line, { minSpurKm: 50 })).toHaveLength(1)
  })
})
