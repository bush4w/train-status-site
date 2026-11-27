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
 * 解析 queryTrainInfo/getTrainName 响应 → 全国车次目录
 * 实测（2026-11-26）：明文、无需浏览器态 cookies，单日约 1.4 万条
 * 格式：{ status:true, data:[{ station_train_code:"G1(北京南-上海虹桥)", train_no:"24000000G10L" }] }
 * @param {object} json
 * @returns {{code:string, route:string, train_no:string}[]}
 */
export function parseTrainNameList(json) {
  const rows = Array.isArray(json?.data) ? json.data : []
  return rows
    .map((r) => {
      const m = String(r.station_train_code || '').match(/^([A-Za-z0-9]+)\(([^)]*)\)$/)
      return m ? { code: m[1], route: m[2], train_no: r.train_no } : null
    })
    .filter(Boolean)
}

/**
 * 按公开车次号 + 起讫站精确匹配目录条目（避免同车次号不同区段的幽灵车/支线车）
 * @param {{code:string, route:string, train_no:string}[]} list
 * @param {string} code  如 'G1'
 * @param {string} start 始发站名，如 '北京南'
 * @param {string} end   终到站名，如 '上海虹桥'
 */
export function matchTrainByName(list, code, start, end) {
  return list.find((t) => t.code === code && t.route === `${start}-${end}`) || null
}

/**
 * 解析 zwdch/query（正晚点查询）响应消息 → 实际/预计时刻
 * 实测（2026-11-26，用户提供浏览器成功样本 + 复现验证）成功配方：
 *   POST cxlx=1 & cz=查询站名 & cc=车次 & czEn=encodeURI(站名).replace(/%/g,'-')
 *   ——不带 randCode 参数；Content-Type 须含 charset=UTF-8；
 *   cookie 带 _jc_save_zwdch_fromStation/_jc_save_zwdch_cxlx（页面 JS 提交前写入）
 * 消息格式：
 *   "G9次列车，北京南站出发时间为10:00"        → 实际出发（已过站/正点）
 *   "预计G1次列车，苏州北站出发时间为11:02"    → 预计出发（前方站）
 * 晚点分钟 = 返回时刻 − 图定时刻（由调用方比对时刻表得出）
 * @param {object} json zwdch/query 响应
 * @returns {{predicted:boolean, train:string, station:string, time:string}|null}
 */
export function parseDelayMessage(json) {
  const msg = json?.data?.message
  if (typeof msg !== 'string') return null
  const m = msg.match(/^(预计)?(.+?)次列车，(.+?)站出发时间为(\d{2}:\d{2})$/)
  if (!m) return null
  return { predicted: Boolean(m[1]), train: m[2], station: m[3], time: m[4] }
}

/**
 * 解析 czxx/queryByTrainNo 或 queryTrainInfo/query 响应 → 经停站数组
 * 两接口响应结构同构（2026-11-25/26 真实响应校准）：
 *   { data: { data: [{ station_name, station_train_code, arrive_time, start_time, station_no }] } }
 * 时间 "----" 表示无到/发时刻（始发站无到）；
 * **终到站的 start_time 被 12306 填为与 arrive_time 相同**（实测 G1 上海虹桥 11:24/11:24），
 * 归一为 null（终到站无发车）。
 * 注意：两接口对在途列车均只返回**图定时刻**（实测 N3/G9 在途对比零差异，2026-11-26），
 * 不含实际到发/正晚点字段；OT 字段实测恒为空数组。
 * @param {object} json
 * @returns {{name:string, arr:string|null, dep:string|null, no:string, arrDay:number|null, depDay:number|null}[]}
 */
export function parseTrainStops(json) {
  const rows = json?.data?.data
  if (!Array.isArray(rows)) return []
  const t = (v) => (v && v !== '----' && /^\d{2}:\d{2}$/.test(v) ? v : null)
  const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
  const dayNum = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  const stops = rows.map((r, i) => {
    const arr = t(r.arrive_time)
    const dep = t(r.start_time)
    const arrDay = arr == null ? null : dayNum(r.arrive_day_diff)
    // 无 start_day_diff 字段：发车日默认与到达日同日；
    // 若发车时刻早于到达时刻（如 23:50 到、00:10 发），视为次日。
    let depDay = null
    if (dep != null) {
      if (i === 0 || arr == null || arrDay == null) depDay = 0
      else depDay = arrDay + (toMin(dep) < toMin(arr) ? 1 : 0)
    }
    return { name: r.station_name, arr, dep, no: String(r.station_no ?? ''), arrDay, depDay }
  })
  if (stops.length) {
    stops[stops.length - 1].dep = null
    stops[stops.length - 1].depDay = null
  }
  return stops
}
