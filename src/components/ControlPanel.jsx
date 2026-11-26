const SPEEDS = [1, 30, 60, 120, 300, 600]

export default function ControlPanel({ time, speed, playing, onSpeed, onToggle, onReset }) {
  return (
    <div className="panel">
      <div className="panel-time">
        <span className="label">模拟时间</span>
        <span className="time">{time}</span>
      </div>

      <div className="panel-speed">
        <span className="label">倍速</span>
        <div className="speed-btns">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={s === speed ? 'active' : ''}
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
          ↺ 回到现在
        </button>
      </div>

      <div className="panel-hint">点击列车查看详情</div>
    </div>
  )
}
