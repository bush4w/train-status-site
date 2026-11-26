import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { stations, stationsMap } from '../data/stations'
import { railLines } from '../data/lines'
import { computeTrainPosition } from '../lib/position'
import { wgs84ToGcj02 } from '../lib/coord'
import { trainTypeInfo } from '../lib/train-type'
import { CORRIDORS, resolveCorridor } from '../lib/diagram'

// 走廊（线路）静态解析：站名 → 坐标序列（数据不变，模块级算一次）
const stationsByName = Object.fromEntries(stations.map((s) => [s.name, s]))
const CORRIDOR_PATHS = CORRIDORS.map((c) => resolveCorridor(c, stationsByName)).filter(
  (c) => c.stations.length >= 3,
)

// 高德瓦片使用 GCJ-02，所有 WGS-84 坐标先转换再交给 Leaflet
const gcj = (lat, lng) => wgs84ToGcj02(lat, lng)
const gcjOf = (s) => {
  const p = gcj(s.lat, s.lng)
  return [p.lat, p.lng]
}

// 双通道编码标记：填充色+形状=车型（新版车次编排规定），光环=正晚点，蓝环=选中
function trainIcon(t, selected) {
  const info = trainTypeInfo(t.no)
  const w = Math.max(26, 13 + String(t.no).length * 7)
  const cls = [
    'train-pill',
    `shape-${info.shape}`,
    t.delay > 0 ? 'delayed' : 'ontime',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" style="--tc:${info.color}">${t.no}</div>`,
    iconSize: [w, 20],
    iconAnchor: [w / 2, 10],
  })
}

function tooltipHtml(t, simMinutes) {
  const pos = computeTrainPosition(t, stationsMap, simMinutes)
  const type = trainTypeInfo(t.no)
  return (
    `<b>${t.no}</b> <span style="color:${type.color}">${type.label}</span>` +
    (pos.delay
      ? `<span style="color:#e67e22">（晚点 ${pos.delay} 分）</span>`
      : '<span style="color:#27ae60">（正点）</span>') +
    `<br/>${pos.label}` +
    (pos.nextStation ? `<br/>预计 ${pos.arrTime} 到 ${pos.nextStation}` : '') +
    `<br/><span style="color:#999">点击查看详情</span>`
  )
}

export default function TrainMap({ trains, simMinutes, selectedNo, onSelect, flyTarget, selectedCorridor, onPickCorridor }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef({})
  const corridorLinesRef = useRef({})
  // 每帧/每次轮询变化的量用 ref 透传，地图仅初始化一次
  const simRef = useRef(simMinutes)
  simRef.current = simMinutes
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const trainsRef = useRef(trains)
  trainsRef.current = trains
  const selectedCorridorRef = useRef(selectedCorridor)
  selectedCorridorRef.current = selectedCorridor
  const onPickCorridorRef = useRef(onPickCorridor)
  onPickCorridorRef.current = onPickCorridor

  useEffect(() => {
    const map = L.map(containerRef.current, {
      center: gcj(35.2, 108.5),
      zoom: 5,
      minZoom: 4,
      preferCanvas: true, // 全国数千要素走 Canvas 渲染
    })

    L.tileLayer(
      'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        attribution: '&copy; 高德地图 | 线路几何 &copy; OpenStreetMap contributors (ODbL)',
      },
    ).addTo(map)

    // 真实铁路线位（OSM 几何，WGS-84 → GCJ-02；普速在下、高铁在上）
    const toGcjLine = (line) => {
      const out = new Array(line.length)
      for (let i = 0; i < line.length; i++) {
        const p = gcj(line[i][0], line[i][1])
        out[i] = [p.lat, p.lng]
      }
      return out
    }
    for (const line of railLines.conv) {
      L.polyline(toGcjLine(line), { color: '#8a8f98', weight: 1, opacity: 0.55, interactive: false }).addTo(map)
    }
    for (const line of railLines.hsr) {
      L.polyline(toGcjLine(line), { color: '#4a6fa5', weight: 1.8, opacity: 0.75, interactive: false }).addTo(map)
    }

    // 车站分层：精确坐标站常驻；城市级站 zoom≥7 才显示（减噪）
    const preciseLayer = L.layerGroup()
    const cityLayer = L.layerGroup()
    for (const s of stations) {
      const m = L.circleMarker(gcjOf(s), {
        radius: s.precise ? 4 : 2.5,
        color: '#fff',
        weight: s.precise ? 1.5 : 0.8,
        fillColor: '#333',
        fillOpacity: 1,
      }).bindTooltip(s.name)
      ;(s.precise ? preciseLayer : cityLayer).addLayer(m)
    }
    preciseLayer.addTo(map)
    const syncCityLayer = () => {
      if (map.getZoom() >= 7) {
        if (!map.hasLayer(cityLayer)) cityLayer.addTo(map)
      } else if (map.hasLayer(cityLayer)) {
        map.removeLayer(cityLayer)
      }
    }
    map.on('zoomend', syncCityLayer)
    syncCityLayer()

    // 线路走廊：不可见粗命中线（点击→运行图）+ 悬停/选中高亮线
    for (const c of CORRIDOR_PATHS) {
      const pts = c.stations.map((s) => gcjOf(s))
      const visible = L.polyline(pts, { color: '#e67e22', weight: 3.5, opacity: 0, interactive: false }).addTo(map)
      L.polyline(pts, { color: '#4a6fa5', weight: 14, opacity: 0, interactive: true })
        .bindTooltip(`${c.name} · 点击查看运行图`)
        .on('mouseover', () => {
          if (selectedCorridorRef.current !== c.id) visible.setStyle({ opacity: 0.45 })
        })
        .on('mouseout', () => {
          if (selectedCorridorRef.current !== c.id) visible.setStyle({ opacity: 0 })
        })
        .on('click', () => onPickCorridorRef.current?.(c.id))
        .addTo(map)
      corridorLinesRef.current[c.id] = visible
    }

    // 列车 marker：tooltip 函数内容（打开时按最新晚点/时刻实时计算）
    for (const t of trainsRef.current) {
      const m = L.marker([0, 0], { icon: trainIcon(t, false) }).addTo(map)
      m.bindTooltip(() => {
        const cur = trainsRef.current.find((x) => x.no === t.no) || t
        return tooltipHtml(cur, simRef.current)
      })
      m.on('click', () => onSelectRef.current(t.no))
      markersRef.current[t.no] = m
    }

    map.on('click', () => onSelectRef.current(null))

    // 位置刷新节流：500ms 一跳
    const updatePositions = () => {
      for (const t of trainsRef.current) {
        const marker = markersRef.current[t.no]
        if (!marker) continue
        const pos = computeTrainPosition(t, stationsMap, simRef.current)
        marker.setLatLng(gcj(pos.lat, pos.lng))
      }
    }
    updatePositions()
    const timer = setInterval(updatePositions, 500)

    mapRef.current = map
    return () => {
      clearInterval(timer)
      map.remove()
      mapRef.current = null
      markersRef.current = {}
      corridorLinesRef.current = {}
    }
  }, [])

  // 选中走廊高亮
  useEffect(() => {
    for (const [id, line] of Object.entries(corridorLinesRef.current)) {
      line.setStyle({ opacity: id === selectedCorridor ? 0.9 : 0 })
    }
  }, [selectedCorridor])

  // 选中态 + 晚点变化 → 重建图标（delaySig 由轮询合并后的晚点驱动）
  const delaySig = trains.map((t) => `${t.no}:${t.delay}`).join(',')
  useEffect(() => {
    for (const t of trainsRef.current) {
      const marker = markersRef.current[t.no]
      if (!marker) continue
      const selected = t.no === selectedNo
      marker.setIcon(trainIcon(t, selected))
      marker.setZIndexOffset(selected ? 1000 : 0)
    }
  }, [selectedNo, delaySig])

  // 搜索定位飞行（seq 变化触发）
  useEffect(() => {
    if (!flyTarget || !mapRef.current) return
    const p = gcj(flyTarget.lat, flyTarget.lng)
    mapRef.current.flyTo([p.lat, p.lng], flyTarget.zoom, { duration: 1.2 })
  }, [flyTarget])

  return <div ref={containerRef} className="map-container" />
}
