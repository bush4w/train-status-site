import { describe, it, expect } from 'vitest'
import { nextIntervalMs, preDelayMs, shuffled } from './schedule.mjs'

describe('nextIntervalMs', () => {
  it('落在 base±jitter 范围内', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const ms = nextIntervalMs(15, 8, () => r)
      const min = (15 - 8) * 60000
      const max = (15 + 8) * 60000
      expect(ms).toBeGreaterThanOrEqual(min)
      expect(ms).toBeLessThanOrEqual(max)
    }
  })
  it('连续取值不相等（随机性生效）且下限 1 分钟', () => {
    const vals = [0.1, 0.9, 0.5].map((r) => nextIntervalMs(15, 8, () => r))
    expect(new Set(vals).size).toBe(3)
    expect(nextIntervalMs(0.5, 2, () => 0)).toBe(60000) // 0.5-2 < 1 → 钳为 1 分钟
  })
})

describe('preDelayMs', () => {
  it('范围 [0, maxSec*1000)', () => {
    expect(preDelayMs(90, () => 0)).toBe(0)
    expect(preDelayMs(90, () => 0.5)).toBe(45000)
    expect(preDelayMs(90, () => 0.999)).toBeLessThan(90000)
  })
})

describe('shuffled', () => {
  it('保持元素集合不变，不改动原数组', () => {
    const src = [1, 2, 3, 4, 5]
    const out = shuffled(src, () => 0.5)
    expect(out.sort()).toEqual([1, 2, 3, 4, 5])
    expect(src).toEqual([1, 2, 3, 4, 5])
  })
})
