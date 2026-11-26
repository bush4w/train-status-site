import { describe, it, expect } from 'vitest'
import { trainTypeInfo, TRAIN_TYPES } from './train-type'

describe('trainTypeInfo（新版车次编排规定 2026-10）', () => {
  it('动车组族 7 字头 = 胶囊形', () => {
    expect(trainTypeInfo('X1')).toMatchObject({ letter: 'X', label: '新时速动车', shape: 'emu' })
    expect(trainTypeInfo('G1')).toMatchObject({ letter: 'G', label: '高速动车', speed: '350 km/h', shape: 'emu' })
    expect(trainTypeInfo('T109')).toMatchObject({ letter: 'T', label: '特快动车', shape: 'emu' }) // 新 T=300km/h 动车
    expect(trainTypeInfo('K101')).toMatchObject({ letter: 'K', label: '快速动车', shape: 'emu' }) // 新 K=200-250 动车
    expect(trainTypeInfo('D3617')).toMatchObject({ letter: 'D', label: '动集动车', shape: 'emu' })
    expect(trainTypeInfo('C20')).toMatchObject({ letter: 'C', label: '城际动车', shape: 'emu' })
    expect(trainTypeInfo('S124')).toMatchObject({ letter: 'S', label: '市郊列车', shape: 'emu' })
  })
  it('普速族 Z/N/V/Y = 机车形', () => {
    expect(trainTypeInfo('Z281')).toMatchObject({ letter: 'Z', label: '快速160', shape: 'loco' })
    expect(trainTypeInfo('N3')).toMatchObject({ letter: 'N', label: '快速140', shape: 'loco' })
    expect(trainTypeInfo('Y501')).toMatchObject({ letter: 'Y', shape: 'loco' })
  })
  it('V 字头号段细分：快速/普快/普慢', () => {
    expect(trainTypeInfo('V3651').label).toBe('快速120') // 1-5998
    expect(trainTypeInfo('V6061').label).toBe('普快120') // 6001-6998
    expect(trainTypeInfo('V7001').label).toBe('普慢120') // 7001-7998
  })
  it('Y 字头号段细分：专线/专列', () => {
    expect(trainTypeInfo('Y101').label).toBe('旅游专线')
    expect(trainTypeInfo('Y1001').label).toBe('旅游专列')
  })
  it('过渡期旧号：L 与纯数字', () => {
    expect(trainTypeInfo('L1234')).toMatchObject({ letter: 'L', label: '临时(旧)', shape: 'loco' })
    expect(trainTypeInfo('1461')).toMatchObject({ letter: '普', label: '普客(旧)', shape: 'loco' })
  })
  it('小写兼容；未知字头归其他', () => {
    expect(trainTypeInfo('g1')).toMatchObject({ letter: 'G' })
    expect(trainTypeInfo('A123').label).toBe('其他列车')
  })
  it('类型颜色互不相同（图例可辨识）', () => {
    const colors = TRAIN_TYPES.map((t) => t.color)
    expect(new Set(colors).size).toBe(colors.length)
  })
})
