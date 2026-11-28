import { describe, it, expect } from 'vitest'
import {
  normalizeStationName,
  isLatinName,
  buildOsmStationIndex,
  matchStation,
  matchStationNearRail,
} from './station-match.mjs'

const ELEMENTS = [
  { type: 'node', id: 1, lat: 39.8652, lon: 116.3786, tags: { name: '北京南站', 'name:zh': '北京南站' } },
  { type: 'way', id: 2, center: { lat: 31.197, lon: 121.336 }, tags: { name: '上海虹桥站' } },
  { type: 'node', id: 3, lat: 30.0, lon: 120.0, tags: { name: '杭州东' } }, // 无"站"尾缀
  { type: 'node', id: 4, lat: 22.5, lon: 114.0, tags: { name: 'Shenzhen North' } }, // 拉丁名不参与
  // 同名歧义：两个"沙河"站相距很远
  { type: 'node', id: 5, lat: 39.9, lon: 116.3, tags: { name: '沙河站' } },
  { type: 'node', id: 6, lat: 22.9, lon: 113.9, tags: { name: '沙河站' } },
  // 县级市：地理编码常落到上级市（玉门 → 酒泉，偏差约 150km），OSM 只有唯一候选
  { type: 'node', id: 7, lat: 40.2716, lon: 97.0439, tags: { name: '玉门站' } },
  // 同一车站在 OSM 里 node + way center 重复登记（相差几十米）
  { type: 'way', id: 8, center: { lat: 40.2717, lon: 97.0442 }, tags: { name: '玉门' } },
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

  it('唯一同名候选放宽到 250km（救回县级市兜底坐标）', () => {
    const r = matchStation('玉门', 39.7437, 98.5577, idx) // 酒泉兜底坐标，距玉门 ~150km
    expect(r).not.toBeNull()
    expect(r.lat).toBeCloseTo(40.2716)
  })

  it('同名有歧义时仍按 80km 严格消歧', () => {
    expect(matchStation('沙河', 30.0, 110.0, idx)).toBeNull() // 远离两个候选
  })

  it('未收录站名返回 null', () => {
    expect(matchStation('不存在的站', 30, 110, idx)).toBeNull()
  })
})

describe('matchStationNearRail（按铁路线位就近匹配）', () => {
  const idx = buildOsmStationIndex([
    // 兴山：真实站址离宜昌市区约 90km，但紧贴郑渝高铁
    { type: 'node', id: 11, lat: 31.3277, lon: 110.7455, tags: { name: '兴山站' } },
    // 同名村镇：离宜昌市区很近，但离所有铁路 20km+
    { type: 'node', id: 12, lat: 30.70, lon: 111.28, tags: { name: '兴山站' } },
    // 同名异地（>350km）
    { type: 'node', id: 13, lat: 40.0, lon: 116.0, tags: { name: '兴山站' } },
  ])
  // 假线位：只有一条经过 31.3,110.7 的线
  const railKmAt = (lat, lng) => (Math.abs(lat - 31.33) < 0.05 && Math.abs(lng - 110.75) < 0.05 ? 0.3 : 20)

  it('常规匹配会撞上同名村镇，线位兜底能选回真实站址', () => {
    const plain = matchStation('兴山', 30.6869, 111.2494, idx)
    // 常规匹配只按城市参考就近：选到了 2km 外的同名村镇（离铁路 20km）
    expect(plain.lat).toBeCloseTo(30.70)
    const r = matchStationNearRail('兴山', 30.6869, 111.2494, idx, railKmAt)
    expect(r).not.toBeNull()
    expect(r.lat).toBeCloseTo(31.3277)
    expect(r.lineKm).toBeLessThan(1)
  })

  it('同名异地超过 350km 的直接排除', () => {
    const r = matchStationNearRail('兴山', 30.6869, 111.2494, idx, () => 0)
    expect(r.lat).not.toBeCloseTo(40.0)
  })

  it('所有候选都不在铁路旁时返回 null', () => {
    expect(matchStationNearRail('兴山', 30.6869, 111.2494, idx, () => 50)).toBeNull()
  })

  it('未收录站名返回 null', () => {
    expect(matchStationNearRail('不存在', 30, 110, idx, railKmAt)).toBeNull()
  })
})
