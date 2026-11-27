// 一次中转建议（M7 / F13 延伸）
// 纯函数：在本地时刻表里找「起点 → 换乘站 → 目标区县」的单次换乘组合。
// 约束：同站换乘（不处理同城换站/多段）、换乘 ≥10 分钟、等待 ≤3 小时、总时长 ≤36 小时。

import { absMin } from './access.js'

const DEFAULTS = {
  minTransferMin: 10,
  maxWaitMin: 180,
  horizonMin: 36 * 60,
  leg1WindowMin: 24 * 60,
  limit: 5,
}

const stopDep = (s) => absMin(s.dep ?? s.arr, s.depDay ?? s.arrDay)
const stopArr = (s) => absMin(s.arr ?? s.dep, s.arrDay ?? s.depDay)

/**
 * @param {Array} trains 车次（stops 含 code/arr/dep/arrDay/depDay）
 * @param {string[]} fromCodes 起点城市车站码
 * @param {string[]} toCodes 目标区县车站码
 * @param {number} nowAbs 当前绝对分钟
 * @param {object} [opts]
 * @returns {Array<{from,transfer,to,leg1,leg2,dep1,arr1,dep2,arr2,waitMin,totalMin,delay,delayKnown}>}
 */
export function findTransferRoutes(trains, fromCodes, toCodes, nowAbs, opts = {}) {
  const { minTransferMin, maxWaitMin, horizonMin, leg1WindowMin, limit } = { ...DEFAULTS, ...opts }
  const from = new Set(fromCodes ?? [])
  const to = new Set(toCodes ?? [])
  if (!from.size || !to.size) return []

  // 第二段候选：按「上车站」归档（只遍历目标站之前的停站，避免全组合爆炸）
  const leg2ByBoard = new Map()
  for (const t of trains) {
    const stops = t.stops
    for (let j = 1; j < stops.length; j++) {
      if (!to.has(stops[j].code)) continue
      const arr2 = stopArr(stops[j])
      if (arr2 == null || arr2 < nowAbs) continue
      for (let i = 0; i < j; i++) {
        const dep2 = stopDep(stops[i])
        if (dep2 == null || dep2 < nowAbs) continue
        if (to.has(stops[i].code)) continue
        const key = stops[i].code
        let bucket = leg2ByBoard.get(key)
        if (!bucket) leg2ByBoard.set(key, (bucket = []))
        bucket.push({ no: t.no, delay: t.delay ?? 0, delayKnown: t.delayKnown !== false, dep: dep2, arr: arr2, to: stops[j].code })
      }
    }
  }
  if (!leg2ByBoard.size) return []

  const best = new Map() // (leg1|换乘站|leg2) → 最优组合
  for (const t of trains) {
    const stops = t.stops
    for (let i = 0; i < stops.length - 1; i++) {
      if (!from.has(stops[i].code)) continue
      const dep1 = stopDep(stops[i])
      if (dep1 == null || dep1 < nowAbs || dep1 > nowAbs + leg1WindowMin) continue
      for (let j = i + 1; j < stops.length; j++) {
        const arr1 = stopArr(stops[j])
        if (arr1 == null) continue
        if (arr1 - dep1 > leg1WindowMin) break
        if (to.has(stops[j].code)) continue // 直达车不再当中转段
        const boards = leg2ByBoard.get(stops[j].code)
        if (!boards) continue
        for (const leg2 of boards) {
          if (leg2.no === t.no) continue
          const wait = leg2.dep - arr1
          if (wait < minTransferMin || wait > maxWaitMin) continue
          const total = leg2.arr - dep1
          if (total > horizonMin) continue
          const key = `${t.no}|${stops[j].code}|${leg2.no}`
          const prev = best.get(key)
          if (prev && prev.totalMin <= total) continue
          best.set(key, {
            from: stops[i].code,
            transfer: stops[j].code,
            to: leg2.to,
            leg1: t.no,
            leg2: leg2.no,
            dep1,
            arr1,
            dep2: leg2.dep,
            arr2: leg2.arr,
            waitMin: wait,
            totalMin: total,
            delay: t.delay ?? 0,
            delayKnown: t.delayKnown !== false,
            delay2: leg2.delay,
            delayKnown2: leg2.delayKnown,
          })
        }
      }
    }
  }

  return [...best.values()]
    .sort((a, b) => a.totalMin - b.totalMin || a.waitMin - b.waitMin || a.dep1 - b.dep1)
    .slice(0, limit)
}
