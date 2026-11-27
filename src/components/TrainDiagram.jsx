import { useEffect, useMemo, useRef } from 'react'
import DiagramPlot, { PLOT_GEOM } from './DiagramPlot'
import { assignCorridorTrains, buildDiagram } from '../lib/diagram'

// 走廊运行图（时间-距离图）——经典铁路运行图样式：
//   横轴 0–24h（小时实线/半小时虚线），纵轴车站按公里标比例
//   每趟车一条折线：斜线=运行（斜率=速度），水平段=停站；红线=当前时刻
//   下行 ↘ / 上行 ↗，交点=会让/越行

export default function TrainDiagram({ corridor, trains, simMinutes, selectedNo, onPickTrain, onClose }) {
  const diagram = useMemo(() => {
    const assigned = assignCorridorTrains(trains, corridor)
    return buildDiagram(corridor, assigned)
  }, [corridor, trains])

  // 打开时把横向滚动定位到当前时刻（24h 图比面板宽），之后不再自动滚动，避免抢用户操作
  const scrollRef = useRef(null)
  const scrolledFor = useRef(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || scrolledFor.current === corridor.id) return
    scrolledFor.current = corridor.id
    const now = Math.max(0, Math.min(simMinutes, 1440))
    const x = PLOT_GEOM.left + (now / 60) * PLOT_GEOM.pxPerHour
    el.scrollLeft = Math.max(0, x - el.clientWidth / 2)
  }, [corridor.id, simMinutes])

  const first = diagram.stations[0]
  const last = diagram.stations[diagram.stations.length - 1]

  return (
    <div className="diagram-mask" onClick={onClose}>
      <div className="diagram-panel" onClick={(e) => e.stopPropagation()}>
        <div className="diagram-head">
          <div>
            <b>{diagram.name}</b>
            <span className="diagram-sub">
              {first?.name} → {last?.name} · {diagram.stations.length} 站 · {diagram.maxKm.toFixed(0)} km · 在图{' '}
              {diagram.trains.length} 趟
            </span>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {diagram.trains.length === 0 ? (
          <div className="diagram-empty">该线路暂无在图车次（抓取样本未覆盖，可提高配额后重跑管道）</div>
        ) : (
          <div className="diagram-scroll" ref={scrollRef}>
            <DiagramPlot
              stations={diagram.stations}
              maxKm={diagram.maxKm}
              trains={diagram.trains}
              timeStart={0}
              timeEnd={1440}
              nowMinutes={simMinutes}
              selectedNo={selectedNo}
              onPickTrain={onPickTrain}
              // 全量数据下走廊动辄数百趟：只给选中车次标车次号，避免顶部数字糊成一片
              labelMode={diagram.trains.length > 40 ? 'selected' : 'all'}
            />
          </div>
        )}

        <div className="diagram-foot">
          斜线=运行（越陡越慢） · 水平段=停站 · 交点=会让/越行 · 红线=当前时刻 · ↘下行 ↗上行 · 点击运行线选中车次
          {diagram.trains.some((t) => t.delay > 0) && ' · 橙色光晕=晚点'}
        </div>
      </div>
    </div>
  )
}
