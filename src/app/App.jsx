import { useEffect, useRef, useState } from 'react'
import { createEngine } from '../engine/index.js'
import { T, FONT_DATA, FONT_CJK, glass, RAIL_LEFT, RAIL_WIDTH } from './theme.js'
import IconRailSidebar from './components/IconRailSidebar.jsx'
import TitleBlock from './components/TitleBlock.jsx'
import Telemetry from './components/Telemetry.jsx'
import TimelineBar from './components/TimelineBar.jsx'
import PoiTags from './components/PoiTags.jsx'
import LayerPickCard from './components/LayerPickCard.jsx'
import WalkPanel from './components/WalkPanel.jsx'

// React shell (R2)：engine mount 容器 + 全部 overlay。引擎只透過 facade
// （createEngine / setParams / 事件）互動，src/engine/ 內部一概不碰。

// 跟隨中角落 chip（src/engine/follow.js，docs/FOLLOW_CAMERA_DESIGN.md §5）——
// 卡片可能已關，chip 是唯一常駐的解除出口。訂 engine 'follow' 事件，跟
// LayerPickCard 的按鈕狀態是各自獨立的訂閱者，共同的狀態擁有者是 engine/follow.js。
//
// 車廂視角（src/engine/ride.js，同文件 §Ride view）也掛在這顆 chip 上，理由
// 一樣：pick 卡片可能已關，chip 才是「不管卡片開關都能切換/退出 ride」的常駐
// 入口。只有跟隨中的圖層有實作 getEntityLookahead（目前只有 trains.js）才顯示。
//
// 不帶自己的 position/top/right/zIndex——跟 WalkPanel 共用 App.jsx 那個右上角
// fixed flex-column 容器（見下方 render），讓兩者自然堆疊不用手算偏移。
function FollowChip({ engine }) {
  const [follow, setFollow] = useState({ active: false, title: null, layerId: null, entityId: null })
  const [ride, setRide] = useState({ active: false })
  useEffect(() => {
    const offFollow = engine.on('follow', (s) => setFollow(s))
    const offRide = engine.on('ride', (s) => setRide(s))
    return () => {
      offFollow()
      offRide()
    }
  }, [engine])
  if (!follow.active) return null
  const rideCapable = engine.canRideView(follow.layerId)
  return (
    <div
      style={{
        ...glass(),
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px 6px 12px',
        boxShadow: T.shadow,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--hud-accent)', flexShrink: 0 }} />
      <span style={{ fontFamily: FONT_CJK, fontSize: T.fs.base, color: T.textStrong, whiteSpace: 'nowrap' }}>跟隨中：{follow.title}</span>
      {rideCapable && (
        <button
          onClick={() => engine.toggleRideView()}
          title="車廂視角 Ride view（ESC 退出）"
          style={{
            all: 'unset',
            cursor: 'pointer',
            fontFamily: FONT_CJK,
            fontSize: T.fs.sm,
            color: ride.active ? 'var(--hud-accent)' : T.textDim,
            whiteSpace: 'nowrap',
            padding: '2px 6px',
            borderRadius: T.radius.md,
            border: `1px solid ${ride.active ? 'var(--hud-accent)' : T.ctrlInactiveBorder}`,
          }}
        >
          {ride.active ? '俯視 Overview' : '車廂 Ride'}
        </button>
      )}
      <button
        onClick={() => engine.stopFollow()}
        title="解除跟隨 Stop following"
        style={{ all: 'unset', cursor: 'pointer', color: T.textDim, padding: '0 3px', fontFamily: FONT_DATA }}
      >
        ✕
      </button>
    </div>
  )
}

// 步行模式提示 chip（src/engine/walk.js，docs/WALK_MODE_DESIGN.md）——頂部置中，
// 不跟右上角的 FollowChip 或左側 IconRailSidebar 打架。只在 walk.active 時顯示，
// 純提示 + 一個常駐離開出口（跟 FollowChip 的 ✕ 同款，Settings 面板可能已收合）。
function WalkHint({ engine }) {
  const [active, setActive] = useState(false)
  useEffect(() => engine.on('walk', (s) => setActive(s.active)), [engine])
  if (!active) return null
  return (
    <div
      style={{
        ...glass(),
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 8px 6px 14px',
        boxShadow: T.shadow,
      }}
    >
      <span style={{ fontFamily: FONT_CJK, fontSize: T.fs.base, color: T.textStrong, whiteSpace: 'nowrap' }}>
        步行中 · WASD 移動 · Shift 衝刺 · ESC 離開
      </span>
      <button
        onClick={() => engine.toggleWalkMode()}
        title="結束步行 Exit walk"
        style={{ all: 'unset', cursor: 'pointer', color: T.textDim, padding: '0 3px', fontFamily: FONT_DATA }}
      >
        ✕
      </button>
    </div>
  )
}

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
          {/* 右上角堆疊：WalkPanel（常駐入口）在上，FollowChip（只在跟隨中才
              出現）在下——flex column 讓兩者自然疊起來，WalkPanel 收合/展開
              高度不同、FollowChip 開關也是條件渲染，手算 top/bottom 偏移在
              任一邊狀態變化時都會碎掉，交給 flexbox 比較穩。 */}
          <div
            style={{
              position: 'fixed',
              top: 16,
              right: 16,
              zIndex: 20,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 10,
            }}
          >
            <WalkPanel engine={engine} />
            <FollowChip engine={engine} />
          </div>
          <WalkHint engine={engine} />
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
