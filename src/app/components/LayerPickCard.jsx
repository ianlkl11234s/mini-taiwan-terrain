import { useEffect, useRef, useState } from 'react'
import { T, FONT_DATA, FONT_CJK, glass } from '../theme.js'

// 圖層點選卡片（click-to-inspect，見 src/engine/index.js 的 pointerup handler +
// layers.pickAll）。跟 PoiTags 同一套雙軌訂閱模式：
// - 'pick' 事件（title/rows/layerId，內容變動才 setState，觸發卡片開/關）
// - 'frame' 事件（screen 座標，ref 直寫 transform/opacity，絕不 setState —
//   否則每幀重繪會打破 on-demand render）
// 卡片本身純 overlay，不進 3D 場景；worldPos 的螢幕投影完全由引擎算好給。

const CARD_W = 240

export default function LayerPickCard({ engine }) {
  const [pick, setPick] = useState(null)
  const pickRef = useRef(null) // mirrors `pick` for the frame-event closure
  const cardRef = useRef(null)

  useEffect(() => {
    const offPick = engine.on('pick', (p) => {
      pickRef.current = p
      setPick(p)
    })
    const offFrame = engine.on('frame', (d) => {
      const el = cardRef.current
      if (!el || !pickRef.current) return
      const pos = d.pick
      if (!pos) return
      const w = window.innerWidth
      const h = window.innerHeight
      const px = Math.min(Math.max(pos.x + 16, 10), w - CARD_W - 10)
      const py = Math.min(Math.max(pos.y + 16, 10), h - 40)
      el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`
      el.style.opacity = pos.visible ? 1 : 0
    })
    return () => {
      offPick()
      offFrame()
    }
  }, [engine])

  if (!pick) return null

  return (
    <div
      ref={cardRef}
      style={{
        ...glass(),
        position: 'fixed',
        left: 0,
        top: 0,
        width: CARD_W,
        padding: '10px 14px',
        pointerEvents: 'auto',
        zIndex: 20,
        boxShadow: T.shadow,
        willChange: 'transform',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ width: 7, height: 7, background: 'var(--hud-accent)', display: 'inline-block', flexShrink: 0 }} />
        <b
          style={{
            flex: 1,
            fontFamily: FONT_CJK,
            fontSize: T.fs.lg,
            fontWeight: 700,
            color: T.textStrong,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {pick.title}
        </b>
        <button
          onClick={() => engine.clearPick()}
          title="close"
          style={{ all: 'unset', cursor: 'pointer', color: T.textDim, padding: '0 3px', fontFamily: FONT_DATA }}
        >
          ✕
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {pick.rows.map(([label, value], i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, fontFamily: FONT_CJK, fontSize: T.fs.base }}>
            <span style={{ color: T.textDim, whiteSpace: 'nowrap' }}>{label}</span>
            <b style={{ fontWeight: 600, color: T.textStrong, textAlign: 'right' }}>{value}</b>
          </div>
        ))}
      </div>
    </div>
  )
}
