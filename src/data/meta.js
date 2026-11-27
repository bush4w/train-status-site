// 由 scripts/fetch-railway-data.mjs 生成（2026-11-27）——请勿手改，重跑脚本更新
export const meta = {
  "line": "全国路网（京沪高铁精确坐标，其余城市级近似）",
  "dataDate": "2026-11-27",
  "complete": true,
  "counts": {
    "stations": 3764,
    "trains": 12558,
    "services": 16181
  },
  "coverage": {
    "catalogTrainNo": 12548,
    "catalogServices": 16171,
    "emuServices": 14003,
    "convServices": 2168,
    "capturedTrains": 12558,
    "capturedServices": 16181
  },
  "disclaimer": "非官方实时数据，仅供参考；时刻以 12306 为准，不得作为行程决策依据",
  "generatedAt": "2026-11-27",
  "delayAsOf": "2026-11-27 22:29",
  "delaySampled": 8,
  "sources": {
    "telecode": "12306 station_name.js（实测抓取）",
    "coord": "OSM 实测站点坐标 3339 站（© OpenStreetMap contributors, ODbL）；其余城市级近似（公开地理信息整理）",
    "timetable": "12306 queryTrainInfo 抓取（2026-11-27 发车日，免 cookie，全量模式）",
    "delay": "12306 正晚点实测（zwdch 抽样）"
  }
}
