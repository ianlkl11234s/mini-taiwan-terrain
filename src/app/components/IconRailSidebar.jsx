import { useState } from 'react'
import { T, FONT_DATA, glass, RAIL_WIDTH, PANEL_WIDTH } from '../theme.js'
import { Icon } from './controls.jsx'
import Locations from './panels/Locations.jsx'
import Layers from './panels/Layers.jsx'
import Tour from './panels/Tour.jsx'
import Settings from './panels/Settings.jsx'

// pulse-form icon rail (56px) + floating panel (288px)：icon 直排、點選展開、
// 再點收合。白玻璃 chrome 全走 theme.js 的 pulse light tokens。

const PANELS = {
  locations: { title: 'Locations', component: Locations },
  layers: { title: 'Layers', component: Layers },
  tour: { title: 'Tour', component: Tour },
  settings: { title: 'Settings', component: Settings },
}

function RailIcon({ name, active, onClick, tooltip }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      title={tooltip}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        all: 'unset',
        cursor: onClick ? 'pointer' : 'default',
        width: 40,
        height: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: T.radius.lg,
        color: active ? T.accentInk : T.textFaint,
        background: active ? T.railIconActive : hover && onClick ? T.bgSubtle : 'transparent',
        transition: 'background 0.12s, color 0.12s',
        marginBottom: 2,
      }}
    >
      <Icon name={name} />
    </button>
  )
}

export default function IconRailSidebar({ engine }) {
  const [activePanel, setActivePanel] = useState(null) // 初始收合：只有 rail
  const toggle = (id) => setActivePanel((prev) => (prev === id ? null : id))
  const Panel = activePanel ? PANELS[activePanel].component : null

  return (
    <>
      {/* ── icon rail ── */}
      <div
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          width: RAIL_WIDTH,
          boxSizing: 'border-box',
          background: T.railBg,
          backdropFilter: `blur(${T.blur}px)`,
          WebkitBackdropFilter: `blur(${T.blur}px)`,
          borderRight: `1px solid ${T.border}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 8,
          paddingBottom: 8,
          zIndex: 20,
        }}
      >
        <RailIcon name="mountain" active={false} tooltip="Terrain Art" />
        <div style={{ width: 32, height: 1, background: T.border, margin: '8px 0' }} />
        <RailIcon name="mapPin" active={activePanel === 'locations'} onClick={() => toggle('locations')} tooltip="位置 Locations" />
        <RailIcon name="layers" active={activePanel === 'layers'} onClick={() => toggle('layers')} tooltip="圖層 Layers" />
        <RailIcon name="nav" active={activePanel === 'tour'} onClick={() => toggle('tour')} tooltip="導覽 Tour" />
        <div style={{ flex: 1 }} />
        <RailIcon name="sliders" active={activePanel === 'settings'} onClick={() => toggle('settings')} tooltip="設定 Settings" />
      </div>

      {/* ── floating panel ── */}
      {activePanel && (
        <div
          style={{
            ...glass(),
            position: 'fixed',
            left: RAIL_WIDTH + 8,
            top: 92,
            width: PANEL_WIDTH,
            maxHeight: '70vh',
            boxShadow: T.shadow,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            zIndex: 19,
            animation: 'ta-panel-in 0.22s ease-out',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px 8px',
              borderBottom: `1px solid ${T.border}`,
              flexShrink: 0,
            }}
          >
            <span style={{ fontFamily: FONT_DATA, fontSize: T.fs.base, fontWeight: 700, letterSpacing: '0.25em', color: T.textStrong, textTransform: 'uppercase' }}>
              {PANELS[activePanel].title}
            </span>
            <button
              onClick={() => setActivePanel(null)}
              style={{ all: 'unset', cursor: 'pointer', color: T.textDim, display: 'flex', padding: 2 }}
              title="收合 Close"
            >
              <Icon name="x" size={14} strokeWidth={2} />
            </button>
          </div>
          <div style={{ overflowY: 'auto', padding: '2px 8px 12px' }} className="ta-panel-scroll">
            <Panel engine={engine} />
          </div>
        </div>
      )}
    </>
  )
}
