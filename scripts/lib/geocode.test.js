import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { hash01, jitter, geocodeStations } from './geocode.mjs'
import { CITY_COORDS } from '../data/city-coords.mjs'
import { parseStationNameJs } from './station-parser.mjs'
import { JINGHU_STATIONS } from '../data/jinghu-line.mjs'

describe('hash01 / jitter', () => {
  it('确定性：同名同结果，异名异结果', () => {
    expect(hash01('北京南')).toBe(hash01('北京南'))
    expect(hash01('北京南')).not.toBe(hash01('北京西'))
    expect(jitter('天津西')).toEqual(jitter('天津西'))
  })
  it('偏移范围 ±0.05°', () => {
    for (const n of ['北京南', '上海虹桥', '广州南', '昆明南']) {
      const j = jitter(n)
      expect(Math.abs(j.dLat)).toBeLessThanOrEqual(0.05)
      expect(Math.abs(j.dLng)).toBeLessThanOrEqual(0.05)
    }
  })
})

describe('geocodeStations', () => {
  const preciseMap = Object.fromEntries(JINGHU_STATIONS.map((s) => [s.name, { lat: s.lat, lng: s.lng }]))
  const sample = [
    { name: '北京南', code: 'VNP', city: '北京' },
    { name: '北京西', code: 'BXP', city: '北京' },
    { name: '某不存在城市的站', code: 'XXX', city: '不存在市' },
  ]

  it('精确坐标覆盖城市级坐标', () => {
    const { geocoded } = geocodeStations(sample, preciseMap)
    const bjn = geocoded.find((s) => s.name === '北京南')
    expect(bjn.precise).toBe(true)
    expect(bjn.lat).toBe(39.8652)
  })

  it('城市级编码带微偏移且同城不重叠', () => {
    const { geocoded } = geocodeStations(sample, preciseMap)
    const bjx = geocoded.find((s) => s.name === '北京西')
    expect(bjx.precise).toBe(false)
    const [cLat, cLng] = CITY_COORDS['北京']
    expect(Math.abs(bjx.lat - cLat)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(bjx.lng - cLng)).toBeLessThanOrEqual(0.05)
    expect(bjx.lat).not.toBe(39.8652) // 与北京南不同坐标
  })

  it('无城市坐标的站进入 missing', () => {
    const { geocoded, missing } = geocodeStations(sample, preciseMap)
    expect(geocoded).toHaveLength(2)
    expect(missing.join()).toContain('不存在市')
  })

  it('真实车站表覆盖率 ≥ 85%，且全部坐标在合理范围', () => {
    const text = readFileSync('.cache/railway/station_name.js', 'utf8')
    const all = parseStationNameJs(text)
    const { geocoded, missing } = geocodeStations(all, preciseMap)
    const ratio = geocoded.length / all.length
    console.log(`覆盖率: ${(ratio * 100).toFixed(1)}% (${geocoded.length}/${all.length}), 缺失城市样本: ${missing.slice(0, 5).join(', ')}`)
    expect(ratio).toBeGreaterThanOrEqual(0.85)
    for (const s of geocoded) {
      expect(s.lat).toBeGreaterThan(15)
      expect(s.lat).toBeLessThan(55)
      expect(s.lng).toBeGreaterThan(70)
      expect(s.lng).toBeLessThan(140)
    }
  })
})
