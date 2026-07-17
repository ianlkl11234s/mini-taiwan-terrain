# FOLLOW_CAMERA_DESIGN — 跟隨鏡頭

> 狀態：**opus 審定通過（2026-07-11，修訂版：state-based pan 偵測 + onArrive engage）**。backlog #2 第三項，無範本，從零設計。
> 前置已上線：列車 pick 資訊卡（trains.js lastHits）、timeStore、ships.js。
> opus 已逐幀推演確認：delta-carry 與 OrbitControls damping 不打架（rotate/zoom 只動 spherical 不動 target，offset 守恆不漂移）；hud3 pulse/scan 不動相機，互斥矩陣無漏。

## 0. 需求與邊界

- 點選列車（未來：船）後可「跟隨」——鏡頭黏著移動實體走，使用者仍可環繞/縮放觀察
- **不與 tour.js 打架**：tour、flyTo tween、keypan、OrbitControls 四個相機動力源已存在，follow 是第五個，必須定義互斥規則
- 效能鐵則不破：跟隨中且時間暫停 → 畫面靜止 → renderCount 凍結

## 1. 核心模型：移動錨點的 OrbitControls（delta-carry）

**不做** 固定尾隨視角（chase cam）、**不做** 相機路徑規劃。follow = 每幀把「實體位移向量」同時加到 `controls.target` 與 `camera.position`：

```
pos   = 圖層回報的實體世界座標（本幀）
delta = pos − lastPos
controls.target   += delta
camera.position   += delta
lastPos = pos
```

- 相對觀察姿態（方位/仰角/距離）完全保留 → 使用者跟隨中可自由 orbit/zoom，OrbitControls 原生行為零改動
- 無 smoothing 追趕邏輯：實體本身每幀連續移動（trains 是純位置函式），delta-carry 天然平滑；**進入**跟隨時的鏡頭移動交給既有 flyTo tween（先 tween 到實體上空，tween 完成才 engage delta-carry）

## 2. 可跟隨介面（generalize，不綁死列車）

Layer 統一介面加**選配**方法：

```js
getEntityPosition(entityId) → { x, y, z } | null   // null = 實體已不存在（收班/跨日 rebuild/資料換日/圖層隱藏）
```

- trains.js：entityId = `train_no`（rebuild 後仍可解析——**禁止用 instance index**，backward-jump rebuild 會洗掉）。**實作（opus minor 1）**：`layout()` 迴圈順手建 `hitByTrainNo` Map（不增迴圈）→ O(1) 查；`getEntityPosition` 先判 `group.visible`，圖層隱藏回 **null**（否則 lastHits 是 stale 舊值，follow 會抱著幽靈車）
- ships.js：entityId = `mmsi`（phase 2，介面免費相容）
- 回 null → follow 自動解除（鏡頭留在原地，不彈跳、不飛回）
- 已知極邊界（接受）：被跟的車若滑出 maxInstances cap 會 null 解除

## 3. 狀態機與互斥（重點審查區）

engine `motion` 加 `followActive`；`follow.js` 新模組持有 `{ layerId, entityId, lastPos }`。

| 事件 | 對 follow 的效果 |
|------|-----------------|
| `followEntity(layerId, entityId)` | 先 `stopTour()`＋取消進行中 tween → `motion.flyTo(..., onArrive)` → **onArrive 才 engage**（見下） |
| `startTour()` / `flyToLonLat`（涵蓋 flyTo/applyPreset/自訂座標） / `selectPoi` / **`deselect`** | **先解除 follow**。deselect 會 flyTo 回程，必須解除（否則回程 tween 與 delta-carry 搶相機）——「不自動解除」只適用於**關 pick 卡 UI**，不是 `deselect()` |
| OrbitControls rotate/zoom | 允許，不解除（跟隨中觀察是核心價值；rotate/zoom 只動 spherical 不動 target，天然無衝突） |
| OrbitControls **pan**（拖曳） | 解除。偵測=雙條件：`controls.state === 2`（PAN；`_STATE.PAN` 未 export，硬編 2 加註解防 three 升版）**且** `controls.target` XZ 實際位移 > eps。單靠 state 會誤殺純 click（pointerdown 即設 PAN）；單靠位移會誤殺 clampPan/反穿地板的每幀微調（它們動 target.y 與邊界 x/z，故 eps 只比 XZ） |
| keypan | 解除——keyPan 直寫 target 不走 controls.state，掛既有 `keyPan.onEngage` callback（index.js:840） |
| 實體消失（getEntityPosition→null，含圖層被隱藏） | 解除，鏡頭原地 |
| 關 pick 卡 UI | 不解除（看車不必開卡）；chip 是常駐出口 |
| dispose | 清理 |

- **engage 時機（opus major 2）**：`motion.flyTo` 目前無到站 callback，且「自然完成」與「被 cancel」（controls 'start' 事件會 cancel 任何 tween——含使用者飛行途中隨手 rotate）從外部不可區分——edge-detect `tweenActive` 會在半空錯誤 engage。**必須**給 `motion.flyTo` 加 `onArrive` 參數（只在 `tween.t>=1` 分支觸發；`cancel()` 清 pending callback）。飛行中被 cancel → 中止 pending follow（chip 消失）、不 engage。
- **follow.tick guard**：`followActive && !motion.tweenActive && !motion.tourActive` 才做 delta-carry（防 pre-engage 飛行期兩個動力源同時寫相機）。
- **不要**把 stopFollow 掛在 `controls 'start'` 事件——會連 rotate 一起殺。
- tour.js 完全不感知 follow：互斥由 engine 事件入口統一把關，兩模組零耦合。tour 進行中點列車按跟隨：click 的 pointerdown 先經 'start'→cancel 砍掉 tour tween，pick 開卡→followEntity（再 stopTour 冪等），路徑通（opus 驗證）。

## 4. 渲染與 tick 順序

- tick 順序：`layers.tickAll()`（實體位置更新，index.js:2233）→ `follow.tick()`（delta-carry，**插在 2233 之後、`camera.updateMatrixWorld()` 2248 之前**）→ render。這樣 `chunkManager.update(controls.target)`（2243）拿到 follow 更新後的 target，DEM 串流跟著車跑。**不需要**在 follow.tick 後重呼 `controls.update()`（offset 守恆，opus 已推演）。
- **isAnimating 不加 follow 項**：跟隨中實體會動 ⇔ 該圖層 visible && playing，既有條件已保證連續渲染；時間暫停 → 實體不動 → delta=0 → 畫面靜止凍結（鐵則自然成立）。唯一補充：engage 瞬間與解除瞬間各 `invalidate()` 一次。
- follow 中 chunk 串流照常（相機移動本來就會觸發 DEM 載入）。

## 5. UI

- LayerPickCard：pick payload 帶 `followable: { layerId, entityId }` 時顯示「跟隨 Follow」鈕；跟隨中變「解除 Following ✓」
- 跟隨中畫面角落小 chip（`跟隨中：1234 自強 ✕`）——解除的常駐出口（卡片可能已關）
- 面板/樣式零改動

## 6. 檔案異動

| 檔案 | 動作 |
|------|------|
| `src/engine/follow.js` | 新增（~100 行） |
| `src/engine/trains.js` | layout() 建 hitByTrainNo Map、`getEntityPosition(trainNo)`（含 group.visible 判 null）；pick payload 加 followable |
| `src/engine/tour.js` | `motion.flyTo` 加 `onArrive` callback（t≥1 才觸發；cancel 清 pending） |
| `src/engine/index.js` | 註冊 follow tick、`followEntity/stopFollow` API、互斥把關（startTour/flyTo/applyPreset/selectPoi 入口） |
| `src/app/components/LayerPickCard.jsx` | 跟隨鈕 |
| `src/app/App.jsx` | 跟隨中 chip |

## 7. 驗收準則

1. 點列車 → 跟隨：tween 飛到車上方 → 黏著走；60x 下依然平滑貼合（同幀 tickAll→follow 順序驗證）
2. 跟隨中 orbit/zoom 順暢不解除；pan/keypan 立即解除；開 tour 立即解除且 tour 正常
3. 跟隨中暫停時間軸 → renderCount 凍結；恢復播放繼續跟
4. 列車到終點收班 → 鏡頭原地停、chip 消失、不彈跳
5. scrub 大跳（backward rebuild）→ train_no 仍在途則繼續跟、已收班則優雅解除
6. **飛行途中干擾**（opus major 2 回歸）：按跟隨後、抵達前 rotate 一下 → 不得在半空 engage，pending follow 中止、chip 消失
7. 跟隨中 zoom 到極近（minDistance=0.25）→ 反穿地板保護與 delta-carry 不對拉、手感不抖
8. 跟隨中隱藏列車圖層 → 立即解除（不抱幽靈車）；resize 一下無異常（煙霧）

## 8. 車廂視角 Ride view（延伸，2026-07-16）

> 沉浸模式 Phase 1 第二塊（`docs/IMMERSIVE_MODE_RESEARCH.md` §六路線圖）。實作在
> `src/engine/ride.js`（~150 行）。**不是**第六個相機動力源、不進 follow 的互斥表
> ——它是 follow 之上的一層「絕對相機擺放」，靠 follow 自身的 onChange 通知同步
> 進退，自己不擁有任何 mutex 邏輯。

### 設計

- **進入條件**：`follow.active` 為真，且該圖層有實作 `getEntityLookahead(entityId, aheadMeters)`（選配介面方法，見下）。今天只有 `trains.js`（台鐵＋高鐵共用同一個 factory）。ships.js 連 `getEntityPosition` 都還沒實作（follow §2 的 phase 2），自然排除在外。
- **進入/退出**：`enter()` 存目前 `camera.position`/`controls.target`（`savedPos`/`savedTarget`），設 `controls.enabled = false`；`exit()` 完整還原兩者、`controls.update()`、`controls.enabled = true`。入口：LayerPickCard 的「車廂視角 Ride view」鈕（跟 Follow 鈕並排，只在 `isFollowingThis` 為真時才出現）；App.jsx 角落 chip 也帶一顆常駐的 Ride/Overview 切換鈕（卡片關掉後唯一的出口，跟 chip 本身的✕解除邏輯一樣的理由）；ESC 鍵直接退出（`ride.js` 自己掛 `keydown` 監聽，`exit()` 本身有 guard，非 riding 狀態按 ESC 是 no-op，不影響其他鍵盤操作）。**沒有做進場 tween**——直接 snap 到 ride pose，理由見下方「已知取捨」。
- **相機位置**：`camera.position = (train.x, max(train.y, drapeAt(heightField, train.x, train.z, exaggeration)) + rideHeight, train.z)`。`max(...)` 是地形 clamp：軌道資料是 2D polyline 貼地烘出來的高程，過鞍部/山側時可能比 heightField 實測值低，直接用 train.y 會鑽進山裡。
- **相機朝向**：`getEntityLookahead(entityId, rideLookAhead)` 沿列車目前所在 part 的弧長表往前取樣（跟 `layoutCars` 車廂尾端偏移用的是同一張表、同一個 `dir`），Y 值加上同一個 `rideHeight`（讓俯仰角跟著軌道坡度走，而不是強制水平）。取樣點不是每幀直接拿去 `camera.lookAt`——先過一個目標點的低通濾波（`lookTarget.lerp(want, 1-exp(-dt/0.35))`，frame-rate independent），避免 polyline 頂點之間的小轉折角讓鏡頭一幀一幀抖動。**這個 lerp 會在剩餘誤差 < 1e-4 world unit 時直接 snap 到目標**（`ride.js` 內的 `distanceToSquared < 1e-8` 判斷）而不是放著它漸近收斂到天長地久：純數學上的 lerp 永遠不會「剛好」等於目標，代表 `camera.lookAt()` 每幀都會吐出一個（極微小地）不同的 quaternion，而 `controls.addEventListener('change', invalidate)` 對這種幅度的變化也會誤判成「相機在動」而持續重開 `activeUntil` 視窗——暫停時間軸、ride 中閒置理論上該凍結的 `renderCount`，若沒有這個 snap 會被這條看不見的尾巴拖住（verify 時實測抓到、修掉後才凍結乾淨）。follow.tick() 本身不需要這道防線：時間暫停時它的 `dx/dy/dz` 是精確算出來的 0（不是漸近趨近於 0），寫回去是真正的 no-op。
- **與 follow 的關係**：follow.tick() 在 ride 期間**照常運作**，完全沒改 follow.js 一行程式碼——它對 `camera.position` 的寫入會被本模組同一幀稍後的絕對寫入蓋掉（`index.js` tick() 順序：`follow.tick()` → `ride.tick()`），而它對 `controls.target` 的寫入大致有用：delta-carry 讓 `controls.target` 每幀跟著實體的位移量移動，這讓 ride 期間 `camDist`（camera↔target 距離）收斂到「一個不大的常數」，遠低於 `trains.js` 的 `CAR_LOD_ENTER_DIST`（7 world units）——**近距車廂鏈 LOD 在整個 ride 過程中必然啟用**，這正是下面「自身車體擋視線」問題的根源。**實測校正**：`controls.target` 並不會精確等於實體的即時世界座標——它只保證跟實體位移「同步」，起始基準點是 follow 的 fly-in tween**完成當下**（`engageArrive()`）取樣到的實體位置，而不是 `followEntity()` 呼叫當下的位置；因為實體在這 1.8 秒的飛行期間持續移動，落地時基準點已經跟實體「當時」的真實位置有一個固定落差，delta-carry 之後這個落差永遠不會被追平（只保持不變，不會擴大）。實測觀察到的落差量級約 0.1–0.7 world unit，仍遠低於 7 world unit 的 LOD 門檻，不影響本節的結論，只是說明 ride 中不能拿 `controls.target` 當「實體目前精確位置」的可靠來源——真正精確的位置一律走 `getEntityPosition()`。
- **mutex**：ride 不在 follow 的互斥表裡加任何一列。做法是把 `ride.exit()` 掛在 follow 自己的 `onChange` callback（`index.js`）：`onChange: (s) => { if (!s.active) ride.exit(); emit('follow', s) }`。follow 的每一個既有 mutex 呼叫點（startTour/flyToLonLat/selectPoi/deselect/keyPan.onEngage/pan-drag 偵測/實體消失）都是**先呼叫 `follow.stopFollow()` 才開始新的 tween/tour**（design doc §3 已有的順序），所以這個 notify 永遠搶在新動力源真正動筆之前同步觸發，`ride.exit()` 永遠贏——不需要在 `ride.tick()` 額外判斷 `motion.tweenActive`/`tourActive`。`ride.tick()` 內仍留了一道 `if (!follow.active) exit()` 的防禦性 self-heal（理論上不太會被觸發，但便宜且安全）。

### 自身車體擋視線——處理選擇

任務列出兩個選項：「相機放車頭前方一點」或「ride 中隱藏被跟隨列車的 mesh」。**選了後者**：`trains.js` 新增選配介面 `setEntityHidden(entityId, hidden)`，`ride.enter()`/`exit()` 呼叫它隱藏/恢復被跟隨列車的實例——`layoutDots`/`layoutCars` 對命中 `hiddenTrainNo` 的那班車，位置/弧長比例的 bookkeeping（`hitByTrainNo`/`locByTrainNo`）照常跑（ride 還是需要即時位置），只跳過 `setMatrixAt`/`count++`/`lastHits.push`。選這個而不是「往前推相機」的理由：`rideHeight` 滑桿下限只有 0.01 world unit（≈4.8m），逼近車廂實際高度（~4m），相機幾乎貼著/穿進車廂 box 幾何體——往前推相機只解決「正前方」，側向/轉彎時仍可能穿模；隱藏整輛車則在整個滑桿範圍內都乾淨，代價是看不到自己車廂的輪廓（不是「像坐在車廂裡」而是「像飄在車頭前方的空拍機/GoPro」）。

### 參數

| 參數 | 單位 | 預設 | 範圍 | 說明 |
|---|---|---|---|---|
| `rideHeight` | world unit（1 unit ≈ 480.78m，geo.js K_ANCHOR） | 0.04（≈20m，「從車頂看出去」） | 0.01–0.2（≈4.8–96m） | Settings › Ride view「視角高度」，live 套用，不觸發 rebuild |
| `rideLookAhead` | 公尺（跟 `carLenM`/`part.lengthM` 同單位） | 3000（3km） | 500–8000 | Settings › Ride view「前瞻距離」 |

### window.__exp 除錯欄位

- `window.__exp.ride` — `ride.js` 回傳物件本體（`.active`/`.enter()`/`.exit()`/`.toggle()`）
- `window.__exp.rideState` — `{active, layerId, entityId, ratio}`，`ratio` 是被跟隨列車目前所在 part 的弧長比例（0..1），來自新增的 `trains.js` `getEntityRatio(entityId)`（純除錯用途，`ride.js` 本身邏輯不消費它）

### 已知限制 / 取捨

- **進場沒有 tween**：直接 snap 到 ride pose，而不是像 follow 的 `onArrive` engage 那樣飛過去。理由：使用者進 ride 前一定已經在 follow 模式（鏡頭本來就懸停在實體附近），從「環繞觀察」直接切到「車頂視角」是視角性質的瞬間切換（像遊戲裡切換座艙視角），不是位置的長距離飛行，snap 不會像 follow 首次 engage 那樣突兀；也符合「先求簡單」的實作原則。
- **進場防呆**：`canRide()` 除了 `follow.active` 還多檢查 `!motion.tweenActive && !motion.tourActive`——`follow.active` 在 `followEntity()` 呼叫當下就同步變真（follow.js 設計文件本身的 active vs. 「已 engage」區分），比 fly-in tween 落地（預設 1.8s）早。實測驗證時抓到：若在這個空窗按 Ride，`ride.tick()` 會在 `motion.tick(dt)` 每幀寫入 tween 插值之後、同一幀立刻把 `camera.position` 覆寫成絕對值，等於瞬間劫持還沒飛完的 follow 鏡頭；`enter()` 存的 `savedPos`/`savedTarget` 也會是飛行途中的過渡姿態，不是真正「懸停在實體上方」的姿態。修法比照 follow.js 自己 `tick()` 的既有防線（design doc §3「opus major 2」同一個理由）：這個空窗內按 Ride 直接 no-op，使用者半秒後再按一次即可——不需要排隊等待或另外 tween。
- **退出還原是絕對世界座標，不是相對 orbit offset**：`exit()` 把 `camera.position`/`controls.target` 還原成 `enter()` 當下存的絕對值，**不會**重新對齊到列車「現在」的位置。若 ride 持續得夠久（列車移動了一段距離），退出後鏡頭會跳回進場前那個懸停點——而 follow 本身仍是 active 的，之後 follow.tick() 只會從這個（已經跟列車現在位置有落差的）錨點繼續往前 carry，不會補上 ride 期間的位移，鏡頭可能暫時看著一段列車已經離開的路段。這是照任務規格「完整還原」字面實作的刻意選擇，不是遺漏；若要「退出後鏡頭仍對著列車目前位置」，需要改成存/還原「相對 orbit offset」語意，不在本次範圍內。
- **look-ahead 只在目前 part 內夾限**：`getEntityLookahead` 把 ratio clamp 在 `[0,1]`（跟 `layoutCars` 車廂尾端偏移的簡化一樣），在 part 邊界（`rail_lines.json` 分段接點）附近，前瞻點會停在該 part 端點、不會延伸到下一個 part，直到列車本身跨過去、`locByTrainNo` 更新為止——實務上是一兩秒的鏡頭「暫停重新瞄準」，不是跳動或出錯。
- **ride 只支援 trains/thsr**：ships.js 目前連 follow 的 `getEntityPosition` 都沒實作（phase 2 backlog），ride 自然也沒有。
- **隱藏车体的代價**：見上一節——看不到自己車廂輪廓，是刻意的取捨，不是遺漏。
- **camDist 副作用**：ride 期間 `trains.js` 的近距車廂鏈 LOD 必然啟用（見「與 follow 的關係」），若某天車廂鏈的每幀成本變重，這裡是第一個要重新檢視的假設。
