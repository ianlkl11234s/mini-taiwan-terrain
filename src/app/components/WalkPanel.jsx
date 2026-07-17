import { useEffect, useState } from 'react'
import { T, FONT_DATA, FONT_CJK, glass } from '../theme.js'
import { Icon, Slider } from './controls.jsx'

// 步行模式的獨立右上角面板（使用者回饋：原本埋在 Settings 面板深處，感覺
// 「無法關閉、不像個獨立功能」）。搬出來後入口本身是常駐的——不像 Settings
// 要先展開圖層面板才找得到——收合時只是一顆小膠囊鈕，展開才看到參數，
// 跟 IconRailSidebar 的 rail→panel 收合邏輯是同一種概念，只是它自己是一個
// 獨立的小元件，不掛在 icon rail 上（步行是相機模式，不是 Layers/Settings
// 那種面板分類）。
//
// 佈局：App.jsx 把本元件跟 FollowChip 放進同一個右上角 fixed flex-column
// 容器裡（本元件在上、FollowChip 在下）——用 flex 自然堆疊，不手算兩者的
// top/bottom 偏移（本元件收合/展開高度不同、FollowChip 本身也是條件渲染，
// 手算偏移量在任一狀態變化時都會跟著碎掉）。因此本元件的根節點刻意不帶
// position/top/right/zIndex，那些交給 App.jsx 的容器。
//
// 狀態：collapsed/expanded 是本元件自己的 local UI state，不進 engine、不
// 持久化——跟 IconRailSidebar 的 activePanel 一樣，每次 reload 預設收合。
// 進入/離開步行、walkSpeed/walkEyeHeight/walkJumpHeight 三顆滑桿則原封不動
// 從 Settings.jsx 搬過來，訂閱方式相同（engine.on('walk'/'params', ...)）。
export default function WalkPanel({ engine }) {
  const [open, setOpen] = useState(false)
  const [walking, setWalking] = useState(false)
  const [p, setP] = useState(() => {
    const cur = engine.getParams()
    return { walkSpeed: cur.walkSpeed, walkEyeHeight: cur.walkEyeHeight, walkJumpHeight: cur.walkJumpHeight }
  })

  useEffect(() => engine.on('walk', (s) => setWalking(s.active)), [engine])
  useEffect(
    () =>
      engine.on('params', () => {
        const cur = engine.getParams()
        setP({ walkSpeed: cur.walkSpeed, walkEyeHeight: cur.walkEyeHeight, walkJumpHeight: cur.walkJumpHeight })
      }),
    [engine]
  )

  const live = (key) => (v) => {
    engine.setParams({ [key]: v })
    setP((prev) => ({ ...prev, [key]: v }))
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="步行模式 Walk mode"
        style={{
          all: 'unset',
          cursor: 'pointer',
          boxSizing: 'border-box',
          ...glass(),
          boxShadow: T.shadow,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '7px 14px',
          fontFamily: FONT_CJK,
          fontSize: T.fs.base,
          fontWeight: 600,
          color: walking ? T.accent : T.textStrong,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: walking ? 'var(--hud-accent)' : T.textFaint,
            flexShrink: 0,
          }}
        />
        步行 Walk
      </button>
    )
  }

  return (
    <div style={{ ...glass(), width: 216, boxShadow: T.shadow, padding: '10px 10px 6px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, padding: '0 2px' }}>
        <span
          style={{
            fontFamily: FONT_DATA,
            fontSize: T.fs.xs,
            fontWeight: 700,
            letterSpacing: '0.25em',
            color: T.textFaint,
            textTransform: 'uppercase',
          }}
        >
          Walk 步行
        </span>
        <button
          onClick={() => setOpen(false)}
          title="收合 Collapse"
          style={{ all: 'unset', cursor: 'pointer', color: T.textDim, display: 'flex', padding: 2 }}
        >
          <Icon name="x" size={13} strokeWidth={2} />
        </button>
      </div>
      <button
        onClick={() => engine.toggleWalkMode()}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'block',
          width: '100%',
          boxSizing: 'border-box',
          margin: '4px 0 6px',
          padding: '7px 0',
          borderRadius: T.radius.lg,
          textAlign: 'center',
          fontFamily: FONT_CJK,
          fontSize: T.fs.base,
          fontWeight: 600,
          color: walking ? '#fff' : T.textDim,
          background: walking ? T.accent : T.ctrlInactiveBg,
          border: `1px solid ${walking ? T.accent : T.ctrlInactiveBorder}`,
        }}
      >
        {walking ? '結束步行 Exit Walk（ESC）' : '進入步行 Enter Walk'}
      </button>
      <Slider label="移動速度 Speed" min={5} max={300} step={5} value={p.walkSpeed} onChange={live('walkSpeed')} format={(v) => `${v} m/s`} />
      <Slider label="視角高度 Eye height" min={2} max={100} step={1} value={p.walkEyeHeight} onChange={live('walkEyeHeight')} format={(v) => `${v} m`} />
      <Slider
        label="跳躍高度 Jump height"
        min={2}
        max={50}
        step={1}
        value={p.walkJumpHeight}
        onChange={live('walkJumpHeight')}
        format={(v) => `${v} m`}
      />
    </div>
  )
}
