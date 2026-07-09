# Backlog

最後更新：2026-07-08（收尾時盤點）

## 資料

- [ ] **補主峰資料**：`src/engine/data/peaks.json` 缺玉山/雪山/南湖大山/七星山等主峰——來源 `mountain_signal_points`（林業署訊號測試點）40 座已是極限。接 NLSC 三角點或百岳清單後直接換檔即生效（Tour/POI/marker 全自動跟上）
- [ ] **z8–z9 圖磚**（選做）：更遠視角備用；taipei-gis-analytics 的 `pipelines/base_map/terrain_rgb/01_encode_terrarium_tiles.py` 改 zoom 範圍重跑（~1 分鐘）

## 部署

- [ ] 圖磚（292MB，2,706 PNG）上 S3 或 Zeabur Volume，前端 `VITE_TILE_BASE` 指過去（README 有接線說明）
- [ ] 靜態站託管（GitHub Pages / Cloudflare Pages）；repo 已在 github.com/ianlkl11234s/mini-taiwan-terrain

## 功能

- [ ] **河川圖層覆蓋率不符直覺認知**（2026-07-09）：目前河線只保留縫合後總長 ≥10km 的水系（死支流 ≥2km 才留）、河面只取河寬 ≥20m／面積 ≥1.5萬 m² 的中下游段——與一般認知的「河川範圍」有落差，覆蓋不夠完整。改善方向：(a) 放寬篩選門檻或分 LOD 載入（拉近視角才 fetch 完整網絡，檔案拆 z 級）；(b) 改用水利署官方河川中心線圖資（含河名，可做標註與點選資訊卡）；(c) 河面吃 `water_river_polygons` 更全量（含高灘地/乾涸河床範圍）；(d) 台北都會區來源拓樸破碎（堤防化渠道），考慮該區另源或手工處理。相關參數在 `scripts/bake_layer_elevations.py` 的 rivers / river_surfaces 段
- [ ] marker sets 接真實資料集（溫泉 / 水庫 / 步道口等，taipei-gis-analytics 有現成 GeoJSON）——API 已就緒：`engine.setMarkerSet(id, {points, color, visible})`
- [ ] 災害 polygon drape（土石流潛勢 / 淹水潛勢）、即時雨量染色地形（接 data-collectors 資料源）——中長期
- [ ] Mobile / 窄螢幕版（pulse 有 MobileBottomSheet 模式可抄）

## 打磨

- [ ] 島景海面：目前是 datum 下的平白面，可考慮海色 tint / 海岸交界處理
- [ ] 西南月世界惡地在島景被密集等高線包成深色斑點（依 LOD 調 contour crowd fade）
- [ ] 島景峰頂 label 部分重疊；marker stem/cap 尺寸不隨距離縮放
- [ ] hud3d survey circles 固定在世界原點（玉山），島景下無意義
- [ ] 縣市界預設樣式（1.5px/0.5/#444）近景與 survey grid 難區分，可調預設
- [ ] procedural 模式的 cone/reticle 追蹤未進 React 主線（`?debug=1` 可用）
- [ ] tour 的 bank / lookAhead 參數僅 debug 模式可調
- [ ] 程式面 `setParams` 不 emit 'params'，Settings 面板不反映外部改動
- [ ] 單環 z10 模式 pan 時近處可能殘留 64² 外環 chunk（視距下無感）
- [ ] postprocessing composer 的 `glBlitFramebuffer` warning（上游既有）

## taipei-gis-analytics 側

- [ ] `docs/data-catalog/base_map/dtm_20m.md`、`contour_dtm20.md` 狀態段過時（仍寫「待 GDAL」，實際 2026-06-26 已完成）
- [ ] registry drift 1 筆（demographics.national_basics paths，既有問題非本專案）
