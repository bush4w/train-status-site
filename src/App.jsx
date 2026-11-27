import { useState, useEffect, useMemo, useRef } from 'react'
import TrainMap from './components/TrainMap'
import ControlPanel from './components/ControlPanel'
import TrainDetail from './components/TrainDetail'
import TrainJourneyDiagram from './components/TrainJourneyDiagram'
import CountyPanel from './components/CountyPanel'
import SearchBox from './components/SearchBox'
import Timeline from './components/Timeline'
import TrainDiagram from './components/TrainDiagram'
import { meta } from './data/meta'
import { statusColor, ON_TIME_COLOR, DELAY_COLOR } from './lib/status'
import { applyLiveDelays } from './lib/delays'
import { computeTrainPosition } from './lib/position'
import { nearestHubStation } from './lib/access'
import { TRAIN_TYPES, trainCategory } from './lib/train-type'
import { CORRIDORS, resolveCorridor } from './lib/diagram'

function daysBetween(from, to) {
  if (!from) return 0
  const a = new Date(`${from}T00:00:00`)
  const b = new Date(`${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}T00:00:00`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0
  return Math.round((b - a) / 86400000)
}

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
  const [fetchStatus, setFetchStatus] = useState(null)
  const [corridorId, setCorridorId] = useState(null)
  // 车次全程运行图（null = 关闭）：点详情里的「查看全程运行图」打开
  const [journeyNo, setJourneyNo] = useState(null)
  // 线路图层：全部 / 仅高铁（hsr）/ 仅普速（conv）
  const [lineFilter, setLineFilter] = useState('all')
  // M6a：区县图层与可达查询
  const [counties, setCounties] = useState(null)
  const [countyVisible, setCountyVisible] = useState(true)
  const [selectedCounty, setSelectedCounty] = useState(null)
  const [mapCenter, setMapCenter] = useState(null)
  const [origin, setOrigin] = useState(null)
  const originInitRef = useRef(false)
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

  // 全量抓取进度：读取 live/fetch-status.json；完成后提示刷新
  useEffect(() => {
    let alive = true
    let timer
    const poll = async () => {
      try {
        const r = await fetch(`live/fetch-status.json?_=${Date.now()}`, { cache: 'no-store' })
        if (r.ok) {
          const j = await r.json()
          if (alive && j) setFetchStatus(j)
        }
      } catch {
        /* 无状态文件时静默 */
      }
      if (alive) timer = setTimeout(poll, 30000)
    }
    poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  // 区县边界：运行时加载（数 MB，失败时静默关闭该功能）
  useEffect(() => {
    let alive = true
    fetch('data/counties.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j?.counties?.length) setCounties(j)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

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

  // 有效车次 = 构建时数据 ⊕ 实时晚点（未抽样车次标 delayKnown=false）
  const trains = data?.trains
  const effectiveTrains = useMemo(() => {
    if (!trains) return []
    if (!liveDelays?.delays) return trains
    return applyLiveDelays(trains, liveDelays)
  }, [trains, liveDelays])

  // 走廊解析（数据加载后）
  const allCorridors = useMemo(() => {
    if (!data) return []
    return CORRIDORS.map((c) => resolveCorridor(c, data.stationsByName)).filter((c) => c.stations.length >= 3)
  }, [data])
  const corridor = allCorridors.find((c) => c.id === corridorId) || null

  const simMinutes = simTime.getHours() * 60 + simTime.getMinutes() + simTime.getSeconds() / 60
  // 数据日期 → 模拟日期（不是墙钟）的天数差：模拟时钟跨过零点、页面开过夜时 nowAbs 自动 >1440
  const dataDate = meta.dataDate || meta.generatedAt
  const dayDelta = daysBetween(dataDate, simTime)
  const nowAbs = dayDelta * 1440 + simMinutes
  // 抓取完成但当前页面仍是旧快照：日期变化或车次数变化都提示刷新
  const dataStale =
    fetchStatus &&
    !fetchStatus.running &&
    fetchStatus.phase === 'done' &&
    ((fetchStatus.dataDate && fetchStatus.dataDate !== dataDate) ||
      (typeof fetchStatus.trains === 'number' && fetchStatus.trains !== (meta.counts?.trains ?? 0)))

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
    // 以数据日 00:00 为基准：m ≥ 1440 即进入次日，跨零点车次连续
    const [y, mo, d] = dataDate.split('-').map(Number)
    const base = new Date(y, mo - 1, d, 0, 0, 0, 0)
    base.setTime(base.getTime() + m * 60000)
    setSimTime(base)
  }

  const pad = (n) => String(n).padStart(2, '0')
  const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

  const selectedTrain = effectiveTrains.find((t) => t.no === selectedNo) || null
  const journeyTrain = effectiveTrains.find((t) => t.no === journeyNo) || null

  // 图层过滤：图例计数与晚点榜单只统计当前图层的车次（地图侧由 TrainMap 按同一判定过滤）
  const mapTrains = useMemo(
    () => (lineFilter === 'all' ? effectiveTrains : effectiveTrains.filter((t) => trainCategory(t.no) === lineFilter)),
    [effectiveTrains, lineFilter],
  )
  const changeLayer = (mode) => {
    setLineFilter(mode)
    if (mode !== 'all' && selectedNo && trainCategory(selectedNo) !== mode) setSelectedNo(null)
  }
  const lateTop = useMemo(
    () =>
      [...mapTrains]
        .filter((t) => t.delay > 0)
        .sort((a, b) => b.delay - a.delay)
        .slice(0, 5),
    [mapTrains],
  )

  const flySeq = flyTarget?.seq ?? 0
  const pickTrain = (t) => {
    // 搜到不在当前图层的车次时，自动切到它所属的图层，保证看得见
    const cat = trainCategory(t.no)
    if (lineFilter !== 'all' && cat !== lineFilter) setLineFilter(cat)
    setSelectedCounty(null)
    setSelectedNo(t.no)
    const pos = computeTrainPosition(t, data.stationsMap, nowAbs)
    setFlyTarget({ lat: pos.lat, lng: pos.lng, zoom: 9, seq: flySeq + 1 })
  }
  const pickStation = (s) => {
    setFlyTarget({ lat: s.lat, lng: s.lng, zoom: 10, seq: flySeq + 1 })
  }
  // 起点默认值只算一次（取全国视图中心最近的枢纽站），之后不随地图移动
  useEffect(() => {
    if (originInitRef.current || !data || !mapCenter) return
    const hub = nearestHubStation(data.stations, effectiveTrains, mapCenter, 1, 100)
    if (hub.length) {
      setOrigin(hub[0])
      originInitRef.current = true
    }
  }, [data, effectiveTrains, mapCenter])
  const setUserOrigin = (s) => {
    originInitRef.current = true
    setOrigin(s)
  }

  // 地图点选：选车时关掉区县面板，点区县时取消选车（右侧只保留一个面板）
  const selectTrain = (no) => {
    setSelectedNo(no)
    if (no) setSelectedCounty(null)
  }
  const pickCounty = (f) => {
    setSelectedCounty(f)
    setSelectedNo(null)
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
      {fetchStatus?.running && (
        <div className="fetch-banner">
          全量抓取中 {fetchStatus.done ?? 0}/{fetchStatus.total ?? '…'} ·{' '}
          {fetchStatus.phase === 'timetables' ? '时刻表' : fetchStatus.phase}
        </div>
      )}
      {dataStale && (
        <div className="fetch-banner done">
          数据已更新（{fetchStatus.dataDate}
          {typeof fetchStatus.trains === 'number' ? ` · ${fetchStatus.trains} 趟` : ''}）
          <button type="button" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      )}
      <TrainMap
        stations={data.stations}
        stationsMap={data.stationsMap}
        trains={effectiveTrains}
        simMinutes={simMinutes}
        nowAbs={nowAbs}
        selectedNo={selectedNo}
        onSelect={selectTrain}
        flyTarget={flyTarget}
        selectedCorridor={corridorId}
        onPickCorridor={setCorridorId}
        lineFilter={lineFilter}
        counties={counties}
        countyVisible={countyVisible}
        selectedCounty={selectedCounty}
        onPickCounty={pickCounty}
        onCenter={setMapCenter}
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
        lineFilter={lineFilter}
        onLineFilter={changeLayer}
        countyVisible={countyVisible}
        onCountyToggle={() => setCountyVisible((v) => !v)}
        countyReady={Boolean(counties)}
      >
        <SearchBox stations={data.stations} trains={effectiveTrains} onPickTrain={pickTrain} onPickStation={pickStation} />
      </ControlPanel>
      <Timeline
        minutes={nowAbs}
        onScrub={scrubTo}
        onScrubStart={() => setScrubbing(true)}
        onScrubEnd={() => setScrubbing(false)}
      />
      {corridor && (
        <TrainDiagram
          corridor={corridor}
          trains={effectiveTrains}
          simMinutes={nowAbs}
          selectedNo={selectedNo}
          onPickTrain={(no) => {
            const t = effectiveTrains.find((x) => x.no === no)
            if (t) pickTrain(t)
          }}
          onClose={() => setCorridorId(null)}
        />
      )}
      {selectedCounty && (
        <CountyPanel
          county={selectedCounty}
          stations={data.stations}
          stationsMap={data.stationsMap}
          trains={effectiveTrains}
          nowAbs={nowAbs}
          center={mapCenter}
          origin={origin}
          onSetOrigin={setUserOrigin}
          onClose={() => setSelectedCounty(null)}
          onPickStation={pickStation}
        />
      )}
      {journeyTrain && (
        <TrainJourneyDiagram
          train={journeyTrain}
          stationsMap={data.stationsMap}
          trains={effectiveTrains}
          corridors={allCorridors}
          nowAbs={nowAbs}
          selectedNo={selectedNo}
          onPickTrain={(no) => {
            setSelectedNo(no)
            setJourneyNo(no)
          }}
          onClose={() => setJourneyNo(null)}
        />
      )}
      {selectedTrain && (
        <TrainDetail
          train={selectedTrain}
          stationsMap={data.stationsMap}
          nowAbs={nowAbs}
          onClose={() => setSelectedNo(null)}
          onJourney={() => setJourneyNo(selectedTrain.no)}
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
              {TRAIN_TYPES.map((t) => {
                // 不属于当前图层（高铁/普速）的车型淡化，保持图例与地图一致
                const dim = lineFilter !== 'all' && trainCategory(t.letter) !== lineFilter
                return (
                  <span className={`type-chip${dim ? ' dim' : ''}`} key={t.letter} title={`${t.label}：${t.desc}`}>
                    <i className={`chip-shape shape-${t.shape}`} style={{ '--tc': t.color }} />
                    {t.letter}·{t.label}
                  </span>
                )
              })}
            </div>
            <div className="item legend-status">
              <span className="ring-demo ontime" />
              <span>正点</span>
              <span className="ring-demo delayed" />
              <span>晚点</span>
              <span className="ring-demo unknown" />
              <span>未实测</span>
            </div>
            <div className="item muted">
              在图车次 {mapTrains.length} · 车站 {meta.counts?.stations ?? data.stations.length}
            </div>
            <div className="item muted">
              {counties ? `区县 ${counties.counties.length} · 放大到 7 级点击查直达` : '区县边界加载中…'}
            </div>
            <div className="item muted">缩放分级：远景大站快车，放大显示更多列车与车站</div>
            {lateTop.length === 0 && (
              <div className="item muted">
                {liveDelays?.sampled ? `本轮实测 ${liveDelays.sampled.length} 趟，均正点` : '抽样车次当前均正点'}
              </div>
            )}
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
              {liveDelays?.sampled ? ` · 覆盖 ${liveDelays.sampled.length} 趟` : ''}
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
