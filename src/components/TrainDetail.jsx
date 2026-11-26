import { computeTrainPosition } from '../lib/position'
import { stationsMap } from '../data/stations'
import { statusColor, STATUS_TEXT } from '../lib/status'
import { trainTypeInfo } from '../lib/train-type'

// F3 车次详情：点击列车后展示车次、当前区间、正晚点与全程时刻表
// 时刻表高亮当前所在站（运行中时同时标记前方站）
export default function TrainDetail({ train, simMinutes, onClose }) {
  const pos = computeTrainPosition(train, stationsMap, simMinutes)
  const color = statusColor(pos.delay)
  const type = trainTypeInfo(train.no)
  const first = stationsMap[train.stops[0].code]
  const last = stationsMap[train.stops[train.stops.length - 1].code]

  return (
    <div className="detail">
      <div className="detail-head">
        <span className="detail-no" style={{ background: type.color }}>
          {train.no}
        </span>
        <span className="detail-route">
          {first.name} → {last.name}
          <span className="detail-type">{type.label}</span>
        </span>
        <button type="button" className="detail-close btn-icon" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>

      <div className="detail-status">
        <span className="badge" style={{ background: color }}>
          {STATUS_TEXT[pos.status]}
        </span>
        <span className={pos.delay ? 'delay-text' : 'ontime-text'}>
          {pos.delay ? `晚点 ${pos.delay} 分` : '正点'}
        </span>
      </div>

      <div className="detail-current">
        <div>{pos.label}</div>
        {pos.nextStation && (
          <div className="muted">
            预计 {pos.arrTime} 到 {pos.nextStation}
          </div>
        )}
      </div>

      <table className="detail-timetable">
        <thead>
          <tr>
            <th>车站</th>
            <th>到</th>
            <th>发</th>
          </tr>
        </thead>
        <tbody>
          {train.stops.map((s, i) => {
            const isCurrent = i === pos.stopIndex
            const isNext = i === pos.nextIndex
            return (
              <tr
                key={s.code}
                className={isCurrent ? 'current' : isNext ? 'next' : ''}
              >
                <td>
                  {stationsMap[s.code].name}
                  {isCurrent && <span className="here">◀ 当前</span>}
                </td>
                <td>{s.arr ?? '—'}</td>
                <td>{s.dep ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="detail-note">推算位置 · 非官方实时数据，仅供参考</div>
    </div>
  )
}
