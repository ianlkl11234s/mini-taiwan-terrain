import { useEffect, useRef, useState } from 'react'
import { T, FONT_DATA, FONT_CJK } from '../../theme.js'
import { Row, Toggle, Slider, ColorSwatch, Icon } from '../controls.jsx'

// 圖層面板：完全由 engine.listLayers() 動態渲染 — 三層資訊架構 主題(group) →
// 子群(subgroup，僅視覺分組) → 圖層(toggle + 依 styleSchema 的樣式控制，或
// marker 類 layer 的 set 動態列表)。每個 layer 的 group/subgroup 由引擎註冊
// 處（src/engine/index.js LAYER_GROUPS）指派、layers.js describe() 曝露 —
// 這裡完全不硬編 layer id，新圖層帶 metadata 就自動歸位。訂閱 'layers' 事件
// 即時更新；主題收合/圖層樣式展開狀態只存在 React state（不持久化）。

// group layers by their (engine-assigned) group, preserving registration
// order within each group and ordering groups by group.order
function groupLayers(layers) {
  const byId = new Map()
  for (const l of layers) {
    const g = l.group
    if (!byId.has(g.id)) byId.set(g.id, { group: g, items: [] })
    byId.get(g.id).items.push(l)
  }
  return [...byId.values()].sort((a, b) => (a.group.order ?? 0) - (b.group.order ?? 0))
}

// split one theme's layers into consecutive subgroup buckets (null subgroup =
// listed directly under the theme, no tag row)
function bucketBySubgroup(items) {
  const buckets = []
  let current = null
  for (const item of items) {
    const key = item.subgroup?.id ?? null
    if (!current || current.key !== key) {
      current = { key, subgroup: item.subgroup ?? null, items: [] }
      buckets.push(current)
    }
    current.items.push(item)
  }
  return buckets
}

// Turn one layer fully on/off through the EXISTING facade only — no new
// engine surface. Plain param-backed layers (rail/rivers/reservoirs/…) go
// through setLayerVisible, exactly like their own row's toggle always has.
// Marker-set layers (stations/trail signs/markers) have no bulk visibility
// hook (their own setVisible only ever triggers the one-shot onActivate
// fetch), so "off" walks every set via setLayerSet — the same call each set's
// own toggle row already makes. Used by the theme master switch + All Off.
function setLayerFullyVisible(engine, layer, visible) {
  if (layer.sets) {
    for (const s of layer.sets) {
      if (s.visible !== visible) engine.setLayerSet(layer.id, s.id, { visible })
    }
  } else {
    engine.setLayerVisible(layer.id, visible)
  }
}

export default function Layers({ engine }) {
  const [layers, setLayers] = useState(() => engine.listLayers())
  useEffect(() => engine.on('layers', () => setLayers(engine.listLayers())), [engine])

  const [collapsed, setCollapsed] = useState(() => new Set()) // theme ids collapsed (default: all expanded)
  const [expandedStyle, setExpandedStyle] = useState(() => new Set()) // layer ids with style controls open
  // theme master-toggle memory: group.id -> layer ids that were on right
  // before the group was switched off (session-only, not persisted)
  const lastOnRef = useRef({})

  const groups = groupLayers(layers)

  return (
    <div>
      <button
        onClick={() => layers.forEach((l) => setLayerFullyVisible(engine, l, false))}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'block',
          width: '100%',
          boxSizing: 'border-box',
          textAlign: 'center',
          fontFamily: FONT_DATA,
          fontSize: T.fs.sm,
          fontWeight: 700,
          letterSpacing: '0.2em',
          padding: '6px 8px',
          borderRadius: T.radius.lg,
          color: T.textDim,
          background: T.ctrlInactiveBg,
          border: `1px solid ${T.ctrlInactiveBorder}`,
          margin: '2px 2px 10px',
        }}
      >
        ALL OFF
      </button>

      {groups.map(({ group, items }) => {
        const expanded = !collapsed.has(group.id)
        const openCount = items.filter((l) => l.visible).length
        return (
          <div key={group.id}>
            <GroupHeader
              group={group}
              openCount={openCount}
              total={items.length}
              expanded={expanded}
              onToggleExpand={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(group.id)) next.delete(group.id)
                  else next.add(group.id)
                  return next
                })
              }
              onToggleGroup={(v) => {
                if (v) {
                  const remembered = lastOnRef.current[group.id]
                  const idSet = new Set(remembered && remembered.length ? remembered : items.map((l) => l.id))
                  for (const l of items) if (idSet.has(l.id)) setLayerFullyVisible(engine, l, true)
                } else {
                  lastOnRef.current[group.id] = items.filter((l) => l.visible).map((l) => l.id)
                  for (const l of items) setLayerFullyVisible(engine, l, false)
                }
              }}
            />
            {expanded &&
              bucketBySubgroup(items).map((bucket, bi) => (
                <div key={bucket.key ?? `_${bi}`}>
                  {bucket.subgroup && <SubgroupTag>{bucket.subgroup.label}</SubgroupTag>}
                  {bucket.items.map((layer) => (
                    <LayerRow
                      key={layer.id}
                      engine={engine}
                      layer={layer}
                      expanded={expandedStyle.has(layer.id)}
                      onToggleExpand={() =>
                        setExpandedStyle((prev) => {
                          const next = new Set(prev)
                          if (next.has(layer.id)) next.delete(layer.id)
                          else next.add(layer.id)
                          return next
                        })
                      }
                    />
                  ))}
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

// 主題列：chevron 展開/收合 + 主題名 + 已開計數（n/m）+ 主題總開關。
// 總開關的「開」定義：主題內至少一層可見（anyOn）；點擊行為：關 = 全關（並記住
// 當下開啟的圖層供下次「開」還原）；開 = 還原上次記住的集合，若無記錄（或記錄
// 為空）則全開。行為單純一致：不管關閉前是全開還是只開一部分，「關」永遠全關；
// 「開」永遠回到關閉前那個狀態（或第一次時的全開）。
function GroupHeader({ group, openCount, total, expanded, onToggleExpand, onToggleGroup }) {
  return (
    <div
      onClick={onToggleExpand}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '7px 8px 4px',
        marginTop: 4,
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            display: 'flex',
            color: T.textFaint,
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.15s',
          }}
        >
          <Icon name="chevronDown" size={12} strokeWidth={2} />
        </span>
        <span
          style={{
            fontFamily: FONT_DATA,
            fontSize: T.fs.xs,
            fontWeight: 700,
            letterSpacing: '0.26em',
            color: T.textFaint,
            textTransform: 'uppercase',
          }}
        >
          {group.label}
        </span>
        <span style={{ fontFamily: FONT_DATA, fontSize: T.fs.xs, color: T.textFaint, fontVariantNumeric: 'tabular-nums' }}>
          {openCount}/{total}
        </span>
      </span>
      <span onClick={(e) => e.stopPropagation()}>
        <Toggle on={openCount > 0} onChange={onToggleGroup} />
      </span>
    </div>
  )
}

function SubgroupTag({ children }) {
  return (
    <div
      style={{
        fontFamily: FONT_DATA,
        fontSize: 8,
        letterSpacing: '0.18em',
        color: T.textFaint,
        textTransform: 'uppercase',
        margin: '4px 8px 2px 18px',
      }}
    >
      {children}
    </div>
  )
}

// one layer within a theme: marker-set layers (stations/trail signs/markers)
// render their per-set toggle list once activated; everything else is a
// name+toggle row, with a chevron unlocking its styleSchema controls (kept
// collapsed by default — the improvement over the old always-shown layout).
function LayerRow({ engine, layer, expanded, onToggleExpand }) {
  if (layer.sets !== undefined) {
    return <MarkerSetLayer engine={engine} layer={layer} />
  }
  const hasStyle = !!layer.styleSchema
  return (
    <>
      <Row label={layer.rowLabel ?? layer.label}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {hasStyle && (
            <button
              onClick={onToggleExpand}
              title={expanded ? '收合樣式 Collapse' : '展開樣式 Expand'}
              style={{
                all: 'unset',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                color: T.textFaint,
                transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 0.15s',
              }}
            >
              <Icon name="chevronDown" size={12} strokeWidth={2} />
            </button>
          )}
          <Toggle on={layer.visible} onChange={(v) => engine.setLayerVisible(layer.id, v)} />
        </span>
      </Row>
      {hasStyle && layer.visible && expanded && (
        <div style={{ marginLeft: 10 }}>
          {Object.entries(layer.styleSchema).map(([key, sch]) => (
            <StyleControl key={key} value={layer.style[key]} schema={sch} onChange={(v) => engine.setLayerStyle(layer.id, { [key]: v })} />
          ))}
        </div>
      )}
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

// marker sets: the layer's own name as a small label, then a dynamic list —
// one toggle per set (per-system visibility, e.g. one row per transit system)
function MarkerSetLayer({ engine, layer }) {
  const sets = layer.sets
  return (
    <div>
      <div style={{ fontFamily: FONT_CJK, fontSize: T.fs.md, color: T.textDefault, padding: '5px 8px 0' }}>{layer.rowLabel ?? layer.label}</div>
      <div style={{ marginLeft: 10 }}>
        {sets.length === 0 ? (
          <div style={{ fontFamily: FONT_DATA, fontSize: T.fs.sm, color: T.textFaint, padding: '2px 8px' }}>NO MARKER SETS</div>
        ) : (
          sets.map((s) => (
            <Row key={s.id} label={s.id}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: FONT_DATA, fontSize: T.fs.sm, color: T.textFaint }}>{s.count} PTS</span>
                <Toggle on={s.visible} onChange={(v) => engine.setLayerSet(layer.id, s.id, { visible: v })} />
              </span>
            </Row>
          ))
        )}
      </div>
    </div>
  )
}
