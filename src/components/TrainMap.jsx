import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { computeTrainStatus } from '../lib/position'
import { wgs84ToGcj02 } from '../lib/coord'
import { trainTypeInfo } from '../lib/train-type'
import { CORRIDORS } from '../lib/diagram'
import { buildRailIndex, buildTrainPath, posAtKm, kmFromStatus, snapChord } from '../lib/snap'

// 高德瓦片使用 GCJ-02，所有 WGS-84 坐标先转换再交给 Leaflet
const gcj = (lat, lng) => wgs84ToGcj02(lat, lng)
const gcjOf = (s) => {
  const p = gcj(s.lat, s.lng)
  return [p.lat, p.lng]
}

// ---------- LOD 分级 ----------
// 列车等级：1=大站快车（X/G）2=快车（T/K）3=动车（D/C）4=普速快（S/Z）5=普速（N/V/Y/普客）
const TRAIN_LEVEL = { X: 1, G: 1, T: 2, K: 2, D: 3, C: 3, S: 4, Z: 4, N: 5, V: 5, Y: 5, L: 5, 普: 5 }
function trainLevel(no) {
  return TRAIN_LEVEL[String(no)[0]?.toUpperCase()] ?? 5
}
// 当前 zoom 下允许显示的最高等级
function zoomLevelCap(zoom) {
  if (zoom >= 8) return 5
  if (zoom >= 7) return 4
  if (zoom >= 6) return 3
  if (zoom >= 5) return 2
  return 1
}
const MAX_MARKERS = 800 // 同屏上限，防止低缩放爆量

// ---------- 车型 SVG 剪影 ----------
function trainIcon(t, selected, showLabel) {
  const info = trainTypeInfo(t.no)
  const delayed = t.delay > 0
  const stroke = delayed ? '#e67e22' : '#ffffff'
  const shape =
    info.shape === 'emu'
      ? `<svg class="veh" width="26" height="13" viewBox="0 0 26 13"><path d="M1.5 6.5 C1.5 2.5 4 1.5 7 1.5 H18.5 C23.5 2 25 4.5 25 6.5 C25 8.5 23.5 11 18.5 11.5 H7 C4 11.5 1.5 10.5 1.5 6.5 Z" fill="${info.color}" stroke="${stroke}" stroke-width="1.4"/></svg>`
      : `<svg class="veh" width="22" height="13" viewBox="0 0 22 13"><rect x="1.2" y="1.8" width="19.6" height="9.4" rx="2.2" fill="${info.color}" stroke="${stroke}" stroke-width="1.4"/><rect x="15.6" y="3.6" width="3.4" height="5.8" rx="1" fill="rgba(255,255,255,.8)"/></svg>`
  const label = showLabel
    ? `<span class="veh-label">${t.no}${delayed ? ` +${t.delay}` : ''}</span>`
    : ''
  const cls = `veh-wrap${selected ? ' sel' : ''}${delayed ? ' delayed' : ''}`
  return L.divIcon({
    className: cls,
    html: `<div class="veh-box">${shape}${label}</div>`,
    iconSize: [44, showLabel ? 30 : 14],
    iconAnchor: [22, 7],
  })
}

function tooltipHtml(t, simMinutes, stationsMap) {
  const st = computeTrainStatus(t, stationsMap, simMinutes)
  const type = trainTypeInfo(t.no)
  return (
    `<b>${t.no}</b> <span style="color:${type.color}">${type.label}</span>` +
    (st.delay
      ? `<span style="color:#e67e22">（晚点 ${st.delay} 分）</span>`
      : '<span style="color:#27ae60">（正点）</span>') +
    `<br/>${st.label}` +
    (st.nextStation ? `<br/>预计 ${st.arrTime} 到 ${st.nextStation}` : '') +
    `<br/><span style="color:#999">点击查看详情</span>`
  )
}

export default function TrainMap({ stations, stationsMap, trains, simMinutes, selectedNo, onSelect, flyTarget, selectedCorridor, onPickCorridor }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef(new Map())
  const corridorLinesRef = useRef({})
  const indexRef = useRef(null)
  const pathsRef = useRef(new Map())
  const stationsByNameRef = useRef(null)
  const simRef = useRef(simMinutes)
  simRef.current = simMinutes
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const trainsRef = useRef(trains)
  trainsRef.current = trains
  const stationsMapRef = useRef(stationsMap)
  stationsMapRef.current = stationsMap
  const selectedNoRef = useRef(selectedNo)
  selectedNoRef.current = selectedNo
  const selectedCorridorRef = useRef(selectedCorridor)
  selectedCorridorRef.current = selectedCorridor
  const onPickCorridorRef = useRef(onPickCorridor)
  onPickCorridorRef.current = onPickCorridor

  const stationLayersRef = useRef(null)
  const lineLayerRef = useRef(null)
  const corridorLayerRef = useRef(null)

  // ---------- 位置解析：吸附路径优先，弦线兜底 ----------
  function resolvePos(t, st) {
    const path = pathsRef.current.get(t.no)
    if (path) {
      const km = kmFromStatus(path, st)
      const p = posAtKm(path, km)
      if (p) return p
    }
    const sm = stationsMapRef.current
    if (st.status === 'running') {
      const a = sm[t.stops[st.k].code]
      const b = sm[t.stops[st.k + 1].code]
      return [a.lat + (b.lat - a.lat) * st.progress, a.lng + (b.lng - a.lng) * st.progress]
    }
    const s = sm[t.stops[st.k].code]
    return [s.lat, s.lng]
  }

  // ---------- marker 同步（LOD + 视野过滤 + 增删 diff） ----------
  function syncMarkers() {
    const map = mapRef.current
    if (!map) return
    const zoom = map.getZoom()
    const cap = zoomLevelCap(zoom)
    const bounds = map.getBounds().pad(0.08)
    const showLabel = zoom >= 7
    const sm = stationsMapRef.current
    const seen = new Set()
    let count = 0

    for (const t of trainsRef.current) {
      const selected = t.no === selectedNoRef.current
      if (!selected && trainLevel(t.no) > cap) continue
      const st = computeTrainStatus(t, sm, simRef.current)
      const pos = resolvePos(t, st)
      const g = gcj(pos[0], pos[1])
      if (!selected && !bounds.contains([g.lat, g.lng])) continue
      if (!selected && count >= MAX_MARKERS) continue
      count++
      seen.add(t.no)

      let m = markersRef.current.get(t.no)
      const sig = `${t.delay}|${showLabel}|${selected}`
      if (!m) {
        m = L.marker([g.lat, g.lng], { icon: trainIcon(t, selected, showLabel), zIndexOffset: selected ? 1000 : 100 }).addTo(map)
        m.bindTooltip(() => {
          const cur = trainsRef.current.find((x) => x.no === t.no) || t
          return tooltipHtml(cur, simRef.current, stationsMapRef.current)
        })
        m.on('click', () => onSelectRef.current(t.no))
        m._sig = sig
        markersRef.current.set(t.no, m)
      } else {
        m.setLatLng([g.lat, g.lng])
        if (m._sig !== sig) {
          m.setIcon(trainIcon(t, selected, showLabel))
          m.setZIndexOffset(selected ? 1000 : 100)
          m._sig = sig
        }
      }
    }
    // 移除不在可见集内的
    for (const [no, m] of markersRef.current) {
      if (!seen.has(no)) {
        m.remove()
        markersRef.current.delete(no)
      }
    }
  }

  // ---------- 车站分层（按停站车次数 + 坐标精度分三级） ----------
  function buildStationLayers() {
    const map = mapRef.current
    if (!map) return
    const counts = new Map()
    for (const t of trainsRef.current) {
      for (const s of t.stops) counts.set(s.code, (counts.get(s.code) ?? 0) + 1)
    }
    const major = L.layerGroup()
    const mid = L.layerGroup()
    const minor = L.layerGroup()
    for (const s of stations) {
      const n = counts.get(s.code) ?? 0
      const isMajor = n >= 12
      const isMid = s.precise || n >= 3
      const target = isMajor ? major : isMid ? mid : minor
      const m = L.circleMarker(gcjOf(s), {
        radius: isMajor ? 4.5 : isMid ? 3 : 2.2,
        color: '#fff',
        weight: isMajor ? 1.5 : 0.8,
        fillColor: '#333',
        fillOpacity: 1,
      }).bindTooltip(s.name)
      target.addLayer(m)
    }
    stationLayersRef.current = { major, mid, minor }
    const syncStationLayers = () => {
      const z = map.getZoom()
      const want = [
        [major, z >= 4],
        [mid, z >= 6],
        [minor, z >= 8],
      ]
      for (const [layer, on] of want) {
        if (on && !map.hasLayer(layer)) layer.addTo(map)
        if (!on && map.hasLayer(layer)) map.removeLayer(layer)
      }
    }
    map.on('zoomend', syncStationLayers)
    syncStationLayers()
  }

  // ---------- 地图初始化（一次） ----------
  useEffect(() => {
    stationsByNameRef.current = Object.fromEntries(stations.map((s) => [s.name, s]))
    const map = L.map(containerRef.current, {
      center: gcj(35.2, 108.5),
      zoom: 5,
      minZoom: 4,
      preferCanvas: true,
    })
    L.tileLayer(
      'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        attribution: '&copy; 高德地图 | 线路几何 &copy; OpenStreetMap contributors (ODbL)',
      },
    ).addTo(map)
    buildStationLayers()
    map.on('click', () => onSelectRef.current(null))
    map.on('moveend', syncMarkers)
    map.on('zoomend', syncMarkers)

    mapRef.current = map
    const timer = setInterval(syncMarkers, 500)
    syncMarkers()
    return () => {
      clearInterval(timer)
      map.remove()
      mapRef.current = null
      markersRef.current.clear()
      corridorLinesRef.current = {}
      pathsRef.current.clear()
      indexRef.current = null
      stationLayersRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- 线位几何加载 → 索引 → 吸附路径 → 走廊命中线 ----------
  useEffect(() => {
    let alive = true
    fetch('data/lines.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j || !mapRef.current) return
        const map = mapRef.current
        const toGcjLine = (line) => line.map(([lat, lng]) => {
          const p = gcj(lat, lng)
          return [p.lat, p.lng]
        })
        // 线路底图（2 条多段折线）
        const drawGroup = (key, style) => {
          const lines = (j[key] ?? []).map(toGcjLine).filter((l) => l.length >= 2)
          if (lines.length) L.polyline(lines, { ...style, interactive: false }).addTo(lineLayerRef.current ?? (lineLayerRef.current = L.layerGroup().addTo(map)))
        }
        drawGroup('conv', { color: '#8a8f98', weight: 1, opacity: 0.55 })
        drawGroup('hsr', { color: '#4a6fa5', weight: 1.8, opacity: 0.75 })

        // 索引与吸附路径
        const index = buildRailIndex(j)
        indexRef.current = index
        const sm = stationsMapRef.current
        // 站对缓存跨车次复用
        const pairCache = new Map()
        const trains = trainsRef.current
        let i = 0
        const chunk = () => {
          if (!alive) return
          const end = Math.min(i + 120, trains.length)
          for (; i < end; i++) {
            const t = trains[i]
            const p = buildTrainPath(t, sm, index, pairCache)
            if (p) pathsRef.current.set(t.no, p)
          }
          if (i < trains.length) setTimeout(chunk, 0)
        }
        chunk()

        // 走廊命中线：吸附到真实线位（失败回退弦线）
        const byName = stationsByNameRef.current
        const layer = L.layerGroup().addTo(map)
        corridorLayerRef.current = layer
        for (const c of CORRIDORS) {
          const sts = c.stations.map((n) => byName[n]).filter(Boolean)
          if (sts.length < 3) continue
          const pts = []
          for (let k = 0; k < sts.length - 1; k++) {
            const a = [sts[k].lat, sts[k].lng]
            const b = [sts[k + 1].lat, sts[k + 1].lng]
            const seg = snapChord(a, b, index) || [a, b]
            for (let q = pts.length ? 1 : 0; q < seg.length; q++) pts.push(seg[q])
          }
          const gj = toGcjLine(pts)
          const visible = L.polyline(gj, { color: '#e67e22', weight: 3.5, opacity: 0, interactive: false }).addTo(layer)
          L.polyline(gj, { color: '#4a6fa5', weight: 14, opacity: 0, interactive: true })
            .bindTooltip(`${c.name} · 点击查看运行图`)
            .on('mouseover', () => {
              if (selectedCorridorRef.current !== c.id) visible.setStyle({ opacity: 0.45 })
            })
            .on('mouseout', () => {
              if (selectedCorridorRef.current !== c.id) visible.setStyle({ opacity: 0 })
            })
            .on('click', () => onPickCorridorRef.current?.(c.id))
            .addTo(layer)
          corridorLinesRef.current[c.id] = visible
        }
        syncMarkers()
      })
      .catch(() => {
        /* 无几何数据时仅显示车站与弦线位置的列车 */
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- 选中车次/走廊变化 → 立即同步 ----------
  useEffect(() => {
    syncMarkers()
    for (const [id, line] of Object.entries(corridorLinesRef.current)) {
      line.setStyle({ opacity: id === selectedCorridor ? 0.9 : 0 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNo, selectedCorridor])

  // ---------- 搜索定位飞行 ----------
  useEffect(() => {
    if (!flyTarget || !mapRef.current) return
    const p = gcj(flyTarget.lat, flyTarget.lng)
    mapRef.current.flyTo([p.lat, p.lng], flyTarget.zoom, { duration: 1.2 })
  }, [flyTarget])

  return <div ref={containerRef} className="map-container" />
}
