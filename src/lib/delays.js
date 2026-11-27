// 实时晚点合并：只有本轮抽样实测过的车次才标「正点/晚点」，
// 未覆盖的车次标记 delayKnown=false（前端显示为「未实测」），避免把未知当正点。
//
// delays.json 约定：
//   { generatedAt, delayAsOf, sampled: [车次], delays: { 车次: 分钟 } }
// 旧格式没有 sampled 字段，视为全量实测，保持向后兼容。

export function applyLiveDelays(trains, live) {
  if (!trains || !live?.delays) return trains
  const sampled = Array.isArray(live.sampled) ? new Set(live.sampled) : null
  let changed = false
  const out = trains.map((t) => {
    if (sampled) {
      const known = sampled.has(t.no)
      const delay = known ? (live.delays[t.no] ?? 0) : 0
      if (t.delay === delay && t.delayKnown === known) return t
      changed = true
      return { ...t, delay, delayKnown: known }
    }
    const v = live.delays[t.no]
    if (v == null || v === t.delay) return t
    changed = true
    return { ...t, delay: v }
  })
  return changed ? out : trains
}
