import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

// 线位几何走 public/data/lines.json（运行时加载，不进主包）
const FILE = 'public/data/lines.json'
const railLines = JSON.parse(readFileSync(FILE, 'utf8'))

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
})
