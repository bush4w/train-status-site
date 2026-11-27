import { describe, it, expect } from 'vitest'
import { statusColor, ON_TIME_COLOR, DELAY_COLOR, UNKNOWN_COLOR } from './status.js'

describe('statusColor · 正点/晚点/未实测三态', () => {
  it('实测正点为绿、晚点为橙', () => {
    expect(statusColor(0)).toBe(ON_TIME_COLOR)
    expect(statusColor(5)).toBe(DELAY_COLOR)
  })

  it('未实测（known=false）为中性灰，即使 delay 为 0', () => {
    expect(statusColor(0, false)).toBe(UNKNOWN_COLOR)
    expect(statusColor(8, false)).toBe(UNKNOWN_COLOR)
  })
})
