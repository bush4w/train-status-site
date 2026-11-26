import { useState } from 'react'
import { search } from '../lib/search'
import { stations } from '../data/stations'
import { statusColor } from '../lib/status'

// F5 车次/车站搜索：输入即搜，点击结果定位（trains 由 App 传入，含实时晚点）
export default function SearchBox({ trains, onPickTrain, onPickStation }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const result = q.trim() ? search(q, trains, stations) : { trains: [], stations: [] }
  const hasResult = result.trains.length > 0 || result.stations.length > 0

  const pick = (fn) => (arg) => {
    fn(arg)
    setOpen(false)
  }

  return (
    <div className="search">
      <input
        type="text"
        className="search-input"
        placeholder="搜索车次（G1）或车站（北京南）"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} // 让点击先触发
      />
      {q && (
        <button type="button" className="search-clear" onClick={() => setQ('')} aria-label="清空">
          ×
        </button>
      )}
      {open && q.trim() && (
        <div className="search-results">
          {!hasResult && <div className="search-empty">无匹配车次/车站</div>}
          {result.trains.map((t) => (
            <div
              className="search-item"
              key={t.no}
              onMouseDown={() => pick(onPickTrain)(t)}
            >
              <span className="dot" style={{ background: statusColor(t.delay) }} />
              <span className="search-item-main">{t.no}</span>
              <span className="search-item-sub">
                {t.route || `${t.stops.length} 站`}
                {t.delay ? ` · 晚${t.delay}分` : ''}
              </span>
            </div>
          ))}
          {result.stations.map((s) => (
            <div
              className="search-item"
              key={s.code}
              onMouseDown={() => pick(onPickStation)(s)}
            >
              <span className="dot station" />
              <span className="search-item-main">{s.name}</span>
              <span className="search-item-sub">{s.city || s.code}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
