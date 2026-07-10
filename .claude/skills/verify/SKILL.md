---
name: verify
description: 啟動並驗證 terrain-art app（dev server、tiles symlink、headless WebGL、engine debug handle）。改完引擎/圖層/UI 後的驗收流程。
---

# terrain-art 驗證 SOP

## 啟動
1. dev server 用 Bash `run_in_background: true` 跑 `npm run dev`（`(npm run dev &)` 子 shell 會被回收）。5173 被主 repo 佔用時 Vite 自動挑 5174。
2. **fresh worktree 必備 symlink**（少任何一個 → "generating terrain…" 永遠卡住）：
   - `public/tiles` → `../taipei-gis-analytics/data/processed/base_map/terrain_rgb/tiles`（gitignored）
   - `node_modules` → 主 checkout 的 node_modules
3. `.env` 沒有 `VITE_TILE_BASE` 是正常的：dev 吃本地 `/tiles`，線上才走 R2。

## 瀏覽器（headless 無 WebGL 的解法）
- agent-browser 內建 daemon **無 WebGL2**，兩條路：
  - SwiftShader：`agent-browser --args "--use-gl=angle,--use-angle=swiftshader,--enable-unsafe-swiftshader,--ignore-gpu-blocklist"`
  - 真 Chrome：以 `--remote-debugging-port=<port>` 啟動 Chrome，再 `agent-browser --cdp <port>`（圖層/視覺驗證建議走這條）
- SwiftShader 在遠景俯視海面會出現水平條紋——渲染 artifact，**不是 app bug**。

## Engine debug handle（DEV only）
`window.__exp` = `engine.debug`：
- `__exp.engine.setParams({...})`、`__exp.camera` / `controls` / `scene`
- `__exp.engine.heightField.projection.lonLatToWorld(lon, lat)`
- **on-demand render**：腳本改動後必呼叫 `__exp.invalidate()` 才會重繪
- 效能驗收：靜止 3 秒後 `__exp.renderCount` 必須凍結

## 驗收清單
- [ ] 地形正常載入（沒卡在 generating terrain）
- [ ] 改動的圖層：開/關、樣式調整即時反應；山區檢查高程貼合
- [ ] idle renderCount 凍結（GPU 歸零）
- [ ] console 無新 error / warning
- [ ] 資料 fetch 失敗時優雅退化（斷網模擬），app 不掛
