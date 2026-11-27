// 启动前数据检查：数据过期/不完整时，在后台拉起全量抓取，不阻塞 Vite。
//
// 触发方式：npm run dev / npm run preview（package.json 的 predev / prepreview）
// 手动：npm run data:ensure
// 跳过：SKIP_FULL_FETCH=1 npm run dev
//
// 判定：public/data/status.json 缺失、dataDate 不是今天、complete!==true、
//       或车次 < 10000 / 车站 < 3400 → 需要全量抓取。
// 锁：.cache/full-fetch.lock（抓取进程写入，防重复）。

import { existsSync, readFileSync, mkdirSync, openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { isLocked } from './lib/lock.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATUS = resolve(ROOT, 'public/data/status.json')
const LOG = resolve(ROOT, '.cache/full-fetch.log')
const SCRIPT = resolve(ROOT, 'scripts/fetch-railway-data.mjs')

function todayStr() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS, 'utf8'))
  } catch {
    return null
  }
}

function needsFetch(status, today) {
  if (!status) return '缺少 status.json'
  if (status.dataDate !== today) return `数据日期 ${status.dataDate} ≠ 今天 ${today}`
  if (status.complete !== true) return '上次抓取未完成'
  if ((status.counts?.trains ?? 0) < 10000) return `车次仅 ${status.counts?.trains ?? 0}（目标 ≥ 10000）`
  if ((status.counts?.stations ?? 0) < 3400) return `车站仅 ${status.counts?.stations ?? 0}（目标 ≥ 3400）`
  return null
}

const today = todayStr()
if (process.env.SKIP_FULL_FETCH === '1') {
  console.log('[data] SKIP_FULL_FETCH=1，跳过全量抓取检查')
  process.exit(0)
}

const lockState = isLocked()
if (lockState.running) {
  console.log(`[data] 全量抓取已在运行（pid ${lockState.lock.pid}，${lockState.lock.date ?? '日期未知'}），不重复启动`)
  process.exit(0)
}

const status = readStatus()
const reason = needsFetch(status, today)
if (!reason) {
  console.log(
    `[data] 数据已就绪：${status.dataDate} · ${status.counts?.trains ?? 0} 车次 / ${status.counts?.stations ?? 0} 车站 / ${status.counts?.services ?? '-'} 班次`,
  )
  process.exit(0)
}

if (process.env.DRY_RUN === '1') {
  console.log(`[data] DRY_RUN：将启动 ${process.execPath} ${SCRIPT} --full --date=${today}`)
  process.exit(0)
}

mkdirSync(resolve(ROOT, '.cache'), { recursive: true })
const fd = openSync(LOG, 'a')
const child = spawn(process.execPath, [SCRIPT, '--full', `--date=${today}`], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', fd, fd],
  env: { ...process.env, FULL_FETCH_CHILD: '1' },
})
child.unref()

console.log(`[data] ${reason}，已在后台启动全量抓取（pid ${child.pid}）`)
console.log(`[data] 日志：${LOG}`)
console.log('[data] 抓取期间页面使用旧数据；完成后顶部会提示刷新（或手动刷新页面）')
