import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const data = JSON.parse(readFileSync('public/data/counties.json', 'utf8'))
const stations = JSON.parse(readFileSync('public/data/stations.json', 'utf8'))
const byCode = Object.fromEntries(stations.map((s) => [s.code, s]))

const inChina = ([lat, lng]) => lat >= 3 && lat <= 54 && lng >= 73 && lng <= 136

describe('M6a 区县边界与车站归属', () => {
  it('规模与结构：市/区县均非空，代码唯一', () => {
    expect(data.cities.length).toBeGreaterThanOrEqual(300)
    expect(data.counties.length).toBeGreaterThanOrEqual(2500)
    expect(new Set(data.counties.map((c) => c.code)).size).toBe(data.counties.length)
    for (const c of data.counties) {
      expect(c.name).toBeTruthy()
      expect(c.city).toBeTruthy()
      expect(c.province).toBeTruthy()
      expect(Array.isArray(c.polys)).toBe(true)
      expect(c.polys.length).toBeGreaterThanOrEqual(1)
      for (const ring of c.polys) {
        expect(ring.length).toBeGreaterThanOrEqual(3)
        for (const p of ring) {
          expect(Array.isArray(p)).toBe(true)
          expect(inChina(p), `${c.name} 坐标越界 ${p}`).toBe(true)
        }
      }
    }
  })

  it('中心点合法，且落在合理范围', () => {
    for (const c of [...data.cities, ...data.counties]) {
      expect(Array.isArray(c.center)).toBe(true)
      expect(inChina(c.center), `${c.name} center 越界`).toBe(true)
    }
  })

  it('车站归属覆盖率 ≥ 95%，且站码都来自车站表', () => {
    expect(data.stationsTotal).toBe(stations.length)
    expect(data.stationsAssigned / data.stationsTotal).toBeGreaterThanOrEqual(0.95)
    for (const c of data.counties) {
      for (const code of c.stations) expect(byCode[code], `${c.name} 的 ${code} 不在车站表`).toBeTruthy()
    }
    // 抽查：南京南 → 雨花台区，北京南 → 丰台区，上海虹桥 → 闵行区
    const of = (code) => data.counties.find((c) => c.stations.includes(code))?.name
    expect(of('NKH')).toBe('雨花台区')
    expect(of('VNP')).toBe('丰台区')
    expect(of('AOH')).toBe('闵行区')
  })

  it('城市车站为所辖区县车站的并集', () => {
    const byCity = new Map()
    for (const c of data.counties) {
      const arr = byCity.get(c.cityCode) ?? []
      arr.push(...c.stations)
      byCity.set(c.cityCode, arr)
    }
    for (const city of data.cities) {
      const expectCodes = (byCity.get(city.code) ?? []).sort()
      expect(city.stations.slice().sort()).toEqual(expectCodes)
    }
  })

  it('体积控制在 8MB 内（运行时加载）', () => {
    const bytes = JSON.stringify(data).length
    expect(bytes).toBeLessThan(8 * 1024 * 1024)
  })
})
