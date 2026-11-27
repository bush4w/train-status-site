// F4 正晚点着色：全网站统一的状态色
// 正点（delay = 0）→ 绿色；晚点（delay > 0）→ 橙色；未抽样实测（known=false）→ 中性灰
// 注意：delay 为 0 不代表实测正点——只有本轮抽样覆盖到的车次才有 delayKnown=true。

export const ON_TIME_COLOR = '#27ae60'
export const DELAY_COLOR = '#e67e22'
export const UNKNOWN_COLOR = '#9aa0a6'

export function statusColor(delay, known = true) {
  if (known === false) return UNKNOWN_COLOR
  return delay > 0 ? DELAY_COLOR : ON_TIME_COLOR
}

export const STATUS_TEXT = {
  pending: '待发车',
  running: '运行中',
  stopped: '停靠中',
  arrived: '已终到',
}
