# WALK_MODE_DESIGN — 第一人稱步行

> 狀態：**Phase 2 原型驗證**（docs/IMMERSIVE_MODE_RESEARCH.md §五-1／§六路線圖）。目標不是 AAA 手感，是證明「WASD 在真實地形上走」可用、驗 20m DEM 在步行視角的可接受度。
> 骨架照抄 `src/engine/ride.js`（save/restore pose、controls.enabled=false、ESC 退出、isAnimating 接線），但 walk 沒有被跟隨的實體——步行者自己的 xz + yaw/pitch 就是狀態。

## 0. 需求與邊界

- 右上角獨立 `WalkPanel`（`src/app/components/WalkPanel.jsx`，見 §9）進入按鈕（+ `engine.toggleWalkMode()` facade）→ pointer lock 滑鼠視角 + WASD 移動 + Shift 衝刺 + Space 跳躍（§5）
- 貼地：每幀查 `heightAtWorld`，垂直阻尼跟隨地形起伏
- ESC（或 pointer lock 原生 exit 事件）退出，還原相機
- 效能鐵則不破：站著不動、不轉頭、不在半空 → `isAnimating()` 必須收斂為 false，`renderCount` 凍結

## 1. 相機模式，不是 Layer

`src/engine/walk.js` 是跟 `ride.js` 同一家族的獨立相機模式模組（`enter/exit/toggle/tick`），不是 `LayerManager` 圖層。理由跟 ride 一樣：它操控的是相機本身，不是場景裡的物件。

進入時：
- `motion.cancel()` + `follow.stopFollow()`（連帶透過 index.js 既有的 `follow.onChange` 觸發 `ride.exit()`）——跟 `keyPan.onEngage` 同一套「搶相機先清空其他動力源」紀律
- 存 `camera.position` / `controls.target` / `camera.near`
- 初始 yaw 取自進入當下相機朝向（`camera.getWorldDirection` 投影到水平面），不讓進入瞬間畫面甩動
- `camera.near` 從 scene.js 的 0.02（≈10m）降到 0.002——步行視角眼高就在地面附近，0.02 會裁掉腳下地面
- `controls.enabled = false`，`domElement.requestPointerLock()`

退出：原樣還原 `camera.position` / `controls.target` / `camera.near` / `controls.enabled`；`document.exitPointerLock()` 若仍鎖著。

## 2. 貼地策略

垂直高度全部走 `metersToWorldY`（geo.js），不手刻公式，跟 `terrain.js` 的 `_makeDemSamplerFor` 同一條路徑（`(heightAtWorld(x,z) - datumM) * K * exaggeration`，忽略 fine-detail noise 那一項——detail 只影響法線/視覺細節，不影響碰撞高度）。

**兩個必守的坑**：

1. **tile 未載入時 heightAtWorld 回 0m**——這個 0m 跟「真的在海平面」無法從回傳值本身分辨（`HeightField.heightAtWorld` 對「tile 缺」和「tile 已解析為海」都回傳 `0`，見 geo.js）。單純判斷「raw===0 就當作 tile miss」在陸地→海面的過渡會出 bug：一旦真的踩進開闊海域（resolved tile, `data: null`），raw 會**持續**是 0，若一路當成"還沒載入"就永遠不會真的把步行者放到海平面，反而卡在最後一次陸地高度飄在空中。

   解法：`walk.js` 的 `tileResident(hf, x, z)` 直接查 `heightField.tiles`（public Map，key 格式跟 `hf.key(tx,ty)` 一致）判斷該 tile **是否已經解析過**（不管解析結果是陸地還是海），而不是看 `heightAtWorld` 的回傳值猜。tile 未解析 → 沿用 `lastGroundM`；已解析 → 相信 `heightAtWorld`（含它自己回的 0m 海面）。只用 `HeightField` 既有 public 介面（`tiles` / `key()` / `projection.worldToPixel()`），**沒有改動 geo.js**。

2. **走進海裡**：`clampedM = Math.max(groundM, 0)`——地面高度 <0（bathymetry 開著時的海床負值）一律 clamp 到 0，等於「走在水面上」，不下潛海底地形。

垂直方向用 `THREE.MathUtils.damp`（lambda=6）跟隨目標地面高度，並在誤差 < 1e-6 world units 時直接 snap 到終點——照抄 `ride.js` 對 lookAt lerp 的同一個教訓：沒 snap 的阻尼永遠差一點點，`isMoving()`/on-demand render 永遠不會收斂到「靜止」。

## 3. 操控

- Pointer lock 自訂實作（未用 three 的 `PointerLockControls`，圖簡單直接控制 quaternion）：`mousemove` 累積 yaw（無限制）/ pitch（clamp ±85°），`camera.rotation.set(pitch, yaw, 0, 'YXZ')` 每幀套用
- WASD/方向鍵沿 yaw 水平移動（`sin/cos(yaw)` 算 forward/right，**忽略 pitch**——低頭看地不會飛起來），對角線移動先 normalize 避免變快；Shift 衝刺 ×4
- Space 跳躍（落地時才觸發，見 §5）
- `walkSpeed`（40 m/s 預設，5–300 滑桿）、`walkEyeHeight`（12m 預設，2–100 滑桿）、`walkJumpHeight`（10m 預設，2–50 滑桿）都是 `WalkPanel`（§9）的 `live()` 參數，不需要 rebuild
- 水平位移公尺→world unit 用 `heightField.projection.K`（**不含** `demExaggeration`——那是垂直專用的誇張係數，水平移動速度/視角高度都該是真實比例）

## 4. tick 順序與 controls.target

跟 `ride.js` 同一個插槽：`follow.tick()` → `ride.tick(dt)` → `walk.tick(dt)`，都在 `chunkManager.update()` 之前。`walk.tick()` 每幀把 `controls.target` 寫到步行者腳下（不是眼睛位置）：

```
controls.target.set(x, groundY, z)   // 眼睛在 groundY + eyeHeight
```

`camDist = eyeHeight`（world units）恆定，`stage.tickView()` 的 fogScale 因此落到最小刻度——這是**預期行為**，不是 bug：近景霧/等高線/survey grid 都該收到最貼近視角的密度。chunk streaming 也自然跟著 `controls.target` 走，不用改 `chunks.js`。

`keyPan`（arrow/WASD 螢幕平移）跟 walk 共用 W/A/S/D 鍵位：`walk.active` 時 index.js 的 tick() 走 `keyPan.reset()` 分支（跟 tour/tween 進行中同一個既有分支），避免兩邊都在動 `camera.position`/`controls.target`（walk 的絕對寫入本來就會蓋掉 keyPan 的殘留速度，但明確跳過比較乾淨、也省一份沒用的向量運算）。

## 5. Jump（跳躍）

Space 按下、且步行者處於**非空中**狀態（`!state.airborne`，見下）→ 起跳。空中時再按 Space 不觸發二段跳——請求會被吃掉（每個 tick 都無條件清空一次性旗標，見下），落地後才會再生效。

**輸入路徑**（跟既有的 WASD/debug 雙軌一致）：
- 真滑鼠鍵盤：`onKeyDown` 收到 `Space` → 設 `jumpQueued = true` + `invalidate()`（喚醒 on-demand loop——idle 時 `tick()` 整段跳過，不喚醒的話這一幀的跳躍請求永遠不會被消費，見 index.js 的 `activeUntil` 早退）+ `preventDefault()`（pointer lock 中不擋掉的話 Space 會捲動背後的頁面）
- Debug：`setInput({ jump: true })` 設 `debugInput.jump = true`，語意跟真鍵盤一致——一次性、只有落地時才生效

**物理**（`src/engine/walk.js` tick()）：
- 重力常數 `WALK_GRAVITY_MPS2 = 25`（m/s²，手感常數，非真實 9.8——這個世界尺度下 40 m/s 的 `walkSpeed` 搭配真實重力會飄，實測調到「跳起來不飄不墜」為準；經驗值：`walkJumpHeight=10m` 時空中時間 ≈1.8 秒，10m 高的一跳落地不拖沓）
- 起跳初速 `v0 = sqrt(2 · g · h)`（`g`、`h` 都先各自乘 `hf.projection.K` 換算成 world units/sec、world units 再代入——**跟眼高 `eyeOffsetY` 同一條路徑**：只過 `K`，不過 `metersToWorldY`/`demExaggeration`，因為跳躍高度是身體尺度的量，不該隨地形垂直誇張係數一起伸縮，跟 `walkEyeHeight` 已經記載的理由相同）
- 空中：semi-implicit Euler 積分（`vy -= g·dt` 先、`eyeY += vy·dt` 後），取代原本的貼地阻尼；水平移動（§3 的 WASD 區塊）不分空中/地面都跑同一段——空中可微調方向，手感比鎖死彈道好
- 落地判定：`eyeY <= targetEyeY`（目標地面+眼高，跟原本貼地邏輯算的是同一個值）→ snap `eyeY = targetEyeY`、`vy = 0`、`airborne = false`，交還給原本的 `THREE.MathUtils.damp` 貼地阻尼
- `state.airborne` 是新增的公開狀態（`debugState().airborne`），`state.moving` 現在是 `walking || settling || airborne`——空中必須算 moving，不然人物飛在半空 renderCount 會提早凍結；落地後不動、不轉頭才真正收斂到 idle

**單位換算摘要**：水平（`walkSpeed`）、眼高（`walkEyeHeight`）、跳躍高度（`walkJumpHeight`）、重力常數全部走「真實公尺 × `hf.projection.K`」這一條路，`demExaggeration` 只碰垂直地形本身（`targetGroundY = metersToWorldY(...)`），不碰人物尺度的量——四者待遇一致，不用分別記憶。

## 6. isAnimating / 效能

`walk.isMoving()`：WASD 任一方向鍵按住、**或**垂直阻尼還沒 snap 到終點、**或**正在空中（`airborne`）時回 `true`，接進 `isAnimating()`。滑鼠視角轉動走事件驅動（`mousemove` handler 直接 `invalidate()` 一次），不是每幀輪詢。站著不動、不轉頭、雙腳落地 → `isMoving()` 收斂為 `false` → 幾秒活躍窗過後凍結。

## 7. Debug / headless 測試

Pointer lock 在 headless/自動化瀏覽器（agent-browser SwiftShader session 常見）經常拿不到，所以移動邏輯不能只靠真滑鼠/鍵盤。`window.__exp.walk`（`engine.debug.walk`）暴露：

- `setInput({ forward, right, sprint, jump, yaw, pitch })`——DEV-only 用途但沒有內部 gate（跟 `engine.debug` 其他成員一樣，只有 App.jsx 的 `window.__exp =` 賦值是 DEV-gated）；`jump: true` 是一次性請求，語意見 §5
- `debugState()` / `window.__exp.walkState`——`{ active, x, z, eyeY, groundM, moving, yaw, pitch, airborne }`

驗跳躍的典型流程：`setInput({jump:true})` → 下一幀起 `walkState.airborne === true` → 持續幾幀後（重力常數對應的空中時間）`airborne` 轉回 `false` 且 `moving` 沒有其他來源時收斂為 `false` → `renderCount` 凍結。

## 8. 已知限制（原型範圍內接受）

- **20m DEM 是步行視角的天花板**：近景會看到明顯的地形階梯感/多邊形面，不是程式錯誤——這正是研究文件 §四點名的硬缺口，本階段不做程序化細節補償（detail normal map / micro-displacement 留給 Phase 3）
- **iOS 無 pointer lock API**：本原型未做虛擬搖桿 fallback，行動裝置上「進入步行」會缺少滑鼠視角
- **海面行走**：`clampedM = max(groundM, 0)` 讓步行者浮在水面，不是真的游泳/潛水模擬
- **DoF/天空/夕陽在步行視角下未特別調校**：`environment.js` 的 Sky/霧每幀貼相機理論上該自動適配，但貼地眼高視角下沒有針對性驗證——若實測發現明顯異常記錄於此，不強修（見下方驗收記錄）
- **`params.autoFocus` 的對焦點**（`cone.getFocusPoint()`）在真實地形模式本來就是既有的近似行為，walk 模式沒有特別處理，可能導致 DoF 對焦距離跳動
- **跳躍是遊戲化的「大跳」，不是真人跳躍模擬**：預設 10m 峰值高度遠超人類跳躍能力，這是刻意的探索性手感（原型範圍接受，跟真實比例的 `walkSpeed`/`walkEyeHeight` 不同調）；`WALK_GRAVITY_MPS2` 是單一全域常數，不隨 `walkJumpHeight` 滑桿變化空中時間手感（跳 50m 高會覺得比跳 2m 高「飄」一些，屬預期）
- **上坡跳躍**：往上坡方向起跳時，若地面上升速度快過彈道下降速度，落地判定會提前觸發（`eyeY <= targetEyeY`）——玩家感覺像是「跳躍被地形吃掉」，不是 bug，是簡化物理模型的已知取捨（原型範圍不做地形碰撞面法向量的完整彈道處理）

## 9. UI：右上角面板（原 Settings 內嵌搬遷）

原本「進入步行」按鈕 + `walkSpeed`/`walkEyeHeight` 滑桿埋在 `Settings.jsx` 的「Walk 步行」區塊——使用者回饋這感覺像「設定裡關不掉的東西」，不像一個獨立功能。搬成 `src/app/components/WalkPanel.jsx`：常駐右上角、收合時只是一顆膠囊鈕，展開才看到參數（含新增的 `walkJumpHeight` 滑桿）。`Settings.jsx` 的「Walk 步行」整段（`SectionHeader` + 按鈕 + 兩顆滑桿）已移除，不留重複入口。

佈局上跟既有的 `FollowChip`（跟隨中才出現的右上角 chip）共用 `App.jsx` 的一個 fixed flex-column 容器（`WalkPanel` 在上、`FollowChip` 在下）——用 flexbox 自然堆疊，不手算兩者的 top/bottom 偏移（`WalkPanel` 收合/展開高度不同、`FollowChip` 本身也是條件渲染，手算在任一邊狀態變化時都會碎掉）。`FollowChip` 原本自帶 `position:fixed/top/right/zIndex`，改成不帶——交給外層容器。

步行中面板仍然掛著、可操作，只是 pointer lock 鎖住游標時滑鼠點不到（跟原本 Settings 面板的限制一樣）；ESC 離開步行後立刻點得到，且面板本身不會因為離開步行而消失（常駐入口）。`WalkHint`（頂部置中的「步行中提示」chip，含 ESC 離開出口）維持原樣不動。

## 10. 檔案異動

| 檔案 | 動作 |
|------|------|
| `src/engine/walk.js` | 新增；後續補跳躍物理（`WALK_GRAVITY_MPS2`、`state.vy`/`state.airborne`、`jumpQueued`、`setInput({jump})`、`debugState().airborne`） |
| `src/engine/index.js` | import + 註冊 walk tick（follow/ride 之後）、`isAnimating()` 加 `walk.isMoving()`、keyPan 三分支門控、`toggleWalkMode` facade、`dispose()`、`debug.walk`/`debug.walkState`、`DEFAULT_PARAMS.walkSpeed`/`walkEyeHeight`；後續補 `DEFAULT_PARAMS.walkJumpHeight` |
| `src/app/components/panels/Settings.jsx` | 「Walk 步行」區塊：進入/結束按鈕 + 兩顆滑桿；後續**整段移除**（搬去 `WalkPanel.jsx`），連同不再使用的 `walking` state/`'walk'` 事件訂閱一併清掉 |
| `src/app/App.jsx` | `WalkHint` 角落提示 chip（WASD/Shift/ESC + 常駐離開出口）；後續新增右上角 `WalkPanel`+`FollowChip` 共用容器，`FollowChip` 改為不帶自己的 fixed 定位 |
| `src/app/components/WalkPanel.jsx` | 新增（§9）：右上角獨立步行面板，收合膠囊鈕/展開卡片兩態 |
