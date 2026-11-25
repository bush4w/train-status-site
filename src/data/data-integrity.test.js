import { describe, it, expect } from 'vitest'
import { stations, stationsMap, linePoints } from './stations'
import { trains } from './trains'
import { meta } from './meta'

const toMin = (hm) => (hm == null ? null : Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)))

describe('M2 生成数据完整性', () => {
  it('京沪线车站 ≥ 20，电报码唯一且格式合法', () => {
    expect(stations.length).toBeGreaterThanOrEqual(20)
    const codes = stations.map((s) => s.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const s of stations) {
      expect(s.code).toMatch(/^[A-Z]{3}$/)
      expect(s.name).toBeTruthy()
    }
  })

  it('真实电报码回归（M1 演示码曾错误）', () => {
    expect(stationsMap.VNP.name).toBe('北京南')
    expect(stationsMap.AOH.name).toBe('上海虹桥')
    expect(stationsMap.JGK.name).toBe('济南西')
    expect(stationsMap.UUH.name).toBe('徐州东')
    expect(stationsMap.ZEH.name).toBe('镇江南')
    expect(stationsMap.NKH.name).toBe('南京南')
    // M1 错误码不应再出现
    expect(stationsMap.BJP).toBeUndefined() // BJP 实为北京站，非北京南
    expect(stationsMap.JNK).toBeUndefined() // JNK 实为济南站，非济南西
    expect(stationsMap.XCH).toBeUndefined() // XCH 实为徐州站，非徐州东
  })

  it('坐标在中国境内合理范围', () => {
    for (const s of stations) {
      expect(s.lat).toBeGreaterThan(18)
      expect(s.lat).toBeLessThan(54)
      expect(s.lng).toBeGreaterThan(73)
      expect(s.lng).toBeLessThan(135)
    }
  })

  it('线路走向：北京南起、上海虹桥终，连线点与车站一致', () => {
    expect(stations[0].name).toBe('北京南')
    expect(stations[stations.length - 1].name).toBe('上海虹桥')
    expect(linePoints).toHaveLength(stations.length)
  })

  it('车次经停码全部存在于车站表，时刻单调递增', () => {
    expect(trains.length).toBeGreaterThanOrEqual(3)
    for (const t of trains) {
      expect(t.stops.length).toBeGreaterThanOrEqual(2)
      expect(t.stops[0].arr).toBeNull()
      expect(t.stops[t.stops.length - 1].dep).toBeNull()
      let prev = -1
      for (const s of t.stops) {
        expect(stationsMap[s.code]).toBeTruthy()
        for (const hm of [s.arr, s.dep]) {
          if (hm == null) continue
          expect(hm).toMatch(/^\d{2}:\d{2}$/)
          const m = toMin(hm)
          expect(m).toBeGreaterThan(prev)
          prev = m
        }
      }
    }
  })

  it('meta 含数据来源与合规声明', () => {
    expect(meta.sources.telecode).toContain('12306')
    expect(meta.sources.timetable).toBeTruthy()
    expect(meta.disclaimer).toContain('非官方')
    expect(meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
