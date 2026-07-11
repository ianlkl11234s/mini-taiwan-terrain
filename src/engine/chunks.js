// Chunk streaming (route A P1 + LOD rings P2): the set of live terrain chunks
// follows the pan target. Every ~200ms the desired set is recomputed as two
// concentric LOD rings — an inner disk (R1 = 0.55 × streaming radius) at the
// distance-driven target zoom with the full grid res, and an outer annulus
// (out to the streaming radius) one zoom coarser at half res. Missing chunks
// queue near-to-far, their tile 3×3 neighbourhoods fetch async, and meshes
// build incrementally — at most 2 per frame inside a ~12ms budget, so
// dragging never blocks. Unloading uses a 1.3× hysteresis radius, plus
// coverage-based removal for stale-LOD chunks: after a zoom re-target, an old
// chunk drops the moment the desired chunks tiling its footprint are all live
// (the terrain visibly "re-focuses" through the fog).

const RECOMPUTE_INTERVAL = 0.2 // seconds between desired-set recomputes
const MAX_FETCH_GROUPS = 6 // chunk tile-neighbourhoods fetching at once
const MAX_BUILDS_PER_TICK = 2
const BUILD_BUDGET_MS = 12
const UNLOAD_FACTOR = 1.3
const INNER_FRACTION = 0.55 // inner LOD ring = this × streaming radius
const MIN_ZOOM = 10

const keyOf = (zoom, tx, ty) => zoom + '/' + tx + '/' + ty

export class ChunkManager {
  constructor(terrain, { radius, targetZoom, innerRes, outerRes }) {
    this.terrain = terrain
    this.radius = radius // () => world units (effective fog far × 1.15)
    this.targetZoom = targetZoom // () => LOD zoom for the inner ring (10–13)
    this.innerRes = innerRes // () => grid res for inner-ring chunks
    this.outerRes = outerRes // () => grid res for outer-ring chunks (≤ innerRes)
    this.enabled = false
    this.queue = [] // [{zoom, tx, ty, res, k, d2, state: pending|fetching|ready, rebuild}]
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
      const { zoom, tx, ty, res } = mesh.userData
      const dx = mesh.position.x - this._last.x
      const dz = mesh.position.z - this._last.z
      this._enqueue(zoom, tx, ty, res, dx * dx + dz * dz, true)
    }
    this.queue.sort((a, b) => a.d2 - b.d2)
    this._acc = RECOMPUTE_INTERVAL
  }

  update(dt, targetX, targetZ) {
    if (!this.enabled || !this.terrain.heightFields) return
    this._last.x = targetX
    this._last.z = targetZ
    this._acc += dt
    if (this._acc >= RECOMPUTE_INTERVAL) {
      this._acc = 0
      this._recompute(targetX, targetZ)
    }
    this._pump()
  }

  _enqueue(zoom, tx, ty, res, d2, rebuild) {
    const e = { zoom, tx, ty, res, k: keyOf(zoom, tx, ty), d2, state: 'pending', rebuild }
    this.queue.push(e)
    this.queued.set(e.k, e)
  }

  _recompute(cx, cz) {
    const fields = this.terrain.heightFields
    const tz = this.targetZoom()
    const oz = Math.max(MIN_ZOOM, tz - 1)
    const single = oz === tz // targetZoom 10: one ring, all z10
    const hfI = fields.get(tz)
    const hfO = fields.get(oz)
    const projI = hfI.projection
    const projO = hfO.projection
    const R = this.radius()
    const R2 = R * R
    const R1sq = R * INNER_FRACTION * (R * INNER_FRACTION)
    const resI = this.innerRes()
    const resO = Math.max(16, Math.min(this.outerRes(), resI)) // never finer than the inner ring

    // Desired set, assembled at OUTER-tile granularity: an outer tile whose 4
    // child tiles all sit inside R1 contributes the children (inner zoom,
    // fine grid) instead of itself — a perfect partition, no overlap and no
    // hole, with the ring boundary snapped to outer-tile edges. Outside the
    // Taiwan bbox nothing is requested or built (it's all open sea), which is
    // what keeps the whole-island view at ~46 land tiles.
    const desired = new Map() // k → {zoom, tx, ty, res, d2}
    const { px, py } = projO.worldToPixel(cx, cz)
    const ctx = Math.floor(px / 256)
    const cty = Math.floor(py / 256)
    const tR = Math.ceil(R / projO.tileWorldSize) + 1
    for (let dy = -tR; dy <= tR; dy++) {
      for (let dx = -tR; dx <= tR; dx++) {
        const tx = ctx + dx
        const ty = cty + dy
        if (!hfO.inTaiwan(tx, ty)) continue
        const c = projO.tileCenterWorld(tx, ty)
        const d2 = (c.x - cx) * (c.x - cx) + (c.z - cz) * (c.z - cz)
        if (d2 > R2) continue
        if (!single) {
          let allInner = true
          const children = []
          for (let sy = 0; sy <= 1 && allInner; sy++) {
            for (let sx = 0; sx <= 1; sx++) {
              const itx = tx * 2 + sx
              const ity = ty * 2 + sy
              const ic = projI.tileCenterWorld(itx, ity)
              const id2 = (ic.x - cx) * (ic.x - cx) + (ic.z - cz) * (ic.z - cz)
              if (id2 > R1sq) {
                allInner = false
                break
              }
              children.push({ tx: itx, ty: ity, d2: id2 })
            }
          }
          if (allInner) {
            for (const ch of children) {
              if (!hfI.inTaiwan(ch.tx, ch.ty)) continue
              desired.set(keyOf(tz, ch.tx, ch.ty), { zoom: tz, tx: ch.tx, ty: ch.ty, res: resI, d2: ch.d2 })
            }
            continue
          }
        }
        // single ring keeps the fine grid near the target, half res beyond R1
        const res = single && d2 <= R1sq ? resI : resO
        desired.set(keyOf(oz, tx, ty), { zoom: oz, tx, ty, res, d2 })
      }
    }

    // dynamic tile-cache sizing (see geo.js HeightField.setMaxTiles): a fixed
    // 300-tile cap starts evicting-and-refetching tiles still needed by live
    // chunks once the desired set outgrows it (large View distance × zoomed
    // out). desired.size IS the current demand — cap every LOD level's cache
    // to it (×1.5 headroom); applying the combined total to each level is a
    // safe over-provision (any one level's actual share is a subset), and the
    // extra memory is cheap next to the eviction thrash it fixes.
    const tileCap = Math.max(300, Math.ceil(desired.size * 1.5))
    for (const hf of fields.values()) hf.setMaxTiles(tileCap)

    for (const [k, e] of desired) {
      const queued = this.queued.get(k)
      if (queued) {
        queued.d2 = e.d2
        queued.res = e.res // pick up a chunkRes change on pending rebuilds
      } else if (!this.terrain.chunkMap.has(k)) {
        this._enqueue(e.zoom, e.tx, e.ty, e.res, e.d2, false)
      }
    }

    // unload: outside the hysteresis band as before, PLUS stale-LOD chunks as
    // soon as the live desired chunks fully re-cover their footprint
    const rOut2 = R2 * UNLOAD_FACTOR * UNLOAD_FACTOR
    for (const [k, mesh] of this.terrain.chunkMap) {
      if (desired.has(k)) continue
      const dx = mesh.position.x - cx
      const dz = mesh.position.z - cz
      if (dx * dx + dz * dz > rOut2 || this._covered(mesh, desired, tz, oz, single)) {
        this.terrain.removeChunk(k)
      }
    }
    // drop queued work that fell out of range (keep rebuilds of live chunks)
    this.queue = this.queue.filter((e) => {
      const keep = desired.has(e.k) || (e.rebuild && this.terrain.chunkMap.has(e.k))
      if (!keep) this.queued.delete(e.k)
      return keep
    })
    this.queue.sort((a, b) => a.d2 - b.d2)
  }

  // Is this stale chunk's footprint fully re-covered by LIVE desired chunks?
  // Walk the desired-set outer-zoom tiles overlapping the footprint; each must
  // either be live itself, be replaced by live inner children, or be absent
  // from the desired set entirely (outside radius/bbox — nothing will build
  // there, so the stale chunk isn't covering for anything visible).
  _covered(mesh, desired, tz, oz, single) {
    const fields = this.terrain.heightFields
    const proj = fields.get(mesh.userData.zoom).projection
    const half = proj.tileWorldSize / 2 - 1e-3 // inset: edge-adjacent tiles don't count
    const projO = fields.get(oz).projection
    const a = projO.worldToPixel(mesh.position.x - half, mesh.position.z - half)
    const b = projO.worldToPixel(mesh.position.x + half, mesh.position.z + half)
    const live = this.terrain.chunkMap
    const tyMax = Math.floor(b.py / 256)
    const txMax = Math.floor(b.px / 256)
    for (let ty = Math.floor(a.py / 256); ty <= tyMax; ty++) {
      for (let tx = Math.floor(a.px / 256); tx <= txMax; tx++) {
        if (desired.has(keyOf(oz, tx, ty))) {
          if (!live.has(keyOf(oz, tx, ty))) return false
          continue
        }
        if (single) continue
        for (let sy = 0; sy <= 1; sy++) {
          for (let sx = 0; sx <= 1; sx++) {
            const ki = keyOf(tz, tx * 2 + sx, ty * 2 + sy)
            if (desired.has(ki) && !live.has(ki)) return false
          }
        }
      }
    }
    return true
  }

  _pump() {
    const fields = this.terrain.heightFields
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
      fields.get(e.zoom).ensureTiles(coords).then(() => {
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
      this.terrain.addChunk(e.zoom, e.tx, e.ty, e.res)
      built++
    }
    if (built && this.onChunksChanged) this.onChunksChanged()
  }
}
