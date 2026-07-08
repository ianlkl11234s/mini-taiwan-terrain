import { useEffect, useState } from 'react'
import { DEM_PRESETS } from '../../../engine/index.js'
import { T, FONT_DATA, FONT_CJK } from '../../theme.js'
import { SectionHeader } from '../controls.jsx'

// 位置面板：8 個台灣預設點卡片（applyPreset 飛行）+ 自訂經緯度 flyTo。

const PRESETS = Object.keys(DEM_PRESETS).filter((k) => DEM_PRESETS[k])

export default function Locations({ engine }) {
  const [current, setCurrent] = useState(engine.getParams().demLocation)
  const [lat, setLat] = useState(String(engine.getParams().demLat))
  const [lon, setLon] = useState(String(engine.getParams().demLon))

  useEffect(() => {
    // preset applied elsewhere (debug panel / engine) — keep the highlight honest
    return engine.on('params', () => setCurrent(engine.getParams().demLocation))
  }, [engine])

  const fly = () => {
    const la = parseFloat(lat)
    const lo = parseFloat(lon)
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return
    engine.setParams({ demLocation: 'Custom' })
    engine.flyTo({ lat: la, lon: lo })
  }

  const inputStyle = {
    fontFamily: FONT_DATA,
    fontSize: T.fs.md,
    color: T.textStrong,
    background: T.searchBg,
    border: `1px solid ${T.ctrlInactiveBorder}`,
    borderRadius: T.radius.lg,
    padding: '5px 8px',
    width: '100%',
    boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div>
      <SectionHeader>Presets</SectionHeader>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: '0 2px' }}>
        {PRESETS.map((name) => {
          const [zh, en] = name.split(' ')
          const active = name === current
          return (
            <button
              key={name}
              onClick={() => engine.applyPreset(name)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                padding: '8px 10px',
                borderRadius: T.radius.lg,
                background: active ? T.accentSoft : T.bgSubtle,
                border: `1px solid ${active ? T.accent : T.border}`,
                boxSizing: 'border-box',
              }}
            >
              <div style={{ fontFamily: FONT_CJK, fontSize: T.fs.lg, fontWeight: 600, color: T.textStrong }}>{zh}</div>
              <div style={{ fontFamily: FONT_DATA, fontSize: T.fs.xs, color: active ? T.accent : T.textFaint, letterSpacing: '0.08em', marginTop: 1 }}>
                {(en ?? '').toUpperCase()}
              </div>
            </button>
          )
        })}
      </div>

      <SectionHeader>Custom</SectionHeader>
      <div style={{ display: 'flex', gap: 6, padding: '0 2px' }}>
        <label style={{ flex: 1 }}>
          <div style={{ fontFamily: FONT_CJK, fontSize: T.fs.sm, color: T.textDim, marginBottom: 3 }}>緯度 Lat</div>
          <input style={inputStyle} value={lat} onChange={(e) => setLat(e.target.value)} />
        </label>
        <label style={{ flex: 1 }}>
          <div style={{ fontFamily: FONT_CJK, fontSize: T.fs.sm, color: T.textDim, marginBottom: 3 }}>經度 Lon</div>
          <input style={inputStyle} value={lon} onChange={(e) => setLon(e.target.value)} />
        </label>
      </div>
      <button
        onClick={fly}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'block',
          textAlign: 'center',
          margin: '10px 2px 2px',
          padding: '7px 0',
          width: 'calc(100% - 4px)',
          borderRadius: T.radius.lg,
          fontFamily: FONT_CJK,
          fontSize: T.fs.md,
          fontWeight: 600,
          color: '#fff',
          background: T.accent,
          boxSizing: 'border-box',
        }}
      >
        飛行 Fly
      </button>
    </div>
  )
}
