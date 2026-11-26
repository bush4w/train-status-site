import { useMemo } from 'react'
import { assignCorridorTrains, buildDiagram } from '../lib/diagram'
import { trainTypeInfo } from '../lib/train-type'

// 运行图（时间-距离图）——经典铁路运行图样式：
//   横轴 0–24h（小时实线/半小时虚线），纵轴车站按公里标比例
//   每趟车一条折线：斜线=运行（斜率=速度），水平段=停站；红线=当前时刻
//   下行 ↘ / 上行 ↗，交点=会让/越行

const M = { top: 30, right: 30, bottom: 30, left: 84 }
const PX_PER_HOUR = 56

function fmtMin(m) {
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`
}

export default function TrainDiagram({ corridor, trains, simMinutes, selectedNo, onPickTrain, onClose }) {
  const diagram = useMemo(() => {
    const assigned = assignCorridorTrains(trains, corridor)
    return buildDiagram(corridor, assigned)
  }, [corridor, trains])

  const plotH = Math.max(320, Math.min(640, diagram.stations.length * 30))
  const W = M.left + 24 * PX_PER_HOUR + M.right
  const H = M.top + plotH + M.bottom
  const x = (min) => M.left + (min / 60) * PX_PER_HOUR
  const y = (km) => M.top + (diagram.maxKm > 0 ? km / diagram.maxKm : 0) * plotH

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
          <div className="diagram-scroll">
            <svg width={W} height={H} className="diagram-svg">
              {/* 时间网格 */}
              {Array.from({ length: 25 }, (_, h) => (
                <g key={h}>
                  <line x1={x(h * 60)} y1={M.top} x2={x(h * 60)} y2={M.top + plotH} stroke="#c9cdd4" strokeWidth="1" />
                  <text x={x(h * 60)} y={M.top - 8} textAnchor="middle" fontSize="10" fill="#888">
                    {String(h % 24).padStart(2, '0')}
                  </text>
                  {h < 24 && (
                    <line
                      x1={x(h * 60 + 30)}
                      y1={M.top}
                      x2={x(h * 60 + 30)}
                      y2={M.top + plotH}
                      stroke="#e4e7ec"
                      strokeWidth="1"
                      strokeDasharray="3 3"
                    />
                  )}
                </g>
              ))}
              {/* 车站横线与站名 */}
              {diagram.stations.map((s) => (
                <g key={s.code}>
                  <line x1={M.left} y1={y(s.km)} x2={W - M.right} y2={y(s.km)} stroke="#dde1e7" strokeWidth="1" />
                  <text x={M.left - 8} y={y(s.km) + 3.5} textAnchor="end" fontSize="11" fill="#555">
                    {s.name}
                  </text>
                  <text x={W - M.right + 6} y={y(s.km) + 3.5} fontSize="9" fill="#bbb">
                    {s.km.toFixed(0)}
                  </text>
                </g>
              ))}
              {/* 当前时刻红线（实时/模拟时钟驱动） */}
              <line
                x1={x(simMinutes)}
                y1={M.top - 4}
                x2={x(simMinutes)}
                y2={M.top + plotH}
                stroke="#e74c3c"
                strokeWidth="1.5"
              />
              <text x={x(simMinutes)} y={M.top - 10} textAnchor="middle" fontSize="10" fill="#e74c3c" fontWeight="700">
                {fmtMin(simMinutes)}
              </text>
              {/* 列车运行线 */}
              {diagram.trains.map((t, i) => {
                const info = trainTypeInfo(t.no)
                const sel = t.no === selectedNo
                const pts = t.pts.map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')
                const lp = t.pts[0]
                return (
                  <g key={t.no} className="diagram-train" onClick={() => onPickTrain(t.no)}>
                    {/* 加宽透明命中线 */}
                    <polyline points={pts} fill="none" stroke="transparent" strokeWidth="9" style={{ cursor: 'pointer' }} />
                    <polyline
                      points={pts}
                      fill="none"
                      stroke={info.color}
                      strokeWidth={sel ? 3.2 : 1.8}
                      strokeLinejoin="round"
                      opacity={selectedNo && !sel ? 0.35 : 0.92}
                      strokeDasharray={t.delay > 0 ? 'none' : 'none'}
                    />
                    {t.delay > 0 && (
                      <polyline points={pts} fill="none" stroke="#e67e22" strokeWidth={sel ? 5 : 3.4} opacity="0.25" />
                    )}
                    {lp && (
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
