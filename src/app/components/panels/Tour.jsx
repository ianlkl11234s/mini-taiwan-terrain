import { useCallback, useEffect, useRef, useState } from 'react'
import { T, FONT_DATA, FONT_CJK } from '../../theme.js'
import { SectionHeader, Row, Slider, Icon } from '../controls.jsx'

// 導覽面板：POI 清單（點了 selectPoi 飛過去）、飛行模式、參數、start/stop。
// 三種模式：點對點（from→to）、繞峰（環繞單一山峰）、等高線（沿等高帶繞行）。
// 面板會即時預覽規劃路徑（半透明 accent 線）；start 前非同步規劃（預串流圖磚 +
// 撞山驗證），規劃期間顯示 loading。touring 狀態聽引擎 'tour' 事件。

const MODES = [
  { id: 'p2p', label: '點對點 Point-to-Point', desc: '從起點飛越地形抵達終點' },
  { id: 'orbit', label: '繞峰 Orbit', desc: '環繞峰頂一圈，鏡頭鎖定山峰' },
  { id: 'contour', label: '等高線 Contour', desc: '沿等高線繞行，維持同一高度帶' },
]

export default function Tour({ engine }) {
  const [pois, setPois] = useState(() => engine.getPois())
  const [selected, setSelected] = useState(-1)
  const [mode, setMode] = useState(engine.getParams().tourMode ?? 'p2p')
  const [from, setFrom] = useState(engine.getParams().tourFrom)
  const [to, setTo] = useState(engine.getParams().tourTo)
  const [offset, setOffset] = useState(engine.getParams().contourOffset ?? 300)
  const [p, setP] = useState(() => ({ ...engine.getParams() }))
  const [touring, setTouring] = useState(false)
  const [planning, setPlanning] = useState(false)
  const timer = useRef(null)
  const previewTimer = useRef(null)

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
    const offTour = engine.on('tour', ({ active, planning }) => {
      if (planning) {
        setPlanning(true)
        return
      }
      setPlanning(false)
      setTouring(active)
      clearTimeout(timer.current)
      // fallback only — a missed finish event still clears the badge
      if (active) timer.current = setTimeout(() => setTouring(false), (engine.getParams().tourDuration + 0.6) * 1000)
    })
    return () => {
      offPois()
      offSel()
      offParams()
      offTour()
      clearTimeout(timer.current)
      clearTimeout(previewTimer.current)
      engine.clearTourPreview() // panel closed → drop the preview line
    }
  }, [engine])

  // debounced preview: coalesces slider drags; skipped while a tour runs
  useEffect(() => {
    if (touring || planning) return
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => {
      engine.previewTour({ mode, from, to, contourOffset: offset })
    }, 200)
    return () => clearTimeout(previewTimer.current)
  }, [engine, mode, from, to, offset, touring, planning])

  const live = useCallback(
    (key) => (v) => {
      engine.setParams({ [key]: v })
      setP((prev) => ({ ...prev, [key]: v }))
    },
    [engine]
  )

  const start = () => {
    setPlanning(true)
    engine.startTour({ mode, from, to, contourOffset: offset })
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

  const modeDesc = MODES.find((m) => m.id === mode)?.desc
  const busy = touring || planning

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
      <div style={{ padding: '0 8px' }}>
        <div style={{ fontFamily: FONT_CJK, fontSize: T.fs.sm, color: T.textDim, marginBottom: 3 }}>模式 Mode</div>
        <select style={selectStyle} value={mode} onChange={(e) => setMode(e.target.value)}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <div style={{ fontFamily: FONT_CJK, fontSize: T.fs.sm, color: T.textFaint, margin: '4px 0 2px' }}>{modeDesc}</div>
      </div>

      <div style={{ height: 4 }} />
      {mode === 'p2p' ? (
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
      ) : (
        <div style={{ padding: '0 8px' }}>
          <div style={{ fontFamily: FONT_CJK, fontSize: T.fs.sm, color: T.textDim, marginBottom: 3 }}>山峰 Peak</div>
          <select style={selectStyle} value={from} onChange={(e) => setFrom(e.target.value)}>
            {pois.map((poi) => (
              <option key={poi.id} value={poi.id}>{poi.id}</option>
            ))}
          </select>
        </div>
      )}

      <div style={{ height: 6 }} />
      {mode === 'contour' && (
        <Slider label="下降 Offset" min={100} max={800} step={20} value={offset} onChange={setOffset} format={(v) => `${Math.round(v)} m`} />
      )}
      <Slider label="時長 Duration" min={4} max={40} step={0.5} value={p.tourDuration} onChange={live('tourDuration')} format={(v) => `${v.toFixed(1)}s`} />
      <Slider label="高度 Altitude" min={0.8} max={10} step={0.1} value={p.tourAltitude} onChange={live('tourAltitude')} format={(v) => v.toFixed(1)} />
      {mode === 'p2p' && (
        <Slider label="平滑 Smoothing" min={0} max={1} step={0.02} value={p.tourSmoothing} onChange={live('tourSmoothing')} format={(v) => v.toFixed(2)} />
      )}

      {busy && (
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
            {planning ? 'PLANNING' : 'TOUR ACTIVE'}
          </span>
          <span style={{ fontFamily: FONT_DATA, fontSize: T.fs.sm, color: T.textMuted, marginLeft: 'auto' }}>
            {mode === 'p2p' ? `${from} → ${to}` : from}
          </span>
        </div>
      )}

      <button
        onClick={touring ? stop : start}
        disabled={planning}
        style={{
          all: 'unset',
          cursor: planning ? 'default' : 'pointer',
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
          background: busy ? T.textMuted : T.accent,
          opacity: planning ? 0.8 : 1,
          boxSizing: 'border-box',
        }}
      >
        <Icon name={touring ? 'stop' : 'play'} size={14} strokeWidth={2.2} />
        {planning ? '規劃中 Planning…' : touring ? '停止 Stop' : '開始導覽 Start Tour'}
      </button>
    </div>
  )
}
