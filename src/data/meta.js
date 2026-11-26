// 由 scripts/fetch-railway-data.mjs 生成（2026-11-26）——请勿手改，重跑脚本更新
export const meta = {
  "generatedAt": "2026-11-26",
  "line": "全国路网（京沪高铁精确坐标，其余城市级近似）",
  "counts": {
    "stations": 3400,
    "trains": 151
  },
  "disclaimer": "非官方实时数据，仅供参考；时刻以 12306 为准，不得作为行程决策依据",
  "sources": {
    "telecode": "12306 station_name.js（实测抓取）",
    "coord": "OSM 实测站点坐标 2721 站（© OpenStreetMap contributors, ODbL）；其余城市级近似（公开地理信息整理）",
    "timetable": "12306 queryTrainInfo 抓取（2026-11-26 发车日，免 cookie，城市级坐标）",
    "delay": "12306 正晚点实测（zwdch 抽样）"
  },
  "delayAsOf": "2026-11-26 16:49"
}
