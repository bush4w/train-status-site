// 模拟列车（M1 演示数据，时刻为近似值）
// delay：晚点分钟数（0 = 正点）

export const trains = [
  {
    no: 'G1',
    color: '#e74c3c',
    delay: 0,
    stops: [
      { code: 'BJP', arr: null, dep: '09:00' },
      { code: 'JNK', arr: '10:22', dep: '10:24' },
      { code: 'NKH', arr: '11:57', dep: '11:59' },
      { code: 'AOH', arr: '13:28', dep: null },
    ],
  },
  {
    no: 'G101',
    color: '#3498db',
    delay: 0,
    stops: [
      { code: 'BJP', arr: null, dep: '08:00' },
      { code: 'TIP', arr: '08:34', dep: '08:36' },
      { code: 'JNK', arr: '09:42', dep: '09:45' },
      { code: 'XCH', arr: '10:51', dep: '10:54' },
      { code: 'BMH', arr: '11:30', dep: '11:32' },
      { code: 'NKH', arr: '12:14', dep: '12:17' },
      { code: 'WXH', arr: '12:56', dep: '12:58' },
      { code: 'AOH', arr: '13:24', dep: null },
    ],
  },
  {
    no: 'G103',
    color: '#f39c12',
    delay: 15,
    stops: [
      { code: 'BJP', arr: null, dep: '08:30' },
      { code: 'TIP', arr: '09:04', dep: '09:06' },
      { code: 'JNK', arr: '10:12', dep: '10:15' },
      { code: 'XCH', arr: '11:21', dep: '11:24' },
      { code: 'NKH', arr: '12:35', dep: '12:38' },
      { code: 'AOH', arr: '13:52', dep: null },
    ],
  },
]
