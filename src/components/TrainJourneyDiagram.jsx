import { useMemo } from 'react'
import DiagramPlot from './DiagramPlot'
import { absMinutes, buildTrainJourney } from '../lib/diagram'
import { trainTypeInfo } from '../lib/train-type'

// 车次全程运行图：一辆车会跨多条线路，这里按它自己的停站铺 y 轴，
// 不依赖走廊定义是否齐全；匹配到的走廊用色带标出线路名，其余区段照常画。
// 同时淡显同区段（共享 ≥2 站）的其他车次，保留会让/越行语境。

const MAX_OVERLAY = 200

function unmatchedSpans(diagram) {
  const spans = []
  let start = -1
  diagram.segments.forEach((s, i) => {
    if (s.line == null && start < 0) start = i
    if (s.line != null && start >= 0) {
      spans.push([start, i])
      start = -1
    }
  })
  if (start >= 0) spans.push([start, diagram.segments.length])
  return spans.map(([a, b]) => `${diagram.stations[a].name}—${diagram.stations[b].name}`)
}

export default function TrainJourneyDiagram({ train, stationsMap, trains, corridors, nowAbs, selectedNo, onPickTrain, onClose }) {
  const diagram = useMemo(
    () => buildTrainJourney(train, stationsMap, corridors),
    [train, stationsMap, corridors],
  )

  const selected = useMemo(() => {
    if (!diagram) return null
    const pts = []
    for (const s of diagram.stations) {
      if (s.arr != null) pts.push({ x: s.arr, y: s.km, station: s.code, kind: 'arr' })
      if (s.dep != null && s.dep !== s.arr) pts.push({ x: s.dep, y: s.km, station: s.code, kind: 'dep' })
      else if (s.dep != null && s.arr == null) pts.push({ x: s.dep, y: s.km, station: s.code, kind: 'dep' })
    }
    pts.sort((a, b) => a.x - b.x)
    return pts.length >= 2 ? { no: train.no, delay: train.delay, pts } : null
  }, [diagram, train])

  const overlay = useMemo(() => {
    if (!diagram) return []
    const axis = new Map()
    for (const s of diagram.stations) if (!axis.has(s.code)) axis.set(s.code, s)
    const out = []
    for (const t of trains) {
      if (t.no === train.no) continue
      const pts = []
      for (const st of t.stops) {
        const a = axis.get(st.code)
        if (!a) continue
        const arr = absMinutes(st.arr, st.arrDay)
        const dep = absMinutes(st.dep, st.depDay)
        if (arr != null && arr >= diagram.timeStart && arr <= diagram.timeEnd) {
          pts.push({ x: arr, y: a.km, station: st.code, kind: 'arr' })
        }
        if (dep != null && dep >= diagram.timeStart && dep <= diagram.timeEnd) {
          pts.push({ x: dep, y: a.km, station: st.code, kind: 'dep' })
        }
      }
      if (pts.length >= 2) {
        pts.sort((p, q) => p.x - q.x)
        out.push({ no: t.no, delay: t.delay, pts })
        if (out.length >= MAX_OVERLAY) break
      }
    }
    return out
  }, [diagram, trains, train.no])

  const first = diagram?.stations[0]
  const last = diagram?.stations[diagram.stations.length - 1]
  const type = trainTypeInfo(train.no)
  const bands = diagram?.lineBands ?? []
  const gaps = diagram ? unmatchedSpans(diagram) : []
  const plotTrains = selected ? [...overlay, selected] : overlay

  return (
    <div className="diagram-mask" onClick={onClose}>
      <div className="diagram-panel" onClick={(e) => e.stopPropagation()}>
        <div className="diagram-head">
          <div>
            <b>
              {train.no} 全程运行图
              <span className="detail-type" style={{ marginLeft: 8, background: type.color }}>
                {type.label}
              </span>
            </b>
            <span className="diagram-sub">
              {first?.name} → {last?.name} · {diagram?.stations.length ?? 0} 站 ·{' '}
              {diagram ? diagram.maxKm.toFixed(0) : 0} km
              {bands.length ? ` · 已识别 ${bands.length} 段线路：${bands.map((b) => b.name).join('、')}` : ''}
              {gaps.length ? ` · 未收录线路：${gaps.slice(0, 2).join('、')}${gaps.length > 2 ? ' 等' : ''}` : ''}
            </span>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {!diagram || !selected ? (
          <div className="diagram-empty">该车次暂无可用时刻表，无法绘制全程运行图</div>
        ) : (
          <div className="diagram-scroll">
            <DiagramPlot
              stations={diagram.stations}
              maxKm={diagram.maxKm}
              trains={plotTrains}
              timeStart={diagram.timeStart}
              timeEnd={diagram.timeEnd}
              nowMinutes={nowAbs}
              selectedNo={train.no}
              onPickTrain={onPickTrain}
              bands={bands}
              labelMode="selected"
              minPlotH={360}
              maxPlotH={Math.max(360, Math.min(900, diagram.stations.length * 26))}
              stationGap={26}
            />
          </div>
        )}

        <div className="diagram-foot">
          斜线=运行（越陡越慢） · 水平段=停站 · 红线=当前时刻 · 彩色色带=已识别线路 · 灰线=同区段其他车次
          {overlay.length >= MAX_OVERLAY ? `（仅显示前 ${MAX_OVERLAY} 趟）` : ''}
          {' · 点击运行线切换车次'}
        </div>
      </div>
    </div>
  )
}
