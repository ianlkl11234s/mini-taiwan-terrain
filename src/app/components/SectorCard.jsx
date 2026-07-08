import { useEffect, useRef, useState } from 'react'
import { T, FONT_DATA, glass, kickerStyle } from '../theme.js'

// 右上唯讀資訊卡（SECTOR）：訂 'params'（位置名 / 來源，低頻 setState）+
// 'gps'（0.5s throttle，ref 直寫不 re-render）。

export default function SectorCard({ engine }) {
  const [p, setP] = useState(() => ({ ...engine.getParams() }))
  const gpsRef = useRef(null)

  useEffect(() => {
    const offParams = engine.on('params', () => setP({ ...engine.getParams() }))
    const offGps = engine.on('gps', ({ lat, lon, zoom }) => {
      if (gpsRef.current) gpsRef.current.textContent = `GPS: ${lat.toFixed(4)}, ${lon.toFixed(4)} · Z${zoom}`
    })
    return () => {
      offParams()
      offGps()
    }
  }, [engine])

  const real = p.source === 'real'
  const dim = { fontSize: T.fs.sm, color: T.textDim, letterSpacing: '0.1em' }

  return (
    <div
      style={{
        ...glass(T.cardBg),
        position: 'fixed',
        top: 14,
        right: 14,
        minWidth: 200,
        padding: '10px 14px',
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 10,
        fontFamily: FONT_DATA,
        textTransform: 'uppercase',
        lineHeight: 1.8,
      }}
    >
      <div style={kickerStyle}>
        <span style={{ width: 7, height: 7, background: 'var(--hud-accent)', display: 'inline-block' }} />
        SECTOR
      </div>
      <div style={{ fontSize: T.fs.md, fontWeight: 700, letterSpacing: '0.18em', color: T.textStrong, marginTop: 2 }}>
        {real ? p.demLocation : 'PROCEDURAL RANGE'}
      </div>
      <div ref={gpsRef} style={dim}>
        {real ? `GPS: ${p.demLat.toFixed(4)}, ${p.demLon.toFixed(4)} · Z${p.demZoom}` : 'GPS: —'}
      </div>
      <div style={dim}>{real ? 'ELEV: NLSC 20M DTM (2024)' : `SEED ${String(p.seed).padStart(4, '0')} · MESH ${p.resolution}²`}</div>
    </div>
  )
}
