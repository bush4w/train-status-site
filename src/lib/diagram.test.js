import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  haversineKm,
  resolveCorridor,
  matchCorridorTrain,
  assignCorridorTrains,
  buildDiagram,
  corridorOfTrain,
  buildTrainJourney,
  CORRIDORS,
} from './diagram'

// 运行时数据（public/data），与 App 加载源一致
const stations = JSON.parse(readFileSync('public/data/stations.json', 'utf8'))
const trains = JSON.parse(readFileSync('public/data/trains.json', 'utf8'))
const stationsMap = Object.fromEntries(stations.map((s) => [s.code, s]))

const byName = Object.fromEntries(stations.map((s) => [s.name, s]))

describe('haversineKm', () => {
  it('北京—天津约 110km', () => {
    const km = haversineKm({ lat: 39.905, lng: 116.405 }, { lat: 39.085, lng: 117.2 })
    expect(km).toBeGreaterThan(95)
    expect(km).toBeLessThan(130)
  })
})

describe('resolveCorridor', () => {
  it('过滤未收录站，公里标单调递增', () => {
    const c = resolveCorridor(CORRIDORS.find((x) => x.id === 'jinghu-hsr'), byName)
    expect(c.stations.length).toBeGreaterThanOrEqual(20)
    expect(c.stations[0].name).toBe('北京南')
    expect(c.maxKm).toBeGreaterThan(1200)
    let prev = -1
    for (const s of c.stations) {
      expect(s.km).toBeGreaterThan(prev)
      prev = s.km
    }
  })
  it('所有走廊至少能解析出 2 站（站名与 12306 对齐）', () => {
    for (const c of CORRIDORS) {
      const r = resolveCorridor(c, byName)
      expect(r.stations.length, `${c.name} 解析站数过少`).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('matchCorridorTrain / buildDiagram', () => {
  const corridor = resolveCorridor(CORRIDORS.find((x) => x.id === 'jinghu-hsr'), byName)
  const code = (n) => byName[n].code

  const downTrain = {
    no: 'TEST1',
    delay: 0,
    stops: [
      { code: code('北京南'), arr: null, dep: '08:00' },
      { code: code('济南西'), arr: '09:30', dep: '09:32' },
      { code: code('上海虹桥'), arr: '12:00', dep: null },
    ],
  }
  const upTrain = {
    no: 'TEST2',
    delay: 5,
    stops: [
      { code: code('上海虹桥'), arr: null, dep: '14:00' },
      { code: code('南京南'), arr: '15:10', dep: '15:12' },
      { code: code('北京南'), arr: '18:30', dep: null },
    ],
  }
  const offRoute = {
    no: 'TEST3',
    delay: 0,
    stops: [
      { code: code('北京'), arr: null, dep: '08:00' },
      { code: code('天津'), arr: '09:00', dep: null },
    ],
  }

  it('下行匹配方向 down，上行匹配方向 up', () => {
    expect(matchCorridorTrain(downTrain, corridor).direction).toBe('down')
    expect(matchCorridorTrain(upTrain, corridor).direction).toBe('up')
  })
  it('仅 1 站重合的列车不属于走廊', () => {
    expect(matchCorridorTrain(offRoute, corridor)).toBeNull()
  })
  it('停站生成水平段（到发两点同 y），始发只有发车点、终到只有到达点', () => {
    const assigned = assignCorridorTrains([downTrain, upTrain, offRoute], corridor)
    expect(assigned).toHaveLength(2)
    const d = buildDiagram(corridor, assigned)
    const t1 = d.trains.find((t) => t.no === 'TEST1')
    expect(t1.pts[0]).toMatchObject({ x: 480, kind: 'dep' }) // 08:00 北京南发
    // 济南西 09:30到/09:32发 → 同 y 两点（水平停留段）
    const jinan = t1.pts.filter((p) => p.station === code('济南西'))
    expect(jinan).toHaveLength(2)
    expect(jinan[0].y).toBe(jinan[1].y)
    expect(jinan[1].x - jinan[0].x).toBe(2)
    const last = t1.pts[t1.pts.length - 1]
    expect(last).toMatchObject({ x: 720, kind: 'arr' }) // 12:00 终到
  })
  it('上行列车 y 随时间递减（↗）', () => {
    const assigned = assignCorridorTrains([upTrain], corridor)
    const d = buildDiagram(corridor, assigned)
    const pts = d.trains[0].pts
    expect(pts[0].y).toBeGreaterThan(pts[pts.length - 1].y)
  })
})

describe('buildTrainJourney（全程运行图）', () => {
  const corridors = CORRIDORS.map((c) => resolveCorridor(c, byName)).filter((c) => c.stations.length >= 3)
  const g1 = trains.find((t) => t.no === 'G1')
  const j = buildTrainJourney(g1, stationsMap, corridors)

  it('站序与累计里程单调递增，覆盖全部停站', () => {
    expect(j.stations).toHaveLength(g1.stops.length)
    for (let i = 1; i < j.stations.length; i++) {
      expect(j.stations[i].km).toBeGreaterThan(j.stations[i - 1].km)
    }
    expect(j.maxKm).toBeCloseTo(j.stations[j.stations.length - 1].km, 1)
  })

  it('每个站间区段都有归属（识别到走廊或标记为其他线路）', () => {
    expect(j.segments).toHaveLength(j.stations.length - 1)
    expect(j.lineBands.length).toBeGreaterThanOrEqual(1)
    for (const s of j.segments) expect(s).toHaveProperty('line')
  })

  it('匹配到的色带按站序排列且不重叠', () => {
    for (let i = 1; i < j.lineBands.length; i++) {
      expect(j.lineBands[i].fromStop).toBeGreaterThanOrEqual(j.lineBands[i - 1].toStop)
    }
    for (const b of j.lineBands) expect(b.toStop).toBeGreaterThan(b.fromStop)
  })

  it('跨日车次时间窗自动超过 1440 分钟（不被 0–24h 截断）', () => {
    const night = {
      no: 'N1',
      delay: 0,
      stops: [
        { code: byName['北京南'].code, arr: null, dep: '23:10' },
        { code: byName['上海虹桥'].code, arr: '04:30', arrDay: 1, dep: null },
      ],
    }
    const nj = buildTrainJourney(night, stationsMap, [])
    expect(nj.timeStart).toBe(1380) // 23:10 → 23:00 取整
    expect(nj.timeEnd).toBeGreaterThan(1440)
    expect(nj.stations[1].arr).toBe(1440 + 270)
    expect(nj.lineBands).toEqual([])
  })

  it('没有走廊数据时也能画出全程（segments 标记为 null）', () => {
    const g = buildTrainJourney(g1, stationsMap, [])
    expect(g.stations.length).toBe(g1.stops.length)
    expect(g.segments.every((s) => s.line === null)).toBe(true)
  })
})

describe('真实数据集成', () => {
  it('京沪高铁走廊能匹配到在图车次（含标杆 G1）', () => {
    const corridor = resolveCorridor(CORRIDORS.find((x) => x.id === 'jinghu-hsr'), byName)
    const assigned = assignCorridorTrains(trains, corridor)
    expect(assigned.length).toBeGreaterThanOrEqual(3)
    expect(assigned.some((a) => a.train.no === 'G1')).toBe(true)
  })
  it('corridorOfTrain 为 G1 找到京沪高铁', () => {
    const corridors = CORRIDORS.map((c) => resolveCorridor(c, byName)).filter((c) => c.stations.length >= 3)
    const g1 = trains.find((t) => t.no === 'G1')
    const c = corridorOfTrain(g1, corridors)
    expect(c).toBeTruthy()
    expect(c.name).toContain('京沪')
    // stationsMap 一致性
    expect(stationsMap[g1.stops[0].code]).toBeTruthy()
  })
})
