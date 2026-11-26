// 随机化调度（US-14：更新时间尽可能随机，防止 12306 识别固定周期拒绝访问）
// 三层随机：
//   1. 轮次间隔 = base ± uniform(0, jitter) 分钟
//   2. 每轮开始前的预备抖动 = uniform(0, preDelayMax) 秒
//   3. 请求级：管道内 politeDelay 已有 1–3s 随机间隔 + 车次查询顺序洗牌

/**
 * 下一轮间隔（毫秒）：base ± uniform(0, jitter)，下限 1 分钟
 * @param {number} baseMin  基准间隔（分钟）
 * @param {number} jitterMin 抖动幅度（分钟）
 * @param {() => number} rand 随机源 [0,1)，默认 Math.random（测试可注入）
 */
export function nextIntervalMs(baseMin, jitterMin, rand = Math.random) {
  const delta = (rand() * 2 - 1) * jitterMin // [-jitter, +jitter]
  return Math.max(1, baseMin + delta) * 60 * 1000
}

/** 轮前预备抖动（毫秒）：uniform(0, maxSec) */
export function preDelayMs(maxSec, rand = Math.random) {
  return rand() * maxSec * 1000
}

/** Fisher–Yates 洗牌（返回新数组，不改动原数组）；用于随机化车次查询顺序 */
export function shuffled(arr, rand = Math.random) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
