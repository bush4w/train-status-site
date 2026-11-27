import { describe, it, expect } from 'vitest'
import { parseStationNameJs, indexByName, indexByCode, normalizeStationName } from './station-parser.mjs'

// fixture 复刻 2026-11-25 实测的 station_name.js 格式（含特殊电报码）
const FIXTURE =
  "var station_names ='@bjn|北京南|VNP|beijingnan|bjn|3|0357|北京|||" +
  '@zjn|镇江南|ZEH|zhenjiangnan|zjn|1623|0706|镇江|||' +
  '@czb|常州北|ESH|changzhoubei|czb|335|0708|常州|||' +
  "@szb|苏州北|OHH|suzhoubei|szb|1216|0710|苏州|||';"

describe('parseStationNameJs', () => {
  it('解析站名/电报码/城市（含 E/O 开头特殊码）', () => {
    const stations = parseStationNameJs(FIXTURE)
    expect(stations).toHaveLength(4)
    expect(stations[0]).toMatchObject({ name: '北京南', code: 'VNP', city: '北京' })
    expect(stations[1]).toMatchObject({ name: '镇江南', code: 'ZEH' })
    expect(stations[2]).toMatchObject({ name: '常州北', code: 'ESH' })
    expect(stations[3]).toMatchObject({ name: '苏州北', code: 'OHH' })
  })

  it('过滤非法电报码条目', () => {
    const bad = "var station_names ='@xx|坏站|BADCODE|x|xx|0|0|某城|||@ok|好站|OKK|ok|ok|1|0|某城|||';"
    const stations = parseStationNameJs(bad)
    expect(stations).toHaveLength(1)
    expect(stations[0].code).toBe('OKK')
  })

  it('无变量声明的裸文本也能解析', () => {
    const stations = parseStationNameJs('@bjn|北京南|VNP|beijingnan|bjn|3|0357|北京|||')
    expect(stations[0].code).toBe('VNP')
  })

  it('按站名/电报码索引', () => {
    const stations = parseStationNameJs(FIXTURE)
    expect(indexByName(stations)['北京南'].code).toBe('VNP')
    expect(indexByCode(stations)['ZEH'].name).toBe('镇江南')
  })

  it('规范化站名：去空白与尾缀「站」，索引键可直接匹配', () => {
    expect(normalizeStationName('惠州  北')).toBe('惠州北')
    expect(normalizeStationName(' 北京南站 ')).toBe('北京南')
    const stations = parseStationNameJs(FIXTURE)
    const idx = indexByName(stations)
    expect(idx[normalizeStationName('北京 南')].code).toBe('VNP')
    expect(idx[normalizeStationName('镇江南站')].code).toBe('ZEH')
  })
})
