// 定时自动刷新：以随机间隔重跑数据管道（US-14 防风控）
//
// 用法：
//   npm run refresh                     # 常驻循环（默认 15±8 分钟随机间隔）
//   npm run refresh:once                # 只刷一轮
//   node scripts/auto-refresh.mjs --base-min=20 --jitter-min=10
//
// 随机化设计（三层）：
//   轮次间隔 base±jitter（均匀分布，下限 1 分钟）→ 轮前预备抖动 0–90s → 管道内请求间隔 1–3s + 车次顺序洗牌
// 日志：控制台 + .cache/refresh.log（gitignored）
// Ctrl+C 退出；数据文件原子性由管道自身保证（失败时保留上一轮数据）

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { nextIntervalMs, preDelayMs } from './lib/schedule.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)
const BASE_MIN = Number(args['base-min'] ?? 15)
const JITTER_MIN = Number(args['jitter-min'] ?? 8)
const PRE_DELAY_MAX_SEC = 90
const LOG = '.cache/refresh.log'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`
  console.log(line)
  try {
    mkdirSync('.cache', { recursive: true })
    appendFileSync(LOG, line + '\n')
  } catch { /* 日志失败不影响主流程 */ }
}

function runPipeline() {
  return new Promise((resolve) => {
    // 定时轮次只做正晚点抽样刷新（~25 请求/轮，轻量防风控）；
    // 时刻表全量刷新请手动跑 npm run fetch（运行图调整周期约数周一次）
    const child = spawn(process.execPath, ['scripts/fetch-railway-data.mjs', '--delays-only'], { stdio: 'inherit' })
    child.on('close', (code) => resolve(code === 0))
  })
}

async function main() {
  const once = Boolean(args.once)
  log(`自动刷新启动：间隔 ${BASE_MIN}±${JITTER_MIN} 分钟（随机），轮前抖动 0–${PRE_DELAY_MAX_SEC}s${once ? '，单轮模式' : ''}`)
  for (;;) {
    const pre = preDelayMs(PRE_DELAY_MAX_SEC)
    log(`轮前抖动 ${Math.round(pre / 1000)}s`)
    await sleep(pre)
    const ok = await runPipeline()
    log(ok ? '本轮刷新完成 ✓' : '本轮刷新失败 ✗（保留上一轮数据，下轮重试）')
    if (once) break
    const wait = nextIntervalMs(BASE_MIN, JITTER_MIN)
    log(`下轮约 ${Math.round(wait / 60000)} 分钟后`)
    await sleep(wait)
  }
}

process.on('SIGINT', () => {
  log('收到退出信号，自动刷新停止')
  process.exit(0)
})

main()
