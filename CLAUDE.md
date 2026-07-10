# mini-taiwan-terrain (terrain-art)

台灣 3D 地形視覺化（Three.js + Vite + React 殼）。定位正在轉換：從單一「地形藝術品」變成 **mini-taiwan 生態系的 3D 展示舞台**——真實地形是底圖，上面疊生態系的開放資料圖層（農田、魚塭、道路、即時水情…），支援時間軸與程序化效果（颱風已上線，煙火等開放性內容在路線圖上）。完整藍圖見 `docs/PLATFORM_BLUEPRINT.md`。

## 生態系地圖（這些 repo 是一體的）

所有 sibling repo 都在 `../`（GIS/ 目錄下）。**動手前先想資料的上游在哪；上游先動、下游後動。**

| Repo | 角色 | 對本 repo 的意義 |
|------|------|-----------------|
| `../taipei-gis-analytics` | 資料探索第一站：29 主題 pipeline、78 個成品資料集、43GB data/ | 新圖層的資料來源。成品在 `data/processed/{theme}/{dataset}/`（EPSG:4326，GeoJSON+Parquet+FGB+PMTiles，附 `_manifest.json`）；清冊 SSOT = `docs/data-registry.yaml` + `docs/data-catalog/` |
| `../gis-platform` | Supabase schema / migrations / RPC 的 SSOT（生態系共用一個 Supabase project `utcmcikhvxnohbxchbrs`） | 要新 RPC、改表、動 RLS → 去那裡開 migration，不要在前端硬幹 |
| `../data-collectors` | 65 個 collector 24/7 收資料（Zeabur + HiCloud VM），寫入 Supabase realtime.* 與 S3。**repo 內 toggle 預設 false 是假象，線上實況以 `config/cross_layer_map.yaml` 為準（58 個在跑）** | 即時圖層的資料來源；表清冊 = `config/realtime_tables.yaml` |
| `../mini-taiwan-pulse` | 主力 2D 即時地圖（Mapbox+deck.gl+Three，265 圖層），往 monitor 發展 | **要抄的參考實作**：時間軸 `src/state/timeStore.ts`、韌性 fetch `src/lib/supabase.ts`、CDN 快照 `src/data/staticRpc.ts`、圖層鎖 `src/lib/layerGates.ts` |
| `../mini-taiwan-info` | 縣市統計儀錶板（themes yaml 驅動） | 跨 repo 同步矩陣在它的 `.claude/memory/CROSS_REPO.md` |

資料流：政府開放資料 → **analytics**（探索/ETL/bake）→ **gis-platform**（DB schema）← **data-collectors**（持續寫入）→ pulse / info / **terrain-art**（讀取展示）。大型靜態資產另走 Cloudflare R2 + CDN（`tiles.itsmigu.com`）。

## 技術棧與結構

- 引擎：純命令式 Three.js（`src/engine/`，入口 `index.js`，唯一被 UI import 的模組）；React 19 只是殼（`src/app/`）
- 圖層：`src/engine/layers.js` 的 `LayerManager`——統一介面 `build/update/tickView/setVisible/setStyle/describe`，在 `index.js` 註冊迴圈加一行即自動出現在 Layers 面板
- 資料載入：`public/layers/manifest.json` 延遲載入，圖層第一次開啟才 fetch，失敗退 fallback 不阻斷
- bake pipeline：`scripts/bake_*.py`（python3 + numpy/PIL/scipy）
- dev：`npm run dev`（5173，被佔會挑 5174）；build：`npm run build`（Vite）

## 資料接入三分法（鐵則）

| 資料性質 | 做法 | 範例 |
|---------|------|------|
| 靜態、bake 後 <2MB | 進 git：`public/layers/*.json` + manifest 條目 | rail、stations、reservoirs |
| 靜態、大檔 | R2（`tiles.itsmigu.com`）+ CDN，manifest 指 CDN URL | DEM 圖磚 292MB |
| 即時 / 時序 | Supabase `public.*` RPC + anon key，fetch 失敗必須有 fallback、非致命 | 水庫蓄水率 `get_reservoir_status_latest` |

- 前端只能用 anon key + `public.*` RPC wrapper；禁直打 `realtime.*` schema；service role key 與 R2 寫入憑證禁止進 bundle
- 接 Supabase 前先讀 `/data-pipeline` skill（含 pulse 可移植模組清單）

## 效能鐵則

- **on-demand render 不可破功**：靜止時 renderCount 必須凍結；程式化改動後呼叫 `invalidate()`
- 「先空後填」物件一律等資料到才建 mesh（deferred 空 geometry 會讓 three 記住 `_maxInstanceCount=0`，之後永遠畫 0 段）
- 時間軸（計畫中）一律採 pulse 的 External Time Store 模式；`currentTime` 禁止進 React deps（設計文件 `../mini-taiwan-pulse/docs/TIMELINE_ARCHITECTURE.md`）

## 開發流程

- 新圖層 → `/new-layer` skill（SOP + 資料候選 + 陷阱）
- 接資料 / R2 / RPC → `/data-pipeline` skill
- 驗收 → `/verify` skill（tiles symlink、SwiftShader、`window.__exp`）

## Agent 分工（派工必指定模型，主迴圈只做理解/分派/驗收）

| 任務 | 子代理（`.claude/agents/`） | 模型 |
|------|------|------|
| 找資料、盤點資料源 | gis-data-scout | haiku |
| 圖層 / 前端實作 | layer-builder | sonnet |
| bake / 資料處理腳本 | pipeline-engineer | sonnet |
| 架構 / 資安審查 | arch-reviewer | opus |

## 部署

- 主線：**Zeabur** 靜態站（build-time 注入 `VITE_TILE_BASE=https://tiles.itsmigu.com`）；圖磚在 R2 + Cloudflare CDN
- `.github/workflows/deploy.yml`（GitHub Pages）是備線，產物不含圖磚
- 改圖磚：`rclone copy` → `r2:terrain-tiles/`；改 `VITE_TILE_BASE` 需 Zeabur redeploy（build-time 變數）

## 資安

- debug 面板與 `window.__exp` 只在 DEV；不得在 UI 公告後門
- `.env` 含 R2 寫入憑證（已 gitignore）——僅本機腳本用
- 完整盤點、待辦與高併發設計：`docs/PLATFORM_BLUEPRINT.md`

## 系統環境

- Python 用 `python3` / `pip3`
- 上游 analytics 的重型地理處理（geopandas/tippecanoe）在 analytics repo 的 venv 做，本 repo bake 腳本保持輕依賴
