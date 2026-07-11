import { useEffect, useRef, useState } from 'react'
import { createEngine } from '../engine/index.js'
import { T, FONT_DATA, glass, RAIL_LEFT, RAIL_WIDTH } from './theme.js'
import IconRailSidebar from './components/IconRailSidebar.jsx'
import TitleBlock from './components/TitleBlock.jsx'
import Telemetry from './components/Telemetry.jsx'
import TimelineBar from './components/TimelineBar.jsx'
import PoiTags from './components/PoiTags.jsx'
import LayerPickCard from './components/LayerPickCard.jsx'

// React shell (R2)：engine mount 容器 + 全部 overlay。引擎只透過 facade
// （createEngine / setParams / 事件）互動，src/engine/ 內部一概不碰。

export default function App() {
  const containerRef = useRef(null)
  const hudRootRef = useRef(null) // debug panel 的 HUD show/opacity 開關作用對象
  const [engine, setEngine] = useState(null)
  const [loading, setLoading] = useState({ active: true, message: 'generating terrain…' })

  useEffect(() => {
    let disposed = false
    let eng = null
    createEngine({ container: containerRef.current }).then((e) => {
      if (disposed) {
        e.dispose()
        return
      }
      eng = e
      // console access for debugging/scripting — same contract as the old shell
      if (import.meta.env.DEV) window.__exp = e.debug
      document.documentElement.style.setProperty('--hud-accent', e.getParams().hudAccent)
      e.on('loading', (l) => setLoading((prev) => ({ active: l.active, message: l.message ?? prev.message })))
      setEngine(e)

      // developer mode: lil-gui with every parameter, dev-only + behind ?debug=1
      if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('debug')) {
        import('../ui/debugPanel.js').then(({ createDebugPanel }) => {
          if (disposed) return
          createDebugPanel(e, {
            // hud2 shim — debug panel's HUD folder talks to the React overlays
            setVisible: (v) => hudRootRef.current && (hudRootRef.current.style.display = v ? '' : 'none'),
            setOpacity: (o) => hudRootRef.current && (hudRootRef.current.style.opacity = o),
            setTheme: ({ accent } = {}) => {
              if (accent !== undefined) document.documentElement.style.setProperty('--hud-accent', accent)
            },
          })
        })
      }
    })
    return () => {
      disposed = true
      eng?.dispose()
    }
  }, [])

  return (
    <>
      <div id="app" ref={containerRef} />
      {engine && (
        <>
          <div ref={hudRootRef}>
            {/* Telemetry(收合 chip) 疊在 TimelineBar 上方，左下同一個 fixed
                容器裡用 flex column 堆疊 —— 高度全交給內容自己撐開，不用猜
                TimelineBar 實際高度去手算第二個 bottom 偏移量 */}
            <div
              style={{
                position: 'fixed',
                left: RAIL_LEFT + RAIL_WIDTH + 12,
                bottom: 20,
                zIndex: 10,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 10,
              }}
            >
              <Telemetry engine={engine} />
              <TimelineBar />
            </div>
            <PoiTags engine={engine} />
          </div>
          <TitleBlock engine={engine} />
          <IconRailSidebar engine={engine} />
          <LayerPickCard engine={engine} />
        </>
      )}
      <div
        style={{
          ...glass(),
          position: 'fixed',
          left: '50%',
          bottom: 28,
          transform: 'translateX(-50%)',
          padding: '6px 14px',
          fontFamily: FONT_DATA,
          fontSize: T.fs.base,
          letterSpacing: '0.15em',
          color: T.textMuted,
          opacity: loading.active ? 1 : 0,
          transition: 'opacity 0.2s',
          pointerEvents: 'none',
          zIndex: 30,
        }}
      >
        {loading.message}
      </div>
    </>
  )
}
