// 监测全量动车抓取完成 → 自动执行收尾
//
// 完成信号：public/data/trains.json 的车次数 > 3000
//   （抓取进行中该文件保持旧的 ~151 趟；抓取完成时管道 emit 会写入全量数据）
//
// 收尾动作：
//   ① 晚点重采样（--delays-only，全量车次快照基础）
//   ② npm test（红线：推送前测试必过）
//   ③ 分支提交数据 → 合并 main
//   ④ 推送 Gitee + GitHub
//
// 用法：node scripts/watch-full-emu.mjs
// 日志：控制台 + .cache/watch-full-emu.log

import { execSync } from 'node:child_process'
import { readFileSync, appendFileSync, readdirSync } from 'node:fs'

const LOG = '.cache/watch-full-emu.log'
const MAX_WAIT_H = 12
const POLL_MIN = 5
const DONE_THRESHOLD = 3000

const log = (m) => {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${m}`
  console.log(line)
  try {
    appendFileSync(LOG, line + '\n')
  } catch {
    /* 日志失败不影响主流程 */
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd) => execSync(cmd, { stdio: 'inherit' })

function countTrains() {
  try {
    return JSON.parse(readFileSync('public/data/trains.json', 'utf8')).length
  } catch {
    return 0
  }
}
function countCache() {
  try {
    return readdirSync('.cache/railway/nat').length
  } catch {
    return 0
  }
}

async function main() {
  const start = Date.now()
  log(`监测启动：完成信号 trains.json > ${DONE_THRESHOLD} 趟；最长等待 ${MAX_WAIT_H} 小时`)
  let tick = 0
  for (;;) {
    if (Date.now() - start > MAX_WAIT_H * 3600e3) {
      log(`✗ 超过 ${MAX_WAIT_H} 小时未检测到完成信号，退出`)
      process.exit(1)
    }
    const n = countTrains()
    if (n > DONE_THRESHOLD) {
      log(`✓ 检测到全量数据：${n} 趟车次`)
      break
    }
    if (tick % 6 === 0) {
      log(`等待中… 时刻表缓存 ${countCache()} 个文件；当前 trains.json ${n} 趟`)
    }
    tick++
    await sleep(POLL_MIN * 60e3)
  }

  try {
    log('① 晚点重采样（--delays-only，使用全量快照）')
    sh('node scripts/fetch-railway-data.mjs --delays-only')

    log('② 运行完整测试（推送红线）')
    sh('npm test')

    log('③ 分支提交数据')
    sh('git checkout -B data/full-emu')
    sh('git add public/data/trains.json public/data/stations.json public/live/delays.json src/data/meta.js')
    sh('git commit -m "data: 全量动车时刻表 + 实时晚点重采样"')
    sh('git checkout main')
    sh('git merge data/full-emu --no-ff -m "merge: 全量动车数据"')

    log('④ 推送双远程')
    sh('git push gitee main')
    sh('git push origin main')

    log('✓ 全部收尾完成')
  } catch (e) {
    log(`✗ 收尾失败：${String(e.message).slice(0, 300)}`)
    process.exit(1)
  }
}

main()
