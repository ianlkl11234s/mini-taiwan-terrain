# ⑤ 海底地形（Bathymetry）實作設計

> 2026-07-10 由 arch-reviewer（opus）產出、主迴圈核定。實作前必讀。
> 前置依賴：④澎湖擴圖（含 ③b 新海陸遮罩）已完成。資料源：GEBCO 2025（public domain，15 arc-sec ≈ 450m，netCDF，陸海一體、負值原生）。

## 1. Bake 端（analytics repo，`--with-bathymetry` 模式）

**合成規則（優先 mosaic，非平均）**
- 陸 = NLSC 20m（含澎湖）置**頂層**；海 = GEBCO 2025 置**底層**，NLSC nodata 處讓 GEBCO 透出
- GEBCO 自帶陸地高程，但被頂層 NLSC 蓋掉，只在 NLSC nodata 處（離島 nodata 區、潮下帶）露出
- GEBCO bilinear 重採到 20m 輸出網格——水下平滑糊化可接受，不假造細節

**接縫**：v1 接受海岸線硬接縫（兩側乾淨跨 0m：NLSC 擁陸、GEBCO 擁海），落差被水面板/岸線遮住。目視太糟才升 v2（沿岸 1-2km 距離場羽化，預設不做）。

**Zoom 取捨（成本核心）— 採 Option B**
- GEBCO 原生 450m；z10≈140m/px 已 3× 過採，z13 海磚純屬無效升採
- **海磚只烘 z10/z11/z12，跳過 z13 海磚**；陸磚維持 z10-13
- 估計淨增 ≈ +778 磚 / ~+50MB（z10 +32 / z11 +136 / z12 +610）——**不是**藍圖早期估的 +3400
- app 預設 primaryZoom=12，z12 有海磚 → 預設視角能看到深度
- 輸出獨立目錄（如 `tiles_bathy/`）或旗標控制，與④的 tiles/ 分離以便回退
- manifest 補 GEBCO 2025 provenance + license note

## 2. 前端改點（file:line）

| # | 位置 | 現況問題 | 改法 |
|---|------|---------|------|
| 1 | `dem.js:43` | `v < -100 ? 0 : v` 誤殺真水深 | 門檻改深海之下（如 `v < -11100`）或顯式測 RGB(0,0,0)，只擋 encode-hole |
| 2 | `geo.js:27` | `TAIWAN_MIN_M=0` | **勿**單純線性改成 −4000（會壓扁陸地對比）。兩段式：保留 `TAIWAN_MAX_M=3952`，新增 `TAIWAN_SEA_MIN_M`（−4000），海平面 0m 釘在 ramp 座標 ~0.35：sea 佔 [0..0.35]、land 佔 [0.35..1] |
| 3 | `terrain.js:418` | `Math.max(0,(h-minH)/span)` 把水下頂點壓最淺色；直接放行負值會 `pow(負,0.85)=NaN` 黑碎片 | 頂點 tint 的 minH 擴到 sea min（`metersToWorldY(hf, seaMinM, ...)`），hn 自然落 [0,1]、去掉 Math.max。`uHeightRange`（terrain.js:349-351）同步餵擴域。**terrain.js:547-549 是 procedural 路徑，勿動** |
| 4 | `terrain.js:564-582` `rebuildRamp` | 4 stop 純陸地漸層 | 擴 stop：t∈[0,0.35] 海洋藍帶（深藍→淺藍→岸線白/沙），0.35 釘海平面，[0.35,1] 沿用陸地漸層；fragment hNorm 兩段 remap（~10 行 shader） |
| 5 | `region.js` 海面板 | opaque 板會遮住真海底 | `regionSeaOpacity`→0.4-0.6、`SEA_PLANE_M`→0；保留 land/sea 遮罩防水漫陸地；polygonOffset 可放鬆（海底已在負值不共面），③a 的 zFightLift 保留 |
| 6 | 模式切換 | — | tiles 一律烘 bathy（深度進 mesh）；runtime toggle 只換著色：rebuildRamp ± 海洋段 + uHeightRange remap + 海面板 opacity，`invalidate()` 一次，不重抓磚不加 RAF |

**datum 陷阱（重要）**：`freezeDatum()`（index.js:1150）取初始 5×5 core 均值，預設玉山全陸安全；若未來 load center 落近海，GEBCO 深度會拉低 datum 使整個世界下沉。緩解：datum 均值排除負值像素，或保證 datum 永遠陸地錨定。

## 3. 驗收清單

1. 解碼：東部外海深磚解出合理負值；陸磚正值不變；encode-hole 仍夾 0
2. 無黑碎片/NaN：z10-12 沿岸與外海平移，水下藍色分級、無黑三角（418 的 pow-NaN 不得回歸）
3. datum 穩定 + render 凍結：玉山 datum 不變（世界不下沉）；toggle 只變色不變高；invalidate 恰一次、idle renderCount 凍結
4. ramp：0m 釘岸線；陸地對比與無-bathy 目視一致；越深越藍暗
5. 海面板：半透明透出海底；遮罩裁岸線；掠角無 z-fight
6. LOD：z13 外海回退平 0m 的 pop 是否可接受，文件記錄
7. 磚預算：實測 ≈ +778 磚（Option B）；R2 增量 `--ignore-existing`；`.png` 免新 Cache Rule；先磚後前端
8. 資安/DB 回歸：零新 RPC、零憑證、`__exp` DEV-only
9. 接縫目視：太糟才升 v2 羽化
10. 平移到開闊海面顯示深度而非報錯；flyToLonLat guard 行為不變
