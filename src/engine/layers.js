// LayerManager: an ordered registry of GIS overlay layers over the terrain.
// The engine drives every layer through two batch calls — updateAll() from the
// regenerateTerrain path and tickAll() from the (non-idle) tick — instead of
// naming each overlay by hand in three places. Adding a new layer next stage is
// `layers.register(makeXxxLayer(...), ctx)`, not a cross-file edit.
//
// Every layer implements the Layer interface:
//   { id, kind: 'point'|'line'|'area'|'label', object3d,
//     build(ctx)?, update(ctx)?, tickView(ctx)?,
//     setVisible(bool)?, setStyle(patch)?, dispose()?, describe() }
//   describe() → { id, kind, label, rowLabel?, count, visible, styleSchema, style, sets? }
//
// ctx (built fresh by the engine per call) carries the live world state a layer
// might need: { params, heightField, projection, camera, fogScale, dt,
// lineResolution, sample, seed, real, toFeet, labelCenter, spots }.

export class LayerManager {
  constructor(scene) {
    this.scene = scene
    this.layers = new Map() // insertion-ordered — updateAll/tickAll/describe follow it
  }

  register(layer, ctx) {
    this.layers.set(layer.id, layer)
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

  describe() {
    return [...this.layers.values()].map((l) => l.describe())
  }

  dispose() {
    for (const layer of this.layers.values()) layer.dispose?.()
  }
}
