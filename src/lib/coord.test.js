import { describe, it, expect } from 'vitest'
import { wgs84ToGcj02 } from './coord'

describe('wgs84ToGcj02', () => {
  it('中国境外坐标原样返回（不做偏移）', () => {
    const p = wgs84ToGcj02(51.5074, -0.1278) // 伦敦
    expect(p.lat).toBe(51.5074)
    expect(p.lng).toBe(-0.1278)
  })

  it('北京坐标产生正向偏移，量级在数百米（<0.01 度）', () => {
    const lat = 39.9042
    const lng = 116.4074
    const p = wgs84ToGcj02(lat, lng)
    expect(p.lat).toBeGreaterThan(lat)
    expect(p.lng).toBeGreaterThan(lng)
    expect(p.lat - lat).toBeLessThan(0.01)
    expect(p.lng - lng).toBeLessThan(0.01)
  })

  it('上海坐标同样产生偏移且结果有限', () => {
    const p = wgs84ToGcj02(31.2304, 121.4737)
    expect(Number.isFinite(p.lat)).toBe(true)
    expect(Number.isFinite(p.lng)).toBe(true)
    expect(p.lat).not.toBe(31.2304)
  })
})
