import { describe, it, expect } from 'vitest'
import { computeTrainPosition } from './position'

// 测试用简化路网：A(0,0) → B(1,1) → C(2,2)
const stationsMap = {
  A: { name: '甲站', lat: 0, lng: 0 },
  B: { name: '乙站', lat: 1, lng: 1 },
  C: { name: '丙站', lat: 2, lng: 2 },
}

// A 08:00 发 → B 09:00 到 09:10 发 → C 10:00 到
const train = {
  no: 'G999',
  delay: 0,
  stops: [
    { code: 'A', arr: null, dep: '08:00' },
    { code: 'B', arr: '09:00', dep: '09:10' },
    { code: 'C', arr: '10:00', dep: null },
  ],
}

const at = (h, m = 0) => h * 60 + m

describe('computeTrainPosition', () => {
  it('首站发车前：待发车，位于始发站', () => {
    const pos = computeTrainPosition(train, stationsMap, at(7, 30))
    expect(pos.status).toBe('pending')
    expect(pos.lat).toBe(0)
    expect(pos.lng).toBe(0)
    expect(pos.stopIndex).toBe(0)
    expect(pos.label).toContain('甲站')
  })

  it('恰在发车时刻：进入区间，进度为 0', () => {
    const pos = computeTrainPosition(train, stationsMap, at(8))
    expect(pos.status).toBe('running')
    expect(pos.lat).toBe(0)
    expect(pos.lng).toBe(0)
    expect(pos.stopIndex).toBe(0)
    expect(pos.nextIndex).toBe(1)
  })

  it('区间中点：线性插值到两站正中', () => {
    const pos = computeTrainPosition(train, stationsMap, at(8, 30))
    expect(pos.status).toBe('running')
    expect(pos.lat).toBeCloseTo(0.5)
    expect(pos.lng).toBeCloseTo(0.5)
    expect(pos.label).toBe('甲站 → 乙站')
    expect(pos.nextStation).toBe('乙站')
    expect(pos.arrTime).toBe('09:00')
  })

  it('中间站停靠期间：位于该站，状态 stopped', () => {
    const pos = computeTrainPosition(train, stationsMap, at(9, 5))
    expect(pos.status).toBe('stopped')
    expect(pos.lat).toBe(1)
    expect(pos.lng).toBe(1)
    expect(pos.stopIndex).toBe(1)
    expect(pos.label).toContain('乙站')
  })

  it('末站到站后：已终到，位于终到站', () => {
    const pos = computeTrainPosition(train, stationsMap, at(10, 30))
    expect(pos.status).toBe('arrived')
    expect(pos.lat).toBe(2)
    expect(pos.lng).toBe(2)
    expect(pos.stopIndex).toBe(2)
  })

  it('晚点列车位置落后：delay=15 在 09:15 的位置 == 正点车在 09:00 的位置', () => {
    const delayed = { ...train, delay: 15 }
    const posDelayed = computeTrainPosition(delayed, stationsMap, at(9, 15))
    const posOnTime = computeTrainPosition(train, stationsMap, at(9))
    expect(posDelayed.lat).toBeCloseTo(posOnTime.lat)
    expect(posDelayed.lng).toBeCloseTo(posOnTime.lng)
    expect(posDelayed.delay).toBe(15)
  })

  it('晚点使未到站变为待发车：delay=30 在 08:20 尚未发车', () => {
    const delayed = { ...train, delay: 30 }
    const pos = computeTrainPosition(delayed, stationsMap, at(8, 20))
    expect(pos.status).toBe('pending')
    expect(pos.delay).toBe(30)
  })

  it('正点车 delay 输出为 0', () => {
    const pos = computeTrainPosition(train, stationsMap, at(8, 30))
    expect(pos.delay).toBe(0)
  })
})

// 跨零点：A 21:12 发 → B 23:50 到 / 次日 00:10 发 → C 次日 07:29 到
const overnight = {
  no: 'Z16',
  delay: 0,
  startOffset: 0,
  stops: [
    { code: 'A', arr: null, dep: '21:12', arrDay: null, depDay: 0 },
    { code: 'B', arr: '23:50', dep: '00:10', arrDay: 0, depDay: 1 },
    { code: 'C', arr: '07:29', dep: null, arrDay: 1, depDay: null },
  ],
}

describe('跨零点位置推算', () => {
  it('当日 22:00：A→B 运行中', () => {
    const pos = computeTrainPosition(overnight, stationsMap, at(22))
    expect(pos.status).toBe('running')
    expect(pos.label).toBe('甲站 → 乙站')
  })

  it('次日 00:05：B 站停靠（到 23:50 / 发 00:10）', () => {
    const pos = computeTrainPosition(overnight, stationsMap, 1440 + 5)
    expect(pos.status).toBe('stopped')
    expect(pos.label).toContain('乙站')
  })

  it('次日 03:00：B→C 运行中（进度约 0.43）', () => {
    const pos = computeTrainPosition(overnight, stationsMap, 1440 + 180)
    expect(pos.status).toBe('running')
    expect(pos.label).toBe('乙站 → 丙站')
    expect(pos.progress).toBeGreaterThan(0.3)
    expect(pos.progress).toBeLessThan(0.6)
  })

  it('昨日始发（startOffset=-1）：今日 03:00 仍在 B→C 运行', () => {
    const y = { ...overnight, startOffset: -1 }
    const pos = computeTrainPosition(y, stationsMap, at(3))
    expect(pos.status).toBe('running')
    expect(pos.label).toBe('乙站 → 丙站')
  })

  it('昨日始发：今日 08:00 已终到', () => {
    const y = { ...overnight, startOffset: -1 }
    const pos = computeTrainPosition(y, stationsMap, at(8))
    expect(pos.status).toBe('arrived')
    expect(pos.lat).toBe(2)
  })
})
