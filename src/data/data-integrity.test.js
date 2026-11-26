import { describe, it, expect } from 'vitest'
import { stations, stationsMap } from './stations'
import { trains } from './trains'
import { meta } from './meta'

const toMin = (hm) => (hm == null ? null : Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)))

describe('M4 全国数据完整性', () => {
  it('车站规模与电报码合法性', () => {
    expect(stations.length).toBeGreaterThanOrEqual(500)
    const codes = stations.map((s) => s.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const s of stations) {
      expect(s.code).toMatch(/^[A-Z]{3}$/)
      expect(s.name).toBeTruthy()
    }
  })

  it('京沪高铁 23 站保留精确坐标与真实电报码', () => {
    const precise = stations.filter((s) => s.precise)
    expect(precise.length).toBeGreaterThanOrEqual(23)
    expect(stationsMap.VNP.name).toBe('北京南')
    // 精确坐标可能来自人工整理或 OSM 实测（站房节点，与站中心可差数百米）；
    // 容差 0.02°≈2.2km：既能容纳 OSM/人工差异，又能挡住"城市级兜底"那种偏差
    expect(Math.abs(stationsMap.VNP.lat - 39.865)).toBeLessThan(0.02)
    expect(Math.abs(stationsMap.VNP.lng - 116.379)).toBeLessThan(0.02)
    expect(stationsMap.AOH.name).toBe('上海虹桥')
    expect(stationsMap.JGK.name).toBe('济南西')
    expect(stationsMap.UUH.name).toBe('徐州东')
    expect(stationsMap.ZEH.name).toBe('镇江南')
    // M1 错码回归：BJP/JNK/XCH 是真实存在的站（北京/济南/徐州），
    // 但绝不能被当成北京南/济南西/徐州东（M1 演示数据的错误）
    if (stationsMap.BJP) expect(stationsMap.BJP.name).toBe('北京')
    if (stationsMap.JNK) expect(stationsMap.JNK.name).toBe('济南')
    if (stationsMap.XCH) expect(stationsMap.XCH.name).toBe('徐州')
    expect(stationsMap.VNP.name).toBe('北京南')
    expect(stationsMap.JGK.name).toBe('济南西')
    expect(stationsMap.UUH.name).toBe('徐州东')
  })

  it('坐标范围覆盖中国及中老铁路（含境外段）', () => {
    for (const s of stations) {
      expect(s.lat).toBeGreaterThan(15)
      expect(s.lat).toBeLessThan(55)
      expect(s.lng).toBeGreaterThan(70)
      expect(s.lng).toBeLessThan(140)
    }
  })

  it('车次规模与京沪标杆车固定收录', () => {
    expect(trains.length).toBeGreaterThanOrEqual(80)
    const nos = new Set(trains.map((t) => t.no))
    for (const pinned of ['G1', 'G7', 'G9', 'G11', 'G13']) {
      expect(nos.has(pinned), `标杆车 ${pinned} 应在数据中`).toBe(true)
    }
  })

  it('车次号唯一、经停码可解析、时刻单调（允许 0 分钟停点）', () => {
    const nos = trains.map((t) => t.no)
    expect(new Set(nos).size).toBe(nos.length)
    for (const t of trains) {
      expect(t.stops.length).toBeGreaterThanOrEqual(2)
      expect(t.stops[0].arr).toBeNull()
      expect(t.stops[t.stops.length - 1].dep).toBeNull()
      let prev = -1
      for (const s of t.stops) {
        expect(stationsMap[s.code], `${t.no} 经停码 ${s.code} 应在车站表`).toBeTruthy()
        for (const hm of [s.arr, s.dep]) {
          if (hm == null) continue
          expect(hm).toMatch(/^\d{2}:\d{2}$/)
          const m = toMin(hm)
          expect(m, `${t.no} 时刻应单调不减`).toBeGreaterThanOrEqual(prev)
          prev = m
        }
      }
    }
  })

  it('晚点值合法（非负整数）', () => {
    for (const t of trains) {
      expect(Number.isInteger(t.delay)).toBe(true)
      expect(t.delay).toBeGreaterThanOrEqual(0)
    }
  })

  it('meta 含规模、数据来源与合规声明', () => {
    expect(meta.counts.stations).toBe(stations.length)
    expect(meta.counts.trains).toBe(trains.length)
    expect(meta.sources.telecode).toContain('12306')
    expect(meta.sources.coord).toBeTruthy()
    expect(meta.sources.timetable).toBeTruthy()
    expect(meta.sources.delay).toBeTruthy()
    expect(meta.disclaimer).toContain('非官方')
    expect(meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(meta.delayAsOf === null || typeof meta.delayAsOf === 'string').toBe(true)
  })
})
