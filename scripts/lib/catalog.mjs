// 车次目录并集与分组（纯函数，fixture 可测）
// 背景：getTrainName 单次响应会缺条目（同日多次抓取 14,400 / 14,776 / 10,652 条），
// 必须多次抓取 + 磁盘缓存做并集；同一 train_no 可能对应多个车次号（如 C1101/C1104），
// 抓取时按 train_no 去重，其余车次号作为 aliases 保留，避免重复请求与重复建车。

const LETTER_RE = /^([A-Za-z])/
const EMU_LETTERS = new Set(['X', 'G', 'T', 'K', 'D', 'C', 'S'])

export function letterOf(code) {
  const m = String(code || '').match(LETTER_RE)
  return m ? m[1].toUpperCase() : '数字'
}

export function isEmuLetter(letter) {
  return EMU_LETTERS.has(String(letter || '').toUpperCase())
}

/**
 * 目录条目去重：唯一键 (code, train_no)
 * @param {{code:string, route:string, train_no:string}[]} entries
 */
export function mergeCatalogEntries(entries) {
  const map = new Map()
  for (const e of entries ?? []) {
    if (!e?.code || !e?.train_no) continue
    const key = `${e.code}|${e.train_no}`
    if (!map.has(key)) map.set(key, { code: e.code, route: e.route ?? '', train_no: e.train_no })
  }
  return [...map.values()]
}

/**
 * 按 train_no 分组：no=主车次号，aliases=同一 train_no 的其余车次号
 * @param {{code:string, route:string, train_no:string}[]} entries 已去重
 */
export function groupByTrainNo(entries) {
  const groups = new Map()
  for (const e of entries ?? []) {
    if (!e?.train_no || !e?.code) continue
    let g = groups.get(e.train_no)
    if (!g) {
      g = { train_no: e.train_no, codes: [], routes: [] }
      groups.set(e.train_no, g)
    }
    if (!g.codes.includes(e.code)) g.codes.push(e.code)
    if (e.route && !g.routes.includes(e.route)) g.routes.push(e.route)
  }
  return [...groups.values()].map((g) => ({
    train_no: g.train_no,
    no: g.codes[0],
    aliases: g.codes.slice(1),
    route: g.routes[0] ?? '',
    routes: g.routes,
  }))
}

/**
 * 组合并集的统计（车次号口径 + train_no 口径）
 */
export function catalogStats(groups) {
  const byLetter = {}
  let services = 0
  for (const g of groups ?? []) {
    services += 1 + (g.aliases?.length ?? 0)
    for (const code of [g.no, ...(g.aliases ?? [])]) {
      const l = letterOf(code)
      byLetter[l] = (byLetter[l] ?? 0) + 1
    }
  }
  let emu = 0
  let conv = 0
  for (const [l, n] of Object.entries(byLetter)) {
    if (isEmuLetter(l)) emu += n
    else conv += n
  }
  return { trainNo: groups?.length ?? 0, services, emuServices: emu, convServices: conv, byLetter }
}
