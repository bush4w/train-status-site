import { describe, it, expect } from 'vitest'
import { mergeCatalogEntries, groupByTrainNo, catalogStats, letterOf, isEmuLetter, pickBaselineDate } from './catalog.mjs'

describe('catalog 目录并集', () => {
  it('按 (code, train_no) 去重，保留同一 train_no 的不同车次号', () => {
    const merged = mergeCatalogEntries([
      { code: 'C1101', route: '通辽-沈阳', train_no: '16000C110404' },
      { code: 'C1101', route: '通辽-沈阳', train_no: '16000C110404' },
      { code: 'C1104', route: '通辽-沈阳', train_no: '16000C110404' },
      { code: 'G1', route: '北京南-上海虹桥', train_no: '24000000G10L' },
    ])
    expect(merged).toHaveLength(3)
  })

  it('按 train_no 分组：首个车次号为主，其余进 aliases', () => {
    const groups = groupByTrainNo([
      { code: 'C1101', route: '通辽-沈阳', train_no: 'T1' },
      { code: 'C1104', route: '通辽-沈阳', train_no: 'T1' },
      { code: 'G1', route: '北京南-上海虹桥', train_no: 'T2' },
    ])
    expect(groups).toHaveLength(2)
    const g = groups.find((x) => x.train_no === 'T1')
    expect(g.no).toBe('C1101')
    expect(g.aliases).toEqual(['C1104'])
    expect(g.route).toBe('通辽-沈阳')
  })

  it('统计车次号口径与动车/普速拆分', () => {
    const groups = groupByTrainNo([
      { code: 'G1', route: 'A-B', train_no: 'T1' },
      { code: 'C1101', route: 'C-D', train_no: 'T2' },
      { code: 'C1104', route: 'C-D', train_no: 'T2' },
      { code: 'Z16', route: 'E-F', train_no: 'T3' },
    ])
    const s = catalogStats(groups)
    expect(s.trainNo).toBe(3)
    expect(s.services).toBe(4)
    expect(s.emuServices).toBe(3)
    expect(s.convServices).toBe(1)
    expect(s.byLetter.C).toBe(2)
  })

  it('基线日期：取之前最近一天，且不超过回溯窗口', () => {
    expect(pickBaselineDate(['2026-11-25', '2026-11-27', '2026-11-28'], '2026-11-28')).toBe('2026-11-27')
    expect(pickBaselineDate(['2026-11-20'], '2026-11-28', 7)).toBe(null)
    expect(pickBaselineDate(['2026-11-21'], '2026-11-28', 7)).toBe('2026-11-21')
    expect(pickBaselineDate(['2026-11-28'], '2026-11-28')).toBe(null)
  })

  it('字头解析', () => {
    expect(letterOf('G1')).toBe('G')
    expect(letterOf('1461')).toBe('数字')
    expect(isEmuLetter('S')).toBe(true)
    expect(isEmuLetter('V')).toBe(false)
  })
})
