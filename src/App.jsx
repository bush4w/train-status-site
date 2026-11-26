import { useState, useEffect, useMemo, useRef } from 'react'
import TrainMap from './components/TrainMap'
import ControlPanel from './components/ControlPanel'
import TrainDetail from './components/TrainDetail'
import SearchBox from './components/SearchBox'
import Timeline from './components/Timeline'
import TrainDiagram from './components/TrainDiagram'
import { meta } from './data/meta'
import { statusColor, ON_TIME_COLOR, DELAY_COLOR } from './lib/status'
import { computeTrainPosition } from './lib/position'
import { TRAIN_TYPES } from './lib/train-type'
import { CORRIDORS, resolveCorridor, corridorOfTrain } from './lib/diagram'

export default function App() {
  // 路网数据运行时加载（全量车次数 MB，不进主包）
  const [data, setData] = useState(null)
  const [dataError, setDataError] = useState(null)
  // 时钟默认「实时」模式：直接对接系统墙钟（不漂移、不倍速）
  const [simTime, setSimTime] = useState(() => new Date())
  const [liveMode, setLiveMode] = useState(true)
  const [speed, setSpeed] = useState(120)
  const [playing, setPlaying] = useState(true)
  const [selectedNo, setSelectedNo] = useState(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [flyTarget, setFlyTarget] = useState(null)
  const [legendOpen, setLegendOpen] = useState(true)
  const [liveDelays, setLiveDelays] = useState(null)
  const [corridorId, setCorridorId] = useState(null)
  const liveModeRef = useRef(liveMode)
  liveModeRef.current = liveMode

  useEffect(() => {
    let alive = true
    Promise.all([
      fetch('data/stations.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error('stations.json 加载失败')))),
      fetch('data/trains.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error('trains.json 加载失败')))),
    ])
      .then(([stations, trains]) => {
        if (!alive) return
        setData({
          stations,
          trains,
          stationsMap: Object.fromEntries(stations.map((s) => [s.code, s])),
          stationsByName: Object.fromEntries(stations.map((s) => [s.name, s])),
        })
      })
      .catch((e) => alive && setDataError(e.message))
    return () => {
      alive = false
    }
  }, [])

  // 时钟推进：实时=每 tick 取系统时间；模拟=按倍速推进（拖动时间轴时暂停）
  useEffect(() => {
    if (!playing || scrubbing) return
    const id = setInterval(() => {
      if (liveModeRef.current) setSimTime(new Date())
      else setSimTime((t) => new Date(t.getTime() + speed * 100))
    }, 100)
    return () => clearInterval(id)
  }, [playing, speed, scrubbing])

  // 实时晚点轮询：读取 auto-refresh 生成的 live/delays.json（45–75s 随机间隔）
  useEffect(() => {
    let alive = true
    let timer
    const poll = async () => {
      try {
        const r = await fetch(`live/delays.json?_=${Date.now()}`, { cache: 'no-store' })
        if (r.ok) {
          const j = await r.json()
          if (alive && j && j.delays) setLiveDelays(j)
        }
      } catch {
        /* 静默 */
      }
      if (alive) timer = setTimeout(poll, 45000 + Math.random() * 30000)
    }
    poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  // 有效车次 = 构建时数据 ⊕ 实时晚点
  const trains = data?.trains
  const effectiveTrains = useMemo(() => {
    if (!trains) return []
    if (!liveDelays?.delays) return trains
    return trains.map((t) =>
      liveDelays.delays[t.no] != null && liveDelays.delays[t.no] !== t.delay
        ? { ...t, delay: liveDelays.delays[t.no] }
        : t,
    )
  }, [trains, liveDelays])

  // 走廊解析（数据加载后）
  const allCorridors = useMemo(() => {
    if (!data) return []
    return CORRIDORS.map((c) => resolveCorridor(c, data.stationsByName)).filter((c) => c.stations.length >= 3)
  }, [data])
  const corridor = allCorridors.find((c) => c.id === corridorId) || null

  const simMinutes = simTime.getHours() * 60 + simTime.getMinutes() + simTime.getSeconds() / 60

  const goLive = () => {
    setLiveMode(true)
    setSimTime(new Date())
  }
  const enterSim = (s) => {
    setLiveMode(false)
    setSpeed(s)
  }
  const scrubTo = (m) => {
    setLiveMode(false)
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setTime(d.getTime() + m * 60000)
    setSimTime(d)
  }

  const pad = (n) => String(n).padStart(2, '0')
  const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

  const selectedTrain = effectiveTrains.find((t) => t.no === selectedNo) || null
  const selectedTrainCorridor = selectedTrain ? corridorOfTrain(selectedTrain, allCorridors) : null
  const lateTop = useMemo(
    () =>
      [...effectiveTrains]
        .filter((t) => t.delay > 0)
        .sort((a, b) => b.delay - a.delay)
        .slice(0, 5),
    [effectiveTrains],
  )

  const flySeq = flyTarget?.seq ?? 0
  const pickTrain = (t) => {
    setSelectedNo(t.no)
    const pos = computeTrainPosition(t, data.stationsMap, simMinutes)
    setFlyTarget({ lat: pos.lat, lng: pos.lng, zoom: 9, seq: flySeq + 1 })
  }
  const pickStation = (s) => {
    setFlyTarget({ lat: s.lat, lng: s.lng, zoom: 10, seq: flySeq + 1 })
  }

  const delayAsOf = liveDelays?.delayAsOf ?? meta.delayAsOf

  if (dataError) {
    return (
      <div className="boot">
        路网数据加载失败：{dataError}
        <br />
        请先运行 <code>node scripts/fetch-railway-data.mjs</code> 生成 public/data/
      </div>
    )
  }
  if (!data) return <div className="boot">加载路网数据…</div>

  return (
    <div className="app">
      <TrainMap
        stations={data.stations}
        stationsMap={data.stationsMap}
        trains={effectiveTrains}
        simMinutes={simMinutes}
        selectedNo={selectedNo}
        onSelect={setSelectedNo}
        flyTarget={flyTarget}
        selectedCorridor={corridorId}
        onPickCorridor={setCorridorId}
      />
      <ControlPanel
        time={fmtTime(simTime)}
        liveMode={liveMode}
        speed={speed}
        playing={playing}
        onSpeed={enterSim}
        onLive={goLive}
        onToggle={() => setPlaying((p) => !p)}
        onReset={goLive}
        onCorridor={setCorridorId}
        corridor={corridor}
        onShowCorridor={() => corridor && setCorridorId(corridor.id)}
        onClearCorridor={() => setCorridorId(null)}
      >
        <SearchBox stations={data.stations} trains={effectiveTrains} onPickTrain={pickTrain} onPickStation={pickStation} />
      </ControlPanel>
      <Timeline
        minutes={simMinutes}
        onScrub={scrubTo}
        onScrubStart={() => setScrubbing(true)}
        onScrubEnd={() => setScrubbing(false)}
      />
      {corridor && (
        <TrainDiagram
          corridor={corridor}
          trains={effectiveTrains}
          simMinutes={simMinutes}
          selectedNo={selectedNo}
          onPickTrain={(no) => {
            const t = effectiveTrains.find((x) => x.no === no)
            if (t) pickTrain(t)
          }}
          onClose={() => setCorridorId(null)}
        />
      )}
      {selectedTrain && (
        <TrainDetail
          train={selectedTrain}
          stationsMap={data.stationsMap}
          simMinutes={simMinutes}
          onClose={() => setSelectedNo(null)}
          onDiagram={selectedTrainCorridor ? () => setCorridorId(selectedTrainCorridor.id) : null}
          diagramName={selectedTrainCorridor?.name}
        />
      )}
      <div className={`legend${legendOpen ? '' : ' collapsed'}`}>
        <button
          type="button"
          className="legend-head"
          onClick={() => setLegendOpen((o) => !o)}
          aria-expanded={legendOpen}
        >
          <span>图例</span>
          <span className="legend-toggle">{legendOpen ? '−' : '+'}</span>
        </button>
        {legendOpen && (
          <div className="legend-body">
            <div className="type-grid">
              {TRAIN_TYPES.map((t) => (
                <span className="type-chip" key={t.letter} title={`${t.label}：${t.desc}`}>
                  <i className={`chip-shape shape-${t.shape}`} style={{ '--tc': t.color }} />
                  {t.letter}·{t.label}
                </span>
              ))}
            </div>
            <div className="item legend-status">
              <span className="ring-demo ontime" />
              <span>正点</span>
              <span className="ring-demo delayed" />
              <span>晚点</span>
            </div>
            <div className="item muted">
              在图车次 {effectiveTrains.length} · 车站 {meta.counts?.stations ?? data.stations.length}
            </div>
            <div className="item muted">缩放分级：远景大站快车，放大显示更多列车与车站</div>
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
              正晚点：{delayAsOf ? `抽样实测于 ${delayAsOf}` : meta.sources.delay}
              {liveDelays && <span className="live-dot" title="实时刷新已连接" />}
            </div>
            <div className="item muted">数据 {meta.generatedAt} · 非官方实时，仅供参考</div>
            <div className="item muted attribution">线路几何 © OpenStreetMap (ODbL)</div>
          </div>
        )}
      </div>
    </div>
  )
}
