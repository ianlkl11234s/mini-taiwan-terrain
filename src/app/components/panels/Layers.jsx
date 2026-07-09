import { useEffect, useState } from 'react'
import { T, FONT_DATA } from '../../theme.js'
import { SectionHeader, Row, Toggle, Slider, ColorSwatch } from '../controls.jsx'

// 圖層面板：完全由 engine.listLayers() 動態渲染 — 每個 layer 一個區塊（toggle +
// 依 styleSchema 的樣式控制），marker 類 layer 展開成 set 動態列表。訂閱 'layers'
// 事件即時更新。新增圖層時面板自動長出來，不用改這裡。

export default function Layers({ engine }) {
  const [layers, setLayers] = useState(() => engine.listLayers())
  useEffect(() => engine.on('layers', () => setLayers(engine.listLayers())), [engine])

  return (
    <div>
      {layers.map((layer) => (
        <LayerBlock key={layer.id} engine={engine} layer={layer} />
      ))}
    </div>
  )
}

function LayerBlock({ engine, layer }) {
  return (
    <>
      <SectionHeader>{layer.label}</SectionHeader>
      {layer.sets ? <MarkerSets engine={engine} layerId={layer.id} sets={layer.sets} /> : <SingleLayer engine={engine} layer={layer} />}
    </>
  )
}

// coastline / counties / labels: one toggle row + (when on) styleSchema controls
function SingleLayer({ engine, layer }) {
  return (
    <>
      <Row label={layer.rowLabel ?? layer.label}>
        <Toggle on={layer.visible} onChange={(v) => engine.setLayerVisible(layer.id, v)} />
      </Row>
      {layer.visible &&
        layer.styleSchema &&
        Object.entries(layer.styleSchema).map(([key, sch]) => (
          <StyleControl key={key} value={layer.style[key]} schema={sch} onChange={(v) => engine.setLayerStyle(layer.id, { [key]: v })} />
        ))}
    </>
  )
}

function StyleControl({ value, schema, onChange }) {
  if (schema.type === 'color') {
    return (
      <Row label={schema.label}>
        <ColorSwatch value={value} onCommit={onChange} />
      </Row>
    )
  }
  // slider (live onChange — all layer style params are non-rebuild)
  return <Slider label={schema.label} min={schema.min} max={schema.max} step={schema.step} value={value} onChange={onChange} format={schema.format} />
}

// marker sets: dynamic list, one toggle each (per-set visibility)
function MarkerSets({ engine, layerId, sets }) {
  if (sets.length === 0) {
    return <div style={{ fontFamily: FONT_DATA, fontSize: T.fs.sm, color: T.textFaint, padding: '2px 8px' }}>NO MARKER SETS</div>
  }
  return sets.map((s) => (
    <Row key={s.id} label={s.id}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: FONT_DATA, fontSize: T.fs.sm, color: T.textFaint }}>{s.count} PTS</span>
        <Toggle on={s.visible} onChange={(v) => engine.setLayerSet(layerId, s.id, { visible: v })} />
      </span>
    </Row>
  ))
}
