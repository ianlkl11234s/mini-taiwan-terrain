# 遊戲引擎級草地渲染研究（2026-07-20）

> 起因：Phase 3 草地上線後，用戶拿 Lucidum（AtmosphericEngine）的蓊鬱草原截圖問「怎樣做出這種遊戲引擎級的細緻 3D 草地」。
> 方法：三路平行研究——(1) AAA 技術拆解（GDC 一手投影片直讀）、(2) 瀏覽器實證案例普查、(3) WebGL2 硬限制與規模預算。本檔為整合結論與 terrain-art 落地路線。
> 信心標註原則：一手（官方投影片/文件/原始碼直讀）／二手（部落格/社群拆解）；查無數字一律寫「未公開」，不編造。

---

## 一、「蓊鬱感」到底是什麼——技術優先級（依貢獻度排序）

綜合 Ghost of Tsushima（GDC 2021，投影片 PDF 直讀）、Horizon Zero Dawn（GDC 2018，同）、BotW/Genshin 社群重現的交叉結論：

| 排名 | 技巧 | 貢獻 | 成本 | 一句話 |
|---|---|---|---|---|
| 1 | **Ground blending**（遠景退化成地形貼圖＋草色與地形色融接） | 極高 | 中高 | 沒有它，草地邊緣穿幫成突兀色塊；GoT 官方 2021 年還把「草地邊緣淡出」列 Future Work——最難也最值 |
| 2 | **Clumping**（Voronoi 叢聚：同 cell 共享朝向/高度/色偏） | 極高 | 中 | 均勻分布＝人工草皮；疏密與朝向的叢聚變化才是「野生」的視覺核心 |
| 3 | **風場**（世界空間 Perlin scrolling，方向與強度分頻取樣） | 高 | 中 | 靜止的草一眼假；GoT 與 HZD 兩個獨立一手案例都是這套 |
| 4 | **root→tip 漸層色**（UV.y lerp 底暗頂亮） | 高 | 低 | 最便宜的體積感；寫實與風格化路線通用 |
| 5 | **密度**（配 LOD 圈層才付得起） | 高 | 高 | 蓊鬱的字面定義，但必須靠圈層剔除撐 |
| 6 | **View-space thickening**（掠射角把葉片朝相機加寬） | 中高 | 中 | 沒有它，平視角草變薄消失、露出地面，密度錯覺瞬間破功（GoT 一手：glancing angle adjustment） |
| 7 | Bezier blade 曲線造型 | 中 | 高 | 近景加分、中遠景看不出；GoT 用 cubic Bezier 4 控制點、15/7 頂點兩級 LOD |
| 8 | Translucency/backscatter（wrap lighting） | 中 | 低中 | 逆光通透感，黃昏場景顯著；GPU Gems 公式 `max(0,(dot(L,N)+w)/(1+w))` |
| 9 | 互動撥草 | 低（沉浸加分） | 中 | 對展示型場景優先度低 |
| 10 | Specular sheen / 各向異性 | 低 | 中 | GoT 只用 1D gloss、HZD 連獨立通道都沒有——AAA 自己都簡化 |
| 11 | 根部 AO | 低 | 低 | HZD 一手投影片明講「AO: Not on Grass!」；暗部靠漸層貼圖即可 |

**修正一個直覺**：之前以為「地面底色是草色」是全部的答案——它確實是排名 1 的一部分，但研究顯示**排名 2 的 clumping 同等關鍵**，而排名 6 的 view-space thickening 是「為什麼 demo 的草看起來密、我們的看起來稀」的直接技術原因之一（平視時葉片薄邊消失）。

### GoT 的工程細節（一手，最值得抄的部分）

- **Blade**：cubic Bezier（P1 基座、P4 葉尖，P2/P3 由 bend/tilt 參數控制）；解析導數同時給法線。High LOD 15 頂點／Low LOD 7 頂點，LOD 切換做頂點 blend 防 popping
- **Compute 流程**（每 lane 一片草）：lane ID→tile 格點+jitter → 距離/frustum 剔除 → 查貼圖定草種與高度 → 無草 lane 丟棄 → occlusion 剔除 → indirect draw
- **Clump**：procedural Voronoi，每片草帶「Clump facing (2 floats)＋Clump color」＝同 cell 共享
- **法線**：Bezier 導數→取與 facing 正交方向外擴寬度；遠距把法線內插向 clump 共用法線＝specular anti-aliasing
- **材質**：Gloss 1D 貼圖、Diffuse 1D 葉脈+2D 色貼圖、Translucency 與 AO 都是**常數**——效能優先於物理正確的直接證據
- 規模數字官方未公開；二手轉述（信心中低）：同螢幕 ~83k 片、~2.5ms/幀
- 來源：gdc_2021_procedural_grass_in_got.pdf（archive.thedatadungeon.com 存檔）；gdcvault.com/play/1027033

### HZD 的一手數字

- 草 LOD 三角形：LOD1 20-36 tri／LOD2/3 各 10-18 tri；樹 5 級 LOD（LOD4 淡入 billboard、LOD5 純 billboard）
- 風 compute 模擬 ~150μs；alpha test 走兩階段（先當 early occluder）
- **World Data 512×512 貼圖**烘焙侵蝕/近水/生態區位 → 驅動植被 colorization 貼合地形色調（ground blending 的 AAA 做法）
- Placement：GPU 即時生成玩家周圍（node-based placement graph＋slope/curvature＋手繪 mask 貼圖）
- 來源：media.gdcvault.com/gdc2018/presentations/gilbert_sanders_between_tech_and.pdf

---

## 二、瀏覽器實證：誰證明了什麼、能抄誰

| 案例 | 技術棧 | 規模實證 | 授權 | 對我們的價值 |
|---|---|---|---|---|
| **SimonDev Quick_Grass**（github.com/simondevyoutube/Quick_Grass） | WebGL2、InstancedBufferGeometry | 每 patch 3072 片×32×32 patch 掃描；FPS 未公開 | **MIT，原始碼完整** | **最優先抄**：view-space thickening（shader 內自註 HACK 的那段）、雙法線 wrap lighting＋backscatter 假 sheen、heightmap 重採樣貼地、LOD 4/14 頂點兩級。與我們同為 onBeforeCompile 系架構，可直接搬段落 |
| **al-ro/grass**（al-ro.github.io/projects/grass） | WebGL2 | 10 萬片、單葉 8 tri | 無 license | instancing 101 教學參考 |
| **Codrops FluffyGrass** | WebGL2、alpha card | ⚠️ 文章宣稱 256-chunk＋百萬葉，**公開 repo 只有單 mesh 8000 instance，chunk/LOD 未實作** | MIT | 只可參考風動 shader；「百萬」是未開源的 Elysium 專案，文章數字不可引用 |
| **boona13/threejs-grass-water-shaders** | WebGL2、GLSL3 | 3 萬片/44×44m，M 系 Mac <1ms（自陳） | MIT（已二次核實） | 抄設計模式：`setTerrainHeightTexture` API、**坡度 stochastic thinning**（0.28-0.65 軟過渡 vs 硬截）、`birthTime` grow-in 動畫。10 stars 社群驗證低，不整包 import |
| **momentchan/false-earth**（Codrops 2026-04 專文） | **WebGPU** TSL compute＋indirect draw | 「百萬級」、GPU 剔除 ~80% instance、三層 LOD（15/5/2 段） | MIT、活躍（2026-07） | **唯一驗證「compute＋地形高度驅動」的公開案例**；未來 WebGPU 分支的首選參考，非現階段行動項 |
| **Revo Realms**（alezen9） | WebGPU TSL sprite | M2 上 1.18M 葉/8.2M tri 單 draw call 120fps（自陳，數字扎實） | MIT | early-refusal culling、bit packing 思路 |
| Tech Redux「百萬葉 60fps M1」 | WebGL2 合併幾何 | 自陳，未完全驗證 | **Patreon 付費** | 只能當量級基準 |
| spacejack/terra | WebGL | 521★ 最成熟 | ⚠️ **CC BY-NC 非商用** | 授權風險，不抄碼 |
| ⚠️ CK42BB/procedural-grass-threejs | — | — | — | **陷阱**：搜尋排名高但實為 AI 教學文件模板，無任何實作檔 |

**關鍵普查結論**：「真實 DEM tile（非靜態 heightmap/程序化 noise）＋chunked instancing 草地」的組合**全網查無現成案例**——terrain-art 的 grass.js 已經站在這個空白區上，底子架構（chunked InstancedMesh＋onBeforeCompile＋heightAtWorld 貼地）與 SimonDev/boona13 同路線且地形整合更難一級。缺的不是架構，是**光照層與 LOD 層**。

---

## 三、WebGL2 硬限制與規模預算

### 無 compute shader 的三條路

1. **CPU 預生成＋分 chunk InstancedMesh＋距離 LOD**——唯一有多個獨立可驗證案例達百萬級的路徑（Codrops 方法論在 UHD620 打到 100 萬、Discourse #82808 M1 100 萬@60fps）。**這就是我們該走的路，也是已經在走的路**
2. Transform feedback 動態生成——three.js 生態**查無草地案例**（PR #26777 未合併），要做等於當先驅，不建議
3. gl_VertexID 純程序化——理論可行、無實證，省的頻寬可能被 ALU 吃掉，只當邊際優化

### 鐵律數字

- **葉片幾何複雜度 > 一切**：3-5 頂點/葉是唯一被驗證能上百萬的規格；10-15 頂點在 50 萬+ 規模**查無 60fps 實證**。三個獨立來源一致：三角形總量安全帶 ~300 萬 tri
- instanceMatrix 64B/instance（100 萬＝61MiB）；自訂 InstancedBufferAttribute 打包（pos+seed 16-24B）省 2-4 倍——但百萬級以上瓶頸是三角形/像素，不是 attribute bytes
- frustum culling 是**逐 draw call**（整個 InstancedMesh 一顆 bounding），所以 chunk 切分＝剔除粒度；occlusion query WebGL2 核心有支援但 three.js WebGLRenderer 明確不做（維護者已聲明），只適合 chunk 粒度自接 raw API，優先度低

### 規模預算表

| 檔位 | instance | 幾何 | 同屏 tri | attr 記憶體 | 條件 | 預期 |
|---|---|---|---|---|---|---|
| 保守 | 10 萬 | 3-5 頂點/葉 | ~30-50 萬 | ~2.7MiB | 16-64 chunk | 60fps 含 UHD620 弱內顯 |
| **標準** | **50 萬** | 3-5 頂點/葉 | ~150-250 萬（安全帶上緣） | ~15MiB | ~256 chunk＋3 級 LOD＋逐 chunk frustum | 60fps on M1/中階獨顯；內顯靠 LOD 壓回保守檔 |
| 激進 | 100 萬 | 3-5 頂點/葉 | 靠 LOD 壓回 <300 萬 | ~31MiB | LOD 必須生效（非全繪） | M1/i3 有實測案例，直繪必掉幀 |

### WebGPU 要不要

- 支援現況（2026 中）：Chromium 系＋新 Safari 覆蓋主流；**桌面 Firefox（macOS-Intel/Linux）與舊 Safari/iOS 是確認缺口**
- 真相：不是「兩個渲染器」（WebGPURenderer 會自動 fallback WebGL2 後端、TSL 雙編譯），而是「**一個渲染器、兩套草地邏輯**」——compute 路徑（GPU 剔除→indirect draw、atomics）在 WebGL2 fallback 上跑不動，永遠要留一套 instancing fallback
- 判斷：目標在標準檔（50 萬）內 → WebGL2 現有做法足夠，雙軌投報率低；要奔 200 萬+＋GPU 風物理才值得，且接受 Firefox 拿降規版。**現階段：留在 WebGL2**

---

## 四、terrain-art 現況定位（grass.js 差距清單）

已有（架構正確）：chunked cell streaming（240m cell、每幀 ≤2 cell）、InstancedMesh 40k 先空後填、真實 DEM heightAtWorld 貼地＋tileResident、坡度/海拔過濾、weather 連動風、camGroundM 門檻＋isAnimating 凍結、5 頂點/葉（規格＝James Smyth BotW 路線，正確量級）。

缺（按優先級表對照）：

| 缺口 | 對應排名 | 現況 |
|---|---|---|
| Ground blending（草區地面色＋遠景退化） | 1 | 無——葉隙露出白紙等高線，這是「稀疏感」主因 |
| Clumping | 2 | 無——per-instance 獨立 hash，均勻分布 |
| 風場連貫性 | 3 | 有風但 per-tuft 相位，非世界空間波前掃過 |
| root→tip 漸層 | 4 | 無（單色×明度抖動） |
| 密度＋LOD 圈層 | 5 | 40k capacity 單一幾何無 LOD；標準檔要 50 萬＋兩級幾何 |
| View-space thickening | 6 | 無 |
| wrap lighting/backscatter | 8 | 無（MeshStandardMaterial 原生 lighting） |
| 坡度軟過渡 | — | 35° 硬截，邊緣生硬（boona13 stochastic thinning 可解） |

---

## 五、落地路線圖（建議三個 PR 節奏）

### PR-A 光照與造型層（成本低、蓊鬱感立即翻倍）
全部在既有 onBeforeCompile block 內增量修改，不換材質系統：
1. root→tip 漸層＋根部壓暗（UV.y lerp，root 色對齊未來地面 splat 色）
2. Clumping：世界空間 cellular noise（shader 內 procedural，免貼圖）→ 同 clump 共享 yaw 偏向/高度縮放/色偏
3. View-space thickening：抄 SimonDev MIT 那段 HACK（view space 沿螢幕 X 加寬掠射角葉片）
4. Wrap lighting＋backscatter 常數（GoT 精神：常數就夠）
5. 風改世界空間 scrolling noise（方向與強度分頻），陣風波前掃過草原
6. 坡度 stochastic thinning 軟過渡（0.28-0.65 帶狀機率淡出）

### PR-B 密度與 LOD 圈層（從 4 萬到 50 萬）
1. 兩級葉片幾何：近圈 5 頂點/葉、外圈 3 頂點（或加寬減片），比照 GoT 15/7 的比例精神
2. cell 依距離選 LOD＋密度衰減曲線重調；capacity 40k→~500k（attr 打包 16-24B/instance，放棄 instanceMatrix 全矩陣——自訂 InstancedBufferAttribute）
3. 逐 cell frustum culling（多顆 InstancedMesh 或 BatchedMesh 評估）
4. On-demand render 相容：維持現有 isAnimating gate；可實驗「idle 降頻＋shader 時間量化（floor(t×12)/12）」讓風跳格不全停——**注意：這是原創組合、查無先例，需實測跳格感**

### PR-C Ground blending（最難、最值，可獨立驗收）
1. terrain.js 注入「草區 splat」：與 grass 佈點同一套規則（坡度/海拔/clump noise）在 fragment 端把 albedo 混向草地色——葉隙不再是白紙
2. 遠景（草葉圈層外）只剩 splat＝GoT「far LOD texture on terrain」的精神；HZD World Data 思路：草色從地形色調採樣，兩者互相貼合
3. **風格決策（須 user 拍板）**：splat 恆常開＝白紙等高線美學改變；建議做成「近景距離窗淡入」（與 detail normal 同窗）或獨立 Lush 風格開關，俯瞰保持紙感

每個 PR 各自可驗收（renderCount 凍結矩陣照舊），順序即優先級——PR-A 單獨上線就會有肉眼可見的質變。

---

## 附錄：關鍵來源

- GoT GDC 2021 投影片 PDF：archive.thedatadungeon.com/ghost_of_tsushima_2020/documents/gdc_2021/gdc_2021_procedural_grass_in_got.pdf（gdcvault.com/play/1027033）
- HZD GDC 2018 投影片：media.gdcvault.com/gdc2018/presentations/gilbert_sanders_between_tech_and.pdf；placement 官方部落格 guerrilla-games.com/read/gpu-based-procedural-placement-in-horizon-zero-dawn
- SimonDev Quick_Grass（MIT）：github.com/simondevyoutube/Quick_Grass；影片 youtube.com/watch?v=bp7REZBV4P4
- boona13 GrassField（MIT）：github.com/boona13/threejs-grass-water-shaders
- false-earth（MIT，WebGPU）：github.com/momentchan/false-earth；Codrops 專文 tympanus.net/codrops/2026/04/21/false-earth-from-webgl-limits-to-a-webgpu-driven-world/
- Codrops FluffyGrass（repo 與文章有落差）：tympanus.net/codrops/2025/02/04/how-to-make-the-fluffiest-grass-with-three-js/
- James Smyth stylized grass：smythdesign.com/blog/stylized-grass-webgl/
- 3M instanced grass 效能討論：discourse.threejs.org/t/81286；百萬葉 M1 案例：discourse.threejs.org/t/82808
- wrap lighting：GPU Gems Ch.16（developer.nvidia.com/gpugems/gpugems/part-iii-materials/chapter-16-real-time-approximations-subsurface-scattering）
- SpeedTree LOD crossfade：GPU Gems 3 Ch.4；Outerra 2012（GoT 自陳靈感源）：outerra.blogspot.com/2012/05/procedural-grass-rendering.html
