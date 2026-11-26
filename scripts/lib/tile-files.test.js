import { describe, it, expect } from 'vitest'
import { isLayerTile } from './tile-files.mjs'

describe('isLayerTile（瓦片文件名匹配，防前缀双下划线回归）', () => {
  it('正常瓦片匹配', () => {
    expect(isLayerTile('hsr_s6_35.5_103.json', 'hsr')).toBe(true)
    expect(isLayerTile('conv_s3_31_121.json', 'conv')).toBe(true)
    expect(isLayerTile('stations_s6_39.5_115.json', 'stations')).toBe(true)
  })
  it('层名带下划线时不应匹配（历史 bug：hsr_ + _s = hsr__s*）', () => {
    expect(isLayerTile('hsr_s6_35.5_103.json', 'hsr_')).toBe(false)
    expect(isLayerTile('hsr__s6_35.5_103.json', 'hsr_')).toBe(true) // 双下划线本身是错误命名
  })
  it('跨层不误匹配', () => {
    expect(isLayerTile('hsr_s6_1_1.json', 'conv')).toBe(false)
    expect(isLayerTile('stations_s6_1_1.json', 'hsr')).toBe(false)
  })
  it('非 JSON 与大写扩展名', () => {
    expect(isLayerTile('hsr_s6_1_1.txt', 'hsr')).toBe(false)
    expect(isLayerTile('hsr_s6_1_1.JSON', 'hsr')).toBe(false)
  })
})
