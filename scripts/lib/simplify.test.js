import { describe, it, expect } from 'vitest'
import { simplify, pointSegDist, roundPts } from './simplify.mjs'

describe('simplify (Douglas-Peucker)', () => {
  it('共线点全部去除，只留首尾', () => {
    const line = [[0, 0], [0, 0.5], [0, 1], [0, 1.5], [0, 2]]
    expect(simplify(line, 0.001)).toEqual([[0, 0], [0, 2]])
  })
  it('拐角保留', () => {
    const line = [[0, 0], [0, 1], [1, 1]] // 直角拐点 [0,1]
    const out = simplify(line, 0.01)
    expect(out).toContainEqual([0, 1])
    expect(out).toEqual([[0, 0], [0, 1], [1, 1]])
  })
  it('小抖动被容差吸收', () => {
    const line = [[0, 0], [0.5, 0.0001], [1, 0], [1.5, 0.0001], [2, 0]]
    expect(simplify(line, 0.001)).toEqual([[0, 0], [2, 0]])
  })
  it('短于 3 点原样返回；tol=0 原样返回', () => {
    expect(simplify([[0, 0], [1, 1]], 0.5)).toEqual([[0, 0], [1, 1]])
    const line = [[0, 0], [0, 0.5], [0, 1]]
    expect(simplify(line, 0)).toBe(line)
  })
  it('长线不爆栈（1 万点锯齿）', () => {
    const big = []
    for (let i = 0; i < 10000; i++) big.push([i * 0.001, i % 2 ? 0.00005 : 0])
    const out = simplify(big, 0.0001)
    expect(out.length).toBeLessThan(50)
    expect(out[0]).toEqual(big[0])
  })
})

describe('pointSegDist', () => {
  it('垂足在线段内/外的距离', () => {
    expect(pointSegDist([1, 1], [0, 1], [2, 1])).toBeCloseTo(0)
    expect(pointSegDist([3, 1], [0, 1], [2, 1])).toBeCloseTo(1) // 垂足截断到端点
  })
})

describe('roundPts', () => {
  it('保留 5 位小数', () => {
    expect(roundPts([[39.123456789, 116.987654321]])).toEqual([[39.12346, 116.98765]])
  })
})
