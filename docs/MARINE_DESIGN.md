# MARINE_DESIGN — 船舶 AIS 圖層 + 海面動態 + 比例尺結論

> 狀態：**opus 審定通過（2026-07-11，修訂版：onBeforeCompile + CDN 快照 + 首載修正）**。實作前必讀。
> 對應 backlog #12（AIS）、#13（海面動態）、#14（比例尺校正）。
> 偵察依據：collectors `ship_ais`（航港局 API，10 分鐘輪，線上在跑）；pulse `shipLoader.ts`；`z_japan_virtual_town/web/island/src/water.js`；geo.js 比例尺盤點。

## 0. 比例尺結論（#14，主迴圈已審）

- **AIS 船位精度不依賴比例尺**：全圖層共用 `lonLatToWorld`（Web Mercator + cos(lat₀) 錨定玉山緯度），任何 lon/lat 資料相對海岸線的位置天然精準。#12 不被 #14 阻塞。
- **垂直**：`demExaggeration` 預設 `1.6 → 1.0`（真實比例：水平垂直同為 1 world unit ≈ 480.78 m）。UI 滑桿保留，用戶可隨時調回誇張視覺。一行改動，隨本期實作一併上。
- **水平**：Mercator 緯度伸縮 ±2%（21°N −1.7% ~ 26.5°N +2.5%）為已知特性，**不做**世界座標重建（全部圖層/圖磚/投影快取都掛在現投影，重建成本與風險不成比例）。記錄於此，結案。

## 1. 船舶 AIS 圖層（#12）

### 1.1 資料路徑（鐵則合規，opus M3 修訂：CDN 快照優先）

- **過去日（不可變資料）走 CDN 靜態快照**：`{VITE_TILE_BASE}/ships/trails/{YYYY-MM-DD}.json`——由 `scripts/bake_ship_trails.py` 產出（經 anon RPC 抓 + 精簡）並 rclone 上 R2。快照 miss（404）→ 才 fallback live RPC。這把共用 DB 的濫用面與重查詢移到 CDN（backlog #9 rate limit 未解前的必要防護）。
- **今日**（快照尚未存在）→ live RPC：`get_ship_trails(target_date)`（anon key，`trail` 格式 `"lat,lng,ts;..."` + `mmsi`/`ship_type`）；`get_ship_dates()` 供可用日參考。**禁止**直讀 `realtime.ship_current`/`ship_positions`（repo 鐵則：前端禁直打 realtime.*，即使 RLS 允許）。
- 今日資料只到最後收集幀（10 分鐘輪）：時間軸播到收集幀之後船會因「t 超出 trail」而隱藏——**這是正確行為**，不是 bug。
- fetch 失敗 → 圖層退化顯示空、非致命（水庫模式）。注意：repo 沒有可複用 Supabase client——reservoir 是 index.js closure 內 inline fetch + 區域 `SUPABASE_URL/SUPABASE_ANON` 常數；ships 實作要**把這兩個常數提升到共用作用域**，不要重複宣告 anon key（opus 資安確認：anon key 進 bundle 合規，.env 的 R2 憑證 src 零引用）。
- 「即時最新船位」需要 gis-platform 開 `get_ship_current()` public wrapper —— **本期不做**，列為 phase 2（上游先動）。

### 1.2 時間模型：第一個 subscribeDate 消費者

ships 是 **track 類**圖層，與 timeStore 的整合是本期的架構重點：

- **日檔載入（opus M2 修訂）**：`onActivate` 必須做兩件事——①**立即**以 `timeStore.getDateKey()` 打一次首載（`subscribeDate` 訂閱當下不觸發 callback，只靠它圖層開了永遠空白）；②`subscribeDate(loadDay)` 訂閱後續 dateKey 變化（scrub 跨日/切日期/播放跨午夜）。**這會首次實戰驗證 subscribeDate 的 300ms debounce**（快速 scrub 跨多天只載最後停下的那天，worst case ~3 req/s，且暫停態 scrub 也會觸發——discrete 路徑不依賴 notifier，opus 已驗證）。競態防護抄 pulse timelineSliceLayer：`currentDate` 比對 + 過期回應丟棄。
- 該日無資料（`get_ship_dates` 對不上）→ 顯示空、面板照常，不 fallback 到別天（時間軸語意誠實）。
- **每幀位置**：`tickView` 內 `timeStore.getTime()` 現讀（同 trains 金律，不訂閱），對每船 trail 做 binary search + 線性插值 lon/lat；`t` 在該船 trail [first,last] 之外 → 隱藏該船。
- GPS 異常過濾（>40 節跳點）移植 pulse shipLoader 的做法，在載入時清一次。

### 1.3 渲染與互動

- `src/engine/ships.js`：InstancedMesh 光點（trains 同款管線），渲染上限 2048 實例。**注意（opus M4）：2048 只是渲染上限，不是記憶體上限**——整日 trail 無論如何 fetch→parse→常駐 JS 記憶體，真正的量控在 bake 快照的精簡（目標單日檔 gzip 後 <2MB，bake 腳本量測回報實際 payload）。在途船 >2048 時按與相機距離排序取近者（1s 節流重排，不逐幀排）並 console.warn 一次。
- MVP 單色 `shipsColor`（預設海軍藍 `#3a6ea5`），船種分色（漁船/貨船/油輪…）列 phase 2（per-type sets，車站模式）。
- styleSchema：`color`+`size`+`opacity`（TRAIN_STYLE 同款）；rowLabel `'船舶 Ships'`；分組 MOVE。
- pick：proximity pick（trains 同款）→ 卡片：船名、MMSI、船種、當下航速（由 trail 相鄰點導出 knots）、資料時刻。
- `isAnimating()`：列車項擴成 `((trainsVisible || thsrVisible || shipsVisible) && timeStore.getPlaying())`。
- deferred：`onActivate` 才打 RPC；「先空後填」陷阱照 SOP。

## 2. 海面動態（#13）

### 2.1 核心決策：fragment-only，不搬 Gerstner 幾何

日本小鎮的海是 384×384 頂點 Gerstner 波（波長 55–130 m、振幅 ~0.5 m）。本 repo 1 world unit ≈ 480 m，**半米浪高是次像素級，頂點位移毫無視覺意義**。要搬的是它的**視覺語言**，不是幾何管線：

| 搬 | 不搬 |
|----|------|
| fresnel 掠角混天色（`pow(1-N·V,5)`） | Gerstner 頂點位移（次像素） |
| 微高光 glint（`pow(N·H, 高指數)` 低強度） | 147k 頂點 tessellation |
| 吸收/透明度語意（近透明 veil） | 白沫系統（岸邊白沫另案，需距離場） |
| 每幀 uTime 驅動 | 深度採樣水色（本 repo 海底色已由 bathymetry ramp 承擔，海面只是薄紗） |

### 2.2 實作

- **（opus M1，本設計最大的坑）絕不換 raw ShaderMaterial**：現有海面板 `MeshBasicMaterial` 的 `alphaMap`（`region_sea_mask.png`）+ `alphaTest:0.5` 是「海不淹平原」的唯一機制，material 還自動承載 fog 注入、`opacity`（bathymetry HANDLER 切 0.5/1.0 的載體）、`polygonOffset`。修改方式=**`material.onBeforeCompile` 注入** fresnel/ripple GLSL（repo 先例：`terrain.js:79`），四項機制全部原封保留。japan 專案是 raw ShaderMaterial 但它沒有陸地遮罩需求，情境不同不可直搬。
- fragment-only 法線微擾：2–3 組不同向/不同速的捲動 sin/噪聲場疊出偽法線 → fresnel（`V` 逐 fragment 變化，平 quad 上掠角梯度天然成立，opus 已確認技術成立）+ faint specular。頂點零改動、單一 quad。
- 透明度語意不變：維持 `regionSeaOpacity` 現值（bathymetry HANDLER 的 0.5/1.0 切換邏輯原封不動），shader 只在其上做 ±0.05 級的微調制——「很淡、接近透明」是硬需求，寧可淡到快看不見再往上調。
- 波紋參數走 styleSchema/params：`seaRippleStrength`（0–1，預設 ~0.3）、`seaRippleSpeed`；`seaAnimated` 開關（預設 on）。
- **on-demand render gate**：`isAnimating()` 加 `(seaAnimated && 海面板實際可見)`；`seaAnimated` off 或海面不可見 → uTime 凍結、renderCount 凍結。海面不 gate 在 `getPlaying()`（浪是牆鐘裝飾動畫，與時間軸無關，比照 typhoon）。**明示 trade（opus m2）**：Region 可見 + `seaAnimated` on ⇒ 永不 idle（等同 typhoon 常駐）——Region 預設關、`seaAnimated` 開關要放在面板好找的位置。可見性代理用 `regionVisible`即可（mask 載入前的短暫空轉可接受，opus m3）。
- 調色以 theme 紙質感為準：天色反射用米白系（japan 的 `#dfe6e2` 方向），不做飽和藍。
- **驗證分級：shader 改動 → 雙道**（實作自驗 + opus 終審截圖比對）。SwiftShader 下噪聲函數精度差異可能造成 banding——驗收以真 GPU 截圖為準（headless 只驗不炸/不黑屏）。

## 3. 檔案異動清單

| 檔案 | 動作 | 期 |
|------|------|-----|
| `scripts/bake_ship_trails.py` | 新增：抓 RPC → 精簡 → 產快照 JSON → rclone 上 R2（`ships/trails/`）；量測並回報 payload | 前置 |
| `src/engine/ships.js` | 新增（track 類圖層範本：CDN 快照優先 + RPC fallback） | A |
| `src/engine/index.js` | 註冊 ships、loader（提升 SUPABASE 常數作用域）、isAnimating 擴充、params；`demExaggeration: 1.6→1.0` | A |
| `src/engine/region.js` | 海面板 `onBeforeCompile` 注入波紋/fresnel + uniforms | B |
| `docs/HANDOFF.md` | #12/#13/#14 狀態更新 | 收尾 |

A（ships+比例尺）與 B（海面）可各自 worktree 平行。**merge 衝突注意（opus m1）：A 與 B 都改 `isAnimating()` 同一個函式**——兩個 term 由主迴圈 merge 時手動合，不是自動可解的相鄰行。

附帶已知（opus m5，cosmetic）：exaggeration 1.0 後 `zFightLift` 絕對值不變 → overlay 相對地形略「浮高」，不會 z-fight（更安全），視覺可接受，不處理。

## 4. 驗收準則（主迴圈執行）

1. `npm run build` 通過（A/B 各自與 merge 後）
2. ships：開圖層 → 當日船點出現在海上；60x 播放 → 船沿軌跡移動；scrub 跨日 → 換日資料載入（subscribeDate 首次實戰）；點船 → 卡片欄位對 trail 原始資料吻合；RPC 斷 → 空層不炸
3. 海面：波紋在真 GPU 可見且「淡」；`seaAnimated` off → renderCount 凍結；bathymetry on/off 切換透明度行為與現況一致
4. 四象限鐵則：ships 隱藏+播放、可見+暫停 → 凍結
5. 比例尺：開機 `getParams().demExaggeration === 1.0`；滑桿調 1.6 視覺回到現狀
