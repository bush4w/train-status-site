import { trainTypeInfo } from '../lib/train-type'

// 运行图绘制主体（纯展示，无状态）：时间-里程坐标 + 车站 + 列车运行线
// 走廊运行图（0–24h、多条车）和车次全程运行图（该车时间窗、区段色带）共用

const M = { top: 30, right: 34, bottom: 30, left: 96 }
const PX_PER_HOUR = 56
const BAND_COLORS = ['#4a6fa5', '#c0392b', '#27ae60', '#8e44ad', '#d68910', '#16a085']

// 供外层容器把横向滚动定位到「当前时刻」
export const PLOT_GEOM = { left: M.left, right: M.right, pxPerHour: PX_PER_HOUR }

export function fmtClock(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export default function DiagramPlot({
  stations,
  maxKm,
  trains,
  timeStart = 0,
  timeEnd = 1440,
  nowMinutes = null,
  selectedNo = null,
  onPickTrain,
  bands = [],
  minPlotH = 320,
  maxPlotH = 640,
  stationGap = 30,
  labelMode = 'all', // 'all' | 'selected'
  showBands = true,
}) {
  const span = Math.max(60, timeEnd - timeStart)
  const plotH = Math.max(minPlotH, Math.min(maxPlotH, stations.length * stationGap))
  const W = M.left + (span / 60) * PX_PER_HOUR + M.right
  const H = M.top + plotH + M.bottom
  const x = (min) => M.left + ((min - timeStart) / 60) * PX_PER_HOUR
  const y = (km) => M.top + (maxKm > 0 ? km / maxKm : 0) * plotH

  const ticks = []
  for (let h = Math.floor(timeStart / 60) * 60; h <= timeEnd; h += 60) ticks.push(h)

  const showNow = nowMinutes != null && nowMinutes >= timeStart && nowMinutes <= timeEnd

  return (
    <svg width={W} height={H} className="diagram-svg">
      {/* 线路区段色带（只标已识别的走廊，未识别区段不画） */}
      {showBands &&
        bands.map((b, i) => {
          const a = stations[b.fromStop]
          const z = stations[b.toStop]
          if (!a || !z) return null
          const color = BAND_COLORS[i % BAND_COLORS.length]
          const y0 = y(Math.min(a.km, z.km))
          const y1 = y(Math.max(a.km, z.km))
          const h = Math.max(1.5, y1 - y0)
          return (
            <g key={`${b.id}-${i}`}>
              <rect x={M.left} y={y0} width={W - M.left - M.right} height={h} fill={color} opacity="0.07" />
              <rect x={M.left - 11} y={y0} width="4" height={h} rx="2" fill={color} opacity="0.85" />
              <text x={M.left + 6} y={y0 + 12} fontSize="10" fill={color} fontWeight="700">
                {b.name}
              </text>
            </g>
          )
        })}

      {/* 时间网格 */}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} y1={M.top} x2={x(t)} y2={M.top + plotH} stroke="#c9cdd4" strokeWidth="1" />
          <text x={x(t)} y={M.top - 8} textAnchor="middle" fontSize="10" fill="#888">
            {String(Math.floor(t / 60) % 24).padStart(2, '0')}
          </text>
          {t + 30 <= timeEnd && (
            <line
              x1={x(t + 30)}
              y1={M.top}
              x2={x(t + 30)}
              y2={M.top + plotH}
              stroke="#e4e7ec"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          )}
        </g>
      ))}

      {/* 车站横线与站名（站距太近时跳过站名，避免叠字） */}
      {(() => {
        let lastLabelY = -Infinity
        return stations.map((s, i) => {
          const yy = y(s.km)
          const showLabel = yy - lastLabelY >= 11
          if (showLabel) lastLabelY = yy
          return (
            <g key={`${s.code}-${i}`}>
              <line x1={M.left} y1={yy} x2={W - M.right} y2={yy} stroke="#dde1e7" strokeWidth="1" />
              {showLabel && (
                <>
                  <text x={M.left - 16} y={yy + 3.5} textAnchor="end" fontSize="11" fill="#555">
                    {s.name}
                  </text>
                  <text x={W - M.right + 6} y={yy + 3.5} fontSize="9" fill="#bbb">
                    {s.km.toFixed(0)}
                  </text>
                </>
              )}
            </g>
          )
        })
      })()}

      {/* 当前时刻红线（实时/模拟时钟驱动） */}
      {showNow && (
        <>
          <line x1={x(nowMinutes)} y1={M.top - 4} x2={x(nowMinutes)} y2={M.top + plotH} stroke="#e74c3c" strokeWidth="1.5" />
          <text x={x(nowMinutes)} y={M.top - 10} textAnchor="middle" fontSize="10" fill="#e74c3c" fontWeight="700">
            {fmtClock(nowMinutes)}
          </text>
        </>
      )}

      {/* 列车运行线 */}
      {trains.map((t, i) => {
        const info = trainTypeInfo(t.no)
        const sel = t.no === selectedNo
        const pts = t.pts.map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')
        const lp = t.pts[0]
        const showLabel = labelMode === 'all' || sel
        return (
          <g key={t.no} className="diagram-train" onClick={() => onPickTrain?.(t.no)}>
            <polyline points={pts} fill="none" stroke="transparent" strokeWidth="9" style={{ cursor: 'pointer' }} />
            <polyline
              points={pts}
              fill="none"
              stroke={info.color}
              strokeWidth={sel ? 3.2 : 1.8}
              strokeLinejoin="round"
              opacity={selectedNo && !sel ? 0.28 : 0.92}
            />
            {t.delay > 0 && (
              <polyline points={pts} fill="none" stroke="#e67e22" strokeWidth={sel ? 5 : 3.4} opacity="0.25" />
            )}
            {showLabel && lp && (
              <text
                x={x(lp.x) + 4}
                y={y(lp.y) - 4 - (i % 3) * 9}
                fontSize="9.5"
                fill={info.color}
                fontWeight={sel ? 700 : 500}
                style={{ pointerEvents: 'none' }}
              >
                {t.no}
                {t.delay > 0 ? `(+${t.delay})` : ''}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
