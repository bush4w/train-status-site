import { describe, it, expect } from 'vitest'
import {
  isEncryptedResult,
  parseLeftTicketEntry,
  parseTrainStops,
  parseTrainNameList,
  matchTrainByName,
  parseDelayMessage,
} from './otn-parser.mjs'

describe('parseDelayMessage（zwdch 正晚点，2026-11-26 实测样本）', () => {
  it('解析实际出发（无"预计"前缀）', () => {
    const json = { data: { result: 'Y', flag: false, message: 'G9次列车，北京南站出发时间为10:00' } }
    expect(parseDelayMessage(json)).toEqual({ predicted: false, train: 'G9', station: '北京南', time: '10:00' })
  })
  it('解析预计出发（前方站）', () => {
    const json = { data: { message: '预计G1次列车，苏州北站出发时间为11:02' } }
    expect(parseDelayMessage(json)).toEqual({ predicted: true, train: 'G1', station: '苏州北', time: '11:02' })
  })
  it('非时刻类消息返回 null（如查询失败/尚未开行提示）', () => {
    expect(parseDelayMessage({ data: { message: '查询失败！' } })).toBeNull()
    expect(parseDelayMessage({ data: { flag: true, data: '<html>...</html>' } })).toBeNull()
    expect(parseDelayMessage(null)).toBeNull()
  })
})

// getTrainName fixture：2026-11-26 真实响应格式（明文，全国 1.4 万+ 条）
const NAME_LIST_FIXTURE = {
  status: true,
  data: [
    { station_train_code: 'C1001(长春-延吉西)', train_no: '11000C10010F' },
    { station_train_code: 'G1(北京南-上海虹桥)', train_no: '24000000G10L' },
    { station_train_code: 'G5(北京-上海)', train_no: '24000000G50H' },
    { station_train_code: '格式异常无括号', train_no: 'x' },
  ],
}

describe('parseTrainNameList / matchTrainByName', () => {
  it('解析车次目录：拆出车次号与起讫站，过滤畸形条目', () => {
    const list = parseTrainNameList(NAME_LIST_FIXTURE)
    expect(list).toHaveLength(3)
    expect(list[0]).toEqual({ code: 'C1001', route: '长春-延吉西', train_no: '11000C10010F' })
    expect(list[1]).toEqual({ code: 'G1', route: '北京南-上海虹桥', train_no: '24000000G10L' })
  })

  it('按车次号+起讫站精确匹配（区分同车次号不同区段）', () => {
    const list = parseTrainNameList(NAME_LIST_FIXTURE)
    expect(matchTrainByName(list, 'G1', '北京南', '上海虹桥')?.train_no).toBe('24000000G10L')
    // G5 终到上海站（既有线），按虹桥匹配应落空——正是管道要防的幽灵车
    expect(matchTrainByName(list, 'G5', '北京南', '上海虹桥')).toBeNull()
    expect(matchTrainByName(list, 'G5', '北京', '上海')?.train_no).toBe('24000000G50H')
    expect(matchTrainByName(list, 'G2', '北京南', '上海虹桥')).toBeNull()
  })

  it('异常输入返回空数组', () => {
    expect(parseTrainNameList(null)).toEqual([])
    expect(parseTrainNameList({ data: 'not-array' })).toEqual([])
  })
})

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
    expect(stops[0]).toMatchObject({ name: '北京南', arr: null, dep: '09:00', no: '01', arrDay: null, depDay: 0 })
    expect(stops[1]).toMatchObject({ name: '济南西', arr: '10:22', dep: '10:24', no: '02', arrDay: 0, depDay: 0 })
    expect(stops[2]).toMatchObject({ name: '上海虹桥', arr: '13:28', dep: null, no: '04', arrDay: 0, depDay: null })
  })

  it('跨零点：arrive_day_diff 解析为 arrDay，发车早于到达时 depDay 进 1', () => {
    const json = {
      data: {
        data: [
          { station_name: '哈尔滨', arrive_time: '----', start_time: '21:12', arrive_day_diff: '0', station_no: '01' },
          { station_name: '沈阳北', arrive_time: '23:50', start_time: '00:10', arrive_day_diff: '0', station_no: '02' },
          { station_name: '北京', arrive_time: '07:29', start_time: '----', arrive_day_diff: '1', station_no: '03' },
        ],
      },
    }
    const stops = parseTrainStops(json)
    expect(stops[0].arrDay).toBeNull()
    expect(stops[0].depDay).toBe(0)
    expect(stops[1].arrDay).toBe(0)
    expect(stops[1].depDay).toBe(1)
    expect(stops[2].arrDay).toBe(1)
    expect(stops[2].depDay).toBeNull()
  })
  it('终到站 start_time 与 arrive_time 相同时归一为 null（2026-11-25 实测 G1 格式）', () => {
    const json = {
      data: {
        data: [
          { station_name: '北京南', arrive_time: '----', start_time: '06:30', station_no: '01' },
          { station_name: '上海虹桥', arrive_time: '11:24', start_time: '11:24', station_no: '07' },
        ],
      },
    }
    const stops = parseTrainStops(json)
    expect(stops[0].arr).toBeNull()
    expect(stops[1].arr).toBe('11:24')
    expect(stops[1].dep).toBeNull()
  })

  it('空响应/异常结构返回空数组', () => {
    expect(parseTrainStops({ data: { data: [] } })).toEqual([])
    expect(parseTrainStops(null)).toEqual([])
    expect(parseTrainStops({})).toEqual([])
  })
})
