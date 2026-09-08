# terrain-art 2 改善方向與接手點

日期：2026-09-08。來源：使用者本次 terrain-art 審查對話，並明確要求記錄改善方式。
狀態：審查與建議已記錄；未實作、未部署。記錄不代表批准全部方案或授權發布。

## 目標與範圍

使用者希望完整探索臺灣陸地及海底地形，改善城市完整感與流暢度，並加入擬真海浪、人物／鏡頭移動及遊戲式山林。
暫將「迷你臺灣 POS」理解為 mini-taiwan-pulse、「terrain-art 2」理解為下一版；尚未獲明確名稱確認。Quiet Space 的海浪套件尚未找到或驗證。

方向：沿用 Three.js，建立全臺／都市／地面多尺度場景；全臺連續可探索，眼前局部精細串流。保留地圖藝術外觀，另提供寫實場景表現。程序化補景與實測資料必須可區分。

## 優先順序

1. **資料狀態與載入正確性**
   - `src/engine/dem.js`、`geo.js`：HTTP／解碼失敗、nodata、真正海面目前可能合併成 null／0m。保留有效、低解析父層、缺資料、失敗等狀態，錯誤不得當成真實地形。
   - `water.js:setData`：缺即時水庫比例使用 `?? 1`，需避免未知畫成滿水。若只是示意水面，明確標示。
   - `vectortiles.js:_fetchAndDecode` 完成只設 ready；`index.js:isAnimating` 未完整追蹤向量 fetch/build queue。完成時喚醒並排空建構工作，等待網路不需持續空轉。慢載入 idle 停住風險為靜態分析，尚未故障注入重現。
2. **完成效能管線**
   - 續接 `docs/VECTOR_PERF_PLAN.md`：局部 DEM-dirty redrape／分幀已完成，不重做；共用圖層幀預算、Worker 解碼與三角化、解碼快取與 GPU mesh 分離仍待完成。
   - 各向量 manager 各有 12ms budget，需總量控管與公平排程；單個密集 tile 仍可能超時。
   - 四層 DEM cache 改用整體記憶體預算；各 300 tile 約合 300 MiB 高度陣列，且容量會隨 desired set 增長，不是實測 heap 或固定上限。
   - 垂直誇張滑桿仍同步全層 redrape；合併連續輸入／分幀更新。
   - 海面 patch 移動時同步重採約 5 萬頂點，考慮分幀或快取。
3. **完成一個跨尺度試點**
   - 選都市＋水岸＋山林可連續探索範圍，先驗證俯瞰到真人步行，再擴全臺。
   - 尚未選定試點、目標硬體或 FPS／記憶體門檻，不將提案寫成已批准規格。
4. **逐步擴展全臺與 Pulse 整合**
   - 共用上游資料、entity ID、座標、時間、source/license/coverage/status；各自保有渲染實作。
   - Pulse 負責搜尋、篩選、監測；terrain-art 負責高度、地形及沉浸式空間探索。
   - 傳遞位置／時間／選取物件，避免整套移植 Mapbox/deck.gl；區域統計不能變成虛構建物事實。

## 三種近景能力

### 海岸

`region.js` 已有約 1.9km、224² 細分近景 Gerstner patch、解析法線、深淺色與近似泡沫；`water.js` 主要是水庫。
先補 shoreline-distance/SDF、沙灘／礁岸遮罩、濕沙與泡沫消散，再連接風浪／潮位資料並顯示 freshness、coverage。
目前 GEBCO 2025 為 15 arc-second（數百公尺）海底網格，適合海盆輪廓，不足還原港內或沙灘近岸；升採樣不會增加真實細節。近岸試點須另驗證高程／水深與垂直基準。

### 步行／人物

`walk.js` 已有 WASD、滑鼠視角、貼地與跳躍；預設約 40m/s、眼高 12m、跳躍 10m，刻意為巨人探索尺度。
保留巨人模式，真人模式另調眼高、速度、相機裁切，補坡度限制、建物／橋面碰撞、水體行為；第三人稱人物加動畫及鏡頭避障。現有 DEM 貼地不等於完整碰撞世界。

### 草地／森林

`grass.js` 已有約 4 萬株 instancing、風、坡度／海拔篩選及串流，尚非完整森林。
近處用立體草／樹幹／灌木和少量碰撞陰影，中距離簡化樹木合批，遠山用樹冠材質與輪廓；加入分 chunk LOD、地表材質混合、土地覆蓋／植群分布，避免城市長滿草。無資料處的植被是補景，不宣稱實測。
WebGPU 後續依 profiling 評估，不當作主執行緒瓶頸的替代解法。

## 都市完整感

補道路寬度與路面、人行道、公園／水岸地表、建築屋頂與立面、代表地標及少量街道物件；橋梁／高架不能一律貼 DEM。
`vectortiles.js` 缺建物高度會預設 3m，需保留推估標記。精細城市模型擴量時評估 3D Tiles/HLOD，但無須因此立即換引擎。

## 驗收與證據限制

- 本次主 agent `npm run build` 通過：98 modules、主 JS 約 1.86MB／gzip 581KB，存在大 chunk 警告。分流 review 曾並行 build 遇到 dist 清理 ENOTEMPTY；後續只允許一個 build owner。
- 本地瀏覽器確認玉山地形、臺北道路／建物載入，當次捕捉無 error/warning；這不代表全臺／線上／長時間驗收。
- 近景曾顯示 30 FPS；程式有 ambient 30 FPS 降載，不可直接視為 GPU 不足。
- 待驗：固定硬體與解析度的拖曳／跨區／縮放 p95/p99 frame time、long tasks、GPU draw calls/triangles、heap／資源回收；單層及多層 A/B；慢網路與失敗後恢復；無可見動畫與佇列時 renderCount 凍結。
- 真實海岸／人物碰撞／森林效果尚未 browser 驗收；資料來源精度、coverage、license、時效與部署須分別確認。
- 未變更應用原始碼；他人 `.claude/skills/*`、`.agents/`、`AGENTS.md` 改動保持原樣。

## 參考

- 既有設計：`docs/VECTOR_PERF_PLAN.md`、`docs/BATHYMETRY_DESIGN.md`、`docs/GRASS_RENDERING_RESEARCH.md`、`docs/WALK_MODE_DESIGN.md`。
- GEBCO：https://www.gebco.net/data-products-gridded-bathymetry-data/gebco2025-grid
- Three.js 海洋：https://threejs.org/examples/webgl_shaders_ocean.html
- Three.js 碰撞：https://threejs.org/examples/games_fps.html
- OGC 3D Tiles：https://www.ogc.org/standards/3dtiles/
