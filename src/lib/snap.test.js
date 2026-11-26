import { describe, it, expect } from 'vitest'
import { buildRailIndex, nearestOnIndex, snapChord, buildTrainPath, posAtKm, kmFromStatus, distKm } from './snap'

// L 形线位：(0,0) → (0,0.02) → (0.01,0.02)（[lat,lng]）
const LINE = [[0, 0], [0, 0.02], [0.01, 0.02]]
const INDEX = buildRailIndex({ hsr: [LINE], conv: [] })
const KM_PER_DEG = 111.32

/** 点到折线的最近距离（km） */
function minKmToPolyline(lat, lng, pts) {
  let best = Infinity
  const cosLat = Math.cos((lat * Math.PI) / 180)
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]
    const [bx, by] = pts[i]
    const dx = (by - ay) * cosLat
    const dy = bx - ax
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : (((lng - ay) * cosLat) * dx + (lat - ax) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const d = Math.hypot((lng - (ay + (by - ay) * t)) * cosLat, lat - (ax + (bx - ax) * t)) * KM_PER_DEG
    if (d < best) best = d
  }
  return best
}

describe('nearestOnIndex', () => {
  it('点投影到最近线段', () => {
    const p = nearestOnIndex(INDEX, 0.001, 0.001)
    expect(p).not.toBeNull()
    expect(p.lat).toBeCloseTo(0, 3)
    expect(p.lng).toBeCloseTo(0.001, 3)
    expect(p.line).toBe(0)
  })
  it('超出 maxKm（无铁路可吸附）返回 null，交由弦线兜底', () => {
    expect(nearestOnIndex(INDEX, 1, 1)).toBeNull()
  })
  it('逐环外扩：偏离两格以上的点也能吸附', () => {
    // 纬度 32° 上一条东西向线；点在其北侧 0.15°（约 16.7km），旧实现 3×3 邻格会 miss
    const line = buildRailIndex({ hsr: [[[32, 105], [32, 105.2]]], conv: [] })
    const p = nearestOnIndex(line, 32.15, 105.1)
    expect(p).not.toBeNull()
    expect(Math.sqrt(p.d2) * KM_PER_DEG).toBeCloseTo(16.7, 0)
  })
  it('距离度量按经纬缩放：正北 10km 应算作 10km（纬度 32°）', () => {
    const line = buildRailIndex({ hsr: [[[32, 105], [32, 105.2]]], conv: [] })
    const p = nearestOnIndex(line, 32 + 10 / KM_PER_DEG, 105.1)
    expect(p).not.toBeNull()
    expect(Math.sqrt(p.d2) * KM_PER_DEG).toBeCloseTo(10, 1)
  })
  it('preferLine 在 1.5× 距离内保持同线', () => {
    // 两条平行线：LINE 在 lat=0，PARALLEL 在 lat=0.0008（约 0.8km 北侧）
    const parallel = [[0.0008, 0], [0.0008, 0.02]]
    const idx = buildRailIndex({ hsr: [LINE, parallel], conv: [] })
    // 点距 LINE 0.00035°，距 PARALLEL 0.00045°（比值 1.29 ≤ 1.5）
    const p = nearestOnIndex(idx, 0.00035, 0.005, 1)
    expect(p.line).toBe(1)
    // 不指定偏好时选更近的 LINE
    const q = nearestOnIndex(idx, 0.00035, 0.005)
    expect(q.line).toBe(0)
  })
})

describe('snapChord', () => {
  it('弦线吸附后经过线位拐角', () => {
    const seg = snapChord([0, 0], [0.01, 0.02], INDEX, 12, 30)
    expect(seg).not.toBeNull()
    // 吸附点都在线位上：要么 lat≈0，要么 lng≈0.02
    for (const [lat, lng] of seg) {
      const onVertical = Math.abs(lat) < 0.0005
      const onHorizontal = Math.abs(lng - 0.02) < 0.0005
      expect(onVertical || onHorizontal).toBe(true)
    }
    // 路径里程应大于弦线距离（沿线走更远）
    let pathKm = 0
    for (let i = 1; i < seg.length; i++) pathKm += distKm(seg[i - 1], seg[i])
    expect(pathKm).toBeGreaterThan(distKm([0, 0], [0.01, 0.02]))
  })
  it('超出 maxKm 返回 null（弦线兜底）', () => {
    expect(snapChord([0.5, 0.5], [0.51, 0.5], INDEX, 8, 5)).toBeNull()
  })
  it('弯线中段偏离弦线 11km 仍可吸附，采样按长度自适应', () => {
    // 弓形线位：站 A、B 在两端，弦线沿 lng 直连，中段离弦线 0.1°≈11km
    const rail = [[0, 0], [0.1, 0.1], [0.1, 0.35], [0, 0.45]]
    const idx = buildRailIndex({ hsr: [rail], conv: [] })
    const seg = snapChord([0, 0], [0, 0.45], idx)
    expect(seg).not.toBeNull()
    expect(seg.length).toBeGreaterThan(8) // 50km 弦线 → 自动加密到 ≥8 段
    for (const [lat, lng] of seg) expect(minKmToPolyline(lat, lng, rail)).toBeLessThan(0.2)
  })
})

describe('buildTrainPath / posAtKm / kmFromStatus', () => {
  const stationsMap = {
    A: { code: 'A', name: '甲', lat: 0, lng: 0 },
    B: { code: 'B', name: '乙', lat: 0.01, lng: 0.02 },
  }
  const train = { no: 'T1', stops: [{ code: 'A', arr: null, dep: '08:00' }, { code: 'B', arr: '09:00', dep: null }] }
  const path = buildTrainPath(train, stationsMap, INDEX, new Map())

  it('里程单调递增，起终点吸附到线位', () => {
    expect(path.pts.length).toBeGreaterThan(2)
    for (let i = 1; i < path.kmAt.length; i++) {
      expect(path.kmAt[i]).toBeGreaterThanOrEqual(path.kmAt[i - 1])
    }
    const start = posAtKm(path, 0)
    const end = posAtKm(path, path.totalKm)
    expect(start[0]).toBeCloseTo(0, 3)
    expect(end[0]).toBeCloseTo(0.01, 3)
    expect(end[1]).toBeCloseTo(0.02, 3)
  })

  it('posAtKm 沿线插值，不超过总里程', () => {
    const mid = posAtKm(path, path.totalKm / 2)
    expect(mid).toHaveLength(2)
    const over = posAtKm(path, path.totalKm * 2)
    expect(over[0]).toBeCloseTo(path.pts[path.pts.length - 1][0], 5)
  })

  it('kmFromStatus：运行中按区间比例，其余按站里程', () => {
    const running = { status: 'running', k: 0, progress: 0.5 }
    const km = kmFromStatus(path, running)
    expect(km).toBeGreaterThan(0)
    expect(km).toBeLessThan(path.totalKm)
    const stopped = { status: 'stopped', k: 1, progress: 0 }
    expect(kmFromStatus(path, stopped)).toBeCloseTo(path.stopKm[1])
    const pending = { status: 'pending', k: 0, progress: 0 }
    expect(kmFromStatus(path, pending)).toBe(0)
  })
})
