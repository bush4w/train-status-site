import { useState, useEffect } from 'react'
import TrainMap from './components/TrainMap'
import ControlPanel from './components/ControlPanel'
import { trains } from './data/trains'

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

  return (
    <div className="app">
      <TrainMap simMinutes={simMinutes} />
      <ControlPanel
        time={fmtTime(simTime)}
        speed={speed}
        playing={playing}
        onSpeed={setSpeed}
        onToggle={() => setPlaying((p) => !p)}
        onReset={reset}
      />
      <div className="legend">
        {trains.map((t) => (
          <div className="item" key={t.no}>
            <span className="dot" style={{ background: t.color }} />
            <span>
              {t.no}
              {t.delay ? `（晚点 ${t.delay} 分）` : ''}
            </span>
          </div>
        ))}
        <div className="item muted">列车沿京沪线移动（模拟）</div>
      </div>
    </div>
  )
}
