import { describe, it, expect } from 'vitest'
import { absMin, distanceKm, nearestStations, countStops, findDirectTrains, fmtAbsMin, nearestHubStation } from './access.js'

const T = (no, stops, extra = {}) => ({ no, delay: 0, delayKnown: true, stops, ...extra })

describe('access · 铁路可达查询', () => {
  it('absMin 处理跨日与缺省', () => {
    expect(absMin('08:05')).toBe(485)
    expect(absMin('01:10', 1)).toBe(1510)
    expect(absMin(null)).toBe(null)
  })

  it('distanceKm 与 nearestStations 基本正确', () => {
    expect(distanceKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.2, 0)
    const stations = [
      { code: 'A', name: '甲', lat: 30, lng: 120 },
      { code: 'B', name: '乙', lat: 31, lng: 121 },
      { code: 'C', name: '丙', lat: 40, lng: 116 },
    ]
    expect(nearestStations(stations, 30.1, 120.1, 2).map((s) => s.code)).toEqual(['A', 'B'])
  })

  it('countStops 只保留枢纽站', () => {
    const trains = [
      T('G1', [{ code: 'A' }, { code: 'B' }]),
      T('G2', [{ code: 'A' }, { code: 'C' }]),
      T('G3', [{ code: 'A' }]),
    ]
    const hubs = countStops(trains, 2)
    expect([...hubs.keys()].sort()).toEqual(['A'])
    expect(hubs.get('A')).toBe(3)
  })

  it('nearestHubStation 只从枢纽站里挑最近的', () => {
    const stations = [
      { code: 'A', name: '甲', lat: 30, lng: 120 },
      { code: 'B', name: '乙', lat: 31, lng: 121 },
      { code: 'C', name: '丙', lat: 30.2, lng: 120.2 },
    ]
    const trains = [
      T('G1', [{ code: 'A' }, { code: 'B' }]),
      T('G2', [{ code: 'A' }, { code: 'B' }]),
      T('G3', [{ code: 'C' }]),
    ]
    const hub = nearestHubStation(stations, trains, { lat: 30.1, lng: 120.1 }, 1, 2)
    expect(hub[0].code).toBe('A')
  })

  it('找到直达车次，并按发车时间排序', () => {
    const trains = [
      T('G2', [
        { code: 'A', dep: '09:00', depDay: 0 },
        { code: 'T', arr: '11:00', arrDay: 0 },
      ]),
      T('G1', [
        { code: 'A', dep: '08:00', depDay: 0 },
        { code: 'T', arr: '10:30', arrDay: 0 },
      ]),
    ]
    const res = findDirectTrains(trains, ['A'], ['T'], 400)
    expect(res.map((r) => r.no)).toEqual(['G1', 'G2'])
    expect(res[0]).toMatchObject({ dep: 480, arr: 630, durationMin: 150 })
  })

  it('方向相反不匹配', () => {
    const trains = [T('G9', [{ code: 'T', dep: '08:00' }, { code: 'A', arr: '10:00' }])]
    expect(findDirectTrains(trains, ['A'], ['T'], 0)).toEqual([])
  })

  it('同城多起点取最后一个上车站', () => {
    const trains = [
      T('G5', [
        { code: 'A1', dep: '08:00', depDay: 0 },
        { code: 'A2', dep: '08:20', depDay: 0 },
        { code: 'T', arr: '10:20', arrDay: 0 },
      ]),
    ]
    const res = findDirectTrains(trains, ['A1', 'A2'], ['T'], 0)
    expect(res[0]).toMatchObject({ from: 'A2', dep: 500, durationMin: 120 })
  })

  it('跨零点车次按 arrDay 计算历时', () => {
    const trains = [
      T('K1', [
        { code: 'A', dep: '23:00', depDay: 0 },
        { code: 'T', arr: '01:30', arrDay: 1 },
      ]),
    ]
    const res = findDirectTrains(trains, ['A'], ['T'], 1200)
    expect(res[0].durationMin).toBe(150)
    expect(res[0].arrDay).toBe(1)
  })

  it('已发车超过宽限、超出时窗的车次被过滤', () => {
    const trains = [
      T('OLD', [{ code: 'A', dep: '06:00' }, { code: 'T', arr: '08:00' }]),
      T('FAR', [{ code: 'A', dep: '08:00', depDay: 2 }, { code: 'T', arr: '10:00', arrDay: 2 }]),
    ]
    expect(findDirectTrains(trains, ['A'], ['T'], 8 * 60)).toEqual([])
  })

  it('limit 生效且格式化正确', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      T(`G${i}`, [
        { code: 'A', dep: `0${8 + i}:00`, depDay: 0 },
        { code: 'T', arr: `1${0 + i}:00`, arrDay: 0 },
      ]),
    )
    expect(findDirectTrains(many, ['A'], ['T'], 0, { limit: 3 })).toHaveLength(3)
    expect(fmtAbsMin(1500)).toBe('次日 01:00')
    expect(fmtAbsMin(485)).toBe('08:05')
  })
})
