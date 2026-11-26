import { describe, it, expect } from 'vitest'
import {
  normalizeStationName,
  isLatinName,
  buildOsmStationIndex,
  matchStation,
} from './station-match.mjs'

const ELEMENTS = [
  { type: 'node', id: 1, lat: 39.8652, lon: 116.3786, tags: { name: '北京南站', 'name:zh': '北京南站' } },
  { type: 'way', id: 2, center: { lat: 31.197, lon: 121.336 }, tags: { name: '上海虹桥站' } },
  { type: 'node', id: 3, lat: 30.0, lon: 120.0, tags: { name: '杭州东' } }, // 无"站"尾缀
  { type: 'node', id: 4, lat: 22.5, lon: 114.0, tags: { name: 'Shenzhen North' } }, // 拉丁名不参与
  // 同名歧义：两个"沙河"站相距很远
  { type: 'node', id: 5, lat: 39.9, lon: 116.3, tags: { name: '沙河站' } },
  { type: 'node', id: 6, lat: 22.9, lon: 113.9, tags: { name: '沙河站' } },
]

describe('normalizeStationName / isLatinName', () => {
  it('去尾缀"站"与空白', () => {
    expect(normalizeStationName('北京南站')).toBe('北京南')
    expect(normalizeStationName(' 上海虹桥站 ')).toBe('上海虹桥')
    expect(normalizeStationName('杭州东')).toBe('杭州东')
  })
  it('拉丁名识别', () => {
    expect(isLatinName('Shenzhen North')).toBe(true)
    expect(isLatinName('深圳北')).toBe(false)
  })
})

describe('buildOsmStationIndex / matchStation', () => {
  const idx = buildOsmStationIndex(ELEMENTS)

  it('中文名建索引（含 name:zh），拉丁名跳过', () => {
    expect(idx.has('北京南')).toBe(true)
    expect(idx.has('上海虹桥')).toBe(true)
    expect(idx.has('Shenzhen North')).toBe(false)
  })

  it('带"站"尾缀与不带的都能匹配到', () => {
    expect(matchStation('北京南', 39.86, 116.37, idx)).toMatchObject({ lat: 39.8652 })
    expect(matchStation('北京南站', 39.86, 116.37, idx)).toMatchObject({ lat: 39.8652 })
  })

  it('way 元素用 center 坐标', () => {
    expect(matchStation('上海虹桥', 31.2, 121.3, idx)).toMatchObject({ lat: 31.197 })
  })

  it('同名歧义按参考坐标就近消歧', () => {
    const north = matchStation('沙河', 39.95, 116.28, idx) // 参考点在北京
    const south = matchStation('沙河', 22.95, 113.85, idx) // 参考点在广东
    expect(north.lat).toBeCloseTo(39.9)
    expect(south.lat).toBeCloseTo(22.9)
  })

  it('超出消歧半径返回 null（防止跨城错配）', () => {
    expect(matchStation('北京南', 31.2, 121.4, idx, 80)).toBeNull() // 参考点在上海
  })

  it('未收录站名返回 null', () => {
    expect(matchStation('不存在的站', 30, 110, idx)).toBeNull()
  })
})
