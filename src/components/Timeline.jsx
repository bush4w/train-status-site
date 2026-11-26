// F6 时间轴：拖动查看全天任意时刻的列车位置（0–24h）
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24]

export default function Timeline({ minutes, onScrub, onScrubStart, onScrubEnd }) {
  const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`
  return (
    <div className="timeline">
      <span className="timeline-now">{fmt(minutes)}</span>
      <input
        type="range"
        className="timeline-slider"
        min={0}
        max={1439}
        step={1}
        value={Math.floor(minutes) % 1440}
        onPointerDown={onScrubStart}
        onPointerUp={onScrubEnd}
        onChange={(e) => onScrub(Number(e.target.value))}
        aria-label="时间轴"
      />
      <div className="timeline-ticks">
        {TICKS.map((h) => (
          <span key={h}>{String(h % 24).padStart(2, '0')}</span>
        ))}
      </div>
    </div>
  )
}
