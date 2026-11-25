import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { stations, linePoints, stationsMap } from '../data/stations'
import { trains } from '../data/trains'
import { computeTrainPosition } from '../lib/position'
import { wgs84ToGcj02 } from '../lib/coord'
import { statusColor } from '../lib/status'

// 高德瓦片使用 GCJ-02，所有 WGS-84 坐标先转换再交给 Leaflet
const gcj = (lat, lng) => wgs84ToGcj02(lat, lng)

function trainIcon(t, selected) {
  return L.divIcon({
    className: '',
    html: `<div class="train-marker${selected ? ' selected' : ''}" style="background:${statusColor(t.delay)}">${t.no}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })
}

export default function TrainMap({ simMinutes, selectedNo, onSelect }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef({})
  // onSelect 每次渲染都是新闭包，用 ref 透传，避免地图重复初始化
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  // 初始化地图（仅一次）
  useEffect(() => {
    const map = L.map(containerRef.current, {
      center: gcj(34.5, 117.0),
      zoom: 6,
      minZoom: 4,
    })

    // 高德中文瓦片（国内访问快）；如需国际版可换 OpenStreetMap，见 coord.js 说明
    L.tileLayer(
      'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        attribution: '&copy; 高德地图',
      },
    ).addTo(map)

    // 线路
    L.polyline(linePoints.map((p) => [gcj(p.lat, p.lng).lat, gcj(p.lat, p.lng).lng]), {
      color: '#4a6fa5',
      weight: 3,
      opacity: 0.7,
    }).addTo(map)

    // 车站
    stations.forEach((s) => {
      const p = gcj(s.lat, s.lng)
      L.circleMarker([p.lat, p.lng], {
        radius: 4,
        color: '#fff',
        weight: 1.5,
        fillColor: '#333',
        fillOpacity: 1,
      })
        .bindTooltip(s.name)
        .addTo(map)
    })

    // 列车 marker（初始置于地图外，随后由 simMinutes 驱动）
    trains.forEach((t) => {
      const m = L.marker([0, 0], { icon: trainIcon(t, false) }).addTo(map)
      // F3：点击列车打开详情（marker 默认不向地图冒泡，不会误触发取消选中）
      m.on('click', () => onSelectRef.current(t.no))
      markersRef.current[t.no] = m
    })

    // 点击地图空白处关闭详情
    map.on('click', () => onSelectRef.current(null))

    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // 随时间推进更新列车位置
  useEffect(() => {
    if (!mapRef.current) return
    trains.forEach((t) => {
      const marker = markersRef.current[t.no]
      if (!marker) return
      const pos = computeTrainPosition(t, stationsMap, simMinutes)
      const p = gcj(pos.lat, pos.lng)
      marker.setLatLng([p.lat, p.lng])
      marker.unbindTooltip()
      const info =
        `<b>${t.no}</b>` +
        (pos.delay ? `<span style="color:#e67e22">（晚点 ${pos.delay} 分）</span>` : '<span style="color:#27ae60">（正点）</span>') +
        `<br/>${pos.label}` +
        (pos.nextStation ? `<br/>预计 ${pos.arrTime} 到 ${pos.nextStation}` : '') +
        `<br/><span style="color:#999">点击查看详情</span>`
      marker.bindTooltip(info)
    })
  }, [simMinutes])

  // 选中态高亮
  useEffect(() => {
    trains.forEach((t) => {
      const marker = markersRef.current[t.no]
      if (!marker) return
      const selected = t.no === selectedNo
      marker.setIcon(trainIcon(t, selected))
      marker.setZIndexOffset(selected ? 1000 : 0)
    })
  }, [selectedNo])

  return <div ref={containerRef} className="map-container" />
}
