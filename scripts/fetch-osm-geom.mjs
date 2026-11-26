// OSM 铁路几何抓取（经代理访问 Overpass API）—— 瓦片化 + 自适应细分
//
// 背景：全国大 bbox 查询在繁忙的 Overpass 上必超时/502（2026-11-26 实测），
//       改为 6° 瓦片逐个抓取；单瓦片连续失败则四分为 3°/1.5° 子瓦片（最小 1.5°）。
//       逐瓦片落盘缓存，断点续抓；镜像轮转 + 指数退避。
//
// 用法：
//   node scripts/fetch-osm-geom.mjs                    # stations + hsr + conv 三层
//   node scripts/fetch-osm-geom.mjs --no-conventional  # 只抓 stations + hsr
//   node scripts/fetch-osm-geom.mjs --layers=hsr       # 只抓指定层（逗号分隔）
//   --proxy=http://127.0.0.1:10808 --max-wait-min=150
//
// 归属：数据 © OpenStreetMap contributors，ODbL 许可（生成数据中必须署名）。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)
const PROXY = args.proxy || 'http://127.0.0.1:10808'
const MAX_WAIT_MIN = Number(args['max-wait-min'] ?? 150)
const OUT_DIR = '.cache/osm/tiles'
const UA = 'train-status-site/1.0 (personal learning project; low-frequency tiled extraction)'

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

// 中国范围（含中老铁路境外段）：lat 17.5–54.5，lon 73–136
const BBOX = { s: 17.5, n: 54.5, w: 73, e: 136 }
const TILE0 = 6 // 初始瓦片边长（度）
const MIN_TILE = 1.5 // 最小瓦片边长

const LAYERS = {
  stations: (b) => `nwr["railway"~"^(station|halt)$"]["station"!~"^(subway|tram|light_rail)$"]${b};out center tags;`,
  hsr: (b) => `way["railway"="rail"]["highspeed"="yes"]${b};out geom;`,
  conv: (b) => `way["railway"="rail"]["usage"="main"]${b};out geom;`,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const politeWait = () => sleep(3000 + Math.random() * 5000) // 瓦片间 3–8s 随机

function enabledLayers() {
  if (args.layers) return String(args.layers).split(',').filter((l) => LAYERS[l])
  if (args['no-conventional']) return ['stations', 'hsr']
  return ['stations', 'hsr', 'conv']
}

function tileName(layer, size, lat, lon) {
  return `${layer}_s${size}_${lat}_${lon}.json`
}

function validJsonFile(f) {
  try {
    if (!existsSync(f) || statSync(f).size < 50) return false
    const head = Buffer.alloc(1)
    const fd = openSync(f, 'r')
    readSync(fd, head, 0, 1, 0)
    closeSync(fd)
    return head[0] === 0x7b // '{'
  } catch {
    return false
  }
}

// 单瓦片查询：镜像轮转 + 递增退避；返回 'ok' | 'retryable' | 'badquery'
async function fetchTile(layer, size, lat, lon) {
  const outFile = `${OUT_DIR}/${tileName(layer, size, lat, lon)}`
  if (validJsonFile(outFile)) return 'cached'
  const bbox = `(${lat},${lon},${Math.min(lat + size, BBOX.n)},${Math.min(lon + size, BBOX.e)})`
  const q = LAYERS[layer](bbox)
  const timeout = size >= 6 ? 300 : size >= 3 ? 240 : 180
  const plan = [
    { m: 0, wait: 0 },
    { m: 1, wait: 15 },
    { m: 2, wait: 30 },
    { m: 0, wait: 60 },
    { m: 1, wait: 120 },
  ]
  for (const step of plan) {
    if (step.wait) await sleep(step.wait * 1000)
    const mirror = MIRRORS[step.m]
    const host = new URL(mirror).host
    let status = 0
    try {
      status = Number(
        execFileSync(
          'curl',
          [
            '-s', '-x', PROXY,
            '--max-time', String(timeout + 60),
            '-A', UA,
            '-X', 'POST', mirror,
            '--data-urlencode', `data=[out:json][timeout:${timeout}];${q}`,
            '-o', outFile,
            '-w', '%{http_code}',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim(),
      )
    } catch {
      status = 0 // curl 超时/网络异常 → 可重试
    }
    if (status === 200 && validJsonFile(outFile)) {
      const mb = statSync(outFile).size / 1048576
      console.log(`✓ ${tileName(layer, size, lat, lon)} ${mb.toFixed(1)}MB @${host}`)
      return 'ok'
    }
    if (status === 400 || status === 422) {
      console.warn(`✗ ${layer} s${size} (${lat},${lon}) HTTP ${status} 查询错误 @${host}`)
      return 'badquery'
    }
    console.warn(`· ${layer} s${size} (${lat},${lon}) HTTP ${status || 'ERR'} @${host}，换镜像/退避`)
  }
  return 'retryable'
}

async function fetchLayer(layer, deadline) {
  // 初始瓦片队列（自西向东、自南向北）
  const queue = []
  for (let lat = BBOX.s; lat < BBOX.n; lat += TILE0) {
    for (let lon = BBOX.w; lon < BBOX.e; lon += TILE0) {
      queue.push({ size: TILE0, lat: +lat.toFixed(2), lon: +lon.toFixed(2) })
    }
  }
  const total0 = queue.length
  let done = 0
  let failed = 0
  console.log(`→ 层 ${layer}：${total0} 个 ${TILE0}° 瓦片（失败自动四分至 ${MIN_TILE}°）`)
  while (queue.length) {
    if (Date.now() > deadline) {
      console.warn(`⚠ 达到时间预算，层 ${layer} 剩余 ${queue.length} 瓦片（重跑本脚本续传）`)
      return { done, failed, incomplete: true }
    }
    const t = queue.shift()
    const r = await fetchTile(layer, t.size, t.lat, t.lon)
    if (r === 'ok' || r === 'cached') {
      done++
      if (done % 10 === 0) console.log(`  …${layer} 进度 ${done}/${total0}+（队列余 ${queue.length}）`)
    } else if (r === 'retryable') {
      if (t.size > MIN_TILE) {
        const h = t.size / 2
        queue.unshift(
          { size: h, lat: t.lat, lon: t.lon },
          { size: h, lat: t.lat, lon: +(t.lon + h).toFixed(2) },
          { size: h, lat: +(t.lat + h).toFixed(2), lon: t.lon },
          { size: h, lat: +(t.lat + h).toFixed(2), lon: +(t.lon + h).toFixed(2) },
        )
        console.log(`  ↳ 瓦片细分 ${layer} s${t.size} (${t.lat},${t.lon}) → 4×s${h}`)
      } else {
        failed++
        console.error(`✗ ${layer} 瓦片 (${t.lat},${t.lon}) s${t.size} 放弃`)
      }
    } else {
      failed++ // badquery：查询本身有问题，细分也没用
    }
    await politeWait()
  }
  console.log(`✓ 层 ${layer} 完成：成功 ${done}，失败 ${failed}`)
  return { done, failed, incomplete: false }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const deadline = Date.now() + MAX_WAIT_MIN * 60000
  const layers = enabledLayers()
  const summary = {}
  for (const layer of layers) {
    summary[layer] = await fetchLayer(layer, deadline)
    if (summary[layer].incomplete) break
  }
  const files = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json'))
  const totalMB = files.reduce((s, f) => s + statSync(`${OUT_DIR}/${f}`).size, 0) / 1048576
  console.log(`\n=== 汇总：${files.length} 个瓦片文件，共 ${totalMB.toFixed(1)}MB ===`)
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: 成功 ${v.done}，失败 ${v.failed}${v.incomplete ? '（未完成）' : ''}`)
  const anyFail = Object.values(summary).some((v) => v.failed > 0 || v.incomplete)
  process.exit(anyFail ? 1 : 0)
}

main()
