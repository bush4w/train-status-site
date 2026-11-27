// 全量抓取锁（跨进程）：防止 predev / 手动命令 / 定时任务重复启动
// 锁文件：.cache/full-fetch.lock { pid, startedAt, date }
// 判定：PID 存活且未超过 24h = 运行中；否则视为陈旧锁并清理。

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'

export const LOCK_FILE = '.cache/full-fetch.lock'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export function readLock() {
  try {
    if (!existsSync(LOCK_FILE)) return null
    return JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
  } catch {
    return null
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // Windows 上无权限探测已存在进程时会抛 EPERM，仍视为存活
    return e?.code === 'EPERM'
  }
}

export function isLocked() {
  const lock = readLock()
  if (!lock) return { running: false, lock: null }
  const stale = !isPidAlive(lock.pid) || Date.now() - Number(lock.startedAt || 0) > MAX_AGE_MS
  if (stale) {
    try {
      unlinkSync(LOCK_FILE)
    } catch {
      /* 已被其他进程清理 */
    }
    return { running: false, lock: null, stale: true }
  }
  return { running: true, lock }
}

/**
 * 获取锁；若锁属于当前进程（子进程继承父进程写入的 PID）则视为已持有。
 * @returns {{ok:boolean, lock?:object, owner?:object}}
 */
export function acquireLock(meta = {}) {
  const state = isLocked()
  if (state.running && state.lock.pid !== process.pid) return { ok: false, owner: state.lock }
  const lock = { pid: process.pid, startedAt: Date.now(), ...meta }
  try {
    mkdirSync('.cache', { recursive: true })
    writeFileSync(LOCK_FILE, JSON.stringify(lock))
  } catch {
    /* 锁写入失败不阻断抓取 */
  }
  return { ok: true, lock }
}

export function releaseLock() {
  const lock = readLock()
  if (lock && lock.pid !== process.pid) return
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE)
  } catch {
    /* 忽略 */
  }
}
