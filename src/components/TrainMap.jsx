import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { stations, stationsMap } from '../data/stations'
import { trains } from '../data/trains'
import { computeTrainPosition } from '../lib/position'
import { wgs84ToGcj02 } from '../lib/coord'
import { statusColor } from '../lib/status'

// 高德瓦片使用 GCJ-02，所有 WGS-84 坐标先转换再交给 Leaflet
const gcj = (lat, lng) => wgs84ToGcj02(lat, lng)
const gcjOf = (s) => {
  const p = gcj(s.lat, s.lng)
  return [p.lat, p.lng]
}

function trainIcon(t, selected) {
  return L.divIcon({
    className: '',
    html: `<div class="train-marker${selected ? ' selected' : ''}" style="background:${statusColor(t.delay)}">${t.no}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })
}

function tooltipHtml(t, simMinutes) {
  const pos = computeTrainPosition(t, stationsMap, simMinutes)
  return (
    `<b>${t.no}</b>` +
    (pos.delay
      ? `<span style="color:#e67e22">（晚点 ${pos.delay} 分）</span>`
      : '<span style="color:#27ae60">（正点）</span>') +
    `<br/>${pos.label}` +
    (pos.nextStation ? `<br/>预计 ${pos.arrTime} 到 ${pos.nextStation}` : '') +
    `<br/><span style="color:#999">点击查看详情</span>`
  )
}

export default function TrainMap({ simMinutes, selectedNo, onSelect }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef({})
  // simMinutes/onSelect 每帧变化，用 ref 透传，地图仅初始化一次
  const simRef = useRef(simMinutes)
  simRef.current = simMinutes
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    const map = L.map(containerRef.current, {
      center: gcj(35.2, 108.5),
      zoom: 5,
      minZoom: 4,
      preferCanvas: true, // M4：全国数千要素走 Canvas 渲染
    })

    L.tileLayer(
      'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      { subdomains: ['1', '2', '3', '4'], maxZoom: 18, attribution: '&copy; 高德地图' },
    ).addTo(map)

    // 每趟车的经停连线（细线成网，点击可选中车次）
    for (const t of trains) {
      const pts = t.stops.map((s) => stationsMap[s.code]).filter(Boolean).map(gcjOf)
      if (pts.length < 2) continue
      L.polyline(pts, { color: '#4a6fa5', weight: 1.2, opacity: 0.35 })
        .on('click', () => onSelectRef.current(t.no))
        .addTo(map)
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

    // 列车 marker：tooltip 用函数内容（打开时实时计算，无需反复重绑）
    for (const t of trains) {
      const m = L.marker([0, 0], { icon: trainIcon(t, false) }).addTo(map)
      m.bindTooltip(() => tooltipHtml(t, simRef.current))
      m.on('click', () => onSelectRef.current(t.no))
      markersRef.current[t.no] = m
    }

    map.on('click', () => onSelectRef.current(null))

    // 位置刷新节流：500ms 一跳（200+ 车 × 每帧 setState 太重）
    const updatePositions = () => {
      for (const t of trains) {
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
    }
  }, [])

  // 选中态高亮
  useEffect(() => {
    for (const t of trains) {
      const marker = markersRef.current[t.no]
      if (!marker) continue
      const selected = t.no === selectedNo
      marker.setIcon(trainIcon(t, selected))
      marker.setZIndexOffset(selected ? 1000 : 0)
    }
  }, [selectedNo])

  return <div ref={containerRef} className="map-container" />
}
