# 全国列车运行状态网站

> 在一张全国地图上，看见此刻哪些列车在跑、跑到哪里、正点还是晚点。

个人学习与演示项目，**非官方、非商业**，与 12306 / 中国国家铁路集团无任何关联。

列车位置由「时刻表 + 正晚点」推算，**不是 GPS 实时定位**；正晚点为每轮约 24 趟在途车的抽样实测值，可能滞后。**未被抽样覆盖的车次显示为「未实测」（灰色），不代表正点**。所有数据仅供参考，**不得作为行程决策依据**。

---

## 功能

| 能力 | 说明 |
|------|------|
| 全国动态地图 | 高德中文瓦片底图 + Leaflet，缩放 4–18，列车点位随当前时间移动 |
| 真实线位 | 列车沿 OSM 铁路几何吸附行驶，而非站间直线；绕行线路用路网最短路径兜底；选中车次时高亮它的实际路径 |
| 全程运行图 | 点开车次按它自己的停站铺纵轴，横轴为全程时间窗（跨日可超 24h），同区段其他车次淡显，已收录线路标色带 |
| 准实时位置 | 时刻表线性插值，叠加实测正晚点偏移；待发车 / 运行中 / 停靠 / 已终到四态 |
| 车次详情 | 车次、起讫、状态、晚点、当前区间、前方站预计到达、全程时刻表（高亮当前站） |
| 正晚点识别 | 正点绿 / 晚点橙 / 未实测灰；只有本轮抽样实测过的车次才判定正晚点，晚点车带橙色呼吸光环，选中车带蓝色光环 |
| 搜索定位 | 车次号与车站名搜索（精确 > 前缀 > 包含），一键飞行定位 |
| 时间轴回放 | 0–48h（当日 + 次日）拖动即时重算全部列车位置，可回放或预演全天运行，跨零点车次连续 |
| 线路运行图 | 20 条主要客运走廊的时间-距离图：斜线=运行、水平段=停站、交点=会让/越行、红线=当前时刻；打开时自动定位到当前时刻 |
| 缩放分级 | 远景只显示大站快车与枢纽站，放大逐步放开快车、动车、普速与全部车站（同屏上限 800） |
| 线路图层 | 全部 / 高铁 / 普速 三种视图，同步过滤底图线路、列车、图例与晚点榜单 |
| 区县与直达 | 缩放 7 级显示区县边界（5–6 级为地市），点击区县查看收录车站与从起点**直达**的车次（发到时刻、历时、跨日、晚点态）；直达不足时给出**同站一次中转**建议（换乘 ≥10 分钟、等待 ≤3 小时）；起点可切换附近枢纽站或使用浏览器定位 |
| 车型剪影 | 按新版车次编排规定区分车型：动车组=流线胶囊，普速=机车轮廓；颜色区分类别 |
| 全量目录 | 启动时检查数据日期/完整度；过期或不足自动后台全量抓取（含普速、跨零点），不阻塞页面 |
| 数据自动刷新 | 定时任务以 15±8 分钟随机间隔抽样晚点；前端 45–75 秒随机轮询，页面无需重建即可更新 |

## 界面布局

```text
┌──────────────────────────────────────────────────────────┐
│ ┌─控制面板────────┐                      ┌─车次详情────┐ │
│ │ 搜索框           │                      │ G1          │ │
│ │ 时钟 / 倍速      │        地  图         │ 状态 / 晚点 │ │
│ │ 暂停 / 回到实时  │      （列车剪影）      │ 时刻表      │ │
│ └──────────────────┘                      └─────────────┘ │
│           ┌─时间轴 0–48h─┐              ┌─图例（可折叠）─┐│
│           └──────────────┘              └────────────────┘│
└──────────────────────────────────────────────────────────┘
```

## 快速开始

要求：Node.js ≥ 18（开发环境使用 Node 26）、npm。

```bash
git clone https://github.com/bush4w/train-status-site.git
cd train-status-site
npm install
npm run dev          # 固定 http://localhost:5173
```

仓库已内置数据快照（车站 / 车次 / 线位 / 晚点），**克隆后无需抓取即可运行**。

`npm run dev` / `npm run preview` 启动前会自动执行 `scripts/ensure-data.mjs`：若 `public/data/status.json` 不是当天、未完成或车次不足 10,000，会在后台拉起全量抓取（不阻塞 Vite），日志写入 `.cache/full-fetch.log`，页面顶部显示进度，完成后提示刷新。设置 `SKIP_FULL_FETCH=1` 可跳过检查。

端口固定为 5173（dev）/ 4173（preview），并启用 `strictPort`：上次的服务器没退出时会直接提示端口被占用，而不是自动换到 5174；结束旧进程后重启即可。

生产构建与本地预览：

```bash
npm run build        # 产物在 dist/
npm run preview
npm test             # 全部单测（算法 + 数据完整性）
```

## 常用命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 启动开发服务器（固定 5173，端口被占用时直接报错） |
| `npm run build` | 生产构建到 `dist/` |
| `npm run preview` | 预览生产构建（固定 4173） |
| `npm test` | 运行全部单元测试（Vitest） |
| `npm run fetch` | 抓取全国车次目录、时刻表（带缓存）与正晚点抽样（默认配额采样） |
| `npm run fetch:all` | 全量抓取：目录并集 + 所有车次（含普速/跨零点），可续跑 |
| `npm run data:ensure` | 手动执行启动前数据检查（必要时后台拉起全量抓取） |
| `npm run fetch:jinghu` | 京沪高铁高精模式（少量标杆车，快速验证） |
| `npm run build:counties` | 抓取/简化区县边界并把车站归属到区县（约 370 请求，可续跑） |
| `npm run refresh` | 常驻自动刷新：15±8 分钟随机间隔重跑管道 |
| `npm run refresh:once` | 只刷新一轮 |

## 开发与分支流程

- 一个阶段一条分支（`feat/`、`fix/`、`data/`、`docs/`、`chore/` + slug），从最新 `main` 切出。
- 每次改动经确认后立即提交，并推送到该分支的 `origin` + `gitee` 同名远程，不让确认过的改动留在本地。
- 阶段结束（路线图里程碑完成或用户宣布）才合并：`npm test` + `npm run build` 通过 → `git merge --no-ff <branch>` 到 `main` → 双远程推送 → 删除阶段分支。
- 提交粒度、消息格式与不入库文件清单见仓库根目录 [`AGENTS.md`](AGENTS.md)。

## 数据管道

前端是纯静态站点，数据由 `scripts/` 下的 Node 管道离线生成。所有抓取请求间隔 1–3 秒随机，仅作低频只读访问。

### 1. 12306 数据

```bash
# 全国模式（默认）：车次目录 + 时刻表（缓存复用）+ 正晚点抽样
npm run fetch

# 全量：目录多次并集 + 所有车次（含普速、跨零点），可续跑
npm run fetch:all
# 等价：node scripts/fetch-railway-data.mjs --full

# 仅刷新正晚点（约 25 请求/轮，适合定时任务；全量抓取期间自动跳过）
node scripts/fetch-railway-data.mjs --delays-only

# 京沪高铁高精模式
npm run fetch:jinghu

# 强制重抓时刻表（忽略缓存）
node scripts/fetch-railway-data.mjs --refresh-timetables

# 全离线（只用 .cache 与快照）
node scripts/fetch-railway-data.mjs --offline

# 全量模式的可选参数
node scripts/fetch-railway-data.mjs --full --limit=100 --no-delay   # 冒烟
node scripts/fetch-railway-data.mjs --full --concurrency=2          # 显式提高并发（默认 1）
node scripts/fetch-railway-data.mjs --full --no-reuse               # 不复用跨日期缓存
```

全量模式的行为：

- **目录并集**：同一天抓 3 次 `getTrainName`，并合并磁盘上该日期的全部目录缓存（单次响应会缺条目，实测同日 10.6k–17.2k 条）。
- **按 `train_no` 去重**：同一内部编号只抓一次时刻表，多个车次号写入 `aliases`（如 C1101/C1104），不重复建车。
- **跨日期复用**：当日无缓存时，复用最近 7 天内任意日期的时刻表；`--refresh-timetables` / `--no-reuse` 可强制重抓。
- **限流与续跑**：默认单 worker、1–3s 随机；失败重试 2 次，403/429 暂停 60s；每车缓存落盘，中断重跑自动续。
- **耗时**：首次全量约 1.5–2.5 小时；次日通常 20–40 分钟（大量缓存复用）。本次 11-27 为 11,768 趟复用 / 791 趟新抓。
- **锁**：`.cache/full-fetch.lock` 防止 `predev`、手动命令、定时任务重复启动；全量期间 `--delays-only` 只更新 `delays.json`，不覆盖主数据。

主要数据源：

- `station_name.js`：全国车站名与电报码
- `queryTrainInfo/getTrainName`：当日全国车次目录（含内部 `train_no`）
- `queryTrainInfo/query`：车次全程时刻表
- `zwdch/query`：正晚点（对在途车次抽样；未发车车次不受理）

### 2. OSM 铁路线位

```bash
# 默认抓取 stations + hsr + conv 三层，瓦片化 + 断点续传
node scripts/fetch-osm-geom.mjs --proxy=http://127.0.0.1:10808

# 也可只抓线位
node scripts/fetch-osm-geom.mjs --layers=hsr,conv --proxy=http://127.0.0.1:10808

# 无本地代理时直连（Overpass 容量波动，失败自动退避/细分）
node scripts/fetch-osm-geom.mjs --layers=stations --proxy=direct

# 续跑会跳过已有瓦片；父瓦片已有子瓦片时直接下钻，不重复重试

# 合并 OSM way → 端点串联 → 简化 → public/data/lines.json
node scripts/build-lines.mjs

# 只更新车站精确坐标，跳过线路构建
node scripts/build-lines.mjs --stations-only

# 把 OSM 精确坐标同步进 public/data/stations.json（不重跑时刻表抓取）
node scripts/apply-station-coords.mjs

# 缺口补片：找出退化成「站点直线」的站对，按 0.5° 网格补抓 railway=rail
node scripts/fetch-osm-gaps.mjs --dry-run   # 先看要补哪些网格
node scripts/fetch-osm-gaps.mjs             # 抓取（Overpass 忙时自动退避重试）
```

推荐顺序：`npm run fetch`（生成车站表缓存）→ OSM 抓取 → `build-lines.mjs` → 再跑一次 `npm run fetch` 采用 OSM 精确站点坐标。区县与直达另跑 `npm run build:counties`（边界 + 车站归属）。只想更新车站坐标时：`build-lines.mjs --stations-only` → `apply-station-coords.mjs`。线位有缺口时再跑 `fetch-osm-gaps.mjs` → `build-lines.mjs`。

### 3. 数据流

```text
ensure-data.mjs（predev）──▶ 检查 status.json ──▶ 后台 fetch-railway-data.mjs --full
                                                        │
12306 station_name.js ─┐                                 │
12306 queryTrainInfo  ─┼─▶ fetch-railway-data.mjs ─▶ public/data/{stations,trains,status}.json
12306 zwdch/query     ─┘        （1–3s 限流）          public/data/fetch-report.json
                                                       public/live/{delays,fetch-status}.json
                                                       src/data/meta.js
OSM Overpass ─▶ fetch-osm-geom.mjs ─▶ build-lines.mjs ─▶ public/data/lines.json
                                                              │
                                          Vite 静态托管 ◀─────┘
                                                   │
                                                   ▼
                                     React + Leaflet（运行时 fetch）
```

## 架构与算法

技术栈：Vite 5 + React 18 + Leaflet 1.9，无后端、无数据库；数据以 JSON 快照随静态站点发布。

- **位置推算** `src/lib/position.js`：按当前时间在相邻到发时刻间求区间序号与进度；晚点分钟数使有效时间整体后移。
- **线位吸附** `src/lib/snap.js`：站对弦线按长度自适应采样（约每 6 km 一点）→ 逐环扩窗投影到最近的铁路线段（同线优先、同线补点防切弯）→ 去回访环 → 形成路径；停站用站坐标收尾（站台离主线超过 1.2 km 时沿用线位点）→ 运行时按里程二分插值取坐标。吸附失败先拉大半径重试，仍无几何的区间标记为 `degraded`，前端画虚线。
- **绕行兜底** `src/lib/route-graph.js`：吸附失败或跳线过大时，在线位节点图上做多源 Dijkstra（两端各取若干主线候选节点），求真实路径并校验绕行比例。长直边按 2 km 插节点，避免简化后的长边附近没有图节点、车站吸附不上。
- **运行图** `src/lib/diagram.js`：走廊视角——车次与走廊有序匹配（下行/上行），以公里标为纵轴、分钟为横轴生成折线；车次视角——`buildTrainJourney` 按该车全部停站铺纵轴，不依赖走廊定义，匹配到的走廊只用于区段线路名标注。
- **区县与直达** `scripts/build-counties.mjs` + `src/lib/access.js`：区县边界取自公开行政区划数据（GCJ-02），Douglas-Peucker 简化后按视野 LOD 渲染；构建期用点在多边形内把车站落到区县（GCJ 归属命中 99.8%，失败率过高时自动回退 WGS 复测）；直达查询在本地时刻表里找「起点城市任一站 → 目标区县任一站」的最晚可上车站对，按绝对分钟处理跨日。
- **车型系统** `src/lib/train-type.js`：按新版《列车车次编排规定》解析字头与号段，输出颜色、形状与速度等级。
- **坐标转换** `src/lib/coord.js`：数据统一 WGS-84，渲染前转 GCJ-02 以对齐高德瓦片。

前端首次加载 `public/data/` 下的车站、车次与线位 JSON，列车路径在浏览器内分批构建；地图标记每 500ms 同步一次，车站与列车按缩放级别分层显示。

## 目录结构

```text
.
├─ public/
│  ├─ data/
│  │  ├─ stations.json      # 车站（电报码 / 名称 / 城市 / WGS-84 坐标 / 是否精确）
│  │  ├─ trains.json        # 车次（车次号 / aliases / 起讫 / 内部编号 / 跨日 / 经停时刻表）
│  │  ├─ status.json        # 数据日期 / 完整度 / 规模（启动检查用）
│  │  ├─ fetch-report.json  # 全量抓取报告（跳过原因 / 未定位站名）
│  │  ├─ lines.json         # OSM 铁路线位（高铁 hsr + 普速 conv）
│  │  └─ counties.json      # 地市/区县边界（简化）+ 区县内车站码（M6a）
│  └─ live/
│     ├─ delays.json        # 正晚点抽样快照（定时刷新）
│     └─ fetch-status.json  # 全量抓取进度（前端顶部进度条）
├─ scripts/
│  ├─ fetch-railway-data.mjs  # 12306 车站 / 车次 / 时刻表 / 正晚点管道（--full 全量）
│  ├─ ensure-data.mjs         # 启动前检查；必要时后台拉起全量抓取
│  ├─ fetch-osm-geom.mjs      # Overpass 瓦片化线位抓取
│  ├─ build-counties.mjs      # 区县边界抓取/简化 + 车站归属
│  ├─ fetch-osm-gaps.mjs      # 缺口补片：按直线兜底的站对补抓线位网格
│  ├─ build-lines.mjs         # 线位串联、拆折返、简化与车站坐标匹配（含 --stations-only）
│  ├─ apply-station-coords.mjs # 把 OSM 站坐标同步进 stations.json（不重跑抓取）
│  ├─ auto-refresh.mjs        # 随机间隔定时刷新（全量期间自动跳过）
│  ├─ data/                   # 城市坐标、补充站坐标、客运走廊、京沪线定义
│  └─ lib/                    # 解析 / 目录并集 / 地理编码 / 锁 / 站名匹配 / 调度（含测试）
├─ src/
│  ├─ components/             # 地图 / 控制面板 / 详情 / 搜索 / 时间轴 / 运行图
│  ├─ lib/                    # 位置 / 吸附 / 路由 / 运行图 / 车型 / 坐标 / 状态
│  ├─ data/meta.js            # 数据来源、生成日期、统计与免责声明
│  ├─ App.jsx
│  └─ styles.css
├─ index.html
├─ vite.config.js
└─ package.json
```

## 数据文件说明

| 文件 | 内容 |
|------|------|
| `stations.json` | `code` 电报码、`name` 站名、`city` 城市、`lat`/`lng`（WGS-84）、`precise` 是否实测坐标；全量后 3,764 站（含 351 个 `synthetic:true` 插值经停站） |
| `trains.json` | `no` 主车次号、`aliases` 同一内部编号的其他车次号、`route` 起讫、`train_no`、`delay`、`crossDay` 是否跨日、`durationMin`、`startOffset`、`stops[]` 各站 `code`/`arr`/`dep`/`arrDay`/`depDay` |
| `status.json` | `dataDate` 数据日期、`generatedAt`、`complete`、`counts`（车站/车次/班次） |
| `fetch-report.json` | 全量抓取报告：目录规模、入库车次/班次、跳过原因、未定位站名、缓存命中/在线抓取数 |
| `lines.json` | `hsr` 与 `conv` 两组 `[[lat,lng],...]` 折线（已简化；高铁 way 不再重复进普速层，串联产生的折返线会被拆开），以及 20 条走廊的构建期预计算线位 `corridors`；含 OSM 署名、容差与 `stats`（跨层去重 / 拆折返条数） |
| `counties.json` | 地市 `cities[]` / 区县 `counties[]`：`code` 行政区划码、`name`、`city`/`province`、`center`、`polys`（外环点列，GCJ-02，已简化）与 `stations`（按点面归属的车站电报码）；`stationsAssigned/Total` 记录归属覆盖率 |
| `delays.json` | `delayAsOf` 抽样时间、`sampled` 本轮实测车次列表、`delays` 实测车次 → 晚点分钟（不含未抽样车次） |
| `fetch-status.json` | 全量抓取进度（`running`/`phase`/`done`/`total`），前端顶部进度条轮询 |

当前快照（2026-11-27 全量）：**3,764 个车站**（3,413 个客运站 + 351 个时刻表插值经停站）、**12,558 趟 / 16,181 班次**（动车组 11,064、普速 1,494；跨零点 1,107 趟）。目录并集为 12,548 个 `train_no` / 16,171 班次，抓取跳过空/失败 1 趟、时刻非单调 1 趟、站点未覆盖 0。实际值以 `public/data/status.json` 为准。

> 数据快照随仓库发布。若要让线上站点显示最新晚点，需要运行刷新后更新部署目录中的 `public/live/delays.json`（本项目无后端，前端只轮询静态文件）。

## 合规与数据来源

- **定位**：个人学习与演示项目，不商业化、不对外运营；不提供购票、订单、登录等功能。
- **抓取**：仅访问 12306 公开查询端点；请求间隔 1–3 秒，轮次随机，不对服务器造成压力；被拒绝即停止。
- **展示**：页面常驻「非官方实时，仅供参考」；正晚点标注抽样时间；`meta.js` 分层披露数据来源。
- **数据来源**：
  - 车站电报码、车次目录、时刻表、正晚点：12306（非官方接口）
  - 铁路线位与部分车站坐标：© OpenStreetMap contributors，ODbL 许可
  - 区县行政区划边界：阿里云 DataV.GeoAtlas（公开数据，仅示意）
  - 底图瓦片：高德地图
  - 其余城市级坐标：公开地理信息整理

## 已知限制

- **车次覆盖**：当前 12,558 趟 / 16,181 班次，目录并集 12,548 个 `train_no` / 16,171 班次；跳过空/失败 1 趟、时刻非单调 1 趟、站点未覆盖 0。极少数幽灵车/无法定位支线会在 `fetch-report.json` 中列出。
- **目录快照不稳**：`getTrainName` 单次响应会缺条目（同日实测 10.6k–17.2k 条），全量模式用「3 次在线 + 磁盘同日缓存」并集缓解；极端情况下仍可能有少量当日新加/临时车次未入目录。
- **跨零点车次**：已支持「当日出发、次日到达」的完整入库与位置推算（本次 1,107 趟）；前一日出发、当日仍在途的车次（需要多日实例键）暂不进入当日地图。
- **坐标精度**：3,354 站为 OSM 实测站房坐标（含按线位就近修正，解决了县级站被地理编码到上级市的问题）；351 个时刻表经停小站用同车次前后已知站坐标插值（`synthetic:true`，误差取决于站间距）；59 站仍是城市级近似。另有约 50 个站所在支线尚未抓取线位，路径会以站点直线穿过。
- **晚点时效**：每轮只对约 24 趟在途车抽样实测，刷新间隔 15±8 分钟；未覆盖车次在前端标注「未实测」，不参与晚点榜单。正晚点接口配方可能随 12306 改版失效。
- **时刻表日期**：快照对应抓取当日运行图；启动时若 `dataDate` 不是当天会自动后台重抓。
- **全量耗时**：首次全量约 1.5–2.5 小时；次日复用缓存通常 20–40 分钟（本次 11-27：11,768 趟复用 / 791 趟新抓）。抓取期间页面使用旧数据，完成后顶部提示刷新。
- **无后端**：所有数据在浏览器本地计算，不做服务端推送，也不做视野级按需加载。
- **运行图跨日**：走廊运行图横轴固定 0–24h，跨零点车只画当日段；车次全程运行图按该车自身时间窗铺轴，跨日会扩展到 24h 以后。
- **线位质量**：取决于 OSM 数据完整度，个别区段可能缺失或与实际走向有偏差；缺几何的区间在选中车次路径上以灰色虚线标出。
- **区县边界**：公开行政区划数据，仅作示意、不具法律效力；直辖市按区参与「地市/区县」两级展示，个别省直辖县级单位会以单列条目出现。
- **直达覆盖**：只覆盖已收录车次（12,558 趟）与快照当日运行图；目标区县无车站或 36 小时内无直达时给出同站一次中转建议，仍无解时如实空状态。中转只处理同站换乘（不处理同城换站/多段），且不校验两段余票与接续可行性。
- **起点**：默认取全国视图中心最近的大枢纽站（西安北），不随地图移动；可手动切换区县附近枢纽或使用浏览器定位（定位仅本地计算，不上传）。
- **区县内容**：热门内容与本地景点（M6b）尚未接入整理数据，面板只展示时刻表可推导的信息。

## 路线图

- [x] 全量车次接入（12,558 趟 / 16,181 班次）
- [x] 全量目录抓取（含普速、站名规范化、经停站对账、启动自动运行）
- [x] 跨零点（当日出发、次日到达）
- [ ] 前一日出发、当日在途的多日实例模型
- [x] 千车级性能基准与渲染优化（全量 12.5k 趟实测；吸附路径改时间片构建，视野/等级优先）
- [x] 时间轴跨日回放（0–48h，含次日）
- [x] 区县图层与「从当前地点铁路可达」查询（M6a：2,874 区县 / 车站归属 99.8% / 直达车次）
- [ ] 区县热门内容与本地景点（M6b，需整理数据源）
- [ ] 特殊班次（旅游专列等）标识
- [ ] 暗色主题

## 许可

本仓库未附带 `LICENSE` 文件。代码仅限个人学习、研究与演示使用，未经作者许可不得用于商业用途。数据版权归原提供方所有，使用时请遵守其条款并保留署名。
