# Phase 3 視覺升級設計（2026-07-17）

> 沉浸模式路線圖第三階段（`docs/IMMERSIVE_MODE_RESEARCH.md` §六）：讓步行（Phase 2）與車廂視角（Phase 1）
> 從「原型」變「能對外展示」。三個獨立工作包：A 近景 Gerstner 海面、B 草地 instancing、C 近景地形細節。
> 零新依賴，純 Three.js shader / instancing。

## 全域鐵則（三包共同遵守）

1. **on-demand render 不可破功**：預設參數＋俯瞰視角下，靜止 3 秒 renderCount 必須凍結。
   新的 wall-clock 動畫比照 rain/typhoon 慣例：在自己 layer 的 `tickView(ctx)` 用 `ctx.dt` 推進時間 uniform，
   `isAnimating()` 只在「該效果實際在動」時才回 true（見各包規格）。
2. **參數歸零＝現狀重現**：每個新視覺參數拖到 0（或關掉 toggle）時，畫面與 main 分支 byte-for-byte 一致。
3. **SwiftShader 可攜**：fragment shader 禁用 dFdx/dFdy（沿用 region.js 海面波紋的解析式 slope 手法）。
4. **先空後填**：InstancedMesh 等「先空後填」物件，等第一次真的有資料才建 mesh（建了就給足 capacity，之後只動 `.count`）。
5. **尺度換算**：1 world unit ≈ 480.78 m（`hf.projection.K` = world-units/meter）；「公尺級」量一律
   `worldYScale(hf, params.demExaggeration)` / `metersToWorldY()` 換算，不寫死魔法數。
6. **新的 ctx 欄位**（已在 index.js 就緒）：`ctx.camGroundM`（相機離地公尺，DEM 未載為 Infinity）、
   `ctx.walkActive`（步行模式布林）。距離門檻一律用 `camGroundM`，不要自己算。

## 工作包 A：近景 Gerstner 海面（region.js 內擴充）

現況：海面＝單一 12000-unit 平面（1×1 quad、MeshBasicMaterial、fragment-only 波紋）。
480 m/unit 下真實波高在俯瞰是次像素——**遠景照舊**，升級只發生在近景。

新增「**近景波浪 patch**」：一塊高細分平面跟隨相機，低空才淡入。

- **Mesh**：`PlaneGeometry(4, 4, 224, 224)`（≈1.9 km 見方、頂點間距 ≈8.6 m），region group 內、與遠景海面同 datum
  （`metersToWorldY(hf, 0, ex)` + `zFightLift`，比遠景海面再多一級 lift）。`ShaderMaterial`（自訂，不必走 onBeforeCompile）。
- **跟隨**：patch 中心貼相機（或 walk 位置）XZ，**snap 到 0.5-unit 格點**（避免游泳感）；snap 時節流地重填
  per-vertex `aDepthM` attribute（`heightField.heightAtWorld` 取海床高，深度 = −h；tile 未載視為深水）。
  一次 snap ≈ 5 萬次取樣，需 budget（一幀最多填一部分或整批 <10 ms 實測拍板）。
- **Gerstner**：4 波（波長 35–160 m、方向散開、steepness 總和 <1 防自交），振幅公尺 × `worldYScale` 換算；
  vertex shader 位移 + 解析法線。
- **淺水行為**：`amp *= smoothstep(0, 8, aDepthM)`（岸邊浪衰減、不切進沙灘）；
  岸邊泡沫帶（depth < 2 m）＋ 浪峰泡沫（法線 y / 相位 crest）＝白色混入。
- **深淺色**：0–40 m 深度 mix 淺色→深色，疊在既有海色（`params.regionSeaColor`）上。
- **光照**：直接**共用** region 既有 rippleUniforms 的 `uSkyColor/uSunDir/uEnvTint` 的 **同一個 .value 物件參考**
  （patch material uniforms 指向同物件）→ environment.js **一行都不用改**，日夜/天氣自動生效。
- **淡入淡出**：`ctx.camGroundM` 800 m→2000 m 間 alpha 淡出（俯瞰永遠看不到一塊方形）；patch 邊緣（最外 15%）
  radial alpha 衰減融入遠景海面，藏接縫。
- **遮罩**：共用遠景海面的 land/sea mask 貼圖（world→mask UV 換算），陸地上 discard。
- **時間**：共用 `uSeaTime`（同一 uniform 物件），既有 `seaAnimated && regionVisible` 的 isAnimating 分支已涵蓋，
  **不新增 isAnimating 條目**。
- **參數**（進 DEFAULT_PARAMS ＋ region `describe()` styleSchema）：`seaWaveHeight`（公尺，預設 1.2，0＝關）、
  `seaWaveChop`（0–1，預設 0.6）、`seaFoam`（0–1，預設 0.7）。`seaWaveHeight = 0` 時 patch 直接不可見（回現狀）。

## 工作包 B：草地 instancing（新檔 src/engine/grass.js）

參考 Codrops FluffyGrass 思路（chunked InstancedMesh），但幾何全程序化、無貼圖。

- **幾何**：一叢 = 3–5 片彎曲葉片（每片 2–4 三角形）merge 成單一 blade-tuft geometry；風格化尺寸 2–3 m 高
  （eye height 12 m 下比例合理）。單一 `InstancedMesh`，capacity 40,000（`grassDensity` param 控制實際用量）。
- **分格生成**：0.5-unit（≈240 m）方格、半徑 ≈1.5 unit 環繞 anchor（walk 時＝walk 位置，否則 controls.target）。
  cell 進入範圍才生成（**每幀最多處理 1–2 個 cell**，防 hitch）；離開回收。
  以 cell 座標做 deterministic hash 佈點（穩定、可重現，不用 Math.random）。
- **佈點過濾**：`tileResident` 為真才放；`heightAtWorld` ≤ 0.5 m（海/灘）不放；坡度 > 35°（鄰點採樣估）不放；
  海拔 > 3000 m 不放；距離 anchor 越遠密度衰減。
- **顏色**：海拔漸變綠色系 + per-instance hash 明度抖動，別跟地形 ramp 打架（偏黃綠、飽和度低）。
- **風吹**：vertex shader `uGrassTime` 擺動（葉尖權重），風強度接天氣：晴 0.3 / 雨 0.7 / 颱風 1.6
  （rain.js 有 export 的 WIND_BY_WEATHER 可參考或 import）。
- **顯示門檻**：`ctx.camGroundM < 1500` 才生成/顯示，之上全部隱藏並停止動畫。
- **isAnimating**：index.js 加一行 `(params.grassVisible && grassLayer.isAnimating())`——
  layer 內 `isAnimating()` = 可見 && 有 instance && 在距離門檻內。俯瞰時必為 false（idle 凍結不破功）。
- **參數**：`grassVisible`（預設 true——俯瞰無感、近景即所見）、`grassDensity`（0–1，預設 0.6）、
  `grassHeight`（公尺，預設 2.2）。Layers 面板走 `describe()` styleSchema 自動生成。
- **frustum**：instanced mesh `frustumCulled = false`（範圍就在相機周圍）或每次重建更新 boundingSphere，擇一並註明。

## 工作包 C：近景地形細節（terrain.js onBeforeCompile 注入擴充）

20 m DEM 近看是「樓梯狀山坡」——用解析式 procedural detail normal 遮。

- **注入點**：既有 `material.onBeforeCompile`（terrain.js:79-262）內擴充 fragment；
  在 `#include <normal_fragment_maps>` 之後擾動 `normal`。
- **雜訊**：world-space XZ 的 value noise **含解析導數**（2–3 octaves，特徵尺度 ~3–15 m），
  純 ALU、無貼圖、無 dFdx。用導數直接建切平面擾動。
- **距離淡出**：以 `cameraPosition` 與 `vWorldPos` 距離：< 500 m 全強度 → 2 km 歸零（俯瞰 byte-for-byte 不變）。
- **輔以 albedo 微變化**：同雜訊低頻分量對 `diffuseColor` 做 ±3% 明度抖動（可選，若打架就拿掉）。
- **參數**：`terrainDetail`（0–1，預設 0.6，0＝完全現狀）。uniform 進 `terrain.mapUniforms` 慣例，
  HANDLERS 一行 live 更新（不是 rebuild key）。
- **靜態效果**：無時間項，不碰 isAnimating。

## 驗收（整合後由主迴圈執行）

- [ ] 俯瞰預設視角：畫面與 main 無可見差異；靜止 3 s renderCount 凍結
- [ ] 步行模式海邊：波浪起伏、岸邊泡沫、深淺色；waveHeight 拖 0 回現狀
- [ ] 步行模式山坡：草地環繞、風吹擺動、坡度/海拔過濾正確；地形近看有細節、遠看不變
- [ ] 天氣連動：颱風時草劇烈擺動、海面波高感知加大（uEnvTint 壓暗照舊）
- [ ] 六時段：夕陽/夜晚海面反射色正確（共用 uniforms 自動生效）
- [ ] console 零新 error；`npm run build` 過
