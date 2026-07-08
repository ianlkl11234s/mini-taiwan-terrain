import { sampleDem } from './dem.js'

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

const TILE_PX = 256
const MPP0 = 156543.03392 // mercator meters per pixel at zoom 0
const K_ANCHOR_ZOOM = 12
const K_ANCHOR_PX = 768 // legacy 3×3 mosaic width
const K_ANCHOR_UNITS = 56 // legacy TERRAIN_SIZE

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
    // world-space center of tile (tx, ty) at `zoom`
    tileCenterWorld(tx, ty) {
      return {
        x: ((tx + 0.5) * TILE_PX - originPxX) * unitsPerPixel,
        z: ((ty + 0.5) * TILE_PX - originPxY) * unitsPerPixel,
      }
    },
  }
}

// Height source for the chunked terrain. P0: one big mosaic (loadDem with
// tilesAcross=5) sampled bilinearly — every chunk vertex reads the same
// surface, so tile borders are seam-free by construction. P1 can swap the
// internals for a tile LRU cache without touching heightAtWorld().
export class HeightField {
  constructor(dem, projection) {
    this.dem = dem
    this.projection = projection
    const n = 2 ** dem.zoom
    const latRad = (dem.lat * Math.PI) / 180
    const cx = Math.floor(((dem.lon + 180) / 360) * n)
    const cy = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
    this.tilesAcross = dem.size / TILE_PX
    const half = Math.floor(this.tilesAcross / 2)
    this.tileX0 = cx - half // top-left tile of the mosaic
    this.tileY0 = cy - half
    this.mosaicOriginPxX = this.tileX0 * TILE_PX
    this.mosaicOriginPxY = this.tileY0 * TILE_PX
    // full world extent covered by the mosaic (== the chunk grid)
    this.extentWorld = this.tilesAcross * projection.tileWorldSize
  }

  // world xz → elevation in meters (bilinear; clamps at the mosaic edge)
  heightAtWorld(x, z) {
    const { px, py } = this.projection.worldToPixel(x, z)
    // -0.5: global pixel coordinate p sits at array index p - 0.5 (pixel centers)
    return sampleDem(this.dem, px - this.mosaicOriginPxX - 0.5, py - this.mosaicOriginPxY - 0.5)
  }
}
