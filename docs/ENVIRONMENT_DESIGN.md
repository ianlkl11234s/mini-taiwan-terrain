# ENVIRONMENT_DESIGN — 時間軸太陽/天空 + 天氣系統（Phase 1）

> 狀態：已實作（2026-07-16，分支 `feat/environment-time-weather`）。
> 上游研究：`docs/IMMERSIVE_MODE_RESEARCH.md`（結論：suncalc + 內建 Sky 是零新依賴的最快勝利，本文件是那個 Phase 1 的落地設計）。
> 風格參考：`docs/TIMELINE_DESIGN.md`。

## 0. 目標與範圍

地圖隨時間軸（`src/state/timeStore.js`）呈現清晨/白天/中午/下午/黃昏/夜晚的光照與配色連續變化，並支援晴天/雨天/颱風天三種天氣修飾。全部在 `params.envAuto=false` 時一鍵關閉，回到改動前像素級一致的手動光照。

第一個消費者：場景光照（太陽/半球光/霧/天空盒）+ 海面 shader（`region.js`）+ 新圖層 `rain.js`。

## 1. 架構：`src/engine/environment.js` 是場景級系統，不是 Layer

不掛進 `LayerManager`（沒有 `describe()`、不出現在 Layers 面板）——它的 UI 是 `Settings.jsx` 的「環境 Environment」區塊 + `debugPanel.js` 的 `Environment` folder。`createEnvironment(params, stage, { regionLayer, invalidate })` 在 `index.js` 完成圖層註冊迴圈之後建立（需要 `layers.get('region')` 已存在），對外只有 5 個方法：`apply()` / `tick(dt)` / `getFogMul()` / `debug()` / `dispose()`。

### 1.1 太陽方位角座標系（最容易做錯的一步）

`scene.js` 的 `placeSun()`／新增的 `placeSunAt(azDeg, elDeg)`：

```js
_sunOffset.set(Math.cos(az)*Math.cos(el)*r, Math.sin(el)*r, Math.sin(az)*Math.cos(el)*r)
```

配合 `geo.js` 的世界座標慣例（+X = East, +Z = South），推出引擎自己的方位角定義：**az=0 → 太陽在正東，az=90 → 正南，az=180 → 正西，az=270 → 正北**（角度沿 東→南→西→北 遞增，跟標準羅盤方位角「北=0 順時針」正好差 90°）。

`suncalc`（**注意：装的是 v2.0.1**，`getPosition()` 回傳的 `azimuth`/`altitude` **已經是角度**、且 azimuth 是標準羅盤方位角（0=北, 90=東, 180=南, 270=西, 順時針）——這跟網路上多數教學描述的 v1 API（弧度、以南為 0）完全不同，是這次實作最容易踩的坑，動手前用 node 手動探測過（`SunCalc.getPosition(date, 23.7, 121.0)` 對正午/日出/日落幾個已知時刻，確認回傳值與台灣的物理直覺相符）才敲定換算公式：

```js
engineAz = ((suncalcAzimuthDeg - 90) % 360 + 360) % 360   // compass -> engine convention
engineEl = suncalcAltitudeDeg                              // 同義，不用換算
```

驗算（Taiwan 2026-07-16，UTC+8）：日出 05:10 → compassAz 65° → engineAz 335°（偏北一點的東北，夏至前後太陽從東北方升起，方向正確）；正午 12:00 → compassAz 168°、altitude 87.6°（接近天頂，符合北回歸線附近盛夏正午）；日落 18:45 → compassAz 294°（偏北的西北）。三個時刻方位/仰角都物理合理，換算公式判定正確。

### 1.2 觀測點

固定台灣中心 `lat 23.7, lon 121.0`（不做逐地區太陽位置，全島誤差在幾度內，不值得增加複雜度）。

### 1.3 時刻來源

直接用 `timeStore.getTime()`（unix 秒）餵給 `new Date(t*1000)` 給 suncalc——**沒有**照原規格描述的「`getDateKey()` + `getDaySeconds()` 組回 Date」繞一圈：`getTime()` 本身就是精確的絕對時刻，SunCalc 只需要一個正確的瞬間 + 經緯度就能算出真太陽位置，跟「這個瞬間對應到哪個時區的哪個曆日」完全無關；額外拆解再組裝只會增加一個手刻時區換算出錯的風險（也是本任務規格特別點名的陷阱），拆解-重組是不必要的間接層，直接用 `getTime()` 更簡單也更不會錯。

## 2. 時段配色 ramp

`environment.js` 的 `RAMP` 常數：以太陽仰角（度）為 key 的 7 個關鍵影格（深夜 -90/-12 持平、曙暮 -4、金色時刻 0/8、白天 35、正午 90），線性內插每個欄位（sun 係數、sunColor、hemi 強度、hemiSky/Ground 色、fog 色、sky 色、envTint、Sky 的 turbidity/rayleigh/mieCoefficient）。

強度規則：
- **太陽**：`sun.intensity = rampCoef × params.sunIntensity`（係數×使用者基準值，深夜係數 0、白天/正午係數 1——回到使用者設定的原值，不覆寫 params）
- **半球光**：`hemi.intensity = params.hemiIntensity + rampHemi`（**加法**，不是係数x基準值——`hemiIntensity` 預設是 0，係数x0 永遠是 0，會讓夜間月光模擬完全失效；改成加法後，使用者從沒調過這顆滑桿時 ramp 的月光/天空補光可以正常運作，調過的話 ramp 疊加在使用者設定之上。這是規格「強度一律用係數×基準值」的唯一例外，決策記錄在 `environment.js` 的 `applyAuto()` 註解）
- **霧/背景色、海面 uSkyColor**：ramp 的「白天」關鍵影格直接讀 `params.fogColor`（fog/background）或原本寫死的海面預設色（`uSkyColor`），所以 envAuto 開著時中午也會回到使用者設定的顏色，不會把自訂色永久蓋掉

## 3. Sky 天空盒

`three/addons/objects/Sky.js`（Preetham model）。`sky.scale.setScalar(2400)`（遠平面只有 3000，縮小到能完整包住視錐又留安全邊界），每個可見 frame 把 `sky.position` 對齊 `camera.position`（標準「相機置中 skybox」作法，不受 pan/dolly 影響）。太陽仰角 ≤ -10° 時 `sky.visible=false`，退回 `scene.background`（ramp 給的夜色）。`sunPosition` uniform 跟 `region.js` 的 `uSunDir`／`scene.js` 的實際太陽方向用同一條 `sunDirection(az, el)` 公式算，三處視覺一致。

## 4. 天氣修飾層

`params.weather`：`'clear' | 'rain' | 'typhoon'`。`WEATHER` 表（`environment.js`）是疊在 ramp 之上的修飾：太陽係數再乘一次（rain ×0.35、typhoon ×0.18）、色調混入灰/灰綠、霧色混濃、Sky turbidity 拉高、海面 `uEnvTint` 再壓暗、`getFogMul()` 提供霧距離收縮倍率（rain 0.55、typhoon 0.4）。

**天氣修飾只在 `envAuto=true` 時生效**（`applyManual()` 完全不看 `params.weather`）——`envAuto=false` 時切換天氣仍會開 `rainVisible`/`typhoonVisible`（雨絲粒子、颱風雲層照樣顯示），但不會改光照/霧色/天空。這是刻意的範圍界線：保住「`envAuto=false` 像素級等同改動前」這條硬性回退保證的唯一辦法，就是讓 manual 分支完全不讀 weather。

`weather` HANDLER（`index.js`）直接改寫 `params.rainVisible`/`params.rainIntensity`/`params.typhoonVisible`（跟既有 `bathymetryVisible` HANDLER 同一種「直接改別的 param + 手動呼叫該圖層 update()」寫法），並用內部旗標 `weatherOpenedTyphoon` 記住「颱風是天氣系統自己開的」，切回 clear/rain 時只關自己開的，不誤關使用者手動從 Layers 面板開的颱風。

## 5. 霧距離 vs 霧顏色：兩條路徑

`scene.js` 的 `tickView()` **每一幀**無條件把 `scene.fog.near/far` 設成 `params.fogNear/Far × fogScale`——這行本來就存在，且發生在 `layers.tickAll()`／`environment.tick()` **之前**。若讓 `environment.apply()` 直接寫 `scene.fog.near`，下一幀就會被 `tickView()` 蓋掉（兩個寫入者互搶,fog wall 忽近忽遠)。解法：`tickView()` 簽章加一個 `envFogMul` 參數（預設 1，不影響任何既有呼叫者），`index.js` 的 `tick()` 每幀傳入 `environment.getFogMul()`——霧的**距離**永遠只有 `scene.js` 一個寫入者，`environment.js` 只回答「這一刻的天氣要不要把霧壓近」。霧的**顏色**則沒有這個逐幀覆寫問題（沒人在幀迴圈裡寫 `fog.color`），純粹跟著 `apply()`（離散事件/節流）更新即可。

## 6. 更新時機與 on-demand render

- **離散變化**（seek/play/pause/setSpeed）：`environment.js` 自己訂閱 `timeStore.subscribe(cb)`（跟 `index.js` 既有的 `invalidate()` 訂閱是分開的兩個訂閱者），只要 `envAuto` 開著就整套重算一次——這條路徑**不看 `playing` 狀態**，暫停中拖時間軸一樣會移動太陽。
- **播放中連續變化**：`timeStore` 的 raw `subscribe` 播放中不會逐幀觸發（`docs/TIMELINE_DESIGN.md` §1.3），所以 `isAnimating()` 加一支 `(params.envAuto && timeStore.getPlaying())`，讓引擎的 render tick 在這個狀態下保持非閒置，`environment.tick(dt)` 因此每個活躍 frame 都會被呼叫；內部再自行節流到 ~250ms 才真正重算 suncalc + ramp（sky 貼相機的位置更新不節流，逐幀都做，因為鏡頭移動跟播放速度無關）。
- **靜態陰影模式**：`applyAuto()` 只有太陽方位角/仰角變化超過 0.5° 才呼叫 `stage.placeSunAt()`（連帶觸發 VSM `shadowMap.needsUpdate`）——否則播放中每 250ms 一次的節流 tick 會在陰影幾乎沒變的情況下重烘整張陰影貼圖。

**鐵則驗收表**：

| envAuto | weather | playing | renderCount |
|:---:|:---:|:---:|---|
| true | clear | 暫停 | **凍結**（`isAnimating()` 兩個新分支都 false） |
| true | clear | 播放 | 持續渲染（太陽緩慢移動） |
| true | rain/typhoon | 任意 | 持續渲染（`rainVisible` 分支恆真） |
| false | 任意 | 任意 | 跟改動前完全一樣（不受本次改動影響） |

## 7. 海面 shader（`region.js`）

`onBeforeCompile` 注入的 fragment 從三個寫死常數改成三顆新 uniform：

| 舊寫死值 | 新 uniform | 預設值（= 舊寫死值） |
|---|---|---|
| `vec3 rSky = vec3(0.8745,0.9020,0.8863)` | `uSkyColor` | 同左 |
| `vec3 rL = vec3(0.4145,0.3256,0.8496)` | `uSunDir` | 同左（驗算過：這正是 `sunDirection(64°, 19°)`——DEFAULT_PARAMS 的 sunAzimuth/sunElevation） |
| （無） | `uEnvTint`（乘在最終色） | `(1,1,1)` |

`getSeaEnvUniforms()` 把這組 uniform 物件（跟既有的 `uSeaTime`/`uRippleStrength` 同一包）交給 `environment.js`；`region.js` 本身完全不知道時間/天氣的存在，只是被動接受驅動——跟 `typhoon.js` 的 `applyLight()` 是同一種模式，只是這次驅動來源換成 environment 而不是直接讀 params。

## 8. 新圖層 `src/engine/rain.js`

相機跟隨的雨絲粒子場，`LineSegments` + 自訂 `ShaderMaterial`（不是 fat-line `LineMaterial`——見 §9 已知限制）。幾何蓋在 **單位局部空間**（-0.5..0.5 立方體），`tickView()` 每幀把整個 group 對齊到 `camera.position` 並用 `camDist × 0.6` 等比縮放——這是縮尺地圖（~480m/world-unit），固定世界尺寸的雨在拉遠時會消失、拉近時變巨物，用相機距離縮放讓雨柱視覺框架在任何縮放層級都維持一致大小。

Vertex shader 用 `mod(phase - uTime*uSpeed, 1.0)` 讓雨滴在局部 Y 軸循環下落，`uWind` 控制傾斜方向（`WIND_BY_WEATHER` 表：晴天 0、雨天小傾角、颱風大傾角，直接讀 `params.weather`，不經 `environment.js` 轉手）。密度改變（`rainDensity`）觸發整個 `BufferGeometry` 重建（新圖層 SOP 的「setData 換新 geometry」鐵則——density 是 attribute 陣列大小，不能原地改）。

Fog 用手刻公式（`fogColor`/`fogNear`/`fogFar` 三個 uniform 佔位，`material.fog=true` 後 three 的 `WebGLRenderer.refreshFogUniforms` 每次 render 自動從 `scene.fog` 灌值進來——**前提是這三個 key 要先存在於 material 自己的 uniforms 物件裡，否則 renderer 內部會對 `undefined.value` 直接炸掉**；GLSL 端手寫線性 fog blend，不依賴 three 的 `#include <fog_pars_fragment>` 巨集鏈）。

## 9. 已知限制

1. **Preetham 夜空無星空**：`Sky.js` 是白天大氣散射模型，太陽仰角 < -10° 直接隱藏退回純色背景（ramp 給的深藍），沒有星星/月亮貼圖——這是規格本身點名的已知取捨，Phase 2 才會考慮補星空。
2. **雨絲「粗細」不是真的線寬**：`THREE.LineSegments` 的 `gl.lineWidth` 在幾乎所有現代瀏覽器/GPU 上都被硬體 clamp 在 1px（WebGL 規格早就允許實作端這樣做），跟場景縮放無關。`rainDensity`/`rainIntensity` 因此改成驅動**密度**和**拖尾長度**（隨 camDist 等比縮放，見 §8），而不是逐像素線寬——視覺上仍然讀得出「雨勢變大」，但物理意義上不是真正的粗細變化。要做到真線寬需要換成 `LineSegments2`/`LineMaterial`（fat line）或 InstancedMesh billboard quad，Phase 1 判斷投報率不划算，先用最簡單可靠的作法。
3. **`typhoon.js` 的雲層光照不跟 envAuto 連動**：颱風雲的 `uLightDir` 仍然直接讀 `params.sunAzimuth/sunElevation`（`applyLight()` 沒有改），envAuto 開啟時雲層光源方向不會跟著 suncalc 走。刻意不動這個檔案（規格把它列為「抄的範例」而非「要改的目標檔」，且颱風雲本身多半靠自身色相/密度而非精準光照方向讀出立體感，暴風天里雲層維持明亮甚至更接近真實衛星雲圖的觀感）。
4. **Sky 的內建 tonemap/colorspace chunk 與 postprocessing 的 ACES 是兩層**：`Sky.js` 的 fragment shader 自帶 `#include <tonemapping_fragment>` + `#include <colorspace_fragment>`（假設直接畫到螢幕），而這個引擎的 `renderer.toneMapping = NoToneMapping`、真正的 ACES 在 `composer` 的 `ToneMappingEffect` 後製階段（`scene.js`）——Sky 那層 tonemap 在 `NoToneMapping` 下等同 identity，不會二次過曝，但顏色觀感仍建議實測調整（已在驗收階段目視檢查，未發現明顯偏色/過曝）。
5. **`hemiIntensity` 用加法不是係数**：見 §2，唯一偏離「強度=係數×基準值」規格字面的地方，理由同段落已記錄。

## 10. 檔案異動清單

| 檔案 | 動作 |
|---|---|
| `src/engine/environment.js` | 新增：ramp/weather/suncalc/Sky/場景驅動 |
| `src/engine/rain.js` | 新增：雨絲粒子圖層 |
| `src/engine/scene.js` | 新增 `placeSunAt()`、暴露 `hemi`、`tickView()` 加 `envFogMul` 參數 |
| `src/engine/region.js` | 海面 shader 三個寫死常數 → uniform，新增 `getSeaEnvUniforms()` |
| `src/engine/index.js` | 新 params（envAuto/weather/rainVisible/rainIntensity/rainDensity）、註冊 rain 圖層、建立 environment、HANDLERS 改線、`isAnimating()`/`tick()` 接線、`window.__exp.environment` |
| `src/app/components/panels/Settings.jsx` | 「環境 Environment」區塊：時段快捷、天氣 Segmented、Auto light Toggle |
| `src/ui/debugPanel.js` | `Environment` folder；`Light` folder 標題註記 envAuto 會蓋過它 |
| `package.json` / `package-lock.json` | 新依賴 `suncalc` |
