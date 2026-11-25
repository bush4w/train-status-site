// 12306 浏览器态接口响应解析器（M2 预留管道，M3 启用）
//
// 背景（2026-11-25 实测，详见 PRD §5）：
// - leftTicket/queryG 对非浏览器会话返回密文（flag=1 仍加密），需浏览器态 cookies
// - czxx/queryByTrainNo 存活且明文，但需当前 train_no（从 leftTicket 明文结果获取）
// 字段映射依据官方前端 queryLeftTicket JS 的 cO 解析函数（已提取验证）。

/**
 * 判断 leftTicket result 是否加密（明文条目含大量 | 分隔符）
 * @param {string[]} result
 */
export function isEncryptedResult(result) {
  return Array.isArray(result) && result.length > 0 && !result[0].includes('|')
}

/**
 * 解析 leftTicket 明文条目（字段映射来自官方 cO 函数）
 * @param {string} entry  '|' 分隔字符串
 */
export function parseLeftTicketEntry(entry) {
  const f = entry.split('|')
  return {
    secretStr: f[0],
    train_no: f[2],
    station_train_code: f[3],
    start_station_telecode: f[4],
    end_station_telecode: f[5],
    from_station_telecode: f[6],
    to_station_telecode: f[7],
    start_time: f[8],
    arrive_time: f[9],
    lishi: f[10],
    canWebBuy: f[11],
    start_train_date: f[13],
  }
}

/**
 * 解析 czxx/queryByTrainNo 响应 → 经停站数组
 * 响应格式（2026-11-25 浏览器态真实响应校准）：
 *   { data: { data: [{ station_name, station_train_code, arrive_time, start_time, station_no }] } }
 * 时间 "----" 表示无到/发时刻（始发站无到）；
 * **终到站的 start_time 被 12306 填为与 arrive_time 相同**（实测 G1 上海虹桥 11:24/11:24），
 * 归一为 null（终到站无发车）。
 * @param {object} json
 * @returns {{name:string, arr:string|null, dep:string|null, no:string}[]}
 */
export function parseTrainStops(json) {
  const rows = json?.data?.data
  if (!Array.isArray(rows)) return []
  const t = (v) => (v && v !== '----' && /^\d{2}:\d{2}$/.test(v) ? v : null)
  const stops = rows.map((r) => ({
    name: r.station_name,
    arr: t(r.arrive_time),
    dep: t(r.start_time),
    no: String(r.station_no ?? ''),
  }))
  if (stops.length) stops[stops.length - 1].dep = null
  return stops
}
