import * as THREE from 'three'
import { PMTiles } from 'pmtiles'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { makeProjection, metersToWorldY } from './geo.js'

// ⑥ PMTiles vector-tile subsystem, Phase 1 (docs/VECTOR_TILES_DESIGN.md). A
// parallel streaming manager modeled on chunks.js's desired-set/LRU/build-
// budget recipe, but standing OUTSIDE the terrain ChunkManager (different
// zoom range, different mesh type, different lifecycle) — see design §0.
//
// Pipeline per tile: PMTiles#getZxy (Range-fetch + auto gzip-decompress —
// confirmed by reading pmtiles' own getZxyAttempt: it always calls
// this.decompress(bytes, header.tileCompression) before resolving, so the
// ArrayBuffer handed back here is ALREADY inflated; no manual gunzip needed)
// → VectorTile(PbfReader) → per-LineString-feature loadGeometry() (extent
// 4096, tile-pixel space, origin top-left, y increases toward the tile's
// SOUTH edge — the SAME direction world Z increases in this engine's
// coordinate system per geo.js's "+Z south (matches XYZ tile y)", so no
// explicit axis flip is needed to place a LINE vertex; a flip only matters
// for polygon winding, which is a Phase 3 (面) concern) → world xz via
// linear interpolation across the tile's four corners (design §3: a single
// small MVT tile's Mercator nonlinearity is sub-meter, cheaper than a
// per-vertex trig round trip) → vertex elevation via heightField.heightAtWorld
// (gated behind heightField.ensureTiles(footprint) so a build never bakes a
// too-early 0 m/sea-level guess — the "未載 DEM 區不沉海" lesson from
// BATHYMETRY/chunks work) → metersToWorldY.

const RECOMPUTE_INTERVAL = 0.3 // a bit coarser than chunks.js's terrain 0.2 — road geometry changes less
const MAX_FETCH_GROUPS = 4 // concurrent tile fetch+decode+drape jobs
const MAX_BUILDS_PER_TICK = 2 // per design §3 — mirrors chunks.js
const BUILD_BUDGET_MS = 12
const UNLOAD_FACTOR = 1.3
const MIN_VZ_FALLBACK = 6 // used until the archive header resolves (design confirms 6-14 for osm_road_drive)
const MAX_VZ_FALLBACK = 14
const HARD_TILE_CAP = 150 // defensive ceiling on one recompute's desired set, independent of the ~30-60 design target
const LINESTRING_TYPE = 2 // VectorTileFeature.types[2] === 'LineString'

const keyOf = (vz, tx, ty) => vz + '/' + tx + '/' + ty

// DEM tile footprint (heightField's own fixed zoom) covering a world-space
// bbox, with a 1-tile margin for heightAtWorld's cross-border bilinear taps —
// same shape as index.js's ensureTourDisk/ensureTourTiles helpers, kept local
// here so this module has no reach-in dependency on index.js.
function demFootprint(heightField, minX, maxX, minZ, maxZ) {
  const proj = heightField.projection
  const a = proj.worldToPixel(minX, minZ)
  const b = proj.worldToPixel(maxX, maxZ)
  const txMin = Math.floor(Math.min(a.px, b.px) / 256) - 1
  const txMax = Math.floor(Math.max(a.px, b.px) / 256) + 1
  const tyMin = Math.floor(Math.min(a.py, b.py) / 256) - 1
  const tyMax = Math.floor(Math.max(a.py, b.py) / 256) + 1
  const coords = []
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) coords.push({ tx, ty })
  }
  return coords
}

export class VectorTileManager {
  constructor({ url, layerName }) {
    this.pmtiles = new PMTiles(url)
    this.layerName = layerName
    this.group = new THREE.Group()
    this.material = new LineMaterial({
      color: 0xffffff,
      linewidth: 1.5,
      transparent: true,
      opacity: 0.85,
      fog: true,
    })
    this.enabled = false
    this.tiles = new Map() // key -> { mesh, seg (Float32Array xyz pairs), elev (Float32Array meters pairs), nSeg, cx, cz }
    this.queue = [] // [{ vz, tx, ty, k, d2, state }]
    this.queued = new Map()
    this._acc = RECOMPUTE_INTERVAL
    this._lastVz = null
    this._projCache = new Map() // vz -> projection (anchor frozen for the session — see geo.js "one world")
    this._sourceZoom = { min: MIN_VZ_FALLBACK, max: MAX_VZ_FALLBACK }
    this._headerRequested = false
    this._inFlight = 0
    this._resolutionSet = false
    this._lastVScale = NaN // heightField.projection.K * exaggeration — redrape gate
    this._demDirty = false
    this.onTilesChanged = null // hook: a build landed — caller invalidates the on-demand renderer
  }

  setLineResolution(res) {
    if (!this._resolutionSet && res) {
      this.material.uniforms.resolution.value = res
      this._resolutionSet = true
    }
  }

  setStyle({ color, width, opacity } = {}) {
    if (color !== undefined) this.material.color.set(color)
    if (width !== undefined) this.material.linewidth = width
    if (opacity !== undefined) this.material.opacity = opacity
  }

  async _loadHeader() {
    this._headerRequested = true
    try {
      const h = await this.pmtiles.getHeader()
      this._sourceZoom = { min: h.minZoom, max: h.maxZoom }
    } catch (err) {
      console.warn('[vectortiles] header fetch failed, using fallback zoom range', err)
    }
  }

  setEnabled(on) {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this._acc = RECOMPUTE_INTERVAL // force an immediate recompute next update()
      if (!this._headerRequested) this._loadHeader()
    } else {
      this._clear()
    }
  }

  // DEM coverage changed (chunkManager.onChunksChanged) — coalesced into ONE
  // redrape pass on the next update() tick, never per-frame (design §6).
  markDemDirty() {
    this._demDirty = true
  }

  _clear() {
    for (const t of this.tiles.values()) {
      this.group.remove(t.mesh)
      t.mesh.geometry.dispose()
    }
    this.tiles.clear()
    for (const e of this.queue) e.abort?.abort()
    this.queue = []
    this.queued.clear()
  }

  _proj(vz) {
    let p = this._projCache.get(vz)
    if (!p) {
      const a = this._anchor
      p = makeProjection({ lat: a.lat, lon: a.lon, zoom: vz })
      this._projCache.set(vz, p)
    }
    return p
  }

  // dt: frame delta. opts: { targetX, targetZ, radius, lodZoom, demLat, demLon,
  // exaggeration, heightField } — a fresh snapshot every call (see
  // vectortiles.js createOsmRoadsLayer.tickView), not a stored closure.
  update(dt, opts) {
    if (!this.enabled) return
    const { targetX, targetZ, radius, lodZoom, demLat, demLon, exaggeration, heightField } = opts
    this._anchor = { lat: demLat, lon: demLon }
    this.heightField = heightField
    const vz = THREE.MathUtils.clamp(Math.round(lodZoom) + 1, this._sourceZoom.min, this._sourceZoom.max)
    if (vz !== this._lastVz) {
      // a different vz means a different tile-index numbering — simplest
      // correct Phase 1 behavior is to drop the old set outright rather than
      // reconcile two zoom levels' worth of tiles (no LOD-covered eviction
      // logic here, unlike chunks.js's terrain rings)
      this._clear()
      this._lastVz = vz
    }
    this._acc += dt
    if (this._acc >= RECOMPUTE_INTERVAL) {
      this._acc = 0
      this._recompute(targetX, targetZ, radius, vz)
    }
    // vScale/redrape BEFORE _pump(): _materialize() reads this._lastExaggeration
    // for newly-built tiles, so it must already reflect the current value the
    // first time anything gets materialized (an empty this.tiles here is a
    // harmless no-op redrape, but it still primes _lastExaggeration/_lastVScale)
    if (heightField) {
      const vScale = heightField.projection.K * exaggeration
      if (vScale !== this._lastVScale || this._demDirty) {
        this._lastVScale = vScale
        this._demDirty = false
        this._redrape(heightField, exaggeration)
      }
    }
    this._pump()
  }

  _recompute(cx, cz, radius, vz) {
    const proj = this._proj(vz)
    const R2 = radius * radius
    const tileW = proj.tileWorldSize
    const c = proj.worldToPixel(cx, cz)
    const ctx = Math.floor(c.px / 256)
    const cty = Math.floor(c.py / 256)
    const tR = Math.ceil(radius / tileW) + 1
    const n = 2 ** vz
    let desired = new Map()
    for (let dy = -tR; dy <= tR; dy++) {
      for (let dx = -tR; dx <= tR; dx++) {
        const tx = ctx + dx
        const ty = cty + dy
        if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue
        const center = proj.tileCenterWorld(tx, ty)
        const ddx = center.x - cx
        const ddz = center.z - cz
        const d2 = ddx * ddx + ddz * ddz
        if (d2 > R2) continue
        desired.set(keyOf(vz, tx, ty), { vz, tx, ty, d2 })
      }
    }
    // defensive hard cap (design targets ~30-60; a mistuned radius/zoom combo
    // should degrade to "keep the nearest N", never balloon unbounded)
    if (desired.size > HARD_TILE_CAP) {
      const nearest = [...desired.entries()].sort((a, b) => a[1].d2 - b[1].d2).slice(0, HARD_TILE_CAP)
      desired = new Map(nearest)
    }
    this.lastDesiredSize = desired.size
    const cap = Math.max(8, Math.ceil(desired.size * 1.5))

    for (const [k, e] of desired) {
      if (this.tiles.has(k)) continue
      const q = this.queued.get(k)
      if (q) {
        q.d2 = e.d2
        continue
      }
      const entry = { ...e, k, state: 'pending' }
      this.queue.push(entry)
      this.queued.set(k, entry)
    }
    this.queue.sort((a, b) => a.d2 - b.d2)

    // unload out-of-radius live tiles
    const rOut2 = R2 * UNLOAD_FACTOR * UNLOAD_FACTOR
    for (const [k, t] of this.tiles) {
      if (desired.has(k)) continue
      const ddx = t.cx - cx
      const ddz = t.cz - cz
      if (ddx * ddx + ddz * ddz > rOut2) {
        this.group.remove(t.mesh)
        t.mesh.geometry.dispose()
        this.tiles.delete(k)
      }
    }
    // independent LRU cap (design §3: desired.size × 1.5, never shared with
    // the DEM's own setMaxTiles) — evict farthest-from-center live tiles
    if (this.tiles.size > cap) {
      const byDist = [...this.tiles.entries()]
        .map(([k, t]) => [k, (t.cx - cx) ** 2 + (t.cz - cz) ** 2])
        .sort((a, b) => b[1] - a[1])
      let over = this.tiles.size - cap
      for (const [k] of byDist) {
        if (over-- <= 0) break
        const t = this.tiles.get(k)
        this.group.remove(t.mesh)
        t.mesh.geometry.dispose()
        this.tiles.delete(k)
      }
    }
    // drop queued work that fell out of range
    this.queue = this.queue.filter((e) => {
      const keep = desired.has(e.k)
      if (!keep) this.queued.delete(e.k)
      return keep
    })
  }

  _pump() {
    for (const e of this.queue) {
      if (this._inFlight >= MAX_FETCH_GROUPS) break
      if (e.state !== 'pending') continue
      e.state = 'fetching'
      this._inFlight++
      e.abort = new AbortController()
      this._fetchAndDecode(e).finally(() => {
        this._inFlight--
      })
    }
    const t0 = performance.now()
    let built = 0
    let changed = false
    while (built < MAX_BUILDS_PER_TICK && performance.now() - t0 < BUILD_BUDGET_MS) {
      const i = this.queue.findIndex((e) => e.state === 'ready' || e.state === 'empty')
      if (i === -1) break
      const e = this.queue[i]
      this.queue.splice(i, 1)
      this.queued.delete(e.k)
      if (e.state === 'ready') {
        this._materialize(e)
        changed = true
      }
      built++
    }
    if (changed && this.onTilesChanged) this.onTilesChanged()
  }

  async _fetchAndDecode(e) {
    try {
      const res = await this.pmtiles.getZxy(e.vz, e.tx, e.ty, e.abort.signal)
      if (this.queued.get(e.k) !== e) return // dropped/replaced while fetching
      if (!res) {
        e.state = 'empty'
        return
      }
      const vt = new VectorTile(new PbfReader(new Uint8Array(res.data)))
      const layer = vt.layers[this.layerName]
      if (!layer || !layer.length) {
        e.state = 'empty'
        return
      }
      const proj = this._proj(e.vz)
      const center = proj.tileCenterWorld(e.tx, e.ty)
      const half = proj.tileWorldSize / 2
      const hf = this.heightField
      if (hf) {
        await hf.ensureTiles(demFootprint(hf, center.x - half, center.x + half, center.z - half, center.z + half))
      }
      if (this.queued.get(e.k) !== e) return // dropped while awaiting DEM tiles

      const xz = [] // flat: x0,z0,x1,z1 per segment (world space, y filled in below)
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i)
        if (feature.type !== LINESTRING_TYPE) continue
        const extent = feature.extent
        const s = proj.tileWorldSize / extent
        const parts = feature.loadGeometry()
        for (const part of parts) {
          for (let j = 0; j < part.length - 1; j++) {
            const p0 = part[j]
            const p1 = part[j + 1]
            xz.push(
              center.x + (p0.x - extent / 2) * s,
              center.z + (p0.y - extent / 2) * s,
              center.x + (p1.x - extent / 2) * s,
              center.z + (p1.y - extent / 2) * s
            )
          }
        }
      }
      if (!xz.length) {
        e.state = 'empty'
        return
      }
      const nSeg = xz.length / 4
      const seg = new Float32Array(nSeg * 6)
      const elev = new Float32Array(nSeg * 2)
      for (let s = 0; s < nSeg; s++) {
        const x0 = xz[s * 4]
        const z0 = xz[s * 4 + 1]
        const x1 = xz[s * 4 + 2]
        const z1 = xz[s * 4 + 3]
        seg[s * 6] = x0
        seg[s * 6 + 2] = z0
        seg[s * 6 + 3] = x1
        seg[s * 6 + 5] = z1
        elev[s * 2] = hf ? hf.heightAtWorld(x0, z0) : 0
        elev[s * 2 + 1] = hf ? hf.heightAtWorld(x1, z1) : 0
      }
      e.seg = seg
      e.elev = elev
      e.nSeg = nSeg
      e.cx = center.x
      e.cz = center.z
      e.state = 'ready'
    } catch (err) {
      if (err?.name === 'AbortError') return
      console.warn('[vectortiles] tile decode failed', e.k, err)
      if (this.queued.get(e.k) === e) e.state = 'empty'
    }
  }

  _materialize(e) {
    // apply the current vertical scale now (redrape only revisits this on a
    // later exaggeration/DEM change, so a tile must land already-scaled)
    const hf = this.heightField
    if (hf) {
      for (let s = 0; s < e.nSeg; s++) {
        e.seg[s * 6 + 1] = metersToWorldY(hf, e.elev[s * 2], this._lastExaggeration ?? 1)
        e.seg[s * 6 + 4] = metersToWorldY(hf, e.elev[s * 2 + 1], this._lastExaggeration ?? 1)
      }
    }
    const geo = new LineSegmentsGeometry()
    geo.setPositions(e.seg)
    const mesh = new LineSegments2(geo, this.material)
    this.group.add(mesh)
    this.tiles.set(e.k, { mesh, seg: e.seg, elev: e.elev, nSeg: e.nSeg, cx: e.cx, cz: e.cz })
  }

  // in-place y rewrite for every live tile — no geometry rebuild, matching
  // polyline.js applyVertical (design §3/§6). Runs on an exaggeration change
  // or a DEM-coverage dirty flag, never per-frame.
  _redrape(heightField, exaggeration) {
    this._lastExaggeration = exaggeration
    for (const t of this.tiles.values()) {
      for (let s = 0; s < t.nSeg; s++) {
        const x0 = t.seg[s * 6]
        const z0 = t.seg[s * 6 + 2]
        const x1 = t.seg[s * 6 + 3]
        const z1 = t.seg[s * 6 + 5]
        t.elev[s * 2] = heightField.heightAtWorld(x0, z0)
        t.elev[s * 2 + 1] = heightField.heightAtWorld(x1, z1)
        t.seg[s * 6 + 1] = metersToWorldY(heightField, t.elev[s * 2], exaggeration)
        t.seg[s * 6 + 4] = metersToWorldY(heightField, t.elev[s * 2 + 1], exaggeration)
      }
      t.mesh.geometry.attributes.instanceStart.data.needsUpdate = true
      t.mesh.geometry.computeBoundingBox()
      t.mesh.geometry.computeBoundingSphere()
    }
  }

  dispose() {
    this._clear()
    this.material.dispose()
  }
}

// R2 CDN — pmtiles reads via HTTP Range on the static archive; no CORS
// hop onto pulse's own origin (see design §2). Dev talks straight to the CDN
// too (design: "本地 dev 直接打 CDN 即可"), so there's no local /tiles-style
// symlink requirement for this data source.
const VECTOR_BASE = import.meta.env.VITE_VECTOR_BASE ?? 'https://tiles.itsmigu.com/vector'
const OSM_ROADS_URL = `${VECTOR_BASE}/osm_road_drive.pmtiles`

const ROADS_STYLE_SCHEMA = {
  width: { type: 'slider', label: '線寬 Width', min: 0.5, max: 4, step: 0.1, format: (v) => v.toFixed(1) },
  opacity: { type: 'slider', label: '不透明度 Opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
  color: { type: 'color', label: '顏色 Color' },
}

// LayerManager adapter (see layers.js header for the interface contract).
// Phase 1: single color/width for the whole road network (class-based style
// buckets are Phase 2) — one shared LineMaterial, one LineSegments2 per tile.
// Registers with an empty, invisible group; the manager only starts
// streaming once the panel switches this layer on (gate() below), matching
// "先空後填" — no tile fetch happens while off.
export function createOsmRoadsLayer(params, { invalidate } = {}) {
  const manager = new VectorTileManager({ url: OSM_ROADS_URL, layerName: 'osm_road_drive' })
  manager.setStyle({ color: params.osmRoadsColor, width: params.osmRoadsWidth, opacity: params.osmRoadsOpacity })
  manager.onTilesChanged = invalidate // a tile finished building — repaint (on-demand render, design §6)

  function gate(ctx) {
    return params.source === 'real' && !!ctx.heightField && !!params.osmRoadsVisible
  }

  return {
    id: 'osm_roads',
    kind: 'line',
    label: 'OSM Roads',
    rowLabel: 'OSM 道路 OSM Roads',
    object3d: manager.group,
    visibleParam: 'osmRoadsVisible',
    paramMap: {
      visible: 'osmRoadsVisible',
      width: 'osmRoadsWidth',
      opacity: 'osmRoadsOpacity',
      color: 'osmRoadsColor',
    },

    build(ctx) {
      if (ctx.lineResolution) manager.setLineResolution(ctx.lineResolution)
    },

    // style/visibility path (setParams → HANDLERS.osmRoads* → layers.get('osm_roads').update)
    update(ctx) {
      const show = gate(ctx)
      manager.setStyle({ color: params.osmRoadsColor, width: params.osmRoadsWidth, opacity: params.osmRoadsOpacity })
      manager.group.visible = show
      manager.setEnabled(show)
    },

    // per-frame streaming (desired-set recompute + throttled build pump) —
    // piggybacks on layers.tickAll's existing every-non-idle-frame cadence
    // instead of a new top-level tick() wire, since this manager only needs
    // to react while its own layer is visible.
    tickView(ctx) {
      if (!manager.enabled || !ctx.heightField) return
      const cx = ctx.labelCenter ? ctx.labelCenter.x : ctx.camera.position.x
      const cz = ctx.labelCenter ? ctx.labelCenter.z : ctx.camera.position.z
      manager.update(ctx.dt, {
        targetX: cx,
        targetZ: cz,
        // smaller than chunkManager's terrain-streaming radius (× 1.15): a
        // dense road network (plains) produces far more MVT tiles per world
        // area than DEM chunks do, so a matching radius overshoots the
        // design's ~30-60 visible-tile target (measured ~120 tiles at 1.15
        // over Chiayi's plains) — 0.65 keeps most zoom/terrain combos in
        // range while still covering the visible fog wall
        radius: ctx.params.fogFar * ctx.fogScale * 0.65,
        lodZoom: ctx.lodZoom ?? 12,
        demLat: ctx.params.demLat,
        demLon: ctx.params.demLon,
        exaggeration: ctx.params.demExaggeration,
        heightField: ctx.heightField,
      })
    },

    setVisible(v) {
      params.osmRoadsVisible = v
      manager.group.visible = v
      manager.setEnabled(v)
    },

    setStyle(patch) {
      for (const k in patch) if (this.paramMap[k]) params[this.paramMap[k]] = patch[k]
      manager.setStyle({ color: params.osmRoadsColor, width: params.osmRoadsWidth, opacity: params.osmRoadsOpacity })
    },

    // chunkManager.onChunksChanged hook (index.js) — coalesced redrape, see
    // VectorTileManager.markDemDirty
    markDemDirty() {
      manager.markDemDirty()
    },

    describe() {
      return {
        id: 'osm_roads',
        kind: 'line',
        label: 'OSM Roads',
        rowLabel: 'OSM 道路 OSM Roads',
        count: manager.tiles.size, // live tile count, not feature count (Phase 1 keeps this cheap)
        visible: params.osmRoadsVisible,
        styleSchema: ROADS_STYLE_SCHEMA,
        style: {
          width: params.osmRoadsWidth,
          opacity: params.osmRoadsOpacity,
          color: params.osmRoadsColor,
        },
      }
    },

    dispose() {
      manager.dispose()
    },
  }
}
