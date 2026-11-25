// 12306 station_name.js 解析器（纯函数，fixture 可测）
// 实测格式（2026-11-25）：
//   var station_names ='@bjb|北京北|VAP|beijingbei|bjb|0|0357|北京|||@...';
// 字段：拼音缩写|车站名|电报码|全拼|拼音首字母|序号|路局码|城市|||

/**
 * 解析 station_name.js 文本 → 车站对象数组
 * 注意：把响应当纯文本解析，绝不 eval（下载内容不可信）
 * @param {string} text
 * @returns {{name:string, code:string, pinyin:string, abbr:string, city:string}[]}
 */
export function parseStationNameJs(text) {
  const m = text.match(/station_names?\s*=\s*'([^']*)'/)
  const body = m ? m[1] : text
  return body
    .split('@')
    .filter(Boolean)
    .map((seg) => {
      const f = seg.split('|')
      return {
        abbr: f[0] || '',
        name: f[1] || '',
        code: f[2] || '',
        pinyin: f[3] || '',
        city: f[7] || '',
      }
    })
    .filter((s) => s.name && /^[A-Z]{3}$/.test(s.code))
}

/** 按站名索引（合并坐标/时刻表用） */
export function indexByName(stations) {
  return Object.fromEntries(stations.map((s) => [s.name, s]))
}

/** 按电报码索引 */
export function indexByCode(stations) {
  return Object.fromEntries(stations.map((s) => [s.code, s]))
}
