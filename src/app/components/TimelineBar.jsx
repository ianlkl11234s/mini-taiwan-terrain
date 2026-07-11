import { useSyncExternalStore } from 'react'
import * as timeStore from '../../state/timeStore.js'
import { T, FONT_DATA, glass, kickerStyle } from '../theme.js'

// pulse 風格時間軸控制列（docs/TIMELINE_DESIGN.md §3）— 第一個消費者是列車圖層
// (src/engine/trains.js)，之後的時序圖層（雨量、水位）都會吃同一顆
// src/state/timeStore.js。三列：日期切換 / 播放+倍速+時刻 / 當日 scrubber。
//
// React 綁定走「epoch snapshot」（設計 §3、§5 陷阱1）：useSyncExternalStore
// 的 snapshot 一律用 getEpoch()（單調整數）——裸 getTime() 每毫秒都在變會讓
// React 判定不穩定觸發無限重繪；快取住的時間數字則反過來，暫停中改倍速時
// 數字不變 → Object.is 判定相等 → 不重繪（播放鈕卡住不翻面）。epoch 兩頭都
// 解掉。playing/speed 不建 React 鏡像 state，render 內直接讀 timeStore。

const SPEED_OPTIONS = [1, 10, 60, 300, 1800, 3600]
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const DAY_SEC = 86400

// dateKey ('YYYY-MM-DD') -> 'M/D (週)'。用純日曆數學（Date.UTC + getUTCDay）
// 算星期幾，不依賴 Intl/時區格式化 —— 日期字串本身已經是 Taipei 曆日，星期
// 幾是曆日的屬性，跟時區無關。
function formatDateChip(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number)
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${m}/${d} (${wd})`
}

function formatHHMM(daySec) {
  const totalMin = Math.floor(daySec / 60)
  const hh = String(Math.floor(totalMin / 60) % 24).padStart(2, '0')
  const mm = String(totalMin % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

const btnStyle = {
  all: 'unset',
  cursor: 'pointer',
  fontFamily: FONT_DATA,
  fontSize: T.fs.base,
  padding: '3px 9px',
  borderRadius: T.radius.md,
  color: T.textStrong,
  background: T.ctrlInactiveBg,
  border: `1px solid ${T.ctrlInactiveBorder}`,
  textAlign: 'center',
  flexShrink: 0,
}

const selectStyle = {
  fontFamily: FONT_DATA,
  fontSize: T.fs.base,
  padding: '3px 6px',
  borderRadius: T.radius.md,
  color: T.textStrong,
  background: T.ctrlInactiveBg,
  border: `1px solid ${T.ctrlInactiveBorder}`,
  flexShrink: 0,
}

export default function TimelineBar() {
  useSyncExternalStore(
    (cb) => timeStore.subscribeThrottled(250, cb),
    () => timeStore.getEpoch(),
  )
  const playing = timeStore.getPlaying()
  const speed = timeStore.getSpeed()
  const dateKey = timeStore.getDateKey()
  const daySec = timeStore.getDaySeconds()

  // 讀 click-time 的新鮮值，不用 render closure 捕捉到的舊 t —— getTime() 隨
  // 時可呼叫都正確（design §1.2），沒有理由信任一個可能已經過期 250ms 的值。
  const shiftDate = (deltaDays) => timeStore.setTime(timeStore.getTime() + deltaDays * DAY_SEC)
  const onScrub = (e) => timeStore.setTime(timeStore.getTime() - timeStore.getDaySeconds() + Number(e.target.value))

  return (
    <div
      style={{
        ...glass(),
        width: 300,
        padding: '10px 14px 12px',
        fontFamily: FONT_DATA,
      }}
    >
      <div style={{ ...kickerStyle, marginBottom: 8 }}>
        <span style={{ width: 7, height: 7, background: 'var(--hud-accent)', display: 'inline-block' }} />
        TIMELINE
      </div>

      {/* row 1: date nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <button style={btnStyle} onClick={() => shiftDate(-1)} title="前一天 Previous day">
          ◀
        </button>
        <span style={{ flex: 1, textAlign: 'center', fontSize: T.fs.md, fontWeight: 600, color: T.textStrong, fontVariantNumeric: 'tabular-nums' }}>
          {formatDateChip(dateKey)}
        </span>
        <button style={btnStyle} onClick={() => shiftDate(1)} title="後一天 Next day">
          ▶
        </button>
        <button style={btnStyle} onClick={() => timeStore.goNow()} title="回到現在 Jump to now">
          Now
        </button>
        {/* 佔位下拉：本期僅 1 天範圍，之後多日視窗才會開放切換（設計 §0） */}
        <select style={selectStyle} value={1} disabled title="顯示天數（本期固定 1 天）">
          <option value={1}>1d</option>
        </select>
      </div>

      {/* row 2: playback */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <button style={{ ...btnStyle, width: 30, fontSize: T.fs.md }} onClick={() => timeStore.toggle()} title={playing ? '暫停 Pause' : '播放 Play'}>
          {playing ? '⏸' : '▶'}
        </button>
        <select style={selectStyle} value={speed} onChange={(e) => timeStore.setSpeed(Number(e.target.value))} title="播放倍速 Speed">
          {SPEED_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: T.fs.lg, fontWeight: 700, color: T.textStrong, fontVariantNumeric: 'tabular-nums' }}>
          {formatHHMM(daySec)}
        </span>
      </div>

      {/* row 3: scrubber — 原生 range 自管拖曳 UI，value 由節流 snapshot 驅動即可
          （設計 §5 陷阱5：不要手刻 onMouseMove、不要把拖曳中間值塞 React state） */}
      <input className="ta-slider" type="range" min={0} max={86399} step={1} value={Math.floor(daySec)} onChange={onScrub} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fs.sm, color: T.textFaint, marginTop: 2 }}>
        <span>00:00</span>
        <span>23:59</span>
      </div>
    </div>
  )
}
