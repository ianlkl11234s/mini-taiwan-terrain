import { fetchTile, TILE_PX } from './dem.js'

// Shared world coordinate system for chunked terrain (route A).
//
// World origin = the load center's Web Mercator position. Axes: +X east,
// +Z south (matches XYZ tile y), +Y up. Mercator meters are corrected to
// ground meters with a single cos(lat0) — a flat local approximation that
// keeps every consumer (chunks, height sampling, peaks, POIs) on one grid.
//
// K (world units per ground meter) is anchored so the legacy single-plane
// view keeps its visual scale: 768 px of z12 (~26.9 km at Yushan) mapped to
// 56 world units → 1 unit ≈ 480 ground meters. K is fixed at the z12 anchor
// regardless of the loaded zoom so world scale stays consistent across zooms.

const MPP0 = 156543.03392 // mercator meters per pixel at zoom 0
const K_ANCHOR_ZOOM = 12
const K_ANCHOR_PX = 768 // legacy 3×3 mosaic width
const K_ANCHOR_UNITS = 56 // legacy TERRAIN_SIZE

// Coverage of the self-hosted tile set. No tile requests happen outside this
// box (it's all open sea / 404s) and the pan clamp keeps the target inside it.
export const TAIWAN_BBOX = { minLon: 119.9, maxLon: 122.1, minLat: 21.8, maxLat: 25.4 }

// Fixed island-wide elevation range: the hypsometric ramp and vertex tint must
// normalize against ONE range or chunks built at different times would color
// differently (a visible seam). Sea level → Yushan.
const TAIWAN_MIN_M = 0
const TAIWAN_MAX_M = 3952

const lonToTileX = (lon, n) => Math.floor(((lon + 180) / 360) * n)
const latToTileY = (lat, n) => {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)
}

export function makeProjection({ lat, lon, zoom }) {
  const n = 2 ** zoom
  const latRad = (lat * Math.PI) / 180
  const cosLat0 = Math.cos(latRad)
  // world units per ground meter (z12 anchor, see header)
  const K = K_ANCHOR_UNITS / (K_ANCHOR_PX * (MPP0 / 2 ** K_ANCHOR_ZOOM) * cosLat0)
  // world units per pixel at `zoom`: mercator m/px × cos(lat0) → ground m/px → × K
  const unitsPerPixel = (MPP0 / n) * cosLat0 * K
  // global pixel coords (at `zoom`) of the world origin
  const originPxX = ((lon + 180) / 360) * n * TILE_PX
  const originPxY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * TILE_PX

  return {
    lat,
    lon,
    zoom,
    K,
    unitsPerPixel,
    tileWorldSize: TILE_PX * unitsPerPixel,
    // world xz → global pixel coords at `zoom`
    worldToPixel(x, z) {
      return { px: originPxX + x / unitsPerPixel, py: originPxY + z / unitsPerPixel }
    },
    lonLatToWorld(lon2, lat2) {
      const lat2Rad = (lat2 * Math.PI) / 180
      const px = ((lon2 + 180) / 360) * n * TILE_PX
      const py = ((1 - Math.log(Math.tan(lat2Rad) + 1 / Math.cos(lat2Rad)) / Math.PI) / 2) * n * TILE_PX
      return { x: (px - originPxX) * unitsPerPixel, z: (py - originPxY) * unitsPerPixel }
    },
    // world xz → geographic coordinate (inverse Web Mercator)
    worldToLonLat(x, z) {
      const px = originPxX + x / unitsPerPixel
      const py = originPxY + z / unitsPerPixel
      const lon2 = (px / (n * TILE_PX)) * 360 - 180
      const lat2 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / (n * TILE_PX)))) * 180) / Math.PI
      return { lon: lon2, lat: lat2 }
    },
    // world-space center of tile (tx, ty) at `zoom`
    tileCenterWorld(tx, ty) {
      return {
        x: ((tx + 0.5) * TILE_PX - originPxX) * unitsPerPixel,
        z: ((ty + 0.5) * TILE_PX - originPxY) * unitsPerPixel,
      }
    },
  }
}

// Height source for the chunked terrain. P1: a tile LRU cache — heightAtWorld
// samples bilinearly across tile borders, ensureTiles() guarantees a chunk's
// 3×3 neighbourhood is resident before its mesh builds (normal probes and
// border bilinear taps cross into adjacent tiles). Tiles not in cache read as
// 0 m, which only happens for far one-off probes (labels, tour paths) — those
// refresh on a throttle as streaming catches up.
export class HeightField {
  constructor(projection, { maxTiles = 300 } = {}) {
    this.projection = projection
    this.zoom = projection.zoom
    this.maxTiles = maxTiles // ~300 × 256² × 4B ≈ 75 MB ceiling
    // key "tx,ty" → { data: Float32Array | null, mean } — null = open sea (0 m).
    // Map insertion order doubles as the LRU order; ensureTiles re-inserts to touch.
    this.tiles = new Map()
    this.pending = new Map() // key → in-flight fetch promise (dedupes requests)
    this.datumM = 0 // vertical datum (meters), frozen once at initial load
    this.minM = TAIWAN_MIN_M
    this.maxM = TAIWAN_MAX_M
    this.stats = { fetched: 0, sea: 0, hit: 0, miss: 0, evicted: 0 }
    const n = 2 ** this.zoom
    this.txMin = lonToTileX(TAIWAN_BBOX.minLon, n)
    this.txMax = lonToTileX(TAIWAN_BBOX.maxLon, n)
    this.tyMin = latToTileY(TAIWAN_BBOX.maxLat, n)
    this.tyMax = latToTileY(TAIWAN_BBOX.minLat, n)
    // inlined worldToPixel — heightAtWorld is the hottest path in the app
    const o = projection.worldToPixel(0, 0)
    this._opx = o.px
    this._opy = o.py
    this._invUpp = 1 / projection.unitsPerPixel
    // 1-slot memo: vertex loops walk scanlines, so consecutive samples almost
    // always hit the same tile — skips the Map lookup and LRU bookkeeping
    this._mtx = NaN
    this._mty = NaN
    this._mtile = null
  }

  key(tx, ty) {
    return tx + ',' + ty
  }

  inTaiwan(tx, ty) {
    return tx >= this.txMin && tx <= this.txMax && ty >= this.tyMin && ty <= this.tyMax
  }

  // tile Float32Array for tile coords — sea tiles AND not-yet-cached both null
  _tile(tx, ty) {
    if (tx === this._mtx && ty === this._mty) return this._mtile
    const e = this.tiles.get(tx + ',' + ty)
    if (e === undefined) this.stats.miss++
    else this.stats.hit++
    const d = e ? e.data : null
    this._mtx = tx
    this._mty = ty
    this._mtile = d
    return d
  }

  _pixel(gx, gy) {
    const t = this._tile(gx >> 8, gy >> 8)
    return t ? t[(gy & 255) * TILE_PX + (gx & 255)] : 0
  }

  // world xz → elevation in meters (bilinear, correct across tile borders)
  heightAtWorld(x, z) {
    // -0.5: global pixel coordinate p sits at array index p - 0.5 (pixel centers)
    const sx = this._opx + x * this._invUpp - 0.5
    const sy = this._opy + z * this._invUpp - 0.5
    const x0 = Math.floor(sx)
    const y0 = Math.floor(sy)
    const fx = sx - x0
    const fy = sy - y0
    const lx = x0 & 255
    const ly = y0 & 255
    let a, b, c, d
    if (lx < 255 && ly < 255) {
      // all 4 taps inside one tile — the overwhelmingly common case
      const t = this._tile(x0 >> 8, y0 >> 8)
      if (!t) return 0
      const i = ly * TILE_PX + lx
      a = t[i]
      b = t[i + 1]
      c = t[i + TILE_PX]
      d = t[i + TILE_PX + 1]
    } else {
      // straddling a tile border: the 4 taps span 2–4 tiles
      a = this._pixel(x0, y0)
      b = this._pixel(x0 + 1, y0)
      c = this._pixel(x0, y0 + 1)
      d = this._pixel(x0 + 1, y0 + 1)
    }
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
  }

  // Guarantee tiles are resident before a chunk build. coords: [{tx, ty}].
  // Cached tiles get an LRU touch; out-of-coverage tiles resolve instantly as
  // sea; everything else fetches (deduped against in-flight requests).
  ensureTiles(coords) {
    const jobs = []
    for (const { tx, ty } of coords) {
      const k = tx + ',' + ty
      const e = this.tiles.get(k)
      if (e !== undefined) {
        this.tiles.delete(k) // LRU touch
        this.tiles.set(k, e)
        continue
      }
      const inflight = this.pending.get(k)
      if (inflight) {
        jobs.push(inflight)
        continue
      }
      if (!this.inTaiwan(tx, ty)) {
        this._store(k, null)
        continue
      }
      const job = fetchTile(this.zoom, tx, ty).then((data) => {
        this.pending.delete(k)
        this._store(k, data)
      })
      this.pending.set(k, job)
      jobs.push(job)
    }
    return jobs.length ? Promise.all(jobs) : Promise.resolve()
  }

  _store(k, data) {
    let mean = 0
    if (data) {
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i]
      mean = sum / data.length
      this.stats.fetched++
    } else {
      this.stats.sea++
    }
    this.tiles.set(k, { data, mean })
    this._mtx = NaN
    this._mtile = null
    while (this.tiles.size > this.maxTiles) {
      this.tiles.delete(this.tiles.keys().next().value)
      this.stats.evicted++
    }
  }

  // Freeze the vertical datum off whatever is cached right now (the initial
  // core tiles). It must never shift afterwards — streaming in new tiles with
  // a moving datum would slide the whole world under the camera.
  freezeDatum() {
    let sum = 0
    let count = 0
    for (const e of this.tiles.values()) {
      sum += e.mean
      count++
    }
    this.datumM = count ? sum / count : 0
  }
}
