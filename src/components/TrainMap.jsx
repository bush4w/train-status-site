import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import { computeTrainStatus } from '../lib/position'
import { wgs84ToGcj02 } from '../lib/coord'
import { trainTypeInfo, trainCategory } from '../lib/train-type'
import { CORRIDORS } from '../lib/diagram'
import { buildRailIndex, buildTrainPath, posAtKm, kmFromStatus, snapChord } from '../lib/snap'
import { buildRouteGraph, routePair } from '../lib/route-graph'

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
  const known = t.delayKnown !== false
  const delayed = known && t.delay > 0
  const stroke = !known ? '#9aa0a6' : delayed ? '#e67e22' : '#ffffff'
  const shape =
    info.shape === 'emu'
      ? `<svg class="veh" width="26" height="13" viewBox="0 0 26 13"><path d="M1.5 6.5 C1.5 2.5 4 1.5 7 1.5 H18.5 C23.5 2 25 4.5 25 6.5 C25 8.5 23.5 11 18.5 11.5 H7 C4 11.5 1.5 10.5 1.5 6.5 Z" fill="${info.color}" stroke="${stroke}" stroke-width="1.4"/></svg>`
      : `<svg class="veh" width="22" height="13" viewBox="0 0 22 13"><rect x="1.2" y="1.8" width="19.6" height="9.4" rx="2.2" fill="${info.color}" stroke="${stroke}" stroke-width="1.4"/><rect x="15.6" y="3.6" width="3.4" height="5.8" rx="1" fill="rgba(255,255,255,.8)"/></svg>`
  const label = showLabel
    ? `<span class="veh-label">${t.no}${delayed ? ` +${t.delay}` : ''}</span>`
    : ''
  const cls = `veh-wrap${selected ? ' sel' : ''}${delayed ? ' delayed' : ''}${known ? '' : ' unknown'}`
  return L.divIcon({
    className: cls,
    html: `<div class="veh-box">${shape}${label}</div>`,
    iconSize: [44, showLabel ? 30 : 14],
    iconAnchor: [22, 7],
  })
}

function tooltipHtml(t, minutes, stationsMap) {
  const st = computeTrainStatus(t, stationsMap, minutes)
  const type = trainTypeInfo(t.no)
  const known = t.delayKnown !== false
  const delayText = !known
    ? '<span style="color:#9aa0a6">（未实测）</span>'
    : st.delay
      ? `<span style="color:#e67e22">（晚点 ${st.delay} 分）</span>`
      : '<span style="color:#27ae60">（正点）</span>'
  return (
    `<b>${t.no}</b> <span style="color:${type.color}">${type.label}</span>` +
    delayText +
    `<br/>${st.label}` +
    (st.nextStation ? `<br/>预计 ${st.arrTime} 到 ${st.nextStation}` : '') +
    `<br/><span style="color:#999">点击查看详情</span>`
  )
}

export default function TrainMap({ stations, stationsMap, trains, simMinutes, nowAbs, selectedNo, onSelect, flyTarget, selectedCorridor, onPickCorridor, lineFilter = 'all', counties = null, countyVisible = true, selectedCounty = null, onPickCounty, onCenter }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef(new Map())
  const corridorLinesRef = useRef({})
  const indexRef = useRef(null)
  const pathsRef = useRef(new Map())
  const selRouteRef = useRef(null)
  const stationsByNameRef = useRef(null)
  const simRef = useRef(nowAbs ?? simMinutes)
  simRef.current = nowAbs ?? simMinutes
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onCenterRef = useRef(onCenter)
  onCenterRef.current = onCenter
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
  const lineFilterRef = useRef(lineFilter)
  lineFilterRef.current = lineFilter
  // 区县图层（M6a）
  const countyLayerRef = useRef(null)
  const countyPolysRef = useRef(new Map())
  const countiesRef = useRef(counties)
  countiesRef.current = counties
  const countyVisibleRef = useRef(countyVisible)
  countyVisibleRef.current = countyVisible
  const selectedCountyRef = useRef(selectedCounty)
  selectedCountyRef.current = selectedCounty
  const onPickCountyRef = useRef(onPickCounty)
  onPickCountyRef.current = onPickCounty

  // 当前图层的车次池：只画本层列车（全量 trains 仍用于建路径与车站分级）
  const layerTrains = useMemo(
    () => (lineFilter === 'all' ? trains : trains.filter((t) => trainCategory(t.no) === lineFilter)),
    [trains, lineFilter],
  )
  const layerTrainsRef = useRef(layerTrains)
  layerTrainsRef.current = layerTrains

  const stationLayersRef = useRef(null)
  const lineLayerRef = useRef(null)
  const lineGroupsRef = useRef({})
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

  // ---------- 选中车次的运行路径（沿线位，degraded 段虚线） ----------
  function syncSelectedRoute() {
    const map = mapRef.current
    if (!map) return
    if (selRouteRef.current) {
      map.removeLayer(selRouteRef.current)
      selRouteRef.current = null
    }
    const no = selectedNoRef.current
    if (!no) return
    const path = pathsRef.current.get(no)
    if (!path || path.pts.length < 2) return
    const toLL = ([lat, lng]) => {
      const p = gcj(lat, lng)
      return [p.lat, p.lng]
    }
    const info = trainTypeInfo(no)
    const bad = new Set(path.degraded ?? [])
    const group = L.layerGroup()
    const segCount = (path.stopPt?.length ?? 0) - 1
    for (let i = 0; i < segCount; i++) {
      const from = path.stopPt[i]
      const to = path.stopPt[i + 1]
      if (to - from < 1) continue
      const pts = path.pts.slice(from, to + 1).map(toLL)
      if (bad.has(i)) {
        // 该区间没有线位几何，退化成站点直线：画成灰色虚线，别当成真实走向
        L.polyline(pts, { color: '#9aa0a6', weight: 2.2, opacity: 0.95, dashArray: '6 6', interactive: false }).addTo(group)
      } else {
        L.polyline(pts, { color: info.color, weight: 3, opacity: 0.85, interactive: false }).addTo(group)
      }
    }
    group.addTo(map)
    selRouteRef.current = group
  }

  // ---------- 底图线路样式（图层过滤 + 选中走廊时淡化） ----------
  function applyLineStyles() {
    const dim = Boolean(selectedCorridorRef.current)
    const mode = lineFilterRef.current
    for (const [kind, g] of Object.entries(lineGroupsRef.current)) {
      const visible = mode === 'all' || mode === kind
      // 单独查看某一图层时略提亮，避免普速灰细线显得过虚
      const base = mode === 'all' ? g.baseOpacity : Math.min(1, g.baseOpacity * 1.35)
      g.pl.setStyle({ opacity: visible ? (dim ? base * 0.3 : base) : 0 })
    }
  }

  // ---------- marker 同步（LOD + 视野过滤 + 增删 diff） ----------
  function syncMarkers() {
    const map = mapRef.current
    if (!map) return
    const zoom = map.getZoom()
    const pool = layerTrainsRef.current
    // 本层车次本就不多时跳过 LOD 降级，否则低缩放下整层列车（如普速）一辆都看不到；
    // 用户显式切到 高铁/普速 图层时同样不做等级裁剪，只保留同屏上限
    const cap =
      lineFilterRef.current !== 'all' || pool.length <= MAX_MARKERS ? 5 : zoomLevelCap(zoom)
    const bounds = map.getBounds().pad(0.08)
    const showLabel = zoom >= 7
    const sm = stationsMapRef.current
    const seen = new Set()
    let count = 0

    for (const t of pool) {
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
      const sig = `${t.delay}|${t.delayKnown}|${showLabel}|${selected}`
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

  // ---------- 区县/地市边界（M6a） ----------
  function featureBBox(f) {
    if (f._bbox) return f._bbox
    let minLat = 90
    let maxLat = -90
    let minLng = 180
    let maxLng = -180
    for (const ring of f.polys ?? []) {
      for (const [lat, lng] of ring) {
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
        if (lng < minLng) minLng = lng
        if (lng > maxLng) maxLng = lng
      }
    }
    f._bbox = [minLat, minLng, maxLat, maxLng]
    return f._bbox
  }

  // 只画当前视野内的边界：zoom≥7 区县，5–6 地市，更远不画
  function syncCounties() {
    const map = mapRef.current
    const layer = countyLayerRef.current
    const data = countiesRef.current
    if (!map || !layer) return
    layer.clearLayers()
    countyPolysRef.current = new Map()
    if (!data || !countyVisibleRef.current) return
    const zoom = map.getZoom()
    const useCounty = zoom >= 7
    if (!useCounty && zoom < 5) return
    const list = useCounty ? data.counties ?? [] : data.cities ?? []
    const bounds = map.getBounds().pad(0.15)
    const sel = selectedCountyRef.current
    for (const f of list) {
      if (!f.polys?.length) continue
      const [minLat, minLng, maxLat, maxLng] = featureBBox(f)
      if (maxLat < bounds.getSouth() || minLat > bounds.getNorth()) continue
      if (maxLng < bounds.getWest() || minLng > bounds.getEast()) continue
      const isSel = Boolean(sel && sel.code === f.code)
      const poly = L.polygon(f.polys, {
        color: isSel ? '#e67e22' : useCounty ? '#c8871f' : '#8d733f',
        weight: isSel ? 2.6 : useCounty ? 1.2 : 1.4,
        opacity: isSel ? 0.95 : 0.55,
        fillColor: isSel ? '#e67e22' : '#c9a227',
        fillOpacity: isSel ? 0.15 : useCounty ? 0.03 : 0,
        interactive: true,
      })
      poly.bindTooltip(f.name, { sticky: true })
      poly.on('click', (e) => {
        if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent)
        onPickCountyRef.current?.(f)
      })
      poly.addTo(layer)
      countyPolysRef.current.set(f.code, poly)
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
    // 区县图层：与底图共用 Canvas 渲染（Leaflet 对 interactive 图层做命中测试）
    countyLayerRef.current = L.layerGroup().addTo(map)
    map.on('click', () => onSelectRef.current(null))
    map.on('moveend', () => {
      syncMarkers()
      syncCounties()
      const c = map.getCenter()
      onCenterRef.current?.({ lat: c.lat, lng: c.lng })
    })
    map.on('zoomend', () => {
      syncMarkers()
      syncCounties()
    })

    mapRef.current = map
    const timer = setInterval(syncMarkers, 500)
    syncMarkers()
    const c0 = map.getCenter()
    onCenterRef.current?.({ lat: c0.lat, lng: c0.lng })
    return () => {
      clearInterval(timer)
      map.remove()
      mapRef.current = null
      markersRef.current.clear()
      corridorLinesRef.current = {}
      pathsRef.current.clear()
      indexRef.current = null
      selRouteRef.current = null
      stationLayersRef.current = null
      countyLayerRef.current = null
      countyPolysRef.current = new Map()
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
        lineGroupsRef.current = {}
        const drawGroup = (key, style) => {
          const lines = (j[key] ?? []).map(toGcjLine).filter((l) => l.length >= 2)
          if (!lines.length) return
          const pl = L.polyline(lines, { ...style, interactive: false }).addTo(
            lineLayerRef.current ?? (lineLayerRef.current = L.layerGroup().addTo(map)),
          )
          lineGroupsRef.current[key] = { pl, baseOpacity: style.opacity }
        }
        drawGroup('conv', { color: '#8a8f98', weight: 1, opacity: 0.55 })
        drawGroup('hsr', { color: '#4a6fa5', weight: 1.8, opacity: 0.75 })
        applyLineStyles()

        // 索引与吸附路径
        const index = buildRailIndex(j)
        indexRef.current = index
        // 路由图：绕行严重的线路（如西成高铁穿秦岭）弦线采样会失败 → 图上找真实路径
        const graph = buildRouteGraph(j)
        const routeCache = new Map()
        const router = (a, b) => {
          const key = `${a[0].toFixed(3)},${a[1].toFixed(3)}|${b[0].toFixed(3)},${b[1].toFixed(3)}`
          if (routeCache.has(key)) return routeCache.get(key)
          const r = routePair(graph, a, b)
          routeCache.set(key, r)
          return r
        }
        const sm = stationsMapRef.current
        // 站对缓存跨车次复用
        const pairCache = new Map()
        // 吸附路径构建：时间片推进（每片 ≤8ms，空闲时继续），避免一次算几秒卡住拖动/缩放。
        // 优先级：选中车次 → 当前视野内（按等级）→ 其余（按等级）。
        const all = trainsRef.current
        const bounds = map.getBounds().pad(0.15)
        const order = []
        const seen = new Set()
        const pushTrain = (t) => {
          if (!t || seen.has(t.no)) return
          seen.add(t.no)
          order.push(t)
        }
        const visible = []
        for (const t of all) {
          const s = sm[t.stops[0].code]
          if (s && bounds.contains([s.lat, s.lng])) visible.push(t)
        }
        visible.sort((a, b) => trainLevel(a.no) - trainLevel(b.no))
        pushTrain(all.find((t) => t.no === selectedNoRef.current))
        visible.forEach(pushTrain)
        all
          .filter((t) => !seen.has(t.no))
          .sort((a, b) => trainLevel(a.no) - trainLevel(b.no))
          .forEach(pushTrain)

        let idx = 0
        const slice = () => {
          if (!alive) return
          const deadline = performance.now() + 8
          while (idx < order.length && performance.now() < deadline) {
            const t = order[idx++]
            const p = buildTrainPath(t, sm, index, pairCache, router)
            if (p) pathsRef.current.set(t.no, p)
          }
          syncSelectedRoute()
          if (idx < order.length) {
            if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(slice, { timeout: 250 })
            else setTimeout(slice, 16)
          }
        }
        slice()

        // 走廊命中线：吸附到真实线位（失败回退弦线）
        const byName = stationsByNameRef.current
        const layer = L.layerGroup().addTo(map)
        corridorLayerRef.current = layer
        const svgRenderer = L.svg() // 走廊高亮用 SVG 渲染，支持流动虚线动画
        for (const c of CORRIDORS) {
          const sts = c.stations.map((n) => byName[n]).filter(Boolean)
          if (sts.length < 3) continue
          const pre = j.corridors?.[c.id]?.points
          let gj
          if (pre && pre.length >= 2) {
            // 构建期已按原始 OSM way 求好真实线位（简化图断链会让长走廊退化成直线）
            gj = toGcjLine(pre)
          } else {
            const pts = []
            for (let k = 0; k < sts.length - 1; k++) {
              const a = [sts[k].lat, sts[k].lng]
              const b = [sts[k + 1].lat, sts[k + 1].lng]
              // 与列车路径同源：采样优先 → 路由图兜底（走廊高亮与列车轨迹一致）
              const cacheKey = `${a[0].toFixed(3)},${a[1].toFixed(3)}|${b[0].toFixed(3)},${b[1].toFixed(3)}`
              let seg = pairCache.get(cacheKey)
              if (!seg) {
                seg = snapChord(a, b, index) || router(a, b) || [a, b]
                pairCache.set(cacheKey, seg)
              }
              for (let q = pts.length ? 1 : 0; q < seg.length; q++) pts.push(seg[q])
            }
            gj = toGcjLine(pts)
          }
          // 选中视觉：宽光晕 + 流动虚线双线（SVG 渲染，CSS 动画驱动）
          const halo = L.polyline(gj, { color: '#f39c12', weight: 13, opacity: 0, interactive: false, renderer: svgRenderer }).addTo(layer)
          const core = L.polyline(gj, {
            color: '#e67e22',
            weight: 3.5,
            opacity: 0,
            interactive: false,
            renderer: svgRenderer,
            dashArray: '10 7',
            className: 'corridor-flow',
          }).addTo(layer)
          L.polyline(gj, { color: '#4a6fa5', weight: 14, opacity: 0, interactive: true })
            .bindTooltip(`${c.name} · 点击查看运行图`)
            .on('mouseover', () => {
              if (selectedCorridorRef.current !== c.id) {
                halo.setStyle({ opacity: 0.35 })
                core.setStyle({ opacity: 0.7 })
              }
            })
            .on('mouseout', () => {
              if (selectedCorridorRef.current !== c.id) {
                halo.setStyle({ opacity: 0 })
                core.setStyle({ opacity: 0 })
              }
            })
            .on('click', () => onPickCorridorRef.current?.(c.id))
            .addTo(layer)
          corridorLinesRef.current[c.id] = { halo, core }
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

  // ---------- 区县数据/显隐/选中变化 → 重绘边界 ----------
  useEffect(() => {
    syncCounties()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counties, countyVisible, selectedCounty])

  // ---------- 选中车次/走廊变化 → 立即同步 ----------
  useEffect(() => {
    syncMarkers()
    syncSelectedRoute()
    for (const [id, { halo, core }] of Object.entries(corridorLinesRef.current)) {
      const on = id === selectedCorridor
      halo.setStyle({ opacity: on ? 0.32 : 0 })
      core.setStyle({ opacity: on ? 1 : 0 })
    }
    // 选中走廊时底图线路淡化，突出所选
    applyLineStyles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNo, selectedCorridor])

  // ---------- 图层切换 → 线路与列车即时显隐 ----------
  useEffect(() => {
    applyLineStyles()
    syncMarkers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineFilter])

  // ---------- 搜索定位飞行 ----------
  useEffect(() => {
    if (!flyTarget || !mapRef.current) return
    const p = gcj(flyTarget.lat, flyTarget.lng)
    mapRef.current.flyTo([p.lat, p.lng], flyTarget.zoom, { duration: 1.2 })
  }, [flyTarget])

  return <div ref={containerRef} className="map-container" />
}