# HANDOFF — 2026-07-12 隔夜衝刺交接

> 給下一個 session 的第一份讀物。搭配 `CLAUDE.md`（慣例）與 `docs/PLATFORM_BLUEPRINT.md`（藍圖）。
> 上一版（2026-07-12 晨間基線）見 git 歷史 `61474e0`。

## 現況快照

- **本輪產出（2026-07-12 深夜隔夜衝刺 + 晨間驗收微調，14 commits）**：**PR #5 已由用戶 merge 上線（merge commit `d06cc7d`）**，main 與 origin 同步，本輪兩個 agent worktree 已清除。opus 全 diff 終審：無 MUST-FIX；兩項 SHOULD-FIX 一項已修（見下）、一項記 backlog #5。
- **近景 UX 包**（`b78bb43`，用戶晨間驗收時追加）：①`minDistance` 0.25→0.08（可貼近至 ~40m 看建物街景）②貼地移動提速——keypan 加 `KEYPAN_FLOOR_DIST=0.35` 速度下限＋`controls.panSpeed` 近距動態補償（camDist≥0.35 恆為 1，遠景手感不變）③電塔/風機各加「點位 Dots」set（THREE.Points 全量常駐、2-3px 固定 screen-size、無近景閘門）——遠景看分佈、推近 3D 浮現；電塔/風機順勢改為 onActivate/sets 啟用模式（移除 visibleParam 死代碼）。
- **效能包 a+b 上線**（原 backlog #3 的 a/b 子項）：ambient 動畫（列車/船/海流/海面）RAF 節流 30fps＋DPR 降 1.0；互動/tour/flyTo 全速；idle 補幀照舊。實測：ambient 97→29.7fps、拖曳恢復 78-113fps、idle renderCount 凍結。**killswitch：`src/engine/index.js` 的 `const PERF_THROTTLE`（≈L514），設 false 一鍵回舊行為（需 rebuild）**——用戶指示：若影響觀感就關。follow 跟隨模式歸類 ambient 吃 30fps（刻意取捨，註解有標）。
- **八個新圖層全部上線**（各 layer 驗證過：pick/styleSchema/idle 凍結/build）：
  | 圖層 | 資料 | 去向 | 備註 |
  |---|---|---|---|
  | 建物 Buildings | GBA 152 萬棟 z13-16 vector PMTiles 139.8MB | R2 `vector/buildings_3d_taiwan.pmtiles` | extrusion＋高度色帶；**CC BY-NC 4.0 署名（GBA © TUM, Zhu et al. 2025）走 pick 彈窗＋describe**；`BUILDINGS_RADIUS_FRAC=0.42`；只有本島 |
  | 步道 Trails | 6 源 7,339 條 PMTiles 2.6MB | R2 `vector/hiking_trails.pmtiles` | **取代**舊 49 條 bake（polyline 版已退場）；trailsColor 預設 #ff7a1a（與 roads #e8722c 同色系，用戶可再定奪） |
  | 機場/港口/消防/急救醫院/警察 | 57/277/717/232/2,065 點 | git `public/layers/*.json` | ports 5 sets、hospitals 4 sets（急救醫院 232≠目錄帳面 252，dedup 差異已在 bake docstring） |
  | 空域 Airspace | 限航 29＋危險 2（**源資料無禁航 P**） | git 19.6KB | floor/ceiling 立體圍籬；ceiling clamp 10000m（影響 9 區） |
  | 電塔/風機 | 26,589塔＋812機 | git 1.75MB/51KB | InstancedMesh＋近景雙閘門（cap 3000）；電壓資料稀疏（8/26589 有標）幾乎全 25m 桶；葉片靜態（旋轉 TODO） |
  | 醫療設施 Medical | 全國健保機構 29,896 點（醫院 451/診所 21,765/藥局 7,680） | R2 `layers/medical.json`（2.83MB） | 真源=`nhi_institutions_geocoded.geojson`（42MB），**不是** poi/medical/medical/（那是 NLSC 社福設施）；與急救醫院層並存不同 id |
  | 海流 Ocean Currents | CMEMS UV 流場 PNG 快照（valid_at 2026-07-02） | R2 `climate/currents_latest.{png,json}` | CPU 平流 2000 粒子；`FLOW_SCALE=9000`、`HDR_BOOST=10`（ACES tonemap 會壓暗 additive 色——重要 gotcha）；設計文件 `docs/OCEAN_CURRENTS_DESIGN.md`；黑潮可辨但偏淡（backlog #4） |
- **opus 終審修正已入**（`0eaa3f2`）：①海流 isAnimating 加 `currentsFetch.loaded` gate（否則 CDN fetch 失敗會永久 30fps 空轉——唯一違反 on-demand 鐵則的路徑）②medicalSize/medicalOpacity 補進 DEFAULT_PARAMS。
- 合併後互動實測：海流 ambient 30.04fps／DPR 1.0，拖曳 78.3fps 全速；**海流開著時互動 DPR 維持 1.0 不回 1.5**（避免手勢中 buffer 重配，效能包註解明講的取捨）。
- 本 diff **零新增 Supabase RPC／零 DB 負載**——所有新資料是靜態 CDN/git。
- 設計文件 SSOT：`TIMELINE_DESIGN.md`、`MARINE_DESIGN.md`、`FOLLOW_CAMERA_DESIGN.md`、`BATHYMETRY_DESIGN.md`、`VECTOR_TILES_DESIGN.md`、**`OCEAN_CURRENTS_DESIGN.md`（新）**。

## 用戶手動項狀態

1. ~~PR merge 拍板~~ ✅ 已 merge（`d06cc7d`，2026-07-12 上午）
2. ~~Cloudflare Cache Rule 補涵蓋~~ ✅ 已設並實測（規則現為 `host eq tiles.itsmigu.com AND (pmtiles OR /ships/trails/ OR /layers/ OR /climate/)`；medical.json MISS→HIT、currents PNG REVALIDATED→HIT 皆驗證過）
3. **Zeabur dashboard 確認 redeploy**（無新環境變數）——未確認
4. 目測定奪（開放中）：trailsColor 橙是否要改（與 roads 同色系）；海流視覺強度是否要加強（backlog #4）；電塔/風機 dots 的大小顏色（現 2-3px，塔 `#5c6670`/機 `#29b6d8`）；效能包 30fps 觀感（不滿意 → `PERF_THROTTLE=false`）

## 未完成 Backlog（優先序供參，用戶隨時重排）

| # | 項目 | 脈絡 |
|---|------|------|
| 1 | **AIS 快照 cron 化**（方案已設計，用戶延後） | 本機 launchd 每日 09:30 跑 `bake_ship_trails.py`（rclone 憑證已在本機、日檔冪等、Mac 醒來補跑；collectors 側要搬憑證故不選）。海流快照每日刷新（pulse 上游 → R2 拷貝）可併同一個排程解 |
| 2 | **時序圖層：雨量/水位**（資料盤點已完成，用戶延後） | rain_gauge ~1,306 站（`get_rain_gauge_day`，每站每小時）＋river ~332 站（`get_river_water_level_day`）皆在線；接法照 MARINE_DESIGN ships 模式；降水 PNG 柵格另議 |
| 3 | 效能包 c–g 殘項 | c 向量瓦片解碼移 Worker／d 海面 overdraw 審計／e ships trail typed array／f 後處理鏈審計／g 8192 貼圖觀察——原專章見 `61474e0` |
| 4 | 海流視覺強化 | 加粒子數／Line2 加寬／獨立非 tonemap composite pass（設計文件有候選）；快照過期顯示（valid_at 已 10 天） |
| 5 | 建物 redrape 納入分幀 budget（opus SHOULD-FIX） | 近景密集區平移時 `_redrape` 一次重掃 ~3M 頂點（20-60ms jank spike，互動全速不受節流保護）；roads/fields 同架構但頂點量差 10-50x |
| 6 | sets loader 吞錯不 rethrow → toggle 無法重試（既有缺陷） | stations/ports/hospitals/medical 全 sets 層同病：fetch 失敗後 `activated` 已 set，再切開關不重試，只能刷頁 |
| 7 | 生態系 P1：Supabase rate limit / Spend Cap | 沿舊 backlog #5；本輪零新增 RPC 無惡化 |
| 8 | 離岸風場 36 面／建物外島／澎湖 DTM 相位／綠島龜山島 DEM 補洞／灌溉全量版 | 小項集合：離岸風場面資料不吃點位 sets（airspace.js 是正確參考路徑）；其餘沿舊 backlog #6-8 |
| 9 | `bake_flow_accum.py`/`pilot_flow_accum.py` 的 TILES_DIR 缺 `bathy/` 段（潛在同 bug） | `bake_layer_elevations.py` 同 bug 本輪已修（高程查找靜默 fallback 0m）；這兩支未修（當時不在改動面） |

## 開發慣例備忘（跨 session 有效）

- 派工必指定模型（haiku 盤點 / sonnet 實作 / opus 設計與重大審查），主迴圈只分派驗收
- **會動 `src/engine` 的實作棒走 git worktree 隔離**；多棒序列任務可共用同一 worktree 同一 branch 鏈續（本輪五棒實證可行）；環境設置見 `.claude/skills/verify/SKILL.md`（build 前 tiles 目錄要暫移，vite 會 ELOOP/整目錄複製）
- **rclone 上 R2 必帶 `--s3-no-check-bucket`**（本機 key 無 HeadBucket 權限會 403）
- 量測/驗證用獨立 Chrome＋`--remote-debugging-port`＋專屬 `--user-data-dir`＋`--disable-backgrounding-occluded-windows`；量測時視窗保持可見；**嚴禁寬 pattern `pkill -f`**；用戶 dev server 慣用 6015，實作棒用 6220+
- 本機 dev 看 R2-hosted 圖層（海流/medical）要 `VITE_TILE_BASE=https://tiles.itsmigu.com npm run dev`
- **ACES tonemap gotcha**：HDR buffer＋ACES 會把 0..1 additive 色壓到近隱形——發光類疊加層要把顏色乘 HDR boost（海流用 10，見 currents.js）
- 測試時重複 navigate/reload 會累積 HMR 殘留（React error-boundary 洗版、`reading 'delete'`）——先用乾淨 Chrome profile 單次流程重跑排除，本輪三棒都遇過、都非真 bug
- 驗證分級：shader/部署/跨 repo 才雙道（實作自驗＋opus 終審），一般圖層煙霧測試即可
- 列車/高鐵/船舶資料契約沿舊版（git `61474e0` §慣例）：train_tracks 弧長=EPSG:3826 真實公尺、thsr 方向=起訖 ratio 規則、ships CDN 快照格式
- 圖層列格式鐵則（`/new-layer` skill §4b）：rowLabel 嚴格「中文名 英文名」、禁動態數字、新圖層必須 styleSchema
