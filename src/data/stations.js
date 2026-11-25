// 京沪高铁代表性车站（坐标为 WGS-84，演示用）
// 顺序即线路走向（北京 → 上海）

export const stations = [
  { code: 'BJP', name: '北京南', lat: 39.865, lng: 116.379 },
  { code: 'TIP', name: '天津南', lat: 39.057, lng: 117.047 },
  { code: 'JNK', name: '济南西', lat: 36.669, lng: 116.895 },
  { code: 'XCH', name: '徐州东', lat: 34.268, lng: 117.286 },
  { code: 'BMH', name: '蚌埠南', lat: 32.936, lng: 117.313 },
  { code: 'NKH', name: '南京南', lat: 31.970, lng: 118.794 },
  { code: 'WXH', name: '无锡东', lat: 31.598, lng: 120.450 },
  { code: 'AOH', name: '上海虹桥', lat: 31.197, lng: 121.336 },
]

export const stationsMap = Object.fromEntries(stations.map((s) => [s.code, s]))

// 线路连线点（M1 用车站间直线，后续 M4 可替换为沿线采样点）
export const linePoints = stations.map((s) => ({ lat: s.lat, lng: s.lng }))
