# terrain-art 平台藍圖（2026-07-10）

> 本文件是 terrain-art 從「地形藝術品」轉型為「生態系 3D 展示舞台」的總規劃 SSOT。
> 涵蓋：架構調整、資料來源盤點、時間軸設計、分階段路線圖、Agent 分工、高併發承載、資安盤點。
> 日常開發鐵則在根目錄 `CLAUDE.md`；本文件放「為什麼這樣設計」與待辦優先序。

---

## 1. 定位轉換

**現在**：真實地形（NLSC 20m DTM）+ 紙質 FUI 風格 + 少量 GIS 圖層（鐵路/河川/水庫/颱風/周邊），資料幾乎全靜態、bake 進 repo。

**目標**：地形 = 底圖概念，上面承載生態系資料的 3D 展示：
- 靜態圖資（農田、魚塭、道路、步道）
- 即時資料（水情、雨量、災害示警——與 pulse 同一上游、兩邊同步顯示）
- 時間軸（展示「這是不是當天的資料」，與 pulse 同設計）
- 程序化/開放性 3D 效果（颱風已示範此模式；煙火、事件脈衝等）
- 產出的 3D 場景/截圖與 pulse、info 互相連動（deeplink、同資料兩視角）

## 2. 目標架構

```
 政府開放資料 / OSM / TDX / WRA / CWA ...
        │
        ▼
 taipei-gis-analytics ──── 探索/ETL/bake（29 主題、78 資料集、_manifest 制度）
        │  成品: GeoJSON+Parquet+FGB+PMTiles (EPSG:4326)
        │
        ├────────────► gis-platform（Supabase migrations/RPC/RLS 的 SSOT）
        │                   ▲
        │                   │ 寫入 realtime.* / spatial.*
        │              data-collectors（65 collectors，Zeabur + HiCloud VM）
        │                   │
        ▼                   ▼
 ┌─────────────────────────────────────────────────────┐
 │              共用資料面（消費端只讀）                  │
 │  Cloudflare R2+CDN            Supabase public.* RPC │
 │  tiles.itsmigu.com            (anon key, RLS 保護)   │
 │  · DEM 圖磚 292MB             · 即時水情/雨量/示警    │
 │  · 大型圖層資產(PMTiles/JSON)  · 按日切分時序 RPC     │
 └───────────┬─────────────────────────┬───────────────┘
             ▼                         ▼
   terrain-art (3D 舞台)      mini-taiwan-pulse (2D monitor)
             └────── mini-taiwan-info (統計) ──────┘
```

原則：**資料只有一個上游**。同一份資料要在 terrain-art 與 pulse 同步顯示時，共用同一個 RPC 或同一份 R2 資產，各自實作展示層，不複製資料檔。

## 3. 資料來源盤點（「我可能會有哪些來源」）

### 3a. 已上線（terrain-art main）
海岸線、縣市界、鐵路 29 線、車站 515 站、河川（物理衍生 sim + 水面 + 標籤）、水庫 63 座（+Supabase 即時蓄水率）、颱風（純程序化）、周邊地圖（Natural Earth）。

### 3b. 現成可加——analytics 成品已備（優先序建議）

| 優先 | 資料集 | 量級 | 接入方式 |
|------|--------|------|---------|
| P1 | 登山步道 49 條 + 路標 3,407 點 | 165K + 1.2M | bake 進 repo（最小、視覺明確，先做） |
| P1 | 魚塭 aquaculture_ponds_osm | 15,241 polygon / 17M | 篩選+簡化後 bake，或 R2 |
| P2 | 農田 ftw_fields_2025 | 386,829 polygon / PMTiles 107MB | **R2 + PMTiles**（首個瓦片化向量圖層，需引擎支援分區載入或先做簡化聚合版） |
| P2 | 國道/快速道路 | 15M | simplify 後 bake |
| P3 | 省道 | 44M | 必須大幅 simplify |
| P3 | 養殖漁業生產區、灌溉渠道（宜蘭） | 1M / 8.4M | bake |
| P4 | 淹水潛勢 flood_hazard_wra | 4GB | 需選降雨情境+重切磚，屬大工程；對應 BACKLOG 的災害 drape |
| P4 | 土壤/作物適栽網格 | 66–599M | 地形著色 texture 化（走 river_sim.png 的 shader 染色模式） |

### 3c. 即時來源——collectors → Supabase（表清冊 `../data-collectors/config/realtime_tables.yaml`）

與地形展示天然契合的：水庫水情（已接）、河川水位、即時雨量/累積雨量柵格、水情燈號、土石流警戒、地震（事件脈衝效果的資料源）、颱風路徑（JMA/JTWC，可讓程序化颱風接真資料定位）、落雷。
次一級：空品、溫度網格（地形染色）、電力、船舶 AIS/航班（周邊海空域動態）。

### 3d. 效果類（無資料或事件驅動）
颱風渦旋（已上線，程序化 shader 模式已示範）→ 煙火（節日/事件觸發）、地震波紋脈衝、雨雪粒子。原則：效果掛在 LayerManager 之下當一種 Layer，可開關、吃事件參數。

## 4. 時間軸設計（採 pulse 既有架構，不重新發明）

- **核心：External Time Store**（照抄 `../mini-taiwan-pulse/src/state/timeStore.ts` + `hooks/useTimeline.ts`）：`currentTime` 存 module 變數不進 React state；三種訂閱粒度（每幀 / throttled / 跨日）；`rangeDays`/`windowDateKeys` 決定 prefetch 視窗，視窗外不打 RPC。
- 資料源分類沿用 pulse 的 `TimeType = track | snapshot | cyclic | event | static`（設計文件 `docs/TIMELINE_ARCHITECTURE.md`）。
- 時序 RPC 一律按日切分 `get_x_day(target_date)`，前端二分搜尋找當前快照。
- terrain-art 引擎是命令式的，比 pulse 更適合這模式：timeline tick 直接呼叫 layer 的 `tickView`/setData + `invalidate()`，完全不經 React。
- 「是不是當天資料」的 UI：沿用 pulse 的 wallClock 與資料時間分離設計，圖層 describe() 帶資料時間戳，面板顯示新鮮度。

## 5. 分階段路線圖

| Phase | 內容 | 主要執行者 | 驗收標準 |
|-------|------|-----------|---------|
| 0 | Harness（CLAUDE.md / skills / agents / 本文件）| 主迴圈 | 新 session 冷啟動即知生態系全貌 |
| 1 | 靜態圖層擴充：步道 → 魚塭 → 道路 → 農田 | gis-data-scout + pipeline-engineer + layer-builder | 每層過 /verify 清單；repo 增量 <2MB/層，大檔上 R2 |
| 2 | Supabase 存取層工程化：移植 resilient fetch + loader 範式 + staticRpc 快照；現有水庫 fetch 重構納入 | layer-builder | 併發上限/timeout/retry/快取生效；水庫行為不變 |
| 3 | 時間軸：timeStore 移植 + 第一個時序圖層（建議：雨量或河川水位染色） | layer-builder（架構由 arch-reviewer 先審） | scrub 不掉幀、視窗外零 RPC、idle renderCount 凍結 |
| 4 | 開放性 3D 效果：事件驅動框架 + 第一個效果（地震脈衝或煙火） | layer-builder | 效果為可開關 Layer；不破 on-demand render |
| 5 | monitor 化與 pulse 深度連動：deeplink 互跳、同資料兩視角、3D 截圖產出流程 | 跨 repo，先寫 handoff 文件 | 兩邊資料時間戳一致 |

Phase 1 與 2 可平行；3 依賴 2；4 獨立可插隊。

## 6. Agent 分工

- **主迴圈（Fable/Opus 級）**：理解需求、拆任務、派工（必指定模型）、驗收、跨 repo 決策把關。不下場寫大量程式碼。
- **gis-data-scout（haiku）**：資料盤點/查找，只讀清冊與 manifest，回結構化結論。
- **pipeline-engineer（sonnet）**：bake 腳本、簡化切磚、R2 上傳。
- **layer-builder（sonnet）**：Layer 模組、引擎接線、面板、loader。
- **arch-reviewer（opus）**：Phase 2/3 架構先審後做；涉及 Supabase/公開端點的 diff merge 前必審。
- 跨 repo 改動（analytics pipeline、gis-platform migration、collectors）由主迴圈確認後，到該 repo 的 session 執行——遵守各 repo 自己的 CLAUDE.md。

## 7. 高併發承載規劃

**現況體質**：terrain-art 是純靜態 SPA，重資產（292MB 圖磚）已在 R2 + Cloudflare CDN（egress 免費）。**前端承載幾乎無上限；瓶頸全在 Supabase。**

分層防線（由外到內）：

| 層 | 措施 | 狀態 |
|----|------|------|
| L1 CDN | 圖磚/圖層資產走 `tiles.itsmigu.com` 邊緣快取。**注意：Cloudflare 預設不快取 `.json`/`.pmtiles`，每種新副檔名要設 Cache Rule**（pulse 踩過此坑） | 圖磚✅ / 圖層 JSON 移 R2 時要補 Rule |
| L2 靜態快照 | 參數無關、更新頻率低的 RPC 改讀 CDN JSON 快照，404 fallback 回真 RPC（pulse `staticRpc.ts` 模式）。DB 負載 O(N 訪客)→O(1) | Phase 2 |
| L3 前端自律 | resilient fetch：全域併發上限 + timeout + retry(含 jitter) + TTL 記憶體快取；圖層資料 onActivate 才載入 | Phase 2 |
| L4 DB | RPC >1s 或 >10k rows 必走 pre-aggregate（表 + pg_cron refresh + 薄 SELECT），範本 `../data-collectors/docs/sql/matview_*.sql`；Supabase pooler 有 2min timeout | 新 RPC 時執行 |
| L5 止血 | Supabase Spend Cap + 用量告警；Cloudflare rate limiting rule | **待辦（全生態系共同缺口）** |

設計預算：每訪客首載 RPC 次數必須有界（目前 = 1，只有水庫）。每加一個即時圖層，在 PR 中聲明「首載 +N、開啟後每分鐘 +M」，由 arch-reviewer 把關。

## 8. 資安盤點

| # | 項目 | 現況 | 風險 | 對策 | 優先 |
|---|------|------|------|------|------|
| 1 | Supabase anon key 內嵌前端 | 設計如此（生態系慣例），靠 RLS + `public.*` RPC wrapper + REVOKE 保護 | key 本身非秘密；風險在後面幾項 | 新 RPC 一律過 arch-reviewer 檢查權限與回傳量 | 持續 |
| 2 | 伺服器端 rate limit | **無**（pulse 亦然，前端併發上限只是自律） | anon key 被刷 → DB 負載/費用暴衝 | Supabase Spend Cap + Cloudflare rate limiting；與 pulse 一起做（同一個 project，一次解決） | **P1** |
| 3 | debug 後門 | `?debug=1` 面板與 `window.__exp` 已 DEV-gate（2026-07 P0 修過） | 回歸 | release build 抽查 `__exp` 不存在 | done/監控 |
| 4 | `.env` 內 R2 寫入憑證明文 | 已 gitignore，僅本機腳本用 | 誤 commit、本機外洩 | 保持 gitignore；定期輪替；考慮改用 rclone 專用設定檔並縮小 token 權限（僅 bucket 級 write） | P2 |
| 5 | R2 CORS `AllowedOrigins: *` | 圖磚任何網站可引用 | egress 免費、實害低；主要是被盜連 | 可接受；若在意可鎖 Origin 白名單 | P3 |
| 6 | CSP / 安全 header | 無（Zeabur 靜態站；pulse 的 CSP 也還在 Report-Only） | XSS 時無第二道防線 | 部署層加 CSP：`connect-src` 鎖 supabase + tiles.itsmigu.com；`frame-ancestors` | P2 |
| 7 | 注入面 | 圖層資料（名稱/標籤）來自自家 bake 產物與 RPC | 低；但接入第三方即時資料後標籤內容不可信 | 禁 innerHTML 渲染資料欄位；React 預設轉義即可 | 持續 |
| 8 | 供應鏈 | npm lockfile + CI `npm ci` | 常規 | 保持 lockfile；新依賴進 PR 說明 | 持續 |
| 9 | 私有/敏感圖層 | 目前全公開 | 未來若有 gated 內容 | 直接沿用 pulse `get_layer_gates()` + DB REVOKE 模式（教訓：光下架 CDN 鎖不住，真斷源要 DB 層） | 需要時 |
| 10 | VM/collectors 憑證 | 不在本 repo | — | 本 repo 永不引入任何寫入型憑證到前端流程 | 持續 |

**單點提醒**：整個生態系共用一個 Supabase project——terrain-art 若把 DB 打掛，pulse 與 info 一起倒。這是把 L1/L2（CDN 化）放在最高優先的根本原因：讓 terrain-art 對 DB 的依賴趨近於零。
