import { useState, useEffect } from 'react'
import TrainMap from './components/TrainMap'
import ControlPanel from './components/ControlPanel'
import TrainDetail from './components/TrainDetail'
import { trains } from './data/trains'
import { stations } from './data/stations'
import { meta } from './data/meta'
import { statusColor, ON_TIME_COLOR, DELAY_COLOR } from './lib/status'

const START_HOUR = 9
const START_MIN = 30

export default function App() {
  const [simTime, setSimTime] = useState(() => {
    const d = new Date()
    d.setHours(START_HOUR, START_MIN, 0, 0)
    return d
  })
  const [speed, setSpeed] = useState(120)
  const [playing, setPlaying] = useState(true)
  const [selectedNo, setSelectedNo] = useState(null)

  // 模拟时钟：每 100ms 推进 speed 倍
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      setSimTime((t) => new Date(t.getTime() + speed * 100))
    }, 100)
    return () => clearInterval(id)
  }, [playing, speed])

  const simMinutes =
    simTime.getHours() * 60 + simTime.getMinutes() + simTime.getSeconds() / 60

  const reset = () => {
    const d = new Date()
    d.setHours(START_HOUR, START_MIN, 0, 0)
    setSimTime(d)
  }

  const pad = (n) => String(n).padStart(2, '0')
  const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

  const selectedTrain = trains.find((t) => t.no === selectedNo) || null

  return (
    <div className="app">
      <TrainMap simMinutes={simMinutes} selectedNo={selectedNo} onSelect={setSelectedNo} />
      <ControlPanel
        time={fmtTime(simTime)}
        speed={speed}
        playing={playing}
        onSpeed={setSpeed}
        onToggle={() => setPlaying((p) => !p)}
        onReset={reset}
      />
      {selectedTrain && (
        <TrainDetail
          train={selectedTrain}
          simMinutes={simMinutes}
          onClose={() => setSelectedNo(null)}
        />
      )}
      <div className="legend">
        <div className="item legend-status">
          <span className="dot" style={{ background: ON_TIME_COLOR }} />
          <span>正点</span>
          <span className="dot" style={{ background: DELAY_COLOR }} />
          <span>晚点</span>
        </div>
        {trains.map((t) => (
          <div
            className={`item clickable${t.no === selectedNo ? ' active' : ''}`}
            key={t.no}
            onClick={() => setSelectedNo(t.no === selectedNo ? null : t.no)}
          >
            <span className="dot" style={{ background: statusColor(t.delay) }} />
            <span>
              {t.no}
              {t.delay ? `（晚点 ${t.delay} 分）` : ''}
            </span>
          </div>
        ))}
        <div className="item muted">
          {meta.line} {stations.length} 站 · 电报码来自 12306
        </div>
        <div className="item muted">时刻表：{meta.sources.timetable}</div>
        <div className="item muted">非官方实时数据，仅供参考</div>
      </div>
    </div>
  )
}
