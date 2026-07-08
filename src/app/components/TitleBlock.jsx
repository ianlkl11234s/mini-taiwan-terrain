import { useEffect, useRef } from 'react'
import { T, FONT_DATA, glass, RAIL_WIDTH } from '../theme.js'

// 左上標題（pulse 風）：無底純文字直接疊在地形上，白 text-shadow 疊層保證深色
// 地形上仍可讀。下方座標讀數 chip（pulse 的 "23.6081, 120.3795 z6.9 …" light 版）：
// lat/lon 訂 'gps'（0.5s throttle）、z/az/el 訂 'frame'（0.15s throttle）→
// ref 直寫 DOM，絕不 setState。

const INK_SHADOW =
  '0 1px 3px rgba(255,255,255,0.8), 0 0 2px rgba(255,255,255,0.9), 0 0 14px rgba(255,255,255,0.6)'

export default function TitleBlock({ engine }) {
  const chipRef = useRef(null)

  useEffect(() => {
    const p = engine.getParams()
    const last = { lat: p.demLat, lon: p.demLon, lod: p.demZoom, az: 0, el: 0 }
    const write = () => {
      if (chipRef.current)
        chipRef.current.textContent = `${last.lat.toFixed(4)}, ${last.lon.toFixed(4)}  z${last.lod ?? '—'}  az ${last.az.toFixed(1)}  el ${last.el.toFixed(1)}`
    }
    const offGps = engine.on('gps', ({ lat, lon }) => {
      last.lat = lat
      last.lon = lon
    })
    let acc = 0.15
    const offFrame = engine.on('frame', (d) => {
      acc += d.dt
      if (acc < 0.15) return
      acc = 0
      last.az = d.az
      last.el = d.el
      last.lod = d.lod
      write()
    })
    write()
    return () => {
      offGps()
      offFrame()
    }
  }, [engine])

  return (
    <div
      style={{
        position: 'fixed',
        left: RAIL_WIDTH + 14,
        top: 16,
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 10,
        fontFamily: FONT_DATA,
      }}
    >
      <div style={{ fontSize: 24, letterSpacing: '3px', fontWeight: 700, color: '#111827', textShadow: INK_SHADOW }}>
        Mini Taiwan Terrain
      </div>
      <div style={{ fontSize: T.fs.sm, letterSpacing: '0.12em', color: T.textMuted, marginTop: 3, textShadow: INK_SHADOW }}>
        taiwan terrain &middot; nlsc 20m dtm
      </div>
      <div
        ref={chipRef}
        style={{
          ...glass(T.cardBg),
          display: 'inline-block',
          marginTop: 8,
          padding: '4px 10px',
          fontSize: T.fs.sm,
          letterSpacing: '0.08em',
          color: T.textMuted,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'pre',
        }}
      />
    </div>
  )
}
