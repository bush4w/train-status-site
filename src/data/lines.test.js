import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { CORRIDORS } from '../../scripts/data/corridors.mjs'
import { buildRailIndex, buildTrainPath, posAtKm, nearestOnIndex } from '../lib/snap'
import { buildRouteGraph, routePair } from '../lib/route-graph'

// 线位几何走 public/data/lines.json（运行时加载，不进主包）
const FILE = 'public/data/lines.json'
const railLines = JSON.parse(readFileSync(FILE, 'utf8'))

const stations = JSON.parse(readFileSync('public/data/stations.json', 'utf8'))
const byName = Object.fromEntries(stations.map((s) => [s.name, s]))

const allLines = [...(railLines.hsr ?? []), ...(railLines.conv ?? [])]
const KM_PER_DEG = 111.32

/** 点到线位的最近距离（km），用于挡住"瓦片没抓完就生成"的缺片数据 */
function minKmToLines(lat, lng) {
  const cosLat = Math.cos((lat * Math.PI) / 180)
  let best = Infinity
  for (const line of allLines) {
    for (let i = 1; i < line.length; i++) {
      const ax = (line[i - 1][1] - lng) * cosLat
      const ay = line[i - 1][0] - lat
      const bx = (line[i][1] - lng) * cosLat
      const by = line[i][0] - lat
      const dx = bx - ax
      const dy = by - ay
      const len2 = dx * dx + dy * dy
      let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(ax + t * dx, ay + t * dy) * KM_PER_DEG
      if (d < best) best = d
    }
  }
  return best
}

describe('railLines（OSM 真实线路几何，public/data/lines.json）', () => {
  it('文件存在且含 ODbL 归属声明', () => {
    expect(existsSync(FILE)).toBe(true)
    expect(railLines.attribution).toContain('OpenStreetMap')
    expect(railLines.attribution).toContain('ODbL')
  })

  it('结构合法：线为点列，点为 [lat,lng] 数值对', () => {
    for (const group of [railLines.hsr, railLines.conv]) {
      expect(Array.isArray(group)).toBe(true)
      for (const line of group) {
        expect(line.length).toBeGreaterThanOrEqual(2)
        for (const p of line) {
          expect(p).toHaveLength(2)
          expect(typeof p[0]).toBe('number')
          expect(typeof p[1]).toBe('number')
        }
      }
    }
  })

  it('坐标落在中国及中老铁路范围', () => {
    for (const group of [railLines.hsr, railLines.conv]) {
      for (const line of group) {
        for (const [lat, lng] of line) {
          expect(lat).toBeGreaterThan(15)
          expect(lat).toBeLessThan(56)
          expect(lng).toBeGreaterThan(70)
          expect(lng).toBeLessThan(140)
        }
      }
    }
  })

  it('生成后应有实际线路数据（占位文件为空则跳过强断言）', () => {
    if (railLines.generatedAt) {
      expect(railLines.counts.hsr).toBeGreaterThan(0)
      expect(railLines.hsr.length).toBe(railLines.counts.hsr)
    }
  })

  it('每条走廊的站点在线位数据中都有真实铁路（≤30km）', () => {
    const names = [...new Set(CORRIDORS.flatMap((c) => c.stations))]
    const checked = names.map((n) => byName[n]).filter(Boolean)
    expect(checked.length).toBeGreaterThanOrEqual(CORRIDORS.length * 2)
    for (const s of checked) {
      const km = minKmToLines(s.lat, s.lng)
      expect(km, `${s.name} 距最近线位 ${km.toFixed(0)}km，疑似瓦片未抓完就生成了 lines.json`).toBeLessThanOrEqual(30)
    }
  })

  it('走廊预计算线位齐备且首末点贴近首末站', () => {
    expect(railLines.corridors).toBeTruthy()
    for (const c of CORRIDORS) {
      const item = railLines.corridors[c.id]
      expect(item, `${c.name} 缺预计算线位`).toBeTruthy()
      expect(item.points.length).toBeGreaterThanOrEqual(2)
      const resolved = c.stations.map((n) => byName[n]).filter(Boolean)
      const head = resolved[0]
      const tail = resolved[resolved.length - 1]
      const [a0, a1] = item.points[0]
      const [b0, b1] = item.points[item.points.length - 1]
      const headKm = Math.hypot((a1 - head.lng) * Math.cos((head.lat * Math.PI) / 180), a0 - head.lat) * KM_PER_DEG
      const tailKm = Math.hypot((b1 - tail.lng) * Math.cos((tail.lat * Math.PI) / 180), b0 - tail.lat) * KM_PER_DEG
      expect(headKm, `${c.name} 首点离 ${head.name} ${headKm.toFixed(0)}km`).toBeLessThanOrEqual(30)
      expect(tailKm, `${c.name} 末点离 ${tail.name} ${tailKm.toFixed(0)}km`).toBeLessThanOrEqual(30)
    }
  })
})

describe('列车路径贴线（回归：广元→绵阳 曾回退为两站直线）', () => {
  const byCode = Object.fromEntries(stations.map((s) => [s.code, s]))
  const index = buildRailIndex(railLines)
  const graph = buildRouteGraph(railLines)
  const router = (a, b) => routePair(graph, a, b)
  const train = {
    no: 'T1',
    stops: [
      { code: 'GYW', arr: null, dep: '21:57' },
      { code: 'MYW', arr: '22:46', dep: null },
    ],
  }

  it('全程贴近最近线位（<3km），不再走弦线', () => {
    const path = buildTrainPath(train, byCode, index, new Map(), router)
    expect(path).toBeTruthy()
    expect(path.totalKm).toBeGreaterThan(150)
    for (let f = 0; f <= 1.001; f += 0.05) {
      const [lat, lng] = posAtKm(path, path.totalKm * f)
      const q = nearestOnIndex(index, lat, lng)
      expect(q).toBeTruthy()
      expect(Math.sqrt(q.d2) * KM_PER_DEG).toBeLessThan(3)
    }
  })
})
