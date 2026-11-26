// 车次类型系统 — 依据现行铁路车次编排规定
// 双通道编码：填充色 = 车型；光环 = 正晚点状态（正点白环 / 晚点橙色脉冲环）
// 形状语言：动车组（G/D/C/S）= 胶囊形（流线头）；普速（Z/T/K/L/Y/纯数字等）= 圆角方形（机车轮廓）

export const TRAIN_TYPES = [
  { letter: 'G', label: '高速动车', color: '#C7000B', shape: 'emu' },
  { letter: 'D', label: '动车组', color: '#1F6FD6', shape: 'emu' },
  { letter: 'C', label: '城际动车', color: '#8E44AD', shape: 'emu' },
  { letter: 'S', label: '市郊通勤', color: '#9B59B6', shape: 'emu' },
  { letter: 'Z', label: '直达特快', color: '#1E8449', shape: 'loco' },
  { letter: 'T', label: '特快', color: '#0E8C8C', shape: 'loco' },
  { letter: 'K', label: '快速', color: '#B9770E', shape: 'loco' },
  { letter: 'L', label: '临时旅客', color: '#7F8C9B', shape: 'loco' },
  { letter: 'Y', label: '旅游列车', color: '#C9A227', shape: 'loco' },
]

const OTHER_LETTER = { letter: '?', label: '其他列车', color: '#6B7280', shape: 'loco' }
const PLAIN_NUMBER = { letter: '普', label: '普通旅客', color: '#6B7280', shape: 'loco' }

/**
 * 由车次号解析车型信息
 * @param {string} no 车次号，如 'G1' / 'K101' / '1461'
 */
export function trainTypeInfo(no) {
  const s = String(no || '').trim()
  const m = s.match(/^([A-Za-z])/)
  if (!m) return s ? PLAIN_NUMBER : OTHER_LETTER
  const found = TRAIN_TYPES.find((t) => t.letter === m[1].toUpperCase())
  return found || { ...OTHER_LETTER, letter: m[1].toUpperCase() }
}
