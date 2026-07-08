import { T, FONT_DATA, glass, RAIL_WIDTH } from '../theme.js'

// 左上標題卡（白玻璃）— 舊 .overlay 紙色卡的升級版。

export default function TitleBlock() {
  return (
    <div
      style={{
        ...glass(T.cardBg),
        position: 'fixed',
        left: RAIL_WIDTH + 12,
        top: 14,
        padding: '9px 14px',
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 10,
        fontFamily: FONT_DATA,
      }}
    >
      <div style={{ fontSize: 14, letterSpacing: '3px', fontWeight: 700, color: T.textStrong }}>TERRAIN ART</div>
      <div style={{ fontSize: T.fs.sm, letterSpacing: '0.12em', color: T.textDim, marginTop: 2 }}>
        taiwan terrain &middot; nlsc 20m dtm
      </div>
    </div>
  )
}
