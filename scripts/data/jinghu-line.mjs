// 京沪高铁整理数据（M2 降级数据源，见 PRD §5/§6.3）
//
// 坐标来源：公开地理信息人工整理（WGS-84，精度约百米级，全国比例尺演示足够）
//           外部坐标源（GitHub/OSM/高德 web）实测均不可达，预留适配层替换。
// 时刻表来源：公开资料整理，近似当前运行图，**以 12306 为准**；
//           浏览器态抓取管道就绪后可无缝替换（fetch-railway-data.mjs --cookie）。
// 电报码不在此硬编码——由脚本从 12306 station_name.js 实测数据按站名合并。

// 京沪高铁本线车站（顺序即线路走向：北京南 → 上海虹桥）
export const JINGHU_STATIONS = [
  { name: '北京南', lat: 39.8652, lng: 116.3786 },
  { name: '廊坊', lat: 39.5128, lng: 116.7044 },
  { name: '天津南', lat: 39.057, lng: 117.047 },
  { name: '沧州西', lat: 38.307, lng: 116.802 },
  { name: '德州东', lat: 37.41, lng: 116.461 },
  { name: '济南西', lat: 36.669, lng: 116.895 },
  { name: '泰安', lat: 36.165, lng: 117.035 },
  { name: '曲阜东', lat: 35.557, lng: 117.022 },
  { name: '滕州东', lat: 35.086, lng: 117.258 },
  { name: '枣庄', lat: 34.811, lng: 117.306 },
  { name: '徐州东', lat: 34.268, lng: 117.286 },
  { name: '宿州东', lat: 33.636, lng: 117.082 },
  { name: '蚌埠南', lat: 32.936, lng: 117.313 },
  { name: '定远', lat: 32.527, lng: 117.683 },
  { name: '滁州', lat: 32.198, lng: 118.317 },
  { name: '南京南', lat: 31.97, lng: 118.794 },
  { name: '镇江南', lat: 32.152, lng: 119.418 },
  { name: '丹阳北', lat: 32.028, lng: 119.601 },
  { name: '常州北', lat: 31.854, lng: 119.954 },
  { name: '无锡东', lat: 31.598, lng: 120.45 },
  { name: '苏州北', lat: 31.421, lng: 120.644 },
  { name: '昆山南', lat: 31.353, lng: 120.95 },
  { name: '上海虹桥', lat: 31.197, lng: 121.336 },
]

// 代表性车次时刻表（公开资料整理；delay 为演示值，M3 接入真实正晚点）
export const JINGHU_TRAINS = [
  {
    no: 'G1',
    delay: 0,
    stops: [
      { name: '北京南', arr: null, dep: '09:00' },
      { name: '济南西', arr: '10:22', dep: '10:24' },
      { name: '南京南', arr: '11:57', dep: '11:59' },
      { name: '上海虹桥', arr: '13:28', dep: null },
    ],
  },
  {
    no: 'G101',
    delay: 0,
    stops: [
      { name: '北京南', arr: null, dep: '08:00' },
      { name: '天津南', arr: '08:34', dep: '08:36' },
      { name: '济南西', arr: '09:42', dep: '09:45' },
      { name: '徐州东', arr: '10:51', dep: '10:54' },
      { name: '蚌埠南', arr: '11:30', dep: '11:32' },
      { name: '南京南', arr: '12:14', dep: '12:17' },
      { name: '无锡东', arr: '12:56', dep: '12:58' },
      { name: '上海虹桥', arr: '13:24', dep: null },
    ],
  },
  {
    no: 'G103',
    delay: 15, // 演示晚点值（M3 替换为真实正晚点）
    stops: [
      { name: '北京南', arr: null, dep: '08:30' },
      { name: '天津南', arr: '09:04', dep: '09:06' },
      { name: '济南西', arr: '10:12', dep: '10:15' },
      { name: '徐州东', arr: '11:21', dep: '11:24' },
      { name: '南京南', arr: '12:35', dep: '12:38' },
      { name: '上海虹桥', arr: '13:52', dep: null },
    ],
  },
]

export const DATA_SOURCES = {
  telecode: '12306 station_name.js（实测抓取）',
  coord: '公开地理信息人工整理（WGS-84，约百米精度）',
  timetable: '公开资料整理（以 12306 为准）',
  delay: '演示值（M3 接入真实正晚点）',
}
