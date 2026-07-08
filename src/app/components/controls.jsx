import { useEffect, useRef, useState } from 'react'
import { T, FONT_DATA, FONT_CJK } from '../theme.js'

// Shared control primitives for the panels — pulse-flavored light chrome.
// Icons are hand-inlined lucide-style strokes (no icon dependency).

const ICON_PATHS = {
  mountain: ['m8 3 4 8 5-5 5 15H2L8 3z'],
  mapPin: ['M12 22s7-7 7-12a7 7 0 1 0-14 0c0 5 7 12 7 12z', 'M12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  layers: ['m12 2 10 6-10 6L2 8l10-6z', 'm2 12 10 6 10-6', 'm2 16 10 6 10-6'],
  nav: ['m3 11 19-9-9 19-2-8-8-2z'],
  sliders: ['M21 4h-7', 'M10 4H3', 'M21 12h-9', 'M8 12H3', 'M21 20h-5', 'M12 20H3', 'M14 2v4', 'M8 10v4', 'M16 18v4'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  play: ['m7 4 13 8-13 8V4z'],
  stop: ['M6 6h12v12H6z'],
}

export function Icon({ name, size = 20, color = 'currentColor', strokeWidth = 1.7 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {ICON_PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  )
}

/** Panel section header — English, uppercase, tracking (pulse language) */
export function SectionHeader({ children }) {
  return (
    <div
      style={{
        fontFamily: FONT_DATA,
        fontSize: T.fs.xs,
        fontWeight: 700,
        letterSpacing: '0.28em',
        color: T.textFaint,
        textTransform: 'uppercase',
        margin: '14px 2px 6px',
      }}
    >
      {children}
    </div>
  )
}

/** Row shell: bilingual label on the left, control on the right */
export function Row({ label, children, onClick, active }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '5px 8px',
        borderRadius: T.radius.lg,
        cursor: onClick ? 'pointer' : 'default',
        background: active ? T.rowActive : 'transparent',
      }}
    >
      <span style={{ fontFamily: FONT_CJK, fontSize: T.fs.md, color: T.textDefault, whiteSpace: 'nowrap' }}>{label}</span>
      {children}
    </div>
  )
}

/** pulse-style pill toggle (LIGHT_PALETTE: off #D1D5DB / on ink, white knob) */
export function Toggle({ on, onChange }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        all: 'unset',
        cursor: 'pointer',
        width: 32,
        height: 18,
        borderRadius: 9999,
        background: on ? T.toggleOn : T.toggleOff,
        position: 'relative',
        transition: 'background 0.15s',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 16 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          transition: 'left 0.15s',
        }}
      />
    </button>
  )
}

/**
 * Slider row. `onChange` fires live while dragging; `commit` (if given) fires
 * only on release — rebuild-class params (demExaggeration/chunkRes 類) must
 * pass commit and no live onChange to the engine.
 */
export function Slider({ label, min, max, step, value, onChange, commit, format = (v) => v }) {
  const [local, setLocal] = useState(value)
  const dragging = useRef(false)
  useEffect(() => {
    if (!dragging.current) setLocal(value)
  }, [value])
  const fire = (v) => {
    setLocal(v)
    onChange?.(v)
  }
  return (
    <div style={{ padding: '4px 8px 6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
        <span style={{ fontFamily: FONT_CJK, fontSize: T.fs.base, color: T.textMuted }}>{label}</span>
        <span style={{ fontFamily: FONT_DATA, fontSize: T.fs.base, color: T.textStrong, fontVariantNumeric: 'tabular-nums' }}>
          {format(local)}
        </span>
      </div>
      <input
        className="ta-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onPointerDown={() => (dragging.current = true)}
        onChange={(e) => fire(parseFloat(e.target.value))}
        onPointerUp={(e) => {
          dragging.current = false
          commit?.(parseFloat(e.target.value))
        }}
        onKeyUp={(e) => commit?.(parseFloat(e.target.value))}
      />
    </div>
  )
}

/** native color input styled as a small swatch; commits on picker close */
export function ColorSwatch({ value, onCommit }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const h = (e) => onCommit(e.target.value)
    el.addEventListener('change', h)
    return () => el.removeEventListener('change', h)
  }, [onCommit])
  return <input ref={ref} className="ta-color" type="color" defaultValue={value} />
}

/** segmented control（品質 32/64/128 類） */
export function Segmented({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {options.map((o) => {
        const active = o === value
        return (
          <button
            key={o}
            onClick={() => onChange(o)}
            style={{
              all: 'unset',
              cursor: 'pointer',
              fontFamily: FONT_DATA,
              fontSize: T.fs.sm,
              padding: '3px 9px',
              borderRadius: T.radius.md,
              color: active ? T.textStrong : T.textDim,
              background: active ? T.ctrlActiveBg : T.ctrlInactiveBg,
              border: `1px solid ${active ? T.borderStrong : T.ctrlInactiveBorder}`,
            }}
          >
            {o}
          </button>
        )
      })}
    </div>
  )
}
