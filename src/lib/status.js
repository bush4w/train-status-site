// F4 正晚点着色：全网站统一的状态色
// 正点（delay = 0）→ 绿色；晚点（delay > 0）→ 橙色

export const ON_TIME_COLOR = '#27ae60'
export const DELAY_COLOR = '#e67e22'

export function statusColor(delay) {
  return delay > 0 ? DELAY_COLOR : ON_TIME_COLOR
}

export const STATUS_TEXT = {
  pending: '待发车',
  running: '运行中',
  stopped: '停靠中',
  arrived: '已终到',
}
