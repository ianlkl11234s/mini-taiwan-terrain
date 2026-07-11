# TIMELINE_DESIGN — 時間軸架構設計

> 狀態：**opus 審定通過（2026-07-11，修訂版：epoch snapshot + live-follow）**。實作前必讀。
> 上游參考：`../mini-taiwan-pulse/src/state/timeStore.ts`、`hooks/useTimeline.ts`、`docs/TIMELINE_ARCHITECTURE.md`
> 規格來源：`docs/HANDOFF.md` §下一項（用戶指定的 UI 佈局）

## 0. 目標與範圍

把左下 TELEMETRY 面板換成 pulse 風格時間軸控制列：

```
[◀] [7/11 (六)] [▶]  [Now]  [1d ▾]
[▶播放] [60x ▾]  00:32
[——●———————————————] 00:00 ~ 23:59
```

- 第一個消費者：列車圖層（`src/engine/trains.js`）
- TELEMETRY 資訊收合保留（不刪功能）
- 之後的時序圖層（雨量、水位）都吃同一個 store
- **不做**（本期）：多日範圍、資料密度條、Live/Replay 模式切換、逐層時間控制（pulse 的這些進階件全部不搬）

## 1. 核心架構決策：lazy-clock 變體

### 1.1 為什麼不能照搬 pulse

pulse 的播放驅動 = React hook 裡 RAF 每幀 `timeStore.setTime()`。terrain-art 有 **on-demand render 鐵則**：靜止時 renderCount 必須凍結。照搬 RAF 會遇到：

| 狀態 | 照搬 RAF 的後果 |
|------|----------------|
| 播放中、列車隱藏 | RAF 每幀 setTime → 每幀 notify → 白燒 CPU，且誘使 engine 連續渲染 |
| 暫停、列車可見 | 現行 `isAnimating()` 只看 `trainsVisible` → 明明畫面靜止仍連續渲染 |

### 1.2 解法：時間現算，不用迴圈推進

`src/state/timeStore.js`（**新目錄 `src/state/`**，framework-agnostic 純 JS module，零依賴）：

```js
// 內部狀態（module 變數，不進任何 React state）
let baseTime   = Date.now() / 1000        // unix 秒（seek/暫停時的錨定值）
let baseAnchor = performance.now()        // 錨定時的單調鐘（ms）
let playing    = true
let speed      = 1
let live       = true                     // §1.6：是否跟隨真實牆鐘
let epoch      = 0                        // §1.4：單調遞增變更計數，UI snapshot 用

export function getTime() {
  if (!playing) return baseTime
  return baseTime + ((performance.now() - baseAnchor) / 1000) * speed
}
```

- **時間永遠現算**：任何消費者任何時刻 `getTime()` 都拿到正確值，不依賴任何 tick 迴圈存活
- 所有離散操作（seek/play/pause/setSpeed）都先 `baseTime = getTime(); baseAnchor = performance.now()` 重新錨定，再改狀態 → 播放中改倍速不跳變
- 初始狀態 = `playing:true, speed:1, live:true` → 行為等同現行牆鐘（live-follow 機制見 §1.6 保證長期不漂移）

### 1.3 通知機制（對齊 pulse 三種粒度）

| API | 觸發時機 | 用途 |
|-----|---------|------|
| `subscribe(cb)` | 每次**離散變更**（seek/play/pause/setSpeed）同步觸發 | engine `invalidate()`；未來低頻消費者 |
| `subscribeThrottled(ms, cb)` | 離散變更（節流）＋ **播放中由內部 notifier 週期觸發** | UI 時鐘/scrubber、未來圖層著色 |
| `subscribeDate(cb)` | 導出的 dateKey（Asia/Taipei）變化，300ms debounce（leading+trailing，抄 pulse dateNotifier） | 未來跨日資料載入（雨量等）。**本期無消費者，未被行使即出貨**，真正驗證等雨量圖層 |

**內部 notifier**：`setInterval(250ms)`，**只在 `playing && (有 throttled 或 date 訂閱者)` 時存在**，每 tick 觸發 throttled 訂閱（各自尊重自己的 ms）並檢查 dateKey 變化。這是純 DOM 級別的心跳，**絕不呼叫 invalidate()、絕不碰 WebGL**。暫停或無訂閱者時 interval 清除，全系統零心跳。

**notify 順序鐵則**：每個 notify pass（離散變更或 notifier tick）進入時**先 `epoch++`，再呼叫 callbacks**——UI 的 useSyncExternalStore 以 epoch 為 snapshot，順序反了時鐘會凍結（opus 審查 #2）。

與 pulse 的差異聲明：pulse 的 raw `subscribe` 每幀觸發（RAF setTime 帶動）；本 repo 的 raw `subscribe` 只在離散變更觸發。**需要每幀新鮮值的消費者（trains）不訂閱，直接在自己的 tickView 內 `getTime()`**——這正是 pulse 金律「RAF 內直接讀 getTime()，不進 React deps」的等價形。

### 1.4 完整 API 表面

```js
// 讀
getTime(): number            // unix 秒（播放中含外插）
getEpoch(): number           // 單調遞增變更計數；UI 的 useSyncExternalStore snapshot 一律用它（見 §5 陷阱1）
getPlaying(): boolean
getSpeed(): number
getDateKey(): string         // 'YYYY-MM-DD'，Asia/Taipei，由 getTime() 導出
getDaySeconds(): number      // 0..86400，Asia/Taipei 當日秒，由 getTime() 導出（trains 直接用）
// 寫（全部先重新錨定；除 goNow 外全部 live=false）
setTime(t): void             // seek；同步 notify 全部粒度
goNow(): void                // 跳回真實牆鐘且 live=true（Now 按鈕專用，≠ setTime(Date.now()/1000)）
play() / pause() / toggle()
setSpeed(s): void
// 訂閱（全部回傳 unsubscribe）
subscribe(cb)
subscribeThrottled(ms, cb)
subscribeDate(cb)
```

**沒有** window/rangeDays/mode 狀態：selectedDate 不是獨立狀態，完全由 `getTime()` 導出。日期切換 = `setTime(getTime() ± 86400)`；Now 按鈕 = `goNow()`；播放跨午夜自然流入下一天（不 loop、不 clamp），日期 chip 跟著 `getDateKey()` 走。這是相對 pulse 的刻意簡化（pulse 需要 window 做多日 prefetch，本期不需要）。

### 1.5 import 方向（慣例宣告）

`src/state/timeStore.js` 是新的共用葉模組：`src/engine/index.js`、`src/engine/trains.js`、`src/app/` 元件都直接 import 它；它自己 import 任何東西都**禁止**。「UI 只 import engine/index.js」慣例不變——該慣例管的是 engine 內部模組，timeStore 不在 engine 內。（opus 已驗證：vite 無特殊 alias，不成環。）

### 1.6 live-follow：預設狀態的牆鐘校正（opus 審查 #4）

`performance.now()` 在筆電 suspend 期間凍結，純外插鐘睡醒後會落後睡眠時長。修法：內部 `live` 旗標——

- `live = true`：初始狀態、以及 `goNow()` 之後
- `live = false`：任何 `setTime()`（scrub、切日期）、`setSpeed(s !== 1)`、`pause()` 之後（一旦時間旅行或暫停就不再是「即時」）
- notifier 每 tick 檢查：`live && playing && speed === 1` 時，`baseTime = Date.now()/1000; baseAnchor = performance.now()` 重播種 → 預設狀態永遠貼真實牆鐘，吸收 suspend/resume 與外插漂移
- 非 live 狀態不校正（使用者 scrub 到過去後播放，絕不能被吸回現在）

## 2. Engine 整合（`src/engine/index.js` + `trains.js`）

### 2.1 isAnimating() 收緊

```js
// 現行： params.trainsVisible ||
// 改為： (params.trainsVisible && timeStore.getPlaying()) ||
```

四象限行為（鐵則驗收表）：

| trainsVisible | playing | 渲染行為 |
|:---:|:---:|------|
| ✓ | ✓ | 連續渲染（列車在動）——同現況 |
| ✓ | ✗ | **凍結**（比現況更省）；scrub/seek 經 raw subscribe → invalidate() 開 2.5s 窗畫出新位置後再凍 |
| ✗ | ✓ | **凍結**（GPU 零負擔）；UI 時鐘由 store 內部 notifier 走，與渲染無關 |
| ✗ | ✗ | 凍結 |

（opus 已驗證無其他破功路徑：`setParams` 結尾必 `invalidate()`、`loadTrainsData` finally 必 `invalidate()`（暫停中延遲資料到達也畫得出）、tour 走 `motion.tourActive` 正交、pick popup 走 idle 2Hz emitFrame 無關。）

### 2.2 engine 訂閱

`createEngine` 初始化時：`timeStore.subscribe(() => invalidate())`，`dispose()` 時退訂。離散變更（暫停狀態下 scrub、切日期、按 Now）各觸發一次 2.5s 渲染窗。播放中這個 callback 不會被高頻打（raw 只在離散變更觸發）。

### 2.3 trains.js 換時源

`currentDaySeconds()` 整個函式體換成 `return timeStore.getDaySeconds()`（Taipei 換算搬進 timeStore，`TAIPEI_OFFSET_MS` 常數以 timeStore 為唯一定義源，trains 改 import 或直接不再需要）。**同時徹底移除 `params.trainsTimeOffset`**——時間軸 scrub 完全取代它，留著就是雙時間系統（重蹈 accent 雙系統 bug 覆轍）。

跨午夜語意：`getDaySeconds()` 86399→0 的「後退跳變」會觸發 trains 既有的 backward-jump rebuild 路徑，行為正確（opus 已驗證）。

## 3. UI（`src/app/components/TimelineBar.jsx`，新檔）

- 位置：取代 Telemetry 的左下角位（`left: RAIL_LEFT + RAIL_WIDTH + 12, bottom: 20`）
- 風格：`theme.js` 的 `glass()` 卡 + `kickerStyle` + JetBrains Mono 數字，紙質 FUI，**不照抄 pulse 深色**
- 三列結構照 HANDOFF 規格：
  - **列1**：`[◀]` `[7/11 (六)]` `[▶]` `[Now]` `[1d ▾]`——日期 chip 顯示 `M/D (週)`（Taipei）；`1d` 為單選項下拉（僅佔位，本期不可換）
  - **列2**：`[▶/⏸]` `[60x ▾]` `HH:MM`——倍速選項 `[1, 10, 60, 300, 1800, 3600]`，顯示為 `1x…3600x`
  - **列3**：原生 `<input type="range" min={0} max={86399} step={1}>` + 兩端 `00:00`/`23:59` 標籤
- React 綁定（**epoch snapshot 方案**，opus 審查 #1）：

```jsx
// snapshot = epoch（單調整數，天然穩定）；時間/播放態/倍速在 render 內即時讀
useSyncExternalStore(
  cb => timeStore.subscribeThrottled(250, cb),
  () => timeStore.getEpoch(),
)
const t = timeStore.getTime()
const playing = timeStore.getPlaying()
const speed = timeStore.getSpeed()
```

任何離散變更（play/pause/setSpeed/seek）epoch++ → 立即 re-render；播放中 notifier 每 250ms epoch++ → 時鐘/scrubber 前進。**禁止**把裸 `getTime()` 或任何時間數字當 snapshot。

- playing/speed **不建 React 鏡像 state**
- scrubber `onChange` → `timeStore.setTime(taipeiMidnight(getTime()) + value)`；播放中拖曳 = seek 後繼續播（re-anchor 語意天然支援）

### 3.1 Telemetry 收合（別刪功能）

`Telemetry.jsx` 改為預設收合的小 chip（例如只剩 `FPS 60` 一枚膠囊），點擊展開成現有完整卡；堆疊在 TimelineBar 上方。既有 `engine.on('frame'/'stats')` 訂閱與所有欄位保留。

## 4. 檔案異動清單

| 檔案 | 動作 |
|------|------|
| `src/state/timeStore.js` | 新增（~170 行，含內嵌 dateNotifier + live-follow） |
| `src/engine/index.js` | `isAnimating()` 收緊；init 訂閱 invalidate、dispose 退訂；**刪 `trainsTimeOffset: 0` params 預設（line ~144）與相關註解（line ~138-141、~1587）** |
| `src/engine/trains.js` | `currentDaySeconds()` → `timeStore.getDaySeconds()`；刪 trainsTimeOffset 引用（line ~205） |
| `src/ui/debugPanel.js` | 刪 trainsTimeOffset 綁定（line ~144-146） |
| `src/app/components/TimelineBar.jsx` | 新增 |
| `src/app/components/Telemetry.jsx` | 收合化 |
| `src/app/App.jsx` | 掛 TimelineBar、調 Telemetry 位置 |

（trainsTimeOffset 全部引用點共 5 處，opus 已 grep 枚舉如上；含註解一併刪。）

## 5. 已知陷阱（實作者必讀）

1. **useSyncExternalStore snapshot 一律用 `getEpoch()`**：裸 `getTime()` 每毫秒在變 → React 判定 snapshot 不穩定 → 無限 re-render；快取時間數字則反過來——play/pause/暫停中改倍速時數字不變 → `Object.is` 相等 → **不 re-render**（播放鈕卡住不翻面）。epoch 單調整數同時解掉兩頭。
2. **notify pass 順序**：先 `epoch++` 再呼叫 callbacks（§1.3 鐵則）。
3. **notifier 生命週期**：以 idempotent `ensureNotifier()` 集中管理——play/pause/subscribe/unsubscribe 之後都重評一次「該不該有 interval」，避免重複 setInterval 或殭屍心跳。`subscribeThrottled` 退訂時要 `clearTimeout` 自己的 pending trailing timer（pulse 有做）。`main.jsx` 無 StrictMode（刻意），雙掛載風險低但 ensureNotifier 仍須 idempotent。
4. **dateKey/daySeconds 換算用 Taipei**，`TAIPEI_OFFSET_MS` 唯一定義在 timeStore。
5. **scrubber 拖曳**：原生 range input 自管拖曳 UI，value 由節流 snapshot 驅動即可；不要 onMouseMove 手刻、不要把拖曳中間值塞 React state。
6. **超高倍速（3600x）**：一幀 ≈ 54 sim-sec，列車位置離散跳躍是預期行為，不需插值平滑。
7. **live-follow 邊界**：重播種只在 `live && playing && speed===1`；任何 setTime/setSpeed(≠1)/pause 都要關 live。漏關 = scrub 後被吸回現在（使用者可見 bug）。
8. **`params.hud` idle 2Hz emitFrame 保活**：Telemetry 的 T+ 時鐘靠它；TimelineBar 不依賴 emitFrame（有自己的 notifier），兩者互不相干，別誤接。

## 6. 驗收準則（主迴圈執行）

1. `npm run build` 通過
2. 煙霧測試（verify skill / SwiftShader + `window.__exp`）：
   - TimelineBar 出現在左下，三列齊全；Telemetry 收合 chip 可展開
   - **按播放/暫停鈕，圖示立即翻面；暫停中改倍速，標籤立即更新**（opus #1 的回歸驗證）
   - 列車可見 + 60x 播放 → 列車位移速率明顯 > 1x
   - 切日期 ◀ ▶ / Now / scrub → 日期 chip 與時刻同步更新；**注意：切日期列車位置不變是預期行為**（列車只吃 daySeconds，時刻表逐日重複；dateKey 是給未來雨量/水位用的）
3. **鐵則驗收**（§2.1 四象限）：
   - 列車隱藏 + 播放中 → renderCount 凍結
   - 列車可見 + 暫停 → renderCount 凍結；scrub 一下 → 渲染窗開 → 列車跳新位置 → 再凍
4. `trainsTimeOffset` 全 repo 零引用：`grep -rn trainsTimeOffset src/`（含註解）
