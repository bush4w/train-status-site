import { describe, it, expect } from 'vitest'
import { applyLiveDelays } from './delays.js'

const trains = [
  { no: 'G1', delay: 0 },
  { no: 'G2', delay: 3 },
  { no: 'K1', delay: 0 },
]

describe('applyLiveDelays · 未实测与正点区分', () => {
  it('sampled 只覆盖部分车次时，未覆盖标记 delayKnown=false', () => {
    const out = applyLiveDelays(trains, { delayAsOf: 'x', sampled: ['G1', 'G2'], delays: { G1: 0, G2: 7 } })
    expect(out[0]).toMatchObject({ no: 'G1', delay: 0, delayKnown: true })
    expect(out[1]).toMatchObject({ no: 'G2', delay: 7, delayKnown: true })
    expect(out[2]).toMatchObject({ no: 'K1', delay: 0, delayKnown: false })
  })

  it('sampled 为空数组时全部视为未实测', () => {
    const out = applyLiveDelays(trains, { sampled: [], delays: {} })
    expect(out.every((t) => t.delayKnown === false)).toBe(true)
  })

  it('旧格式（无 sampled）按全量实测处理，且不写 delayKnown', () => {
    const out = applyLiveDelays(trains, { delays: { G2: 9, G1: 0 } })
    expect(out[1].delay).toBe(9)
    expect(out[0].delayKnown).toBeUndefined()
    expect(out[2].delayKnown).toBeUndefined()
  })

  it('无变化时返回原数组引用（避免无谓重渲染）', () => {
    const out = applyLiveDelays(trains, { delays: { G2: 3 } })
    expect(out).toBe(trains)
  })
})
