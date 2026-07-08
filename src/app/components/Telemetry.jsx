import { useEffect, useRef } from 'react'
import { T, FONT_DATA, glass, kickerStyle, RAIL_WIDTH } from '../theme.js'

// 左下遙測卡：訂 'frame'（每幀）→ ref 直寫 DOM，絕不 setState；
// 'stats'（1Hz）補 CHUNKS。文字刷新沿用舊 hud2d 的 0.15s throttle。

const ROWS = [
  ['az', 'CAM AZ'],
  ['el', 'CAM EL'],
  ['focus', 'FOCUS'],
  ['lod', 'LOD'],
  ['fps', 'FPS'],
  ['chunks', 'CHUNKS'],
  ['clock', 'T+'],
]

export default function Telemetry({ engine }) {
  const refs = useRef({})

  useEffect(() => {
    let acc = 0
    const w = (key, text) => {
      const el = refs.current[key]
      if (el) el.textContent = text
    }
    const offFrame = engine.on('frame', (d) => {
      acc += d.dt
      if (acc < 0.15) return
      acc = 0
      w('az', `${d.az.toFixed(1)}°`)
      w('el', `${d.el.toFixed(1)}°`)
      w('focus', d.focus.toFixed(2))
      w('lod', d.lod ? `Z${d.lod}` : '—')
      w('fps', String(Math.round(d.fps)))
      w('clock', d.clock)
    })
    const offStats = engine.on('stats', (s) => w('chunks', String(s.chunks)))
    return () => {
      offFrame()
      offStats()
    }
  }, [engine])

  return (
    <div
      style={{
        ...glass(T.cardBg),
        position: 'fixed',
        left: RAIL_WIDTH + 12,
        bottom: 20,
        minWidth: 165,
        padding: '10px 14px',
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 10,
        fontFamily: FONT_DATA,
        fontSize: T.fs.sm,
        letterSpacing: '0.14em',
        lineHeight: 1.85,
      }}
    >
      <div style={kickerStyle}>
        <span style={{ width: 7, height: 7, background: 'var(--hud-accent)', display: 'inline-block' }} />
        TELEMETRY
      </div>
      {ROWS.map(([key, label]) => (
        <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 18 }}>
          <span style={{ color: T.textDim }}>{label}</span>
          <b ref={(el) => (refs.current[key] = el)} style={{ fontWeight: 600, color: T.textStrong, fontVariantNumeric: 'tabular-nums' }}>
            —
          </b>
        </div>
      ))}
    </div>
  )
}
