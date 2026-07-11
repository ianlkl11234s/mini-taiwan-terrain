// LayerManager: an ordered registry of GIS overlay layers over the terrain.
// The engine drives every layer through two batch calls — updateAll() from the
// regenerateTerrain path and tickAll() from the (non-idle) tick — instead of
// naming each overlay by hand in three places. Adding a new layer next stage is
// `layers.register(makeXxxLayer(...), ctx, meta)`, not a cross-file edit.
//
// Every layer implements the Layer interface:
//   { id, kind: 'point'|'line'|'area'|'label', object3d,
//     build(ctx)?, update(ctx)?, tickView(ctx)?,
//     setVisible(bool)?, setStyle(patch)?, pick(raycaster)?, dispose()?, describe() }
//   describe() → { id, kind, label, rowLabel?, count, visible, styleSchema, style, sets? }
//
// pick(raycaster) is OPTIONAL — click-to-inspect (see index.js pointerup
// handler). A layer that implements it returns either null (no hit) or
// { title, rows: [[label, value], ...], worldPos: THREE.Vector3 } for its own
// single nearest feature. Layers without a pick() are skipped automatically
// by pickAll() below, so adding pick support to a future layer is opt-in — no
// change needed anywhere else. Two conventions the engine sets on the shared
// raycaster before calling pickAll (see index.js), which pick() implementations
// may rely on:
//   - raycaster.camera        — standard three.js field (set by setFromCamera);
//     needed by Line2/LineSegments2.raycast and usable for manual `.project()`
//   - raycaster.params.Line2  — { threshold } in CSS px, added to the fat
//     line's own linewidth for LineSegments2/Line2 hit-testing
//   - raycaster.pickPx        — { x, y } CSS-pixel screen position of the
//     click; point/instanced layers project each candidate with
//     raycaster.camera and compare in pixel space (world-space thresholds
//     don't scale well against dense point sets — see markers.js)
//
// ctx (built fresh by the engine per call) carries the live world state a layer
// might need: { params, heightField, projection, camera, fogScale, dt,
// lineResolution, sample, seed, real, toFeet, labelCenter, spots }.
//
// meta (register's 3rd arg, optional): { group: {id,label,order}, subgroup?:
// {id,label} } — the Layers panel's 主題/子群 grouping. Layer modules never
// carry this themselves (it's presentation, not rendering); the engine's
// registration site (index.js) is the single place that assigns it, so a new
// layer lands in the right theme by adding one entry there — Layers.jsx never
// needs an edit. A layer registered with no meta (or an unrecognized group)
// falls back to UNGROUPED so it still shows up instead of silently vanishing.

export const UNGROUPED = { id: 'misc', label: '其他 Other', order: 99 }

export class LayerManager {
  constructor(scene) {
    this.scene = scene
    this.layers = new Map() // insertion-ordered — updateAll/tickAll/describe follow it
    this.meta = new Map() // id -> { group, subgroup } (panel grouping only)
  }

  register(layer, ctx, meta = {}) {
    this.layers.set(layer.id, layer)
    this.meta.set(layer.id, meta)
    layer.build?.(ctx)
    if (layer.object3d) this.scene.add(layer.object3d)
    return layer
  }

  get(id) {
    return this.layers.get(id)
  }

  updateAll(ctx) {
    for (const layer of this.layers.values()) layer.update?.(ctx)
  }

  tickAll(ctx) {
    for (const layer of this.layers.values()) layer.tickView?.(ctx)
  }

  // click-only feature picking (no hover — see index.js pointerup handler).
  // Walks visible layers in REVERSE registration order (later-registered
  // layers draw on top, so they get first refusal) and returns the first
  // layer's own nearest hit — not a cross-layer distance comparison, since
  // line/point features carry incomparable "distance" semantics (segment-
  // perpendicular px vs point-projected px). A layer with no pick() is
  // skipped; a coarse object3d.visible pre-check saves the per-layer work for
  // anything switched off.
  pickAll(raycaster) {
    const ordered = [...this.layers.values()].reverse()
    for (const layer of ordered) {
      if (typeof layer.pick !== 'function') continue
      if (layer.object3d && layer.object3d.visible === false) continue
      const hit = layer.pick(raycaster)
      if (hit) return { ...hit, layerId: layer.id }
    }
    return null
  }

  describe() {
    return [...this.layers.values()].map((l) => {
      const meta = this.meta.get(l.id) || {}
      return { ...l.describe(), group: meta.group ?? UNGROUPED, subgroup: meta.subgroup ?? null }
    })
  }

  dispose() {
    for (const layer of this.layers.values()) layer.dispose?.()
  }
}
