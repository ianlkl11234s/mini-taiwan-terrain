import { useCallback, useEffect, useRef, useState } from 'react'
import { T, FONT_DATA, FONT_CJK } from '../../theme.js'
import { SectionHeader, Row, Slider, Icon } from '../controls.jsx'

// 導覽面板：POI 清單（點了 selectPoi 飛過去）、from/to、飛行參數、start/stop。
// 引擎沒有 tour 狀態事件 — start 回傳 true 後以 tourDuration 計時器收尾；
// 用戶手抓相機提前取消時，狀態最晚在 duration 到點自動歸位。

export default function Tour({ engine }) {
  const [pois, setPois] = useState(() => engine.getPois())
  const [selected, setSelected] = useState(-1)
  const [from, setFrom] = useState(engine.getParams().tourFrom)
  const [to, setTo] = useState(engine.getParams().tourTo)
  const [p, setP] = useState(() => ({ ...engine.getParams() }))
  const [touring, setTouring] = useState(false)
  const timer = useRef(null)

  useEffect(() => {
    const offPois = engine.on('pois', (next) => {
      setPois(next)
      // terrain regenerated — the engine re-pointed tourFrom/tourTo at valid ids
      const params = engine.getParams()
      setFrom(params.tourFrom)
      setTo(params.tourTo)
    })
    const offSel = engine.on('selection', ({ index }) => setSelected(index))
    const offParams = engine.on('params', () => setP({ ...engine.getParams() }))
    return () => {
      offPois()
      offSel()
      offParams()
      clearTimeout(timer.current)
    }
  }, [engine])

  const live = useCallback(
    (key) => (v) => {
      engine.setParams({ [key]: v })
      setP((prev) => ({ ...prev, [key]: v }))
    },
    [engine]
  )

  const start = () => {
    if (engine.startTour({ from, to })) {
      setTouring(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setTouring(false), (engine.getParams().tourDuration + 0.5) * 1000)
    }
  }
  const stop = () => {
    engine.stopTour()
    clearTimeout(timer.current)
    setTouring(false)
  }

  const selectStyle = {
    fontFamily: FONT_DATA,
    fontSize: T.fs.base,
    color: T.textStrong,
    background: '#FFFFFF', // pulse light SELECT_BG
    border: `1px solid ${T.ctrlInactiveBorder}`,
    borderRadius: T.radius.lg,
    padding: '4px 6px',
    width: '100%',
    boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div>
      <SectionHeader>Points of Interest</SectionHeader>
      {/* label 用 name（真實山峰 id 是「玉山 3952」— 海拔只顯示一處）；右欄公尺
          來自 elevM（山峰目錄海拔，不再取樣 height field — 舊 feet 取樣在圖磚
          未載入時讀 0，顯示成 0 FT） */}
      {pois.map((poi, i) => (
        <Row key={poi.id} label={poi.name ?? poi.id} onClick={() => engine.selectPoi(i)} active={i === selected}>
          <span style={{ fontFamily: FONT_DATA, fontSize: T.fs.sm, color: i === selected ? T.accent : T.textFaint }}>
            {poi.elevM.toLocaleString()} m
          </span>
        </Row>
      ))}

      <SectionHeader>Flight</SectionHeader>
      <div style={{ display: 'flex', gap: 6, padding: '0 8px' }}>
        <label style={{ flex: 1 }}>
          <div style={{ fontFamily: FONT_CJK, fontSize: T.fs.sm, color: T.textDim, marginBottom: 3 }}>起點 From</div>
          <select style={selectStyle} value={from} onChange={(e) => setFrom(e.target.value)}>
            {pois.map((poi) => (
              <option key={poi.id} value={poi.id}>{poi.id}</option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          <div style={{ fontFamily: FONT_CJK, fontSize: T.fs.sm, color: T.textDim, marginBottom: 3 }}>終點 To</div>
          <select style={selectStyle} value={to} onChange={(e) => setTo(e.target.value)}>
            {pois.map((poi) => (
              <option key={poi.id} value={poi.id}>{poi.id}</option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ height: 6 }} />
      <Slider label="時長 Duration" min={4} max={40} step={0.5} value={p.tourDuration} onChange={live('tourDuration')} format={(v) => `${v.toFixed(1)}s`} />
      <Slider label="高度 Altitude" min={0.8} max={10} step={0.1} value={p.tourAltitude} onChange={live('tourAltitude')} format={(v) => v.toFixed(1)} />
      <Slider label="平滑 Smoothing" min={0} max={1} step={0.02} value={p.tourSmoothing} onChange={live('tourSmoothing')} format={(v) => v.toFixed(2)} />

      {touring && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: '10px 8px 0',
            padding: '6px 10px',
            borderRadius: T.radius.lg,
            background: T.accentSoft,
            border: `1px solid ${T.accent}`,
          }}
        >
          <span className="ta-live-dot" />
          <span style={{ fontFamily: FONT_DATA, fontSize: T.fs.sm, color: T.accent, fontWeight: 700, letterSpacing: '0.12em' }}>
            TOUR ACTIVE
          </span>
          <span style={{ fontFamily: FONT_DATA, fontSize: T.fs.sm, color: T.textMuted, marginLeft: 'auto' }}>
            {from} → {to}
          </span>
        </div>
      )}

      <button
        onClick={touring ? stop : start}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          margin: '10px 8px 2px',
          padding: '9px 0',
          width: 'calc(100% - 16px)',
          borderRadius: T.radius.lg,
          fontFamily: FONT_CJK,
          fontSize: T.fs.lg,
          fontWeight: 600,
          color: '#fff',
          background: touring ? T.textMuted : T.accent,
          boxSizing: 'border-box',
        }}
      >
        <Icon name={touring ? 'stop' : 'play'} size={14} strokeWidth={2.2} />
        {touring ? '停止 Stop' : '開始導覽 Start Tour'}
      </button>
    </div>
  )
}
