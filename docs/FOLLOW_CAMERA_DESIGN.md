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
