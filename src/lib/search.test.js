import { describe, it, expect } from 'vitest'
import { search } from './search'

const trains = [{ no: 'G1' }, { no: 'G101' }, { no: 'G103' }, { no: 'D3617' }, { no: 'K101' }]
const stations = [
  { name: '北京南', code: 'VNP' },
  { name: '北京', code: 'BJP' },
  { name: '北京西', code: 'BXP' },
  { name: '南京南', code: 'NKH' },
  { name: '上海虹桥', code: 'AOH' },
]

describe('search', () => {
  it('空输入返回空结果', () => {
    expect(search('', trains, stations)).toEqual({ trains: [], stations: [] })
    expect(search('   ', trains, stations)).toEqual({ trains: [], stations: [] })
  })
  it('车次精确匹配排最前，小写输入自动大写', () => {
    const r = search('g1', trains, stations)
    expect(r.trains[0].no).toBe('G1')
    expect(r.trains.map((t) => t.no)).toContain('G101') // 前缀匹配随后
  })
  it('前缀优先于包含', () => {
    const r = search('G10', trains, stations)
    expect(r.trains.map((t) => t.no)).toEqual(['G101', 'G103'])
  })
  it('车站前缀优先，截断数量', () => {
    const r = search('北京', trains, stations)
    expect(r.stations.map((s) => s.name)).toEqual(['北京南', '北京', '北京西'])
    const r2 = search('南', trains, stations)
    expect(r2.stations.length).toBeLessThanOrEqual(4)
    expect(r2.stations[0].name).toBe('南京南') // 前缀匹配优先
  })
  it('无匹配返回空', () => {
    const r = search('Zzzz', trains, stations)
    expect(r.trains).toEqual([])
    expect(r.stations).toEqual([])
  })
})
