import { useEffect, useRef, useState } from 'react'
import { T, FONT_DATA, glass } from '../theme.js'

// POI 螢幕錨點層（取代舊 ui/hud2d 的 marker DOM）：
// - 'pois' / 'selection' → setState（低頻，重排 tag 列表）
// - 'frame' → ref 直寫 transform/opacity，絕不 setState
// 點 tag → engine.selectPoi(i) 飛過去；選中出白玻璃資訊卡（跟著 marker 走）。

export default function PoiTags({ engine }) {
  const [pois, setPois] = useState(() => engine.getPois())
  const [sel, setSel] = useState({ index: -1, poi: null })
  const tagRefs = useRef([])
  const panelRef = useRef(null)
  const selRef = useRef(-1)

  useEffect(() => {
    const offPois = engine.on('pois', (next) => setPois([...next]))
    const offSel = engine.on('selection', ({ index, poi }) => {
      selRef.current = index
      setSel({ index, poi })
    })
    const offFrame = engine.on('frame', (d) => {
      d.poiScreens.forEach((pos, i) => {
        const el = tagRefs.current[i]
        if (!el) return
        el.style.transform = `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px)`
        el.style.opacity = pos.visible ? 1 : 0
      })
      const s = selRef.current
      if (s >= 0 && d.poiScreens[s] && panelRef.current) {
        const pos = d.poiScreens[s]
        const px = Math.min(Math.max(pos.x + 14, 10), window.innerWidth - 270)
        const py = Math.min(pos.y + 16, window.innerHeight - 190)
        panelRef.current.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`
        panelRef.current.style.opacity = pos.visible ? 1 : 0
      }
    })
    return () => {
      offPois()
      offSel()
      offFrame()
    }
  }, [engine])

  const row = (label, value, accent) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18 }}>
      <span style={{ color: T.textDim }}>{label}</span>
      <b style={{ fontWeight: 600, color: accent ? 'var(--hud-accent)' : T.textStrong }}>{value}</b>
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
      {pois.map((p, i) => (
        <div key={p.id} ref={(el) => (tagRefs.current[i] = el)} className={`ta-poi${i === sel.index ? ' active' : ''}`}>
          <span className="tag" onClick={() => engine.selectPoi(i)}>
            <b>{p.id}</b>
            <i>
              {p.kind} · {p.feet.toLocaleString()} FT
            </i>
          </span>
        </div>
      ))}

      {sel.index >= 0 && sel.poi && (
        <div
          ref={panelRef}
          style={{
            ...glass(),
            position: 'absolute',
            left: 0,
            top: 0,
            minWidth: 230,
            padding: '10px 14px',
            pointerEvents: 'auto',
            fontFamily: FONT_DATA,
            fontSize: T.fs.sm,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            lineHeight: 1.8,
            willChange: 'transform',
            boxShadow: T.shadow,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, letterSpacing: '0.25em', marginBottom: 5, color: T.textStrong }}>
            <span style={{ width: 7, height: 7, background: 'var(--hud-accent)', display: 'inline-block' }} />
            <b style={{ flex: 1 }}>{sel.poi.id}</b>
            <button
              onClick={() => engine.deselect()}
              title="close & reset view"
              style={{ all: 'unset', cursor: 'pointer', color: T.textDim, padding: '0 3px' }}
            >
              ✕
            </button>
          </div>
          {row('CLASS', sel.poi.kind)}
          {row('ELEV', `${sel.poi.feet.toLocaleString()} FT`)}
          {row('GRID', sel.poi.grid)}
          {row('STATUS', 'LOCKED', true)}
        </div>
      )}
    </div>
  )
}
