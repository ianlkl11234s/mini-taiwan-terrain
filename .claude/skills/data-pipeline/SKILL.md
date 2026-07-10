---
name: data-pipeline
description: terrain-art 的資料接入決策與跨 repo 資料流（analytics 成品 / data-collectors 即時表 / Supabase RPC / R2 CDN）。當用戶問「資料哪裡來」「接即時資料」「上 R2」「加 RPC」「跟 pulse 同步顯示」時使用。
---

# 資料接入決策樹

| 資料性質 | 做法 | 現有範例 |
|---------|------|---------|
| 靜態、bake 後 <2MB | 進 git：`public/layers/*.json` + manifest | rail 1.8M、stations、reservoirs |
| 靜態、大檔（PMTiles / 瓦片 / 大 JSON） | Cloudflare R2 + CDN（`tiles.itsmigu.com`），manifest/程式指 CDN URL | DEM 圖磚 292MB |
| 即時（分鐘~小時級） | Supabase `public.*` RPC + anon key，失敗 fallback 非致命 | 水庫 `get_reservoir_status_latest`（`src/engine/index.js` fetchReservoirRatios） |
| 時序（時間軸播放） | 按日切分 RPC `get_x_day(target_date)` + timeline 視窗 prefetch | pulse `freewayLoader.ts` 模式 |

## 上游位置速查
- **analytics 成品**：`../taipei-gis-analytics/data/processed/{theme}/{dataset}/`（EPSG:4326，附 `_manifest.json`）；清冊 `docs/data-registry.yaml`；文件 `docs/data-catalog/`
- **collectors 即時表**：清冊 `../data-collectors/config/realtime_tables.yaml`；production 實況 `config/cross_layer_map.yaml`（repo toggle 預設 false 是假象，線上 58 個在跑）
- **Supabase**（共用 project `utcmcikhvxnohbxchbrs`，schema 分工 realtime/reference/spatial/public）：**要新 RPC、改表、動 RLS → 去 `../gis-platform/migrations/` 開 migration**；前端禁直打 `realtime.*`
- RPC >1s 或 >10k rows → pre-aggregate pattern（表 + per-day refresh + pg_cron + 薄 SELECT RPC），範本 `../data-collectors/docs/sql/matview_*.sql`

## R2 上傳 SOP
- bucket `terrain-tiles`，custom domain `tiles.itsmigu.com`（CORS `*` / GET,HEAD 已設）
- `rclone copy <dir> r2:terrain-tiles/<prefix>`（憑證在 `.env`，僅本機腳本用，禁入前端）
- **Cloudflare 預設不快取 `.json` / `.pmtiles`**：新副檔名要在 Cloudflare 補 Cache Rule，否則每請求回源（pulse 踩過）
- `VITE_TILE_BASE` 是 build-time 變數，改了要 Zeabur redeploy

## 從 pulse 移植的模組（接 Supabase / 做時間軸前必讀）
| 模組 | 路徑（`../mini-taiwan-pulse/`） | 用途 |
|------|------|------|
| resilient fetch | `src/lib/supabase.ts`（wrapper 段） | 全域併發上限 8 + FIFO + 30s timeout + retry×2(jitter)，防雪崩 |
| loader 範式 | `src/data/freewayLoader.ts` | rpc + withLoading + cachedByKey TTL 快取 |
| staticRpc CDN 快照 | `src/data/staticRpc.ts` | 低頻 RPC 改讀 CDN JSON，404 fallback 回真 RPC |
| External Time Store | `src/state/timeStore.ts` + `src/hooks/useTimeline.ts` | 時間軸；`currentTime` 禁進 React deps |
| layer gating | `src/lib/layerGates.ts` | tier 鎖層，fail-safe（RPC 失敗保持鎖定） |

## 兩邊同步顯示（terrain-art × pulse）
同一份資料要在兩邊出現：**資料只有一個上游**（同一個 RPC 或同一份 R2 資產），兩邊各自實作展示層，不複製資料檔。跨 repo 交接寫 `docs/handoff/<slug>.md`（沿用 analytics/pulse 慣例）。每加一個即時圖層，PR 要聲明「首載 +N 次 RPC、開啟後每分鐘 +M」，由 arch-reviewer 把關。
