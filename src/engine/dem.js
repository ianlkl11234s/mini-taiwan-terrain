// Real-world elevation via NLSC 20m DTM (2024) re-encoded as terrarium RGB PNGs,
// with GEBCO 2025 bathymetry mosaicked in below sea level (see
// docs/BATHYMETRY_DESIGN.md). Self-hosted XYZ tiles, z10–13, Taiwan only.
// meters = (R*256 + G + B/256) - 32768. Pure-sea tiles at z13 are not
// generated (Option B — see the design doc) — fetchTile synthesizes those
// from the z12 parent (below); a tile still missing after that fallback
// resolves null (= 0 m).

const TILE_BASE = import.meta.env.VITE_TILE_BASE ?? '/tiles'
// bathy/ prefix: R2 hosts the bathymetry-inclusive tile set alongside (not
// replacing) the old land-only one, so an older deployed frontend pointed at
// the same TILE_BASE keeps working unaffected.
const TILE_URL = (z, x, y) => `${TILE_BASE}/bathy/${z}/${x}/${y}.png`
export const TILE_PX = 256

// shared decode canvas — drawImage + getImageData run synchronously between
// awaits, so concurrent fetchTile calls can never interleave on it
let _ctx = null
function decodeCtx() {
  if (!_ctx) {
    const c = document.createElement('canvas')
    c.width = c.height = TILE_PX
    _ctx = c.getContext('2d', { willReadFrequently: true })
  }
  return _ctx
}

// Fetch + decode one terrarium tile into meters. Resolves null for missing or
// non-image responses (open sea) — never rejects.
async function fetchTileDirect(zoom, tx, ty) {
  let img
  try {
    const r = await fetch(TILE_URL(zoom, tx, ty))
    // vite's SPA fallback answers missing tiles with 200 + index.html — treat as missing
    if (!r.ok || !(r.headers.get('content-type') || '').includes('image')) return null
    img = await createImageBitmap(await r.blob())
  } catch {
    return null
  }
  const ctx = decodeCtx()
  ctx.drawImage(img, 0, 0)
  const rgba = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data
  img.close?.()
  const data = new Float32Array(TILE_PX * TILE_PX)
  for (let i = 0; i < data.length; i++) {
    const ri = i * 4
    const v = rgba[ri] * 256 + rgba[ri + 1] + rgba[ri + 2] / 256 - 32768
    // NODATA guard: RGB(0,0,0) decodes to exactly -32768 m — the terrarium
    // encode-hole sentinel (e.g. offshore islets without DTM coverage), not a
    // real depth. Real GEBCO bathymetry is baked into these tiles now and
    // Taiwan's bbox never comes close to -32768 m (bottoms out ~-6.8 km), so
    // this only ever catches the encode hole, never a genuine deep-sea sample
    // (the old `v < -100` threshold used to punch black pits into real
    // shallow-water depths once bathymetry was baked in).
    data[i] = rgba[ri] === 0 && rgba[ri + 1] === 0 && rgba[ri + 2] === 0 ? 0 : v
  }
  return data
}

// Parent-tile fetches done purely to synthesize a missing child (below) are
// memoized — a coastline pans past many sibling tiles that all 404 down to
// the SAME parent, and this keeps that to one network request per parent
// regardless of how many children fall back to it.
const _parentCache = new Map() // "z,x,y" → Promise<Float32Array|null>
function fetchParentForFallback(zoom, tx, ty) {
  const k = `${zoom},${tx},${ty}`
  let p = _parentCache.get(k)
  if (!p) {
    p = fetchTileDirect(zoom, tx, ty)
    _parentCache.set(k, p)
  }
  return p
}

// Bilinear 2× upsample of one 128×128 quadrant (qx,qy ∈ {0,1}) of a parent
// tile's decoded meters into a full 256×256 tile. Sampling is allowed to
// cross the quadrant's inner seam (real neighbouring parent data — correct),
// only clamped at the parent tile's own outer edge (no data beyond it).
function upsampleQuadrant(parent, qx, qy) {
  const half = TILE_PX / 2
  const ox = qx * half
  const oy = qy * half
  const out = new Float32Array(TILE_PX * TILE_PX)
  for (let y = 0; y < TILE_PX; y++) {
    const sy = oy + y / 2
    const y0 = Math.floor(sy)
    const y1 = Math.min(TILE_PX - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < TILE_PX; x++) {
      const sx = ox + x / 2
      const x0 = Math.floor(sx)
      const x1 = Math.min(TILE_PX - 1, x0 + 1)
      const fx = sx - x0
      const a = parent[y0 * TILE_PX + x0]
      const b = parent[y0 * TILE_PX + x1]
      const c = parent[y1 * TILE_PX + x0]
      const d = parent[y1 * TILE_PX + x1]
      out[y * TILE_PX + x] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
    }
  }
  return out
}

// Public entry: as fetchTileDirect, but a missing tile (404 — pure sea at
// z13, see the Option B note up top) falls back one zoom level to the
// immediate parent tile and upsamples the matching quadrant, instead of
// decoding as flat 0 m. Only one hop is tried — if the parent is ALSO
// missing, this resolves null exactly like before (never cascades further,
// never rejects). This isn't special-cased to z13/sea: any zoom's 404 gets
// the same fallback, generically. The synthesized tile is an ordinary
// Float32Array indistinguishable to the caller, so geo.js's HeightField
// caches it like any other tile — this only ever runs once per missing tile,
// never per frame.
export async function fetchTile(zoom, tx, ty) {
  const direct = await fetchTileDirect(zoom, tx, ty)
  if (direct) return direct
  if (zoom <= 0) return null
  const parent = await fetchParentForFallback(zoom - 1, tx >> 1, ty >> 1)
  if (!parent) return null
  return upsampleQuadrant(parent, tx & 1, ty & 1)
}
