import { describe, it, expect } from 'vitest'
import { isEncryptedResult, parseLeftTicketEntry, parseTrainStops } from './otn-parser.mjs'

// 明文条目 fixture：字段映射依据官方前端 cO 函数（2026-11-25 提取验证）
// f[2]=train_no f[3]=车次 f[4]/f[5]=始发/终到码 f[8]/f[9]=发/到时刻 f[13]=乘车日期
const PLAIN_ENTRY = [
  'secretBASE64str', // 0 secretStr
  '预订', // 1 buttonTextInfo
  '2j000000G103', // 2 train_no
  'G1', // 3 station_train_code
  'VNP', // 4 start_station_telecode
  'AOH', // 5 end_station_telecode
  'VNP', // 6 from_station_telecode
  'AOH', // 7 to_station_telecode
  '09:00', // 8 start_time
  '13:28', // 9 arrive_time
  '04:28', // 10 lishi
  'Y', // 11 canWebBuy
  'ypinfo', // 12 yp_info
  '2026-11-26', // 13 start_train_date
].join('|')

describe('isEncryptedResult', () => {
  it('明文条目（含 |）判为未加密', () => {
    expect(isEncryptedResult([PLAIN_ENTRY])).toBe(false)
  })
  it('密文条目（无 |）判为加密', () => {
    expect(isEncryptedResult(['efRnNo32IBTHd48kCwP7Ncydeh3yTC7doSk3Veok'])).toBe(true)
  })
  it('空数组判为未加密（无内容可判）', () => {
    expect(isEncryptedResult([])).toBe(false)
  })
})

describe('parseLeftTicketEntry', () => {
  it('提取 train_no 与车次等关键字段', () => {
    const e = parseLeftTicketEntry(PLAIN_ENTRY)
    expect(e.train_no).toBe('2j000000G103')
    expect(e.station_train_code).toBe('G1')
    expect(e.start_station_telecode).toBe('VNP')
    expect(e.end_station_telecode).toBe('AOH')
    expect(e.start_time).toBe('09:00')
    expect(e.arrive_time).toBe('13:28')
    expect(e.start_train_date).toBe('2026-11-26')
  })
})

describe('parseTrainStops', () => {
  it('解析经停站，---- 归一为 null', () => {
    const json = {
      data: {
        data: [
          { station_name: '北京南', station_train_code: 'G1', arrive_time: '----', start_time: '09:00', station_no: '01' },
          { station_name: '济南西', station_train_code: 'G1', arrive_time: '10:22', start_time: '10:24', station_no: '02' },
          { station_name: '上海虹桥', station_train_code: 'G1', arrive_time: '13:28', start_time: '----', station_no: '04' },
        ],
      },
    }
    const stops = parseTrainStops(json)
    expect(stops).toHaveLength(3)
    expect(stops[0]).toEqual({ name: '北京南', arr: null, dep: '09:00', no: '01' })
    expect(stops[1]).toEqual({ name: '济南西', arr: '10:22', dep: '10:24', no: '02' })
    expect(stops[2]).toEqual({ name: '上海虹桥', arr: '13:28', dep: null, no: '04' })
  })
  it('空响应/异常结构返回空数组', () => {
    expect(parseTrainStops({ data: { data: [] } })).toEqual([])
    expect(parseTrainStops(null)).toEqual([])
    expect(parseTrainStops({})).toEqual([])
  })
})
