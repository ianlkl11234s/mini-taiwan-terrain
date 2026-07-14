# 向量圖層平移效能改造計畫（VECTOR_PERF_PLAN）

> 2026-07-12 擬定。研究：兩輪 Sonnet 盤點（vectortiles.js 內部＋上游資產/pulse 參考）＋ Opus 終審逐項核實。
> 主訴：開啟路網/建物/農田後拖曳鏡頭卡頓。**誤診澄清：不是下載慢**——四個重型圖層（roads/fields/buildings/trails）已是 PMTiles 串流、Cloudflare Cache Rule 實測 HIT，卡頓全部在資料抵達後的主執行緒。本計畫不動資料格式與上游 pipeline，只改 `src/engine/` 渲染管線，**使用者所見內容零改變**。

## 根因排名（均已對照程式碼核實）

| # | 根因 | 證據 | 性質 |
|---|------|------|------|
| R1 | 建物 redrape 無分幀預算：DEM chunk 落地 → `index.js:954-960` 四層同時 `markDemDirty()` → `_redrape()`（`vectortiles.js:837`）一次重掃全部活 tile。建物常駐 ~65 tiles / ~312 萬頂點，每頂點呼叫 `heightAtWorld()`，20-60ms 單幀尖峰，發生在拖曳全速分支。**關鍵浪費：新 tile 解碼時已 `ensureTiles` 貼地（`vectortiles.js:796-798`），重掃的幾乎都是 DEM 沒變的既有 tile** | `vectortiles.js:837-847,1403-1415` | 持續性，最傷 |
| R2 | MVT 解碼＋Earcut 三角化在 fetch resolve 後同步跑到底，密集 tile 數千棟建物一次三角化，在 `_pump` 12ms 預算之外、不受任何節流保護 | `vectortiles.js:778-816,1268-1370` | 進入新區域時尖峰 |
| R3 | 四個 VectorTileManager 各持 12ms 建構預算，疊加單幀最壞 ~60ms | `vectortiles.js:46-47` | 疊加放大 |
| R4 | vz 跨 LOD 門檻整層 `_clear()` 重建、四層同時發生（`chunks.js:191-222` 有 `_covered()` 未搬） | `vectortiles.js:643-650` | **縮放**卡頓，非平移 |
| R5 | 解碼結果與 mesh 同生命週期，LRU 逐出即丟，回訪重 decode＋三角化 | `vectortiles.js:582-589,723-724` | 回訪成本 |

## 執行順序（Opus 終審修正後的 ROI 排序）

1. **P1a-1 redrape 分幀化**（安全網）：`_redrape` 改佇列式逐 tile、套 `_pump` 的 `BUILD_BUDGET_MS` 模式；持久 cursor 跨幀、逐項判 tile 存活（可能已被 LRU 逐出）。**只套用在 `_demDirty` 路徑**；exaggeration（`vScale`）變動仍全層同步 redrape（罕見、一次性、每頂點 Y 都變）。
2. **P1a-2 dirty-region redrape（全案最高 ROI）**：`geo.js` `HeightField._store`（`geo.js:217-231`）累積「新 resident DEM tile key 集合」並曝露；`index.js` `onChunksChanged` 取出傳給 `markDemDirty(dirtySet)`；`vectortiles.js` 用現成 `demFootprint()`（`vectortiles.js:459-472`）算相交，只將與新 DEM tile 相交的向量 tile 入佇列。無參數呼叫 → 退回全層（相容 vScale 路徑）。穩態平移下 redrape 從「每幀 312 萬頂點」塌縮到「幾個 tile」。
3. **P1b 共用幀預算**：四個 VectorTileManager 共用 ~8-12ms/幀，**每幀輪轉起始順位**（buildings 註冊在最後、固定順序會被餓死）；**chunkManager（地形）保留獨立預算**，底圖優先。注意：P1 全部做完仍不治 R2。
4. **P2a 解碼移 Web Worker（第二大 win，殺 R2）**：raw `res.data` ArrayBuffer transferable 進 worker，worker 內 `new VectorTile(new PbfReader(...))` ＋三角化，**不做 DEM 取樣**（decode 函式簽名去掉 `hf`、proj 只傳純數字）；輸出平面幾何（y=0）＋ `faceFeature/segFeature` typed arrays，主線程用 P1a 分幀機制做首次貼地——`redrapeBuildingBucket` 本質就是對平面幾何貼地的函式，roads/fields 同理，不需新寫貼地邏輯。
5. **P2c 解碼快取與 mesh LRU 分層**：仿 `HeightField`（`geo.js:100-101,188-215`）模式，decoded buckets 另存較大 LRU、設記憶體上界，mesh 逐出不丟解碼資料。
6. **P2b `_covered()` LOD 銜接**：降優先——治縮放不治平移，且 fields 半透明/buildings 不透明在新舊 tile 共存期有雙重合成風險，非 drop-in port。等縮放閃爍成為實際抱怨再做。
7. ~~P3a GPU drape~~：**擱置**。P1a-2 落地後邊際效益趨近零；`LineMaterial` 注入 DEM-texture 位移＋多 LOD atlas＋接縫處理成本極高。
8. P3b 兩段式 decode 降 GC：P2a 後在 worker 內做，等 profiling 顯示 GC 再說。

## P2a 的兩個隱形陷阱（實作必守）

- **首次貼地完成前 mesh 不得加入 `this.group`**——否則建物先在海平面閃現再彈起，違反「所見零改變」。分幀預算切在 tile 之間、不切單一 tile 之內（單一密集 tile 貼地約 2-4ms，塞得進一個 slot）。
- **vector 工作佇列必須納入 `isAnimating()`（`index.js:2554` 目前只掛 chunkManager）且保證排空**——否則停手後在途結果卡住不補畫；或每幀 invalidate 不止 → `renderCount` 爬升、on-demand render 鐵則破功。

## 效能預期與驗收

- P1+P2a 完成後：平移 20-60ms 尖峰**消除**、絕大多數 frame <16ms；「long frame 歸零」是過度承諾（大 tile GPU buffer 上傳、分幀 slice 本身仍可能貼近 16ms）。
- 驗收標準：① 拖曳平移 long-frame（>16ms）次數前後對比；② idle 時 `renderCount` 凍結不破功（`/verify`）；③ exaggeration 變動後全層貼地正確；④ 點選/raycast 行為不變。

## 進度

- [x] P1a-1 redrape 分幀化（PR：sprint/vector-perf-p1a）
- [x] P1a-2 dirty-region（同上；空集合＝「chunk 有動但 DEM 沒變」→ 不入佇列，null 才退回全層）
  - ✅ 2026-07-14 /verify 補驗通過（SwiftShader headless，台北→台中實測）：
    - 貼地：建物 tile mesh（18.1 萬頂點）底部 -4.27 vs 地形取樣 -4.24，貼合正常
    - dirty-region 實效：飛行途中 markDemDirty 42 次呼叫，33 次空集合→零入佇列（舊版會 42 次全層重掃）
    - 佇列排空：強制全層 fallback（48+48 tiles）→ 分幀排空 drained、期間 renderCount 僅 +8
    - idle freeze：收斂後 renderCount 凍結 12 秒不動、`idle:true`
    - exaggeration：設 1.6 後 mesh minY 精確 ×1.6、同步全層重貼、pending 立即為空、rc 隨後凍結
    - console 無新 error（glBlitFramebuffer warning 為 SwiftShader 已知 artifact）
- [ ] P1b 共用幀預算
- [ ] P2a worker decode
- [ ] P2c 分層 LRU
- [ ] P2b `_covered()`（暫緩）
