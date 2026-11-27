import { useMemo, useState } from 'react'
import { countStops, findDirectTrains, fmtAbsMin, nearestStations, distanceKm } from '../lib/access'
import { findTransferRoutes } from '../lib/transfer'
import { trainTypeInfo } from '../lib/train-type'
import { statusColor } from '../lib/status'

// M6a/M7：区县面板 —— 基本信息 + 收录车站 + 直达车次 + 单次中转建议
// 热门内容/景点属 M6b（需整理数据），这里先留如实空状态。

function durationText(min) {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`
}

const isTourist = (no) => /^Y/i.test(no)

function NoBadge({ no }) {
  const type = trainTypeInfo(no)
  return (
    <span className="arrival-no" style={{ background: type.color }}>
      {no}
      {isTourist(no) ? <i className="badge-tour">旅游</i> : null}
    </span>
  )
}

function DelayBadge({ delay, known }) {
  return (
    <span className="arrival-status" style={{ color: statusColor(delay, known) }}>
      {!known ? '未实测' : delay ? `+${delay}` : '正点'}
    </span>
  )
}

export default function CountyPanel({
  county,
  stations,
  stationsMap,
  trains,
  nowAbs,
  center,
  origin,
  onSetOrigin,
  onClose,
  onPickStation,
}) {
  const [geoState, setGeoState] = useState('') // '' | 'asking' | 'denied' | 'ok'
  // 按分钟取整：时钟每 100ms 跳一次，可达查询没必要跟到秒
  const nowMinute = Math.floor(nowAbs)

  const countyStations = useMemo(
    () => (county.stations ?? []).map((code) => stationsMap[code]).filter(Boolean),
    [county, stationsMap],
  )

  // 枢纽站（停靠 ≥12 趟）：用于起点选择，避免几百个乘降所
  const hubs = useMemo(() => countStops(trains, 12), [trains])
  const hubList = useMemo(() => {
    const out = []
    for (const code of hubs.keys()) {
      const s = stationsMap[code]
      if (s) out.push(s)
    }
    return out
  }, [hubs, stationsMap])

  // 起点默认值在 App 侧一次固定；这里的候选按「目标区县附近」排序，方便手动改近处城市
  const target = county.center ? { lat: county.center[0], lng: county.center[1] } : center
  const nearby = useMemo(
    () => (target ? nearestStations(hubList, target.lat, target.lng, 14) : hubList.slice(0, 14)),
    [hubList, target],
  )
  const effectiveOrigin = origin ?? nearby[0] ?? null
  const originOptions =
    effectiveOrigin && !nearby.some((s) => s.code === effectiveOrigin.code)
      ? [{ ...effectiveOrigin, km: target ? distanceKm(target, effectiveOrigin) : 0 }, ...nearby]
      : nearby

  // 起点按城市取站：从「北京」出发时，北京南/北京西/北京朝阳都算可选
  const fromCodes = useMemo(() => {
    if (!effectiveOrigin) return []
    const codes = stations.filter((s) => s.city && s.city === effectiveOrigin.city).map((s) => s.code)
    return codes.length ? codes : [effectiveOrigin.code]
  }, [stations, effectiveOrigin])

  const arrivals = useMemo(
    () => (countyStations.length ? findDirectTrains(trains, fromCodes, county.stations, nowMinute, { limit: 40 }) : []),
    [trains, fromCodes, county.stations, countyStations.length, nowMinute],
  )

  // 直达不足 3 趟时才尝试一次中转（耗时可观，避免每次打开都全量算）
  const transfers = useMemo(() => {
    if (!countyStations.length || arrivals.length >= 3) return []
    return findTransferRoutes(trains, fromCodes, county.stations, nowMinute, { limit: 5 })
  }, [trains, fromCodes, county.stations, countyStations.length, arrivals.length, nowMinute])

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setGeoState('denied')
      return
    }
    setGeoState('asking')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        let best = null
        for (const s of hubList) {
          const km = distanceKm({ lat: latitude, lng: longitude }, s)
          if (!best || km < best.km) best = { ...s, km }
        }
        if (best) {
          onSetOrigin(best)
          setGeoState('ok')
        } else {
          setGeoState('denied')
        }
      },
      () => setGeoState('denied'),
      { timeout: 8000, maximumAge: 300000 },
    )
  }

  const stName = (code) => stationsMap[code]?.name ?? code

  return (
    <div className="county-panel">
      <div className="county-head">
        <div>
          <b>{county.name}</b>
          <span className="county-sub">
            {county.province} · {county.city}
            {county.code ? ` · ${county.code}` : ''}
          </span>
        </div>
        <button type="button" className="btn-icon" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>

      <div className="county-section">
        <div className="county-label">收录车站 · {countyStations.length}</div>
        {countyStations.length === 0 ? (
          <div className="county-empty">该区县暂无收录车站（可能尚未抓取到经停车次），可查看邻近区县。</div>
        ) : (
          <div className="county-chips">
            {countyStations.map((s) => (
              <button
                type="button"
                className="county-chip"
                key={s.code}
                title={`${s.name} · ${s.code}${s.precise ? ' · 实测坐标' : ' · 近似坐标'}`}
                onClick={() => onPickStation?.(s)}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="county-section">
        <div className="county-label">
          铁路可达
          {effectiveOrigin ? (
            <span className="county-origin-note">
              从 {effectiveOrigin.name}
              {target ? `（距区县约 ${Math.round(distanceKm(target, effectiveOrigin))} km）` : ''}
            </span>
          ) : null}
        </div>

        <div className="county-origin-row">
          <select
            className="county-select"
            value={effectiveOrigin?.code ?? ''}
            onChange={(e) => {
              const s = hubList.find((x) => x.code === e.target.value)
              if (s) {
                onSetOrigin(s)
                setGeoState('')
              }
            }}
            aria-label="选择起点站"
          >
            {originOptions.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} · {s.city}（{Math.round(s.km)}km）
              </option>
            ))}
          </select>
          <button type="button" className="county-geo" onClick={useMyLocation} disabled={geoState === 'asking'}>
            {geoState === 'asking' ? '定位中…' : '📍 我的位置'}
          </button>
        </div>
        <div className="county-hint">
          {geoState === 'denied'
            ? '定位不可用，已回退为地图中心的枢纽站；位置仅本地计算，不上传。'
            : '开始站按城市汇总（同城多站都算）；位置仅本地计算，不上传。'}
        </div>

        {countyStations.length === 0 ? null : arrivals.length === 0 ? (
          <div className="county-empty" style={{ marginTop: 8 }}>
            未来 36 小时内无直达车次{transfers.length ? '，可参考下方中转方案：' : '。'}
          </div>
        ) : (
          <div className="county-arrivals">
            {arrivals.map((a) => (
              <div className="arrival-row" key={a.no}>
                <NoBadge no={a.no} />
                <span className="arrival-time">
                  {fmtAbsMin(a.dep)}
                  <i>{stName(a.from)}</i>
                </span>
                <span className="arrival-arrow">→</span>
                <span className="arrival-time">
                  {fmtAbsMin(a.arr)}
                  <i>{stName(a.to)}</i>
                </span>
                <span className="arrival-dur">{durationText(a.durationMin)}</span>
                <DelayBadge delay={a.delay} known={a.delayKnown} />
              </div>
            ))}
          </div>
        )}

        {transfers.length > 0 && (
          <>
            <div className="county-label transfer-heading">
              中转建议 · {transfers.length} 条
              <span className="county-origin-note">同站换乘 ≥10 分钟 · 等待 ≤3 小时</span>
            </div>
            <div className="transfer-list">
              {transfers.map((r) => (
                <div className="transfer" key={`${r.leg1}-${r.transfer}-${r.leg2}`}>
                  <div className="transfer-line">
                    <NoBadge no={r.leg1} />
                    <span className="arrival-time">
                      {fmtAbsMin(r.dep1)}
                      <i>{stName(r.from)}</i>
                    </span>
                    <span className="arrival-arrow">→</span>
                    <span className="arrival-time">
                      {fmtAbsMin(r.arr1)}
                      <i>{stName(r.transfer)}</i>
                    </span>
                    <span className="transfer-wait">换乘 {r.waitMin}m</span>
                  </div>
                  <div className="transfer-line">
                    <NoBadge no={r.leg2} />
                    <span className="arrival-time">
                      {fmtAbsMin(r.dep2)}
                      <i>{stName(r.transfer)}</i>
                    </span>
                    <span className="arrival-arrow">→</span>
                    <span className="arrival-time">
                      {fmtAbsMin(r.arr2)}
                      <i>{stName(r.to)}</i>
                    </span>
                    <span className="arrival-dur">{durationText(r.totalMin)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="county-section county-muted">
        本地热门与景点（M6b）尚未接入整理数据；当前只展示时刻表可推导的信息。
        <br />
        直达/中转结果由本地时刻表推算，与 12306 售票/开行可能有差异，仅供参考。
      </div>
    </div>
  )
}
