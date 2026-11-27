// F5 车次/车站搜索（纯函数，可测试）

/**
 * @param {string} query 用户输入
 * @param {object[]} trains  [{no, ...}]
 * @param {object[]} stations [{name, code, ...}]
 * @returns {{trains: object[], stations: object[]}} 车次优先，各截断
 */
export function search(query, trains, stations, maxTrains = 6, maxStations = 4) {
  const q = String(query || '').trim()
  if (!q) return { trains: [], stations: [] }
  const qu = q.toUpperCase()

  // 车次：精确 > 前缀 > 包含（同时匹配 aliases：同一 train_no 的其他车次号）
  const exact = []
  const prefix = []
  const includes = []
  for (const t of trains) {
    const names = [t.no, ...(t.aliases ?? [])].map((n) => String(n).toUpperCase())
    if (names.some((n) => n === qu)) exact.push(t)
    else if (names.some((n) => n.startsWith(qu))) prefix.push(t)
    else if (names.some((n) => n.includes(qu))) includes.push(t)
  }
  const matchedTrains = [...exact, ...prefix, ...includes].slice(0, maxTrains)

  // 车站：前缀 > 包含（中文无大小写）
  const stPrefix = []
  const stIncludes = []
  for (const s of stations) {
    if (s.name.startsWith(q)) stPrefix.push(s)
    else if (s.name.includes(q)) stIncludes.push(s)
  }
  const matchedStations = [...stPrefix, ...stIncludes].slice(0, maxStations)

  return { trains: matchedTrains, stations: matchedStations }
}
