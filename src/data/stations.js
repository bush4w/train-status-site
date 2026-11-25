// 由 scripts/fetch-railway-data.mjs 生成（2026-11-25）——请勿手改，重跑脚本更新
// 京沪高铁本线车站（电报码来自 12306 实测；坐标为公开地理信息整理，WGS-84）

export const stations = [
  {
    "code": "VNP",
    "name": "北京南",
    "lat": 39.8652,
    "lng": 116.3786
  },
  {
    "code": "LJP",
    "name": "廊坊",
    "lat": 39.5128,
    "lng": 116.7044
  },
  {
    "code": "TIP",
    "name": "天津南",
    "lat": 39.057,
    "lng": 117.047
  },
  {
    "code": "CBP",
    "name": "沧州西",
    "lat": 38.307,
    "lng": 116.802
  },
  {
    "code": "DIP",
    "name": "德州东",
    "lat": 37.41,
    "lng": 116.461
  },
  {
    "code": "JGK",
    "name": "济南西",
    "lat": 36.669,
    "lng": 116.895
  },
  {
    "code": "TMK",
    "name": "泰安",
    "lat": 36.165,
    "lng": 117.035
  },
  {
    "code": "QAK",
    "name": "曲阜东",
    "lat": 35.557,
    "lng": 117.022
  },
  {
    "code": "TEK",
    "name": "滕州东",
    "lat": 35.086,
    "lng": 117.258
  },
  {
    "code": "ZEK",
    "name": "枣庄",
    "lat": 34.811,
    "lng": 117.306
  },
  {
    "code": "UUH",
    "name": "徐州东",
    "lat": 34.268,
    "lng": 117.286
  },
  {
    "code": "SRH",
    "name": "宿州东",
    "lat": 33.636,
    "lng": 117.082
  },
  {
    "code": "BMH",
    "name": "蚌埠南",
    "lat": 32.936,
    "lng": 117.313
  },
  {
    "code": "EWH",
    "name": "定远",
    "lat": 32.527,
    "lng": 117.683
  },
  {
    "code": "CXH",
    "name": "滁州",
    "lat": 32.198,
    "lng": 118.317
  },
  {
    "code": "NKH",
    "name": "南京南",
    "lat": 31.97,
    "lng": 118.794
  },
  {
    "code": "ZEH",
    "name": "镇江南",
    "lat": 32.152,
    "lng": 119.418
  },
  {
    "code": "EXH",
    "name": "丹阳北",
    "lat": 32.028,
    "lng": 119.601
  },
  {
    "code": "ESH",
    "name": "常州北",
    "lat": 31.854,
    "lng": 119.954
  },
  {
    "code": "WGH",
    "name": "无锡东",
    "lat": 31.598,
    "lng": 120.45
  },
  {
    "code": "OHH",
    "name": "苏州北",
    "lat": 31.421,
    "lng": 120.644
  },
  {
    "code": "KNH",
    "name": "昆山南",
    "lat": 31.353,
    "lng": 120.95
  },
  {
    "code": "AOH",
    "name": "上海虹桥",
    "lat": 31.197,
    "lng": 121.336
  }
]

export const stationsMap = Object.fromEntries(stations.map((s) => [s.code, s]))

// 线路连线点（车站间直线，M4 可替换为沿线采样点）
export const linePoints = stations.map((s) => ({ lat: s.lat, lng: s.lng }))
