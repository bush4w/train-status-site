// 站名规范化（纯函数）
// 12306 目录/时刻表偶发站名内含空格（如「合肥 南」「惠州  北」），
// 与车站表/坐标表匹配前必须去掉全部空白与尾缀「站」。
// 注意：只用于匹配键，不改变展示名。

export function normalizeStationName(name) {
  if (!name) return ''
  return String(name).trim().replace(/\s+/g, '').replace(/站$/, '')
}
