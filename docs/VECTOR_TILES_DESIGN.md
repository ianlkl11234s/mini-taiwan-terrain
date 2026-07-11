# ⑥ PMTiles 向量瓦片子系統 實作設計

> 2026-07-11 arch-reviewer（opus）產出、主迴圈核定。實作前必讀。
> 動機：OSM 全路網（55.5 萬邊）與農田（38.6 萬 polygon）的 PMTiles 已就緒（pulse 在用），terrain-art 缺渲染能力。此能力同時解鎖「農田單田點選」。
> 上游（CONFIRMED，讀過 PMTiles v3 header）：`osm_road_drive.pmtiles` 59MB / zoom 6-14 / layer `osm_road_drive` / 欄位 highway,name,ref,lanes,oneway,maxspeed,surface,bridge,tunnel；`ftw_fields_2025.pmtiles` 107MB / zoom 5-14 / layer `fields` / 欄位 field_id,area_ha,confidence_mean,source_tile。皆 tippecanoe 產出、tile 內容 gzip。

## 0. 架構定位
pulse 走 mapbox-gl + mapbox-pmtiles（硬依賴 mapbox-gl，不可沿用）。terrain-art 改用裸 `pmtiles` reader + 自解 MVT；內部照抄自家 `chunks.js` 模式（相機半徑 desired-set / LRU / 每幀 build 預算 / near-to-far），新增平行的 `VectorTileManager`，**不**塞進地形 ChunkManager（zoom/生命週期/mesh 型別不同）。

## 1. 依賴
`pmtiles`（^4.4.1，對齊 pulse）+ `@mapbox/vector-tile` + `pbf`，合計 ~45KB gz、純 JS 無 wasm。不引入 mapbox-gl/deck。
**CDN Range 快取（必做）**：Cloudflare 預設不快取 `.pmtiles` → `tiles.itsmigu.com` 要設 Cache Rule，否則每個 Range 請求回源。兩檔皆 < CF 512MB 單物件上限。

## 2. CORS / 部署
**不要跨站抓 pulse**（它走同源相對路徑無 CORS 保證）。`rclone copy` 兩檔到 `r2:terrain-tiles/vector/`（R2 CORS * / GET,HEAD 已開、原生支援 Range）。前端經 `VITE_TILE_BASE` 衍生或新增 `VITE_VECTOR_BASE`。驗收前 `curl -H "Range: bytes=0-99"` 確認 206 + CORS header。

## 3. 瓦片 → 網格管線（VectorTileManager，藍本 = chunks.js）
- **Zoom**：`vz = clamp(stage.lodZoom + 1, sourceMin, sourceMax)`。tippecanoe 已按 zoom 泛化，永不一次解碼全量；相機半徑 desired-set 封頂視野瓦片數（~30-60）
- **單瓦片流程**：`getZxy` → gzip 解壓（確認 lib 是否代解，Phase 1 spike）→ `VectorTile(new Pbf(buf))` → `loadGeometry()`（extent 4096、**y 軸向下要翻轉**）→ 世界座標線性內插（單瓦片內 Mercator 非線性誤差 sub-meter 可接受）
- **線**：按 highway class 分 3 寬度桶，每桶一個 `LineSegments2`（複用 polyline.js fat-line + 共享 LineMaterial + ctx.lineResolution），顏色 vertexColors
- **面**：`THREE.ShapeUtils.triangulateShape`（與 river_surfaces 同法）。**winding 陷阱**：MVT y-down 下外環 CW/內環 CCW，與 ShapeUtils 慣例相反——必須 signed-area 正規化 winding 並吸收 y 翻轉，否則破面/洞挖反。必寫單測
- **高程貼合**：逐頂點 heightAtWorld → metersToWorldY。**未載 DEM 回 0m 的教訓**：建瓦片前 `ensureTiles(footprint)` gate；`onChunksChanged` 時對受影響瓦片就地重寫 y（照 polyline.js applyVertical 手法，不重建 geometry）
- **LRU**：獨立 cap = 自身 desired.size×1.5（勿共用 DEM 的 setMaxTiles）；evict 時 geometry.dispose()
- **節流**：MAX_BUILDS_PER_TICK=2 / BUILD_BUDGET_MS=12（照 chunks.js）；z14 密集瓦片超預算 → Phase 3 逃生艙：解碼+三角化移 Web Worker（transferable）

## 4. 樣式（宣告式 layer config）
```
ROAD_STYLE = { motorway:{c,w:'major'}, trunk, primary, secondary, residential:{w:'minor'}, _default }
FTW_STYLE  = { fill:'#c9b063', edge:'#8a7a3a', alphaFrom:'confidence_mean' }
```

## 5. Picking
VectorTileLayer 以 THREE.Group 為 object3d；線用 faceIndex→segFeature 對照、面用 faceIndex→faceFeature 對照 → 既有 `pick(raycaster)` 介面回 {title, rows, worldPos}。road 顯示 name/ref/highway/lanes；ftw 顯示 field_id/area_ha/confidence。只對 live 瓦片 raycast。

## 6. On-demand render（不可破功）
瓦片到貨/build 完成 → invalidate；重貼合只在 DEM 覆蓋變動時（dirty flag）觸發，**嚴禁每幀無條件 invalidate**。相機靜止 + desired 不變 + queue 空 → 零活動。向量 LRU 與 DEM overzoom/動態快取上限互不干涉。

## 7. 分期與驗收
- **Phase 1**（最小可行：osm_road_drive 線渲染、無 pick、主線程解碼）：R2 206+CORS ✓ / Cache Rule HIT ✓ / 島景→貼臉道路貼地不卡 ✓ / idle renderCount 凍結 ✓ / 未載 DEM 區不沉海 ✓ / LRU 不 thrash ✓ / 零新 RPC 零憑證 ✓
- **Phase 2**（樣式分色分寬 + pick）：class 顏色正確 / 點路彈 name,ref,lanes / 與既有 draped 層無 z-fight（zFightLift）
- **Phase 3**（農田面）：winding 單測過、無破面 / 半透明 depthWrite:false、renderOrder 於 reservoir sheet 之下 / z14 build 不掉幀或已 Worker 化 / 點田彈 field_id,area_ha / 繪製順序 terrain < ftw < draped 線 < labels

## 8. 風險排序
1. z14 密集瓦片主線程解碼爆幀（build 預算 + 泛化封頂 + Worker 逃生艙）
2. DEM 未載 0m 沉海 pop（ensureTiles gate + 重貼合）
3. 記憶體（LRU + dispose，可控）
4. MVT winding/Vector2 陷阱（Phase 3 首要單測）
5. z-fight/繪製順序（zFightLift + renderOrder）
6. `.pmtiles` Cache Rule 漏設（上架即設）

## 9. 生態系連帶
零新 RPC、零 Supabase 依賴，純 R2 Range 讀取——對共用 DB 無風險，符合藍圖 L1 CDN 化方向。
