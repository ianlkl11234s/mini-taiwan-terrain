// Chunk streaming (route A P1): the set of live terrain chunks follows the
// pan target. Every ~200ms the desired set (tiles within `radius()` world
// units of the target) is recomputed; missing chunks queue near-to-far, their
// tile 3×3 neighbourhoods fetch async, and meshes build incrementally — at
// most 2 per frame inside a ~12ms budget, so dragging never blocks. Unloading
// uses a 1.3× hysteresis radius to avoid thrash at the boundary.

const RECOMPUTE_INTERVAL = 0.2 // seconds between desired-set recomputes
const MAX_FETCH_GROUPS = 6 // chunk tile-neighbourhoods fetching at once
const MAX_BUILDS_PER_TICK = 2
const BUILD_BUDGET_MS = 12
const UNLOAD_FACTOR = 1.3

const keyOf = (tx, ty) => tx + ',' + ty

export class ChunkManager {
  constructor(terrain, { radius }) {
    this.terrain = terrain
    this.radius = radius // () => world units (fog far × 1.15)
    this.enabled = false
    this.queue = [] // [{tx, ty, k, d2, state: pending|fetching|ready, rebuild}]
    this.queued = new Map() // k → queue entry
    this.onChunksChanged = null // hook: static shadow maps need a re-render
    this._acc = RECOMPUTE_INTERVAL // force a recompute on first update
    this._last = { x: 0, z: 0 }
  }

  setEnabled(on) {
    this.enabled = on
    if (on) this._acc = RECOMPUTE_INTERVAL
  }

  // drop everything (leaving real mode)
  clear() {
    for (const k of [...this.terrain.chunkMap.keys()]) this.terrain.removeChunk(k)
    this.queue = []
    this.queued.clear()
  }

  // re-queue every live chunk for rebuild (sampler changed: vertical scale,
  // chunk resolution, seed). Old meshes stay up until their replacement builds
  // — the world updates near-to-far without a synchronous full rebuild.
  invalidate() {
    for (const [k, mesh] of this.terrain.chunkMap) {
      const existing = this.queued.get(k)
      if (existing) {
        existing.rebuild = true
        continue
      }
      const [tx, ty] = k.split(',').map(Number)
      const dx = mesh.position.x - this._last.x
      const dz = mesh.position.z - this._last.z
      this._enqueue(tx, ty, dx * dx + dz * dz, true)
    }
    this.queue.sort((a, b) => a.d2 - b.d2)
    this._acc = RECOMPUTE_INTERVAL
  }

  update(dt, targetX, targetZ) {
    if (!this.enabled || !this.terrain.heightField) return
    this._last.x = targetX
    this._last.z = targetZ
    this._acc += dt
    if (this._acc >= RECOMPUTE_INTERVAL) {
      this._acc = 0
      this._recompute(targetX, targetZ)
    }
    this._pump()
  }

  _enqueue(tx, ty, d2, rebuild) {
    const e = { tx, ty, k: keyOf(tx, ty), d2, state: 'pending', rebuild }
    this.queue.push(e)
    this.queued.set(e.k, e)
  }

  _recompute(cx, cz) {
    const proj = this.terrain.heightField.projection
    const R = this.radius()
    const R2 = R * R
    const { px, py } = proj.worldToPixel(cx, cz)
    const ctx = Math.floor(px / 256)
    const cty = Math.floor(py / 256)
    const tR = Math.ceil(R / proj.tileWorldSize) + 1
    const desired = new Set()
    for (let dy = -tR; dy <= tR; dy++) {
      for (let dx = -tR; dx <= tR; dx++) {
        const tx = ctx + dx
        const ty = cty + dy
        const c = proj.tileCenterWorld(tx, ty)
        const d2 = (c.x - cx) * (c.x - cx) + (c.z - cz) * (c.z - cz)
        if (d2 > R2) continue
        const k = keyOf(tx, ty)
        desired.add(k)
        const queued = this.queued.get(k)
        if (queued) queued.d2 = d2
        else if (!this.terrain.chunkMap.has(k)) this._enqueue(tx, ty, d2, false)
      }
    }
    // unload with hysteresis: chunks in the R..1.3R band stay put
    const rOut2 = R2 * UNLOAD_FACTOR * UNLOAD_FACTOR
    for (const [k, mesh] of this.terrain.chunkMap) {
      if (desired.has(k)) continue
      const dx = mesh.position.x - cx
      const dz = mesh.position.z - cz
      if (dx * dx + dz * dz > rOut2) this.terrain.removeChunk(k)
    }
    // drop queued work that fell out of range (keep rebuilds of live chunks)
    this.queue = this.queue.filter((e) => {
      const keep = desired.has(e.k) || (e.rebuild && this.terrain.chunkMap.has(e.k))
      if (!keep) this.queued.delete(e.k)
      return keep
    })
    this.queue.sort((a, b) => a.d2 - b.d2)
  }

  _pump() {
    const hf = this.terrain.heightField
    // kick tile fetches for the nearest pending chunks
    let inFlight = 0
    for (const e of this.queue) if (e.state === 'fetching') inFlight++
    for (const e of this.queue) {
      if (inFlight >= MAX_FETCH_GROUPS) break
      if (e.state !== 'pending') continue
      e.state = 'fetching'
      inFlight++
      const coords = []
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) coords.push({ tx: e.tx + dx, ty: e.ty + dy })
      }
      hf.ensureTiles(coords).then(() => {
        // entry may have been dropped/replaced while fetching — only promote our own
        if (this.queued.get(e.k) === e) e.state = 'ready'
      })
    }
    // build the nearest ready chunks within this frame's budget
    const t0 = performance.now()
    let built = 0
    while (built < MAX_BUILDS_PER_TICK && performance.now() - t0 < BUILD_BUDGET_MS) {
      const i = this.queue.findIndex((e) => e.state === 'ready') // queue is distance-sorted
      if (i === -1) break
      const e = this.queue[i]
      this.queue.splice(i, 1)
      this.queued.delete(e.k)
      if (e.rebuild) this.terrain.removeChunk(e.k)
      this.terrain.addChunk(e.tx, e.ty)
      built++
    }
    if (built && this.onChunksChanged) this.onChunksChanged()
  }
}
