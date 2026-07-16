# 沉浸模式探索研究（2026-07-16）

> 起因：Threads 上 @gameenginedev.lucidum 的「100km² 開放地圖、C++ 引擎編譯 WASM 跑瀏覽器」demo。
> 問題：如何把 terrain-art 從「俯瞰的地形藝術品」變成「能走進去的地圖」——走上山、去海邊、搭火車看山海移動、海面與夕陽渲染。
> 方法：5 路平行研究（本地引擎盤點 / C++→WASM 生態 / 全球應用普查 / 技術深潛 / 引擎選型），本檔為整合結論。

---

## 一、那則 demo 的真相

- 作者是**台灣的 rendering/engine 工程師 Loïc Chen（陳明佑）**，個人站 lucidum.dev，GitHub `painfulexistence`。
- 引擎極可能就是他開源的 [AtmosphericEngine](https://github.com/painfulexistence/AtmosphericEngine)：heightmap terrain + dynamic tessellation + collision，OpenGL 主渲染、WebGPU 開發中，Emscripten 編譯 WASM、自動 fallback WebGL2。README 自陳 heavily AI-assisted。
- 這是**多年業餘累積的側專案**，不是短期衝刺產物。從零寫這種等級的引擎，業界共識是以「年」計（參照：把現成引擎 pmtech 移植到 web 就花了 20 個工作天）。

## 二、C++/WASM vs 留在 Three.js —— 結論：WASM 沒有捷徑

1. **瀏覽器裡拿不到多執行緒紅利**：SharedArrayBuffer 需要 COOP/COEP header，Godot 官方在 4.3 都踩坑投降退回單執行緒。C++ 換到 web 跟 Three.js 的處境幾乎一樣。
2. **demo 的真技術含量（quadtree/clipmap LOD、tile streaming、instancing）與語言無關**，Three.js 全做得到；terrain-art 的 tile pyramid + manifest 延遲載入本質上已是同一套邏輯的簡化版。
3. **換 C++ 放棄的比得到的多**：fetch/GLTF loader/npm 生態/除錯工具全要重造；Emscripten 的資源串流（preload-file 100MB 上限、IDBFS 大檔 OOM）是實際工程負擔。
4. **只有兩種情況 C++/WASM 才有不可替代性**：要跟桌面版共用 native codebase，或非用 compute shader 不可——後者其實是 WebGPU 的優勢，Three.js WebGPURenderer/TSL 也拿得到。
5. WebGPU 現況（2026 中）：三大瀏覽器都已出貨但不齊平，仍需 WebGL2 fallback，「只做一份」還不成熟。

## 三、世界上最接近想像畫面的東西（應用普查）

| 想像要素 | 最接近者 | 缺口 |
|---|---|---|
| 真實地形第一人稱行走 | TrailView/Terrender（蘇黎世大學 2025 論文，[Terrender 開源](https://github.com/crocij/terrender)） | 無公開 demo、非產品 |
| 大範圍真實地形瀏覽器效能 | [GeoFS](https://geo-fs.com)（CesiumJS + Cesium World Terrain） | 綁定飛機視角，無步行 |
| 沿真實鐵路搭車 | [Geoglyph 3D Rail](https://earth.geoglyph.info)（MapLibre + Three.js，[開源](https://github.com/hirakata-farm/GeoglyphRail)） | 非台灣、非藝術化 |
| 海面/夕陽渲染 | [@takram/three-geospatial](https://github.com/takram-design-engineering/three-geospatial)（大氣散射，MIT） | 只是模組非場景 |
| 真實 DEM 藝術化敘事 | Explore Primland、San Rita Project（Codrops 拆解） | 導向式運鏡、非自由漫遊 |

**核心發現：四塊技術各自成熟，但沒有任何公開產品把它們拼在一起。** 回放型產品（Ayvri 關站、FATMAP 被 Strava 收掉）證明光有飛越鏡頭撐不起產品；跨過「貼地行走」的只有一篇沒 demo 的論文。台灣也查無「真實 DEM 藝術化互動」競品。→ terrain-art 站在空白區上。

## 四、本地引擎盤點：離沉浸模式差多遠

**可直接重用（已就緒）**
- `heightField.heightAtWorld(x,z)` 雙線性採樣 + LRU 快取（src/engine/geo.js）——貼地行走的碰撞基礎現成
- 統一座標系（1 unit ≈ 480.78m，Web Mercator + cos(lat₀)）、chunk streaming + 3×3 預載
- 火車系統（trains.js，EPSG:3826 弧長參數化）＋ follow camera（follow.js delta-carry）＋ tour 相機（tour.js）＋ timeStore
- `demExaggeration` 已是參數（預設 1.0），尺度切換有現成鉤子

**硬缺口**
- **20m DEM 是天花板**：480m/unit 下 20m 網格 ≈ 1/24 unit，街景級近看會是「樓梯狀山坡」。近景細節只能靠程序化補（detail normal map、micro-displacement、草地 instancing）——這正是 Lucidum demo 用草遮 20m 級地形的同一招
- 無自由第一人稱相機（MapControls 不支援 WASD+pointer lock），估 200–300 行新增
- 無天空盒/時間驅動光照（太陽方位是固定參數）
- on-demand render 與持續移動模式衝突：需把 firstPersonMode 加進 isAnimating()，chunkManager 要改追相機位置

## 五、技術知識點地圖（七大塊，各附最推薦起手）

1. **第一人稱行走**：pointer lock + WASD；貼地不用物理引擎，用既有 heightAtWorld（或 three-mesh-bvh `raycastFirst`）+ 簡單重力/坡度限制。Rapier heightfield 留給未來要碰撞物體時。坑：tile 未載時懸空、iOS 無 pointer lock 要虛擬搖桿。
2. **近景地形細節**：slope/altitude texture splatting + triplanar mapping（防陡坡拉伸，需 onBeforeCompile 注入）+ detail normal map；草地抄 [Codrops FluffyGrass](https://github.com/thebenezer/FluffyGrass)（chunked InstancedMesh，百萬葉級）。坑：草 chunk 與 DEM tile LOD 邊界要同步。
3. **海洋**：在既有海面上疊 **Gerstner waves**（vertex 位移，甜蜜點）+ smoothstep 波峰 foam + depth-based 深淺色。FFT ocean（Tessendorf）視覺最好但需持續 render pass，與 on-demand render 衝突，需限頻。
4. **天空/夕陽**：`timeStore → suncalc(lat,lon,t) → 太陽方位/仰角 → DirectionalLight + Sky uniform → ACES tone mapping`。起手用內建 Sky（Preetham），要求高再換 Bruneton 系（@takram/three-atmosphere，注意 WebGPU 未支援）。God rays 用 [three-good-godrays](https://github.com/Ameobea/three-good-godrays)，須可一鍵關（PERF_THROTTLE 精神）。
5. **火車視角**：鐵路 polyline → `CatmullRomCurve3`（centripetal 防 overshoot）→ 等弧長取樣 + look-ahead lookAt + quaternion slerp。速度上限 ≤ tile 載入吞吐（最簡單的 streaming 對策）。坑：GPS 折線鋸齒要先抽稀平滑；相機高度用軌道高＋視高，不是 DEM 高。
6. **LOD streaming**：理論＝chunked quadtree（screen-space error + skirt 補縫）/ CDLOD / geometry clipmaps。現成庫：[three-tile](https://github.com/sxguojf/three-tile)（輕依賴、自接資料源，最貼合自有 tile CDN）、[3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS)（NASA，最成熟，但要標準格式）。第一人稱下 LOD popping 遠比空拍刺眼——這是最容易低估的成本。
7. **尺度設計**：垂直誇張不是妥協而是地形視覺化必要手段；「縮尺總覽 ↔ 等比沉浸」共存的成熟先例是 VR 的 **Worlds-in-Miniature**（WIM, CHI 1995）。做法：把 exaggeration 保持為 shader uniform（勿烘進 geometry），模式切換做 scale tween 插值。

## 六、建議路線圖

**留在 terrain-art，不開新專案**（沉浸模式 = 相機模式 + 渲染升級，資料資產 100% 共用）：

- **Phase 1（最快勝利，零新依賴）**：suncalc + 內建 Sky 打通「時間軸→夕陽」；把 follow camera 升級成「車廂視角」（相機掛在列車位置 + look-ahead）。→ 「搭火車看山海 + 夕陽」直接成立
- **Phase 2（原型驗證）**：第一人稱 WASD + heightAtWorld 貼地（~200–300 行 + isAnimating 接線），驗證 20m DEM 在步行視角的可接受度
- **Phase 3（視覺升級）**：Gerstner 海面 + foam + 深淺色；草地 instancing + splatting 遮近景粗糙
- **Phase 4（架構投資，確認方向後才做）**：LOD streaming 重構（three-tile 評估）、WIM 式雙尺度模式、@takram/three-atmosphere

**唯一值得開新專案的情境**：目標變成「我要學引擎底層/轉 engine programmer 賽道」——那是興趣/職涯轉軌專案（C++ 或 Rust + WebGPU，刻意壓小範圍如花蓮海岸 100km²），不是 terrain-art 的延伸，也不該犧牲主線產出。

## 七、求職價值（回應「做 demo 能不能找到更好工作」）

- 現有技能（JS/Three.js + Python GIS）**同時命中 web graphics 與 GIS visualization 兩個賽道**：Three.js 職缺均值 ~$121k、GIS 專職可達 $139k–223k，**不低於** game engine dev（Unity/Unreal 均值 $108–120k）。
- 轉 C++ 引擎賽道 = 放棄既有複利、跟寫了十年 C++ 的人競爭更小的池子，effort/return 差；作為「證明懂 GPU 底層」的差異化訊號可以，作為履歷投資不划算。
- terrain-art 做完沉浸模式後，恰好就是 Awwwards 型 live demo（web graphics 賽道要的）+ 真實空間資料工程（GIS 賽道要的）的複合作品——比 Lucidum 那條路線更貼合自身賽道。

---

### 附錄：五份子研究關鍵來源

- AtmosphericEngine / cpp-wasm（Loïc Chen）：github.com/painfulexistence
- Godot 4.3 web export 退回單執行緒：godotengine.org/article/progress-report-web-export-in-4-3/
- pmtech WASM 移植記（20 工作天）：polymonster.co.uk/blog/porting-to-wasm-with-emscripten
- Geometry Clipmaps（Hoppe）：hhoppe.com/geomclipmap.pdf；CDLOD：aggrobird.com/files/cdlod_latest.pdf
- Three.js WebGPU TSL procedural terrain 官方範例：threejs.org/examples/webgpu_tsl_procedural_terrain.html
- 草地實戰：tympanus.net/codrops/2025/02/04/how-to-make-the-fluffiest-grass-with-three-js/
- Gerstner 教學：sbcode.net/threejs/gerstnerwater/；FFT ocean：github.com/jbouny/fft-ocean
- suncalc：github.com/mourner/suncalc；Bruneton：github.com/ebruneton/precomputed_atmospheric_scattering
- TerrainView7（C++/WebGPU/Emscripten 行星渲染，solo 多年連載）：dev.to/the_lone_engineer
- WIM 論文：cs.cmu.edu/~stage3/publications/95/conferences/chi/paper.html
- 薪資：creativedevjobs.com/blog/threejs-developer-salary-guide、ziprecruiter.com/Jobs/Webgl
