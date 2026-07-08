# Terrain Art — 台灣 3D 地形視覺化

台灣版的互動 3D 地形圖：復古 USGS 地形圖紙質感 + FUI 掃描介面，載入**台灣真實高程**（玉山、雪山、大霸尖山、太魯閣…8 個 preset，或自訂經緯度），以等高線、分層設色、測量網格、真實山峰 POI 與電影式飛覽探索。

Fork 自 [kaolti/monolith-terrain](https://github.com/kaolti/monolith-terrain)（MIT），資料源由 AWS Terrain Tiles 換成自家 NLSC 20m DTM 圖磚，並加上真實山峰標註與台灣 preset。

## 資料來源

- **高程**：內政部國土測繪中心（NLSC）20 公尺網格數值地形模型（DTM），2024 年版，[政府資料開放授權條款](https://data.gov.tw/license)。已重編碼為 terrarium RGB PNG XYZ 圖磚（z10–13，`meters = R*256 + G + B/256 - 32768`；純海域 tile 不產生，缺 tile 視為海平面 0 m）。
- **山峰**：`src/data/peaks.json`（40 筆，name / elev / lat / lon）。

## 圖磚接線

圖磚不進 git（`public/tiles` 已 ignore）。兩種接法：

```bash
# A. symlink 到本機圖磚目錄（開發用）
ln -s /path/to/taipei-gis-analytics/data/processed/base_map/terrain_rgb/tiles public/tiles

# B. 環境變數指到任一 tile server / CDN
VITE_TILE_BASE=https://example.com/tiles npm run dev
```

未設 `VITE_TILE_BASE` 時預設抓 `/tiles/{z}/{x}/{y}.png`。

## Dev

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # 靜態產物在 dist/
```

## 操作

| 動作 | 方式 |
|---|---|
| 環視 | 拖曳旋轉、滾輪縮放、右鍵平移 |
| 看某座山 | 點山峰標籤（真名 + 海拔）— 鏡頭飛入並開啟資料卡 |
| 電影式飛覽 | 左側面板 **Tour** 選 from / to，按 **▶ start tour** |
| 換地點 | **Terrain source → location** 選 preset，或 Custom + 經緯度後按 **load location** |
| 雷達掃描 | **HUD → trigger scan** |

## License

[MIT](LICENSE) — 沿用上游 kaolti/monolith-terrain 之授權，LICENSE 檔保留原作者版權聲明。
