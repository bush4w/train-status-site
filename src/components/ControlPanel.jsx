import { CORRIDORS } from '../lib/diagram'

const SPEEDS = [30, 60, 120, 300, 600]

// 线路图层：与 lines.json 的 hsr / conv 分组、车次的 trainCategory 对应
const LINE_LAYERS = [
  { id: 'all', label: '全部', title: '同时显示高铁与普速线路' },
  { id: 'hsr', label: '高铁', title: '仅看高铁线路（动车组列车）' },
  { id: 'conv', label: '普速', title: '仅看普速线路（普速列车）' },
]

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
  corridor,
  onShowCorridor,
  onClearCorridor,
  lineFilter,
  onLineFilter,
  countyVisible,
  onCountyToggle,
  countyReady,
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

      <div className="panel-layer">
        <span className="label">线路</span>
        <div className="speed-btns">
          {LINE_LAYERS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={lineFilter === l.id ? 'active' : ''}
              onClick={() => onLineFilter(l.id)}
              title={l.title}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-layer">
        <span className="label">区域</span>
        <div className="speed-btns">
          <button
            type="button"
            className={countyVisible ? 'active' : ''}
            onClick={onCountyToggle}
            disabled={!countyReady}
            title="显示地市/区县边界；放大到 7 级后点击区县可查直达车次"
          >
            区县边界
          </button>
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

      {corridor && (
        <div className="corridor-chip">
          <span className="corridor-chip-name" title={corridor.name}>
            已选：{corridor.name}
          </span>
          <button type="button" onClick={onShowCorridor}>
            运行图
          </button>
          <button type="button" className="corridor-chip-close" onClick={onClearCorridor} aria-label="清除线路选择">
            ×
          </button>
        </div>
      )}

      <div className="panel-hint">点击列车看详情 · 放大后点区县查直达 · 拖动底部时间轴回放</div>
    </div>
  )
}
