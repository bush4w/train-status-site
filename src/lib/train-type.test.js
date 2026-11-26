import { describe, it, expect } from 'vitest'
import { trainTypeInfo, TRAIN_TYPES } from './train-type'

describe('trainTypeInfo（车次编排规定分类）', () => {
  it('字母车次按首字母归类，小写兼容', () => {
    expect(trainTypeInfo('G1')).toMatchObject({ letter: 'G', label: '高速动车', shape: 'emu' })
    expect(trainTypeInfo('D3617')).toMatchObject({ letter: 'D', shape: 'emu' })
    expect(trainTypeInfo('C20')).toMatchObject({ letter: 'C', label: '城际动车' })
    expect(trainTypeInfo('Z281')).toMatchObject({ letter: 'Z', shape: 'loco' })
    expect(trainTypeInfo('T109')).toMatchObject({ letter: 'T', label: '特快' })
    expect(trainTypeInfo('K101')).toMatchObject({ letter: 'K', label: '快速' })
    expect(trainTypeInfo('y501')).toMatchObject({ letter: 'Y', label: '旅游列车' })
    expect(trainTypeInfo('S124')).toMatchObject({ letter: 'S', label: '市郊通勤' })
    expect(trainTypeInfo('L1234')).toMatchObject({ letter: 'L', label: '临时旅客' })
  })
  it('纯数字车次 = 普通旅客', () => {
    expect(trainTypeInfo('1461')).toMatchObject({ letter: '普', label: '普通旅客', shape: 'loco' })
  })
  it('未知字母前缀归其他（如局管内 N/V 字头）', () => {
    const t = trainTypeInfo('N715')
    expect(t.label).toBe('其他列车')
    expect(t.letter).toBe('N')
  })
  it('颜色互不相同（图例可辨识）', () => {
    const colors = TRAIN_TYPES.map((t) => t.color)
    expect(new Set(colors).size).toBe(colors.length)
  })
})
