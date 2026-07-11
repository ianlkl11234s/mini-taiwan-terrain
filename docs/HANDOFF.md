# HANDOFF — 2026-07-11 session 交接

> 給下一個 session 的第一份讀物。搭配 `CLAUDE.md`（慣例）與 `docs/PLATFORM_BLUEPRINT.md`（藍圖）。

## 現況快照

- **本地 main 領先 origin/main 35 個 commit，未 push、未發 PR**（用戶指示：修到一個程度再收）。全部經過驗收、`npm run build` 通過。
- 本 session 完成（時序）：步道圖層 → 階層面板+點選 popup 系統 → 山頂鑽地修復 → ③海平面 z-fight → ④澎湖擴圖 → ⑤海底地形（GEBCO）→ ①②農田 drape+灌溉渠道 → overzoom/快取/淡綠帶三修 → 金馬+福建擴圖 → 外島海岸線+南界 21.0 → **向量瓦片三期**（OSM 路網分級+點選、農田單田點選、投影錨點修復）→ **列車 MVP**（TRA 992 班時刻表光點）→ **時間軸**（見下節）→ **面板格式整頓**（rowLabel 鐵則落地、Row 防凸框、車站/點層 size+opacity 滑桿範本、Markers 列移除、海底地形預設開）→ **高鐵列車**（THSR 212 班，trains.js 工廠參數化雙實例）→ **列車點選資訊卡**（proximity pick，台鐵/高鐵通用）→ **船舶 AIS 圖層**（`ships.js` track 層，CDN 快照優先+RPC fallback，subscribeDate 首戰）→ **比例尺真實化**（demExaggeration 預設 1.0，滑桿可調回）→ **海面淡波紋**（region 海面板 onBeforeCompile 注入 fresnel/spec，opus 雙道審過，customProgramCacheKey 隔離）。設計 SSOT：`docs/MARINE_DESIGN.md`。
- 設計文件（opus 審定、實作前必讀）：`docs/BATHYMETRY_DESIGN.md`、`docs/VECTOR_TILES_DESIGN.md`、`docs/TIMELINE_DESIGN.md`。
- R2 資產現況：`terrain-tiles/`（本島舊磚，舊版前端用）、`terrain-tiles/bathy/`（8,096 磚，現行前端唯一讀取路徑）、`terrain-tiles/vector/`（osm_road_drive.pmtiles 59MB + ftw_fields_2025.pmtiles 107MB）。
- bbox 現況：117.8–123.5E / 21.0–26.5N（含金馬澎+福建沿岸+巴士海峽）。

## 時間軸（2026-07-11 完成）

pulse 風格時間軸控制列已上線，取代左下 TELEMETRY（TELEMETRY 收合為 FPS 膠囊，點擊展開，功能未刪）。

- **架構 = lazy-clock 變體**（設計 SSOT：`docs/TIMELINE_DESIGN.md`，opus 審定）：`src/state/timeStore.js` 時間永遠現算不用迴圈推進；UI 用 **epoch snapshot** 綁 useSyncExternalStore（裸 getTime 會無限重繪、快取時間數字會讓播放鈕卡住——都在設計 §5 陷阱）；live-follow 旗標吸收 suspend/resume 漂移
- 列車已改吃 `timeStore.getDaySeconds()`；`trainsTimeOffset` 已全面移除（時間軸 scrub 取代）
- on-demand render 四象限驗收過：列車可見+暫停、隱藏+播放都凍結 renderCount
- **之後的時序圖層（雨量、水位）都吃同一顆 store**：`subscribeThrottled`（著色）+ `subscribeDate`（跨日載資料，本期尚無消費者、未被實戰驗證）

## Backlog（優先序供參，用戶隨時重排）

| # | 項目 | 脈絡 |
|---|------|------|
| 1 | ~~時間軸~~ ✅ 2026-07-11 完成 | 見上節；設計 `docs/TIMELINE_DESIGN.md` |
| 2 | 列車二期：~~點選班次資訊卡~~✅、3D 車廂、**跟隨鏡頭** | 資訊卡 2026-07-11 完成；跟隨鏡頭無範本（v3/pulse 都沒做），需從零設計且不與 tour.js 打架 |
| 3 | ~~rail_lines.json 切段點維護~~ ✅ 2026-07-11 完成 | `scripts/fix_rail_cuts.py` 簡單路徑分解重縫，全段涵蓋 **84%→100%**、leg 98.7%→100%；幾何聯集不變（`verify_rail_geometry.py` 可重驗）、thsr byte-identical |
| 4 | OSM 步道圖層 | 需上游 analytics 從 PBF 重抽全台 walk network（path/footway/steps/track ~19 萬邊，現有萃取只有 9 城市）；OSM 無 sac_scale 難度標籤 |
| 5 | Cloudflare `.pmtiles` Cache Rule | **用戶手動**：dashboard 對 tiles.itsmigu.com 加 Cache Rule，否則每個 Range 請求回源（現況 cf-cache-status: DYNAMIC） |
| 6 | Worker 逃生艙（向量瓦片） | z14 密集瓦片解碼移 Web Worker；壓測 56-84fps 暫不需要，設計 §3 有方案 |
| 7 | 澎湖 DTM 相位對齊 | mosaic 網格相位未對齊造成 bathy 磚 ~3m 微漂移；下次重烘用金門同款 `-te` 相位對齊手法一併修（analytics `docs/data-catalog/base_map/dtm_20m_kinmen.md` 有完整記錄） |
| 8 | 綠島/龜山島 DEM 補洞 | 主 DEM 這兩島是 nodata（蘭嶼有值）；分幅版 dataset 35430 可能有 |
| 9 | 生態系 P1：Supabase rate limit / Spend Cap | 全生態系共同缺口（與 pulse 一起解），藍圖 §7 L5 |
| 10 | farm/river_sim 貼圖 vs 低階 GPU 8192 材質上限 | SwiftShader 會自動縮圖；真 GPU 16384 通常無虞，觀察即可 |
| 11 | 灌溉全量版（3.4MB）上 R2 | 現行 repo 內為 80m/470m 簡化版；備案 B 參數在 `scripts/bake_irrigation.py` 回報中 |
| 12 | ~~船舶 AIS 圖層~~ ✅ 2026-07-11 完成 | `ships.js` 上線（設計 `docs/MARINE_DESIGN.md`）；CDN 快照 bake（`scripts/bake_ship_trails.py` → R2 `ships/trails/`）視上傳結果補跑；phase 2=即時船位（需 gis-platform 開 `get_ship_current` RPC）、船種分色 |
| 13 | ~~海面動態~~ ✅ 2026-07-11 完成 | fresnel 波紋 onBeforeCompile 注入，opus 雙道審過；波紋強度/速度/開關在 Region 圖層樣式 |
| 14 | ~~比例尺校正~~ ✅ 2026-07-11 結案 | demExaggeration 預設 1.0（真實比例）；Mercator ±2% 緯度伸縮記為已知特性不重建（結論見 MARINE_DESIGN §0）；船位精度與比例尺無關（同投影自然精準） |

## 開發慣例備忘（跨 session 有效）

- 派工必指定模型（haiku 盤點 / sonnet 實作 / opus 設計與重大審查），主迴圈只分派驗收
- **會動 `src/engine` 的實作棒走 git worktree 隔離**（用戶常開著自己的 dev server，HMR 會吃到中間狀態）；worktree 環境設置見 `.claude/skills/verify/SKILL.md`（tiles 為實體目錄含 bathy symlink——相對 symlink 深度不夠時用絕對路徑）
- 驗證分級：shader/部署/跨 repo 才雙道（實作自驗+opus 終審），一般圖層煙霧測試即可；截圖抓到證據即停
- 用戶 dev server 慣用 port 6015（`gis-up` 清單目前登記 6007，尚未改）
- 列車資料契約：`train_tracks.json` 弧長度量=EPSG:3826 真實公尺；part key=`tra_00..30`（rail_lines 篩 tra 後的 index；2026-07-11 切段點重縫後 37→31 parts）；`dep_sec_of_day`=Asia/Taipei 當日秒；`rail_lines.json` 的 `meta.partCount/vertexCount` 已過期（無程式讀取，純資訊性）
- 高鐵資料契約：`thsr_tracks/thsr_schedule.json` schema 同台鐵；part=`thsr_00` 南下/`thsr_01` 北上（鏡射走廊）；**方向判定=整班「起點 ratio < 終點 ratio」**（bake 的 `match_thsr_track_to_part()` 與前端 `resolveCorridorPart()` 同一套規則，改一邊必改另一邊）；時刻表源=pulse 快照 2026-02-18（212 班）
- 圖層列格式鐵則已入 `/new-layer` skill §4b：rowLabel 嚴格「中文名 英文名」、禁動態數字、新圖層必須有 styleSchema（點層 size+opacity 起跳，範本=markers.js POINT_STYLE / trains.js TRAIN_STYLE）
