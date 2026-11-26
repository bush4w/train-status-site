import { CORRIDORS } from '../lib/diagram'

const SPEEDS = [30, 60, 120, 300, 600]

export default function ControlPanel({
  time,
  liveMode,
  speed,
  playing,
  onSpeed,
  onLive,
  onToggle,
  onReset,
  onCorridor,
  children,
}) {
  return (
    <div className="panel">
      {children}
      <div className="panel-time">
        <span className="label">{liveMode ? '当前时间' : '模拟时间'}</span>
        <span className="time">{time}</span>
        {liveMode && <span className="live-badge">实时</span>}
      </div>

      <div className="panel-speed">
        <span className="label">时钟</span>
        <div className="speed-btns">
          <button type="button" className={liveMode ? 'active' : ''} onClick={onLive}>
            实时
          </button>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={!liveMode && s === speed ? 'active' : ''}
              onClick={() => onSpeed(s)}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      <div className="panel-actions">
        <button type="button" onClick={onToggle}>
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button type="button" onClick={onReset}>
          ↺ 回到实时
        </button>
      </div>

      <select
        className="corridor-select"
        value=""
        onChange={(e) => {
          if (e.target.value) onCorridor(e.target.value)
        }}
      >
        <option value="">📈 线路运行图…</option>
        {CORRIDORS.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}（{c.stations[0]}—{c.stations[c.stations.length - 1]}）
          </option>
        ))}
      </select>

      <div className="panel-hint">点击列车查看详情 · 拖动底部时间轴可回放</div>
    </div>
  )
}
