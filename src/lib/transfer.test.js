import { describe, it, expect } from 'vitest'
import { findTransferRoutes } from './transfer.js'

const T = (no, stops) => ({ no, delay: 0, delayKnown: true, stops })

// 便捷构造停站：code, arr, dep, day
const S = (code, arr, dep, arrDay = 0, depDay = 0) => ({ code, arr, dep, arrDay, depDay })

describe('transfer · 一次中转建议', () => {
  it('找到同站换乘，并按总时长排序', () => {
    const trains = [
      T('G1', [S('A', null, '08:00'), S('M', '10:00', '10:05'), S('X', '12:00', '12:05')]),
      T('G2', [S('M', null, '10:20'), S('T', '12:00', null)]),
      T('G3', [S('M', null, '10:40'), S('T', '12:30', null)]),
    ]
    const res = findTransferRoutes(trains, ['A'], ['T'], 400)
    expect(res.map((r) => [r.leg1, r.leg2])).toEqual([
      ['G1', 'G2'],
      ['G1', 'G3'],
    ])
    expect(res[0]).toMatchObject({ transfer: 'M', waitMin: 20, totalMin: 240 })
  })

  it('换乘时间不足 10 分钟不采纳', () => {
    const trains = [
      T('G1', [S('A', null, '08:00'), S('M', '10:00', '10:05')]),
      T('G2', [S('M', null, '10:05'), S('T', '12:00', null)]),
    ]
    expect(findTransferRoutes(trains, ['A'], ['T'], 400)).toEqual([])
  })

  it('等待超过 3 小时不采纳', () => {
    const trains = [
      T('G1', [S('A', null, '08:00'), S('M', '10:00', '10:05')]),
      T('G2', [S('M', null, '13:10'), S('T', '15:00', null)]),
    ]
    expect(findTransferRoutes(trains, ['A'], ['T'], 400)).toEqual([])
  })

  it('直达车不当作中转段，也不会与自身换乘', () => {
    const trains = [T('G9', [S('A', null, '08:00'), S('M', '09:30', '09:35'), S('T', '11:00', null)])]
    expect(findTransferRoutes(trains, ['A'], ['T'], 400)).toEqual([])
  })

  it('跨零点换乘按绝对分钟计算', () => {
    const trains = [
      T('K1', [S('A', null, '23:00'), S('M', '23:50', '23:55')]),
      T('K2', [S('M', null, '00:20', 0, 1), S('T', '02:00', null, 1)]),
    ]
    const res = findTransferRoutes(trains, ['A'], ['T'], 1200)
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ waitMin: 30, totalMin: 180, dep2: 1460, arr2: 1560 })
  })

  it('已发车与超出总时长的组合被过滤', () => {
    const trains = [
      T('G1', [S('A', null, '06:00'), S('M', '08:00', '08:05')]),
      T('G2', [S('M', null, '08:20'), S('T', '10:00', null)]),
    ]
    expect(findTransferRoutes(trains, ['A'], ['T'], 8 * 60)).toEqual([])
  })

  it('limit 生效', () => {
    const trains = [
      T('G1', [S('A', null, '08:00'), S('M', '10:00', '10:05')]),
      ...Array.from({ length: 6 }, (_, i) =>
        T(`D${i}`, [S('M', null, `1${1 + i}:00`), S('T', `1${2 + i}:00`, null)]),
      ),
    ]
    expect(findTransferRoutes(trains, ['A'], ['T'], 0, { limit: 3 })).toHaveLength(3)
  })
})
