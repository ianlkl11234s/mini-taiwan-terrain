import { useCallback, useEffect, useState } from 'react'
import { T } from '../../theme.js'
import { SectionHeader, Row, Slider, Segmented, ColorSwatch, Toggle } from '../controls.jsx'

// 設定面板（精選）。rebuild 類參數（demExaggeration / chunkRes）只在放開/點選時
// commit — R1 的教訓：live 送會連環觸發全地形重建。

export default function Settings({ engine }) {
  const [p, setP] = useState(() => ({ ...engine.getParams() }))

  useEffect(() => engine.on('params', () => setP({ ...engine.getParams() })), [engine])

  const live = useCallback(
    (key) => (v) => {
      engine.setParams({ [key]: v })
      setP((prev) => ({ ...prev, [key]: v }))
    },
    [engine]
  )
  const commit = useCallback((key) => (v) => engine.setParams({ [key]: v }), [engine])

  return (
    <div>
      <SectionHeader>View</SectionHeader>
      <Slider label="視距 View distance" min={1} max={3.75} step={0.05} value={p.viewRange} onChange={live('viewRange')} format={(v) => `${v.toFixed(2)}×`} />
      <Slider
        label="垂直放大 Vertical scale"
        min={0.5}
        max={5}
        step={0.1}
        value={p.demExaggeration}
        commit={commit('demExaggeration')}
        format={(v) => `${v.toFixed(1)}×`}
      />
      <Row label="品質 Quality">
        <Segmented options={[32, 64, 128]} value={p.chunkRes} onChange={(v) => { engine.setParams({ chunkRes: v }); setP((prev) => ({ ...prev, chunkRes: v })) }} />
      </Row>
      <Row label="精緻度 Detail">
        {/* 標準 = 現況；高 = LOD +1（遠景更銳利）；超高 = +1 且外環滿解析（實驗性，島景重） */}
        <Segmented
          options={['標準', '高', '超高']}
          value={p.detailBias ? (p.outerChunkRes >= 128 ? '超高' : '高') : '標準'}
          onChange={(label) => {
            const patch =
              label === '標準'
                ? { detailBias: 0, outerChunkRes: 64 }
                : label === '高'
                  ? { detailBias: 1, outerChunkRes: 64 }
                  : { detailBias: 1, outerChunkRes: 128 }
            engine.setParams(patch)
            setP((prev) => ({ ...prev, ...patch }))
          }}
        />
      </Row>

      <SectionHeader>Peaks</SectionHeader>
      <Slider label="搜尋半徑 Radius" min={0} max={80} step={5} value={p.peakRadiusKm} onChange={live('peakRadiusKm')} format={(v) => v === 0 ? '自動' : `${v} km`} />
      <Slider label="顯示數量 Max peaks" min={3} max={100} step={1} value={p.peakLimit} onChange={live('peakLimit')} format={(v) => String(v)} />
      <Slider label="最低海拔 Min elevation" min={0} max={3000} step={100} value={p.peakMinElev} onChange={live('peakMinElev')} format={(v) => `${v} m`} />

      <SectionHeader>Map</SectionHeader>
      <Slider label="等高線間距 Contour interval" min={0.04} max={0.6} step={0.01} value={p.contourInterval} onChange={live('contourInterval')} format={(v) => v.toFixed(2)} />
      <Slider label="等高線濃度 Contour opacity" min={0} max={1} step={0.02} value={p.contourOpacity} onChange={live('contourOpacity')} format={(v) => v.toFixed(2)} />
      <Slider label="顆粒 Grain" min={0} max={0.5} step={0.01} value={p.grain} onChange={live('grain')} format={(v) => v.toFixed(2)} />
      <Row label="海底地形 Bathymetry">
        <Toggle on={p.bathymetryVisible} onChange={live('bathymetryVisible')} />
      </Row>

      <SectionHeader>Theme</SectionHeader>
      <Row label="強調色 Accent">
        <ColorSwatch
          value={p.hudAccent}
          onCommit={(v) => {
            engine.setParams({ hudAccent: v }) // rebuilds the 3D FUI layer
            document.documentElement.style.setProperty('--hud-accent', v) // POI tags / kickers
          }}
        />
      </Row>
    </div>
  )
}
