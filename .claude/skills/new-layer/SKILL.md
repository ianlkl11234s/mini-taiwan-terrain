---
name: new-layer
description: 在 terrain-art 新增一個 GIS overlay 圖層（農田、魚塭、道路、步道…）。完整 SOP：選資料 → bake → Layer 模組 → 註冊 → 驗證。當用戶說「新增圖層」「加 XX 圖層」「把 XX 放上 3D 地圖」時使用。
---

# 新增 3D 圖層 SOP

## 架構前提
- `src/engine/layers.js` 的 `LayerManager`：每個圖層實作統一介面 `build/update/tickView/setVisible/setStyle/describe`
- 註冊入口：`src/engine/index.js` 的 `layers.register` 迴圈——加一行即自動出現在 Layers 面板（`listLayers()` 動態渲染），註冊順序 = 繪製/更新順序
- 資料走 `public/layers/manifest.json` 延遲載入：圖層第一次開啟才 fetch（onActivate），失敗退 fallback、不阻斷

## 步驟

### 1. 選資料（派 gis-data-scout，不要自己翻 43GB）
先查 `../taipei-gis-analytics/docs/data-catalog/{theme}/{dataset_id}.md` 與成品的 `_manifest.json`。
現成候選與優先序見 `docs/PLATFORM_BLUEPRINT.md` §3b（步道最小先做；農田 386K polygon 要走 R2+PMTiles 或簡化聚合版）。

### 2. Bake（python3，派 pipeline-engineer）
照 `scripts/bake_layer_elevations.py` / `bake_region_*.py` 模式：
- 讀 analytics 成品（EPSG:4326）→ 篩選/簡化 → 離線烘高程 → 輸出 `public/layers/<name>.json`
- 在 `public/layers/manifest.json` 加條目
- 產物 >2MB → 上 R2、manifest 指 CDN URL（SOP 見 /data-pipeline skill）
- 腳本要冪等、印進度

### 3. Layer 模組（派 layer-builder）
參考同型圖層：線 = `polyline.js`（rail/rivers）、點 = `markers.js`（stations）、面/水 = `water.js`、周邊 = `region.js`、程序化效果 = `typhoon.js`、地形染色 = river sim 的 shader texture 模式。
- 垂直高度一律用 `metersToWorldY` / `drapeAt` helper，不要手刻公式
- 面資料三角化要傳 `THREE.Vector2`（plain object 會炸 `.equals`）

### 4. 註冊
`src/engine/index.js` 註冊迴圈加一行。

### 4b. 圖層列格式鐵則（Layers 面板，2026-07-11 用戶定版）
- `describe().rowLabel` 一律**「中文名 英文名」**，可帶簡短括號註記（如「等高線 Contour DTM20 (20m)」）；**禁止**動態數字（班次數/tile 數）與說明句——說明放 docs 或 pick popup，不放面板列
- 動態計數走 `describe().count` 欄位，不得混進 rowLabel
- 新圖層**必須**提供 styleSchema，最低要求：點層 `size`+`opacity`、線層 `width`+`opacity`、面層 `opacity`；顏色可調就加 `color`。宣告格式參考 `polyline.js` 的 `POLYLINE_STYLE`
- 長標籤靠 Row 的 ellipsis 截斷保底，但不要依賴它——標籤本來就該短

### 5. 驗證（/verify skill）
必查：
- 圖層開/關、樣式即時反應；縮放到山區看高程貼合（drape）
- 靜止 3 秒後 `window.__exp.renderCount` 凍結（on-demand render 沒破功）
- console 無新 error；fetch 失敗時圖層退化但 app 不掛

## 陷阱（全部踩過，不要再踩）
- **先空後填**：deferred layer 空 geometry 先被渲染 → three 記住 `_maxInstanceCount=0` → setData 後永遠畫 0 段。解法：setData 換新 geometry，或等資料到才建 mesh
- 未串流的 tile `sample()` 回 0m → 高程在 bake 階段離線烘，不要 runtime 取樣
- 即時資料 fetch 放 onActivate、失敗必須非致命（水庫 fallback ratio=1 模式）
- 大檔別 bundle：import JSON 會進 bundle，一律走 manifest fetch
