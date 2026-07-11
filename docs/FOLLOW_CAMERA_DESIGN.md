# FOLLOW_CAMERA_DESIGN — 跟隨鏡頭

> 狀態：草案（待 opus 審定）。backlog #2 第三項，無範本（v3/pulse 都沒做過），從零設計。
> 前置已上線：列車 pick 資訊卡（trains.js lastHits）、timeStore、ships.js。

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
getEntityPosition(entityId) → { x, y, z } | null   // null = 實體已不存在（收班/跨日 rebuild/資料換日）
```

- trains.js：entityId = `train_no`（rebuild 後仍可解析——**禁止用 instance index**，backward-jump rebuild 會洗掉）；由 layout() 現成的 lastHits/active set 查
- ships.js：entityId = `mmsi`（phase 2，介面免費相容）
- 回 null → follow 自動解除（鏡頭留在原地，不彈跳、不飛回）

## 3. 狀態機與互斥（重點審查區）

engine `motion` 加 `followActive`；`follow.js` 新模組持有 `{ layerId, entityId, lastPos }`。

| 事件 | 對 follow 的效果 |
|------|-----------------|
| `followEntity(layerId, entityId)` | 先 `stopTour()`＋取消進行中 tween → flyTo tween 至實體 → tween 完成 engage |
| `startTour()` / `applyPreset` / `flyTo` / `selectPoi` | **先解除 follow**（任何新相機意圖都是退出訊號） |
| OrbitControls rotate/zoom | 允許，不解除（跟隨中觀察是核心價值） |
| OrbitControls **pan** / keypan | **解除 follow**（使用者要拿回位置控制權） |
| 實體消失（getEntityPosition→null） | 解除，鏡頭原地 |
| `deselect` / pick 卡關閉 | 不自動解除（看車不必開卡）；卡上跟隨鈕變切換態 |
| dispose | 清理 |

- pan 偵測：OrbitControls 的 pan 會動 `controls.target`——follow 中偵測「非 delta-carry 造成的 target 位移」即視為 pan，解除。實作上在每幀 delta-carry 前比對 `controls.target` 與上幀寫入值（epsilon）。
- tour.js 完全不感知 follow：互斥由 engine 事件入口統一把關（startTour 先 stopFollow、followEntity 先 stopTour），兩模組零耦合。

## 4. 渲染與 tick 順序

- tick 順序：`layers.tickAll()`（實體位置更新）→ `follow.tick()`（delta-carry）→ render。follow.tick 在 tickAll 之後才能拿到本幀新位置。
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
| `src/engine/trains.js` | 加 `getEntityPosition(trainNo)`；pick payload 加 followable |
| `src/engine/index.js` | 註冊 follow tick、`followEntity/stopFollow` API、互斥把關（startTour/flyTo/applyPreset/selectPoi 入口） |
| `src/app/components/LayerPickCard.jsx` | 跟隨鈕 |
| `src/app/App.jsx` | 跟隨中 chip |

## 7. 驗收準則

1. 點列車 → 跟隨：tween 飛到車上方 → 黏著走；60x 下依然平滑貼合（同幀 tickAll→follow 順序驗證）
2. 跟隨中 orbit/zoom 順暢不解除；pan/keypan 立即解除；開 tour 立即解除且 tour 正常
3. 跟隨中暫停時間軸 → renderCount 凍結；恢復播放繼續跟
4. 列車到終點收班 → 鏡頭原地停、chip 消失、不彈跳
5. scrub 大跳（backward rebuild）→ train_no 仍在途則繼續跟、已收班則優雅解除
