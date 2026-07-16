# WALK_MODE_DESIGN — 第一人稱步行

> 狀態：**Phase 2 原型驗證**（docs/IMMERSIVE_MODE_RESEARCH.md §五-1／§六路線圖）。目標不是 AAA 手感，是證明「WASD 在真實地形上走」可用、驗 20m DEM 在步行視角的可接受度。
> 骨架照抄 `src/engine/ride.js`（save/restore pose、controls.enabled=false、ESC 退出、isAnimating 接線），但 walk 沒有被跟隨的實體——步行者自己的 xz + yaw/pitch 就是狀態。

## 0. 需求與邊界

- Settings 面板「Walk 步行」進入按鈕（+ `engine.toggleWalkMode()` facade）→ pointer lock 滑鼠視角 + WASD 移動 + Shift 衝刺
- 貼地：每幀查 `heightAtWorld`，垂直阻尼跟隨地形起伏
- ESC（或 pointer lock 原生 exit 事件）退出，還原相機
- 效能鐵則不破：站著不動、不轉頭 → `isAnimating()` 必須收斂為 false，`renderCount` 凍結

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
- `walkSpeed`（40 m/s 預設，5–300 滑桿）、`walkEyeHeight`（12m 預設，2–100 滑桿）都是 Settings 面板 `live()` 參數，不需要 rebuild
- 水平位移公尺→world unit 用 `heightField.projection.K`（**不含** `demExaggeration`——那是垂直專用的誇張係數，水平移動速度/視角高度都該是真實比例）

## 4. tick 順序與 controls.target

跟 `ride.js` 同一個插槽：`follow.tick()` → `ride.tick(dt)` → `walk.tick(dt)`，都在 `chunkManager.update()` 之前。`walk.tick()` 每幀把 `controls.target` 寫到步行者腳下（不是眼睛位置）：

```
controls.target.set(x, groundY, z)   // 眼睛在 groundY + eyeHeight
```

`camDist = eyeHeight`（world units）恆定，`stage.tickView()` 的 fogScale 因此落到最小刻度——這是**預期行為**，不是 bug：近景霧/等高線/survey grid 都該收到最貼近視角的密度。chunk streaming 也自然跟著 `controls.target` 走，不用改 `chunks.js`。

`keyPan`（arrow/WASD 螢幕平移）跟 walk 共用 W/A/S/D 鍵位：`walk.active` 時 index.js 的 tick() 走 `keyPan.reset()` 分支（跟 tour/tween 進行中同一個既有分支），避免兩邊都在動 `camera.position`/`controls.target`（walk 的絕對寫入本來就會蓋掉 keyPan 的殘留速度，但明確跳過比較乾淨、也省一份沒用的向量運算）。

## 5. isAnimating / 效能

`walk.isMoving()`：WASD 任一方向鍵按住 **或** 垂直阻尼還沒 snap 到終點時回 `true`，接進 `isAnimating()`。滑鼠視角轉動走事件驅動（`mousemove` handler 直接 `invalidate()` 一次），不是每幀輪詢。站著不動、不轉頭 → `isMoving()` 收斂為 `false` → 幾秒活躍窗過後凍結。

## 6. Debug / headless 測試

Pointer lock 在 headless/自動化瀏覽器（agent-browser SwiftShader session 常見）經常拿不到，所以移動邏輯不能只靠真滑鼠/鍵盤。`window.__exp.walk`（`engine.debug.walk`）暴露：

- `setInput({ forward, right, sprint, yaw, pitch })`——DEV-only 用途但沒有內部 gate（跟 `engine.debug` 其他成員一樣，只有 App.jsx 的 `window.__exp =` 賦值是 DEV-gated）
- `debugState()` / `window.__exp.walkState`——`{ active, x, z, eyeY, groundM, moving, yaw, pitch }`

## 7. 已知限制（原型範圍內接受）

- **20m DEM 是步行視角的天花板**：近景會看到明顯的地形階梯感/多邊形面，不是程式錯誤——這正是研究文件 §四點名的硬缺口，本階段不做程序化細節補償（detail normal map / micro-displacement 留給 Phase 3）
- **iOS 無 pointer lock API**：本原型未做虛擬搖桿 fallback，行動裝置上「進入步行」會缺少滑鼠視角
- **海面行走**：`clampedM = max(groundM, 0)` 讓步行者浮在水面，不是真的游泳/潛水模擬
- **DoF/天空/夕陽在步行視角下未特別調校**：`environment.js` 的 Sky/霧每幀貼相機理論上該自動適配，但貼地眼高視角下沒有針對性驗證——若實測發現明顯異常記錄於此，不強修（見下方驗收記錄）
- **`params.autoFocus` 的對焦點**（`cone.getFocusPoint()`）在真實地形模式本來就是既有的近似行為，walk 模式沒有特別處理，可能導致 DoF 對焦距離跳動

## 8. 檔案異動

| 檔案 | 動作 |
|------|------|
| `src/engine/walk.js` | 新增 |
| `src/engine/index.js` | import + 註冊 walk tick（follow/ride 之後）、`isAnimating()` 加 `walk.isMoving()`、keyPan 三分支門控、`toggleWalkMode` facade、`dispose()`、`debug.walk`/`debug.walkState`、`DEFAULT_PARAMS.walkSpeed`/`walkEyeHeight` |
| `src/app/components/panels/Settings.jsx` | 「Walk 步行」區塊：進入/結束按鈕 + 兩顆滑桿 |
| `src/app/App.jsx` | `WalkHint` 角落提示 chip（WASD/Shift/ESC + 常駐離開出口） |
