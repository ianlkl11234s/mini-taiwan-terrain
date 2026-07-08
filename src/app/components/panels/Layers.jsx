import { useCallback, useEffect, useState } from 'react'
import { T, FONT_DATA } from '../../theme.js'
import { SectionHeader, Row, Toggle, Slider, ColorSwatch } from '../controls.jsx'

// 圖層面板：coastline / counties 各四參數、marker sets 動態列表、peak labels。
// 這些全是非 rebuild 參數 → slider 走 live onChange（debugPanel 同款）。

export default function Layers({ engine }) {
  const [p, setP] = useState(() => ({ ...engine.getParams() }))
  const [sets, setSets] = useState(() => engine.listMarkerSets())

  useEffect(() => engine.on('params', () => setP({ ...engine.getParams() })), [engine])

  const set = useCallback(
    (key) => (v) => {
      engine.setParams({ [key]: v })
      setP((prev) => ({ ...prev, [key]: v }))
    },
    [engine]
  )

  const toggleSet = (id, visible) => {
    engine.setMarkerSet(id, { visible })
    setSets(engine.listMarkerSets())
  }

  return (
    <div>
      <SectionHeader>Coastline</SectionHeader>
      <Row label="海岸線 Coastline">
        <Toggle on={p.coastline} onChange={set('coastline')} />
      </Row>
      {p.coastline && (
        <>
          <Slider label="線寬 Width" min={0.5} max={8} step={0.1} value={p.coastlineWidth} onChange={set('coastlineWidth')} format={(v) => v.toFixed(1)} />
          <Slider label="不透明度 Opacity" min={0} max={1} step={0.02} value={p.coastlineOpacity} onChange={set('coastlineOpacity')} format={(v) => v.toFixed(2)} />
          <Row label="顏色 Color">
            <ColorSwatch value={p.coastlineColor} onCommit={set('coastlineColor')} />
          </Row>
        </>
      )}

      <SectionHeader>Counties</SectionHeader>
      <Row label="縣市界 Counties">
        <Toggle on={p.counties} onChange={set('counties')} />
      </Row>
      {p.counties && (
        <>
          <Slider label="線寬 Width" min={0.5} max={6} step={0.1} value={p.countiesWidth} onChange={set('countiesWidth')} format={(v) => v.toFixed(1)} />
          <Slider label="不透明度 Opacity" min={0} max={1} step={0.02} value={p.countiesOpacity} onChange={set('countiesOpacity')} format={(v) => v.toFixed(2)} />
          <Row label="顏色 Color">
            <ColorSwatch value={p.countiesColor} onCommit={set('countiesColor')} />
          </Row>
        </>
      )}

      <SectionHeader>Markers</SectionHeader>
      {sets.length === 0 && (
        <div style={{ fontFamily: FONT_DATA, fontSize: T.fs.sm, color: T.textFaint, padding: '2px 8px' }}>NO MARKER SETS</div>
      )}
      {sets.map((s) => (
        <Row key={s.id} label={`${s.id}`}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: FONT_DATA, fontSize: T.fs.sm, color: T.textFaint }}>{s.count} PTS</span>
            <Toggle on={s.visible} onChange={(v) => toggleSet(s.id, v)} />
          </span>
        </Row>
      ))}

      <SectionHeader>Labels</SectionHeader>
      <Row label="山峰標籤 Peak labels">
        <Toggle on={p.labels} onChange={set('labels')} />
      </Row>
    </div>
  )
}
