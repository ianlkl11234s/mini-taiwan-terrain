import { useEffect, useRef, useState } from 'react'
import { createEngine } from '../engine/index.js'
import { T, FONT_DATA, glass } from './theme.js'
import IconRailSidebar from './components/IconRailSidebar.jsx'
import TitleBlock from './components/TitleBlock.jsx'
import Telemetry from './components/Telemetry.jsx'
import PoiTags from './components/PoiTags.jsx'

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
      window.__exp = e.debug
      document.documentElement.style.setProperty('--hud-accent', e.getParams().hudAccent)
      e.on('loading', (l) => setLoading((prev) => ({ active: l.active, message: l.message ?? prev.message })))
      setEngine(e)

      // developer mode: lil-gui with every parameter, only behind ?debug=1
      if (new URLSearchParams(window.location.search).has('debug')) {
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
            <Telemetry engine={engine} />
            <PoiTags engine={engine} />
          </div>
          <TitleBlock engine={engine} />
          <IconRailSidebar engine={engine} />
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
