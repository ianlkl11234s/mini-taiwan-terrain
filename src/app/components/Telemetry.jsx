import { useEffect, useRef, useState } from 'react'
import { T, FONT_DATA, glass, kickerStyle } from '../theme.js'

// 遙測卡：訂 'frame'（每幀）→ ref 直寫 DOM，絕不 setState；'stats'（1Hz）補
// CHUNKS。文字刷新沿用舊 hud2d 的 0.15s throttle。時間軸上線後預設收合成一
// 枚 FPS 膠囊（騰出左下角空間給 TimelineBar），點擊展開回完整卡；collapsed/
// expanded 共用同一組 engine 訂閱不受影響，只是分別寫進不同的 DOM ref
// （collapsed 時完整卡的 row ref 是 null，w() 的 if(el) guard 會靜默跳過）。
// 定位交給呼叫端（App.jsx 把它跟 TimelineBar 疊在同一個 fixed 容器裡）。

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
  const chipFpsRef = useRef(null) // collapsed 膠囊的 FPS 讀數，跟完整卡的 fps row 同步寫入，不受 expanded 狀態影響
  const [expanded, setExpanded] = useState(false)

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
      const fps = String(Math.round(d.fps))
      w('fps', fps)
      if (chipFpsRef.current) chipFpsRef.current.textContent = fps
      w('clock', d.clock)
    })
    const offStats = engine.on('stats', (s) => w('chunks', String(s.chunks)))
    return () => {
      offFrame()
      offStats()
    }
  }, [engine])

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        title="展開遙測 Expand telemetry"
        style={{
          all: 'unset',
          cursor: 'pointer',
          ...glass(T.cardBg),
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 12px',
          fontFamily: FONT_DATA,
          fontSize: T.fs.sm,
          letterSpacing: '0.1em',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--hud-accent)', display: 'inline-block', flexShrink: 0 }} />
        <b ref={chipFpsRef} style={{ fontWeight: 700, color: T.textStrong, fontVariantNumeric: 'tabular-nums' }}>
          —
        </b>
        <span style={{ color: T.textDim }}>FPS</span>
      </button>
    )
  }

  return (
    <div
      style={{
        ...glass(T.cardBg),
        minWidth: 165,
        padding: '10px 14px',
        userSelect: 'none',
        fontFamily: FONT_DATA,
        fontSize: T.fs.sm,
        letterSpacing: '0.14em',
        lineHeight: 1.85,
      }}
    >
      <div onClick={() => setExpanded(false)} style={{ ...kickerStyle, cursor: 'pointer', justifyContent: 'space-between' }} title="收合 Collapse">
        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ width: 7, height: 7, background: 'var(--hud-accent)', display: 'inline-block' }} />
          TELEMETRY
        </span>
        <span style={{ color: T.textFaint }}>✕</span>
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
