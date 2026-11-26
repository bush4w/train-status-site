import { useState, useEffect } from 'react'
import TrainMap from './components/TrainMap'
import ControlPanel from './components/ControlPanel'
import TrainDetail from './components/TrainDetail'
import SearchBox from './components/SearchBox'
import Timeline from './components/Timeline'
import { trains } from './data/trains'
import { stations, stationsMap } from './data/stations'
import { meta } from './data/meta'
import { statusColor, ON_TIME_COLOR, DELAY_COLOR } from './lib/status'
import { computeTrainPosition } from './lib/position'

export default function App() {
  // 模拟时钟默认对齐真实当前时间：列车位置与正晚点快照同日同刻，消除班次错位
  const [simTime, setSimTime] = useState(() => new Date())
  const [speed, setSpeed] = useState(120)
  const [playing, setPlaying] = useState(true)
  const [selectedNo, setSelectedNo] = useState(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [flyTarget, setFlyTarget] = useState(null)

  // 模拟时钟：每 100ms 推进 speed 倍（拖动时间轴时暂停推进）
  useEffect(() => {
    if (!playing || scrubbing) return
    const id = setInterval(() => {
      setSimTime((t) => new Date(t.getTime() + speed * 100))
    }, 100)
    return () => clearInterval(id)
  }, [playing, speed, scrubbing])

  const simMinutes =
    simTime.getHours() * 60 + simTime.getMinutes() + simTime.getSeconds() / 60

  const reset = () => setSimTime(new Date()) // 回到现在（真实时间）

  const pad = (n) => String(n).padStart(2, '0')
  const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

  const selectedTrain = trains.find((t) => t.no === selectedNo) || null
  // 晚点 Top5（全国模式车次多，图例只列晚点前列）
  const lateTop = [...trains]
    .filter((t) => t.delay > 0)
    .sort((a, b) => b.delay - a.delay)
    .slice(0, 5)

  // F6 时间轴拖动：设置当日时刻
  const scrubTo = (m) => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setTime(d.getTime() + m * 60000)
    setSimTime(d)
  }

  // F5 搜索定位：车次→当前位置；车站→站点坐标
  const flySeq = flyTarget?.seq ?? 0
  const pickTrain = (t) => {
    setSelectedNo(t.no)
    const pos = computeTrainPosition(t, stationsMap, simMinutes)
    setFlyTarget({ lat: pos.lat, lng: pos.lng, zoom: 9, seq: flySeq + 1 })
  }
  const pickStation = (s) => {
    setFlyTarget({ lat: s.lat, lng: s.lng, zoom: 10, seq: flySeq + 1 })
  }

  return (
    <div className="app">
      <TrainMap
        simMinutes={simMinutes}
        selectedNo={selectedNo}
        onSelect={setSelectedNo}
        flyTarget={flyTarget}
      />
      <ControlPanel
        time={fmtTime(simTime)}
        speed={speed}
        playing={playing}
        onSpeed={setSpeed}
        onToggle={() => setPlaying((p) => !p)}
        onReset={reset}
      >
        <SearchBox onPickTrain={pickTrain} onPickStation={pickStation} />
      </ControlPanel>
      <Timeline
        minutes={simMinutes}
        onScrub={scrubTo}
        onScrubStart={() => setScrubbing(true)}
        onScrubEnd={() => setScrubbing(false)}
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
        <div className="item muted">
          在图车次 {trains.length} · 车站 {meta.counts?.stations ?? stations.length}
        </div>
        {lateTop.length === 0 && <div className="item muted">抽样车次当前均正点</div>}
        {lateTop.map((t) => (
          <div
            className={`item clickable${t.no === selectedNo ? ' active' : ''}`}
            key={t.no}
            onClick={() => setSelectedNo(t.no === selectedNo ? null : t.no)}
          >
            <span className="dot" style={{ background: statusColor(t.delay) }} />
            <span>
              {t.no}（晚点 {t.delay} 分）
            </span>
          </div>
        ))}
        <div className="item muted">
          正晚点：{meta.delayAsOf ? `抽样实测于 ${meta.delayAsOf}` : meta.sources.delay}
        </div>
        <div className="item muted">数据 {meta.generatedAt} · 非官方实时，仅供参考</div>
      </div>
    </div>
  )
}
