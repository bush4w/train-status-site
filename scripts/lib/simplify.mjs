// Douglas-Peucker 折线简化（纯函数，可测试）
// 用途：OSM 铁路几何降采样，全国路网控制在可渲染/可打包的体积内

// 点到线段 (p1→p2) 的垂直距离（度平面近似，简化用途足够）
export function pointSegDist(p, p1, p2) {
  const [y, x] = p
  const [y1, x1] = p1
  const [y2, x2] = p2
  const dx = x2 - x1
  const dy = y2 - y1
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1)
  let t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

/**
 * Douglas-Peucker 简化
 * @param {number[][]} pts [[lat,lng],...]
 * @param {number} tol 容差（度；0.002° ≈ 200m）
 * @returns {number[][]} 简化后的点列（首尾必保留）
 */
export function simplify(pts, tol) {
  if (pts.length <= 2 || tol <= 0) return pts
  // 迭代式 DP（避免长线上递归爆栈）
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()
    let maxD = -1
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      const d = pointSegDist(pts[i], pts[s], pts[e])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1
      stack.push([s, idx], [idx, e])
    }
  }
  const out = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

/** 坐标保留 5 位小数（~1m），减小生成文件体积 */
export function roundPts(pts) {
  return pts.map(([lat, lng]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5])
}
