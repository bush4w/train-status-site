// F6 时间轴：拖动查看任意时刻的列车位置（0–48h，含次日跨零点回放）
// 分钟数相对数据日 00:00；≥1440 显示「次日」。
const TICKS = [0, 6, 12, 18, 24, 30, 36, 42, 48]
const MAX_MIN = 2880 - 1

export default function Timeline({ minutes, onScrub, onScrubStart, onScrubEnd }) {
  const value = Math.max(0, Math.min(MAX_MIN, Math.floor(minutes)))
  const day2 = value >= 1440
  const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`
  return (
    <div className="timeline">
      <span className="timeline-now">
        {day2 && <span className="timeline-day">次日</span>}
        {fmt(value)}
      </span>
      <input
        type="range"
        className="timeline-slider"
        min={0}
        max={MAX_MIN}
        step={1}
        value={value}
        onPointerDown={onScrubStart}
        onPointerUp={onScrubEnd}
        onChange={(e) => onScrub(Number(e.target.value))}
        aria-label="时间轴"
      />
      <div className="timeline-ticks">
        {TICKS.map((h) => (
          <span key={h} className={h >= 24 ? 'next-day' : ''}>
            {String(h % 24).padStart(2, '0')}
          </span>
        ))}
      </div>
    </div>
  )
}
