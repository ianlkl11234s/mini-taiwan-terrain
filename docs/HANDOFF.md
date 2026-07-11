# HANDOFF — 2026-07-12 session 交接

> 給下一個 session 的第一份讀物。搭配 `CLAUDE.md`（慣例）與 `docs/PLATFORM_BLUEPRINT.md`（藍圖）。

## 現況快照

- **main 與 origin 完全同步**：2026-07-11 sprint 全部經 PR #4 merge 上線（45+ commits），無未推變更。
- **部署狀態**：GitHub Pages 備線已開通並注入 `VITE_TILE_BASE`（`https://ianlkl11234s.github.io/mini-taiwan-terrain/`，完整可用不再缺圖磚）；Zeabur 主線 deploy 需用戶在 dashboard 確認有跟上（CLI 看不到）。
- **Cloudflare Cache Rule 已設**（用戶 2026-07-11 完成）：單一規則涵蓋 `*.pmtiles` + `/ships/trails/`，Edge TTL 7d ignore-origin，實測 HIT。**重烘 pmtiles 同名覆寫後要手動 Purge Cache**（或把 purge 加進上傳腳本，需 Cache Purge 權限的 API token）。
- **功能現況**（全部驗收過）：時間軸（lazy-clock timeStore）、台鐵 992 班+高鐵 212 班（全段涵蓋率 100%）、3D 車廂近景 LOD、跟隨鏡頭（delta-carry）、列車點選資訊卡、船舶 AIS（7 天 CDN 快照+RPC fallback）、海面淡波紋、真實比例尺（demExaggeration 預設 1.0）、海底地形預設開、Layers 面板格式鐵則。
- 設計文件 SSOT（opus 審定、動相關功能前必讀）：`TIMELINE_DESIGN.md`、`MARINE_DESIGN.md`、`FOLLOW_CAMERA_DESIGN.md`、`BATHYMETRY_DESIGN.md`、`VECTOR_TILES_DESIGN.md`。
- R2 資產：`terrain-tiles/bathy/`（8,096 磚，前端唯一磚路徑）、`terrain-tiles/vector/`（osm_road_drive.pmtiles 59MB + ftw_fields_2025.pmtiles 107MB）、`terrain-tiles/ships/trails/`（7 個日檔 2026-07-04~10）、`terrain-tiles/`（本島舊磚，舊版用）。
- bbox：117.8–123.5E / 21.0–26.5N（金馬澎+福建沿岸+巴士海峽）。
- 2026-07-11 已完成項明細（時間軸、列車二期全三項、切段點、Cache Rule、AIS、海面、比例尺）：見舊版 HANDOFF（git 歷史 `95777fe`）與 PR #4 描述。

## 未完成 Backlog（優先序供參，用戶隨時重排）

| # | 項目 | 脈絡 |
|---|------|------|
| 1 | **時序圖層二號：雨量/水位**（推薦下一個） | 時間軸/subscribeDate/CDN 快照模式全就位，這是地基的原始目的；資料 collectors 在收（`config/realtime_tables.yaml`）；接法照 MARINE_DESIGN 的 ships 模式 |
| 2 | **AIS phase 2** | ①快照 cron 化（現 7 天是手動烘，會陳舊——`bake_ship_trails.py` 已冪等，排程即可）②船種分色（per-type sets，車站模式）③即時船位（需 gis-platform 開 `get_ship_current` public RPC，上游先動）④跟隨船（follow.js 介面已預留 mmsi） |
| 3 | **顯示效能提升包**（2026-07-12 用戶新增） | 見下節專章 |
| 4 | OSM 步道圖層 | 卡上游：analytics 從 PBF 重抽全台 walk network（現有萃取只有 9 城市）；OSM 無 sac_scale 難度標籤 |
| 5 | 生態系 P1：Supabase rate limit / Spend Cap | 全生態系缺口（gis-platform 動手，與 pulse 一起解）；**AIS 上線後前端 RPC 面變大，急迫性升高**；藍圖 §7 L5 |
| 6 | 澎湖 DTM 相位對齊 | bathy 磚 ~3m 微漂移；下次重烘用金門同款 `-te` 手法一併修（analytics `docs/data-catalog/base_map/dtm_20m_kinmen.md`） |
| 7 | 綠島/龜山島 DEM 補洞 | 主 DEM 兩島 nodata；分幅版 dataset 35430 可能有 |
| 8 | 灌溉全量版（3.4MB）上 R2 | 現行 repo 內為簡化版；備案 B 參數在 `scripts/bake_irrigation.py` 回報中 |

## 顯示效能提升包（backlog #3 專章，實作前先 profile 真 GPU）

> 原則：on-demand render 鐵則已把「靜止成本」壓到零，剩下的戰場是**連續渲染時的每幀成本**（列車/船舶播放中、海面波紋開啟時）。按 CP 值排序，a/b 普惠低風險先做，c/d/e 需 profile 佐證再動。

| 子項 | 內容 | 預期收益 / 風險 |
|------|------|----------------|
| a. **動畫幀率上限** | ambient 連續渲染（列車/船/海面）時把 RAF 節流到 30fps；使用者互動（orbit/zoom/pan/tween）瞬間恢復全速 | GPU 成本直接砍半；低風險，地圖引擎常規手法 |
| b. **DPR 上限＋動態解析度** | `renderer.setPixelRatio` 上限 2（Retina 3x 螢幕是 9 倍像素成本）；進階：動畫/互動中降 0.75–1x，靜止前補一幀全解析度 | 高 DPI 裝置大幅減負；注意 idle 補幀保銳利度 |
| c. **向量瓦片解碼移 Web Worker**（原 backlog 併入） | z14 密集瓦片主執行緒解碼卡幀；`VECTOR_TILES_DESIGN.md` §3 已有方案 | 消除縮放卡頓尖峰；壓測 56-84fps 未觸發，放大鏡頭+慢 GPU 才有感 |
| d. **海面 overdraw 審計** | 海面板 `alphaTest` 令 early-Z 失效（opus 審查確認）：被地形遮住的海像素仍跑 fragment（含波紋 sin×3）。評估 depth pre-pass／海域裁剪 mesh／idle 換便宜材質 | 全螢幕級 fragment 節省；動遮罩機制要小心（MARINE M1 教訓） |
| e. **ships trail 記憶體 → typed array** | 每日 1.1–1.4 萬艘 ×10–20 萬點常駐 JS 物件陣列；轉 typed array 降 GC 壓力與記憶體 | 記憶體減半以上；純資料結構改動，改動面在 ships.js 核心 |
| f. **後處理鏈審計** | 盤點 scene.js composer 的 pass 清單，動畫模式停用昂貴 pass（若有 bloom/AO 類） | 視 pass 而定；先盤點再說 |
| g. farm/river_sim 8192 貼圖 vs 低階 GPU（原 backlog 併入） | SwiftShader 自動縮圖、真 GPU 16384 通常無虞 | 觀察即可，暫不動 |

## 開發慣例備忘（跨 session 有效）

- 派工必指定模型（haiku 盤點 / sonnet 實作 / opus 設計與重大審查），主迴圈只分派驗收
- **會動 `src/engine` 的實作棒走 git worktree 隔離**；環境設置見 `.claude/skills/verify/SKILL.md`（tiles 為實體目錄含 bathy symlink——相對 symlink 深度不夠時用絕對路徑；worktree 內 build 前記得移掉 tiles symlink 否則 vite 會嘗試複製整個磚目錄）
- 驗證分級：shader/部署/跨 repo 才雙道（實作自驗+opus 終審），一般圖層煙霧測試即可
- **子代理收尾嚴禁寬 pattern `pkill -f`**（兩次教訓）；本機有並行 session 會劫持共用 agent-browser daemon——實作棒改用獨立 Chrome + `--remote-debugging-port` + 專屬 `--session`
- 用戶 dev server 慣用 port 6015（`gis-up` 清單目前登記 6007，尚未改）
- 列車資料契約：`train_tracks.json` 弧長=EPSG:3826 真實公尺；part key=`tra_00..30`（切段點重縫後 37→31 parts）；`dep_sec_of_day`=Asia/Taipei 當日秒；`rail_lines.json` 的 `meta.partCount/vertexCount` 已過期（無程式讀取）
- 高鐵資料契約：schema 同台鐵；part=`thsr_00` 南下/`thsr_01` 北上（鏡射走廊）；**方向判定=整班「起點 ratio < 終點 ratio」**（bake `match_thsr_track_to_part()` 與前端 `resolveCorridorPart()` 同規則，改一邊必改另一邊）；時刻表源=pulse 快照 2026-02-18
- 船舶資料契約：CDN 快照 `{VITE_TILE_BASE}/ships/trails/{YYYY-MM-DD}.json`＝`{meta, trails:[{mmsi, ship_type, points:[[lat,lng,ts]]}]}`（ts=epoch 秒遞增、已過濾 >40 節跳點）；非快照日 fallback `get_ship_trails` RPC（分號字串格式、需自行過濾）
- 圖層列格式鐵則（`/new-layer` skill §4b）：rowLabel 嚴格「中文名 英文名」、禁動態數字、新圖層必須 styleSchema（點層 size+opacity 起跳）
