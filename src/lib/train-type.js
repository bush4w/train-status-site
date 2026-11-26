// 车次类型系统 — 依据新版《列车车次编排规定》
// 来源：央视新闻 2026-10-16《动车字头4个变7个 铁路车次编排改革启动》
//   https://news.cctv.com/2026/10/16/ARTI24EGvOC0E8oz3dvCr8va261016.shtml
// 换编节奏：第一批 2026-11 下旬（普速/旅游/货物）；第二批 2026-12 下旬（动车组族）
//
// 双通道编码：填充色+形状 = 车型速度等级；光环 = 正晚点状态
// 形状语言：动车组族（X/G/T/K/D/C/S）= 胶囊；普速族（Z/N/V/Y 及过渡旧号）= 圆角方形

export const TRAIN_TYPES = [
  { letter: 'X', label: '新时速动车', desc: '最高时速350公里以上复兴号动车组（预留更高速度等级）', speed: '350+ km/h', color: '#7D0A2B', shape: 'emu' },
  { letter: 'G', label: '高速动车', desc: '最高时速350公里复兴号动车组', speed: '350 km/h', color: '#C7000B', shape: 'emu' },
  { letter: 'T', label: '特快动车', desc: '最高时速300公里动车组', speed: '300 km/h', color: '#E8590C', shape: 'emu' },
  { letter: 'K', label: '快速动车', desc: '最高时速200–250公里动车组', speed: '200–250 km/h', color: '#B9770E', shape: 'emu' },
  { letter: 'D', label: '动集动车', desc: '最高时速200公里及以下动力集中动车组', speed: '≤200 km/h', color: '#1F6FD6', shape: 'emu' },
  { letter: 'C', label: '城际动车', desc: '最高时速200公里及以下局管内城际动车组', speed: '≤200 km/h', color: '#8E44AD', shape: 'emu' },
  { letter: 'S', label: '市郊列车', desc: '市域范围最高时速160公里及以下局管内旅客列车', speed: '≤160 km/h', color: '#9B59B6', shape: 'emu' },
  { letter: 'Z', label: '快速160', desc: '最高时速160公里快速旅客列车', speed: '160 km/h', color: '#1E8449', shape: 'loco' },
  { letter: 'N', label: '快速140', desc: '最高时速140公里快速旅客列车', speed: '140 km/h', color: '#0E8C8C', shape: 'loco' },
  { letter: 'V', label: '普速120', desc: '最高时速120公里普速旅客列车（快速/普快/普慢号段）', speed: '120 km/h', color: '#6B7280', shape: 'loco' },
  { letter: 'Y', label: '旅游列车', desc: '普速旅游专线（Y1-998）/旅游专列（Y1001-9998）', speed: '普速', color: '#C9A227', shape: 'loco' },
  // 过渡期旧号段（第一批已换编、第二批 12 月下旬完成前仍可能出现）
  { letter: 'L', label: '临时(旧)', desc: '旧编号临时旅客列车（过渡期）', speed: '—', color: '#7F8C9B', shape: 'loco' },
  { letter: '普', label: '普客(旧)', desc: '旧编号纯数字普客列车（过渡期）', speed: '—', color: '#9CA3AF', shape: 'loco' },
]

const OTHER_LETTER = { letter: '?', label: '其他列车', desc: '未归类字头', speed: '—', color: '#6B7280', shape: 'loco' }

function numPart(no) {
  return parseInt(String(no).replace(/^\D+/, ''), 10) || 0
}

/**
 * 由车次号解析车型信息（新版编排规定 + 号段细分）
 * @param {string} no 车次号，如 'X1' / 'G1' / 'V6061' / '1461'
 */
export function trainTypeInfo(no) {
  const s = String(no || '').trim()
  const m = s.match(/^([A-Za-z])/)
  if (!m) {
    const legacy = TRAIN_TYPES.find((t) => t.letter === '普')
    return s ? legacy : OTHER_LETTER
  }
  const up = m[1].toUpperCase()
  const base = TRAIN_TYPES.find((t) => t.letter === up)
  if (!base) return { ...OTHER_LETTER, letter: up }
  // V 字头号段细分：V1-5998 快速 / V6001-6998 普快 / V7001-7998 普慢
  if (up === 'V') {
    const n = numPart(s)
    if (n >= 7001 && n <= 7998) return { ...base, label: '普慢120', desc: '普通旅客慢车（V7001-V7998）' }
    if (n >= 6001 && n <= 6998) return { ...base, label: '普快120', desc: '普通旅客快车（V6001-V6998）' }
    return { ...base, label: '快速120', desc: '时速120公里快速旅客列车（V1-V5998）' }
  }
  // Y 字头号段细分：Y1-998 旅游专线 / Y1001-9998 旅游专列
  if (up === 'Y') {
    const n = numPart(s)
    return n >= 1001
      ? { ...base, label: '旅游专列', desc: '普速旅游专列（Y1001-Y9998）' }
      : { ...base, label: '旅游专线', desc: '普速旅游专线列车（Y1-Y998）' }
  }
  return base
}

/**
 * 车次所属线路网络，与 lines.json 的图层键同名
 * @param {string} no 车次号
 * @returns {'hsr'|'conv'} 高铁/动车组族 或 普速族
 */
export function trainCategory(no) {
  return trainTypeInfo(no).shape === 'emu' ? 'hsr' : 'conv'
}
