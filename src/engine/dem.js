// Real-world elevation via NLSC 20m DTM (2024) re-encoded as terrarium RGB PNGs,
// with GEBCO 2025 bathymetry mosaicked in below sea level (see
// docs/BATHYMETRY_DESIGN.md). Self-hosted XYZ tiles, z10–13, Taiwan only.
// meters = (R*256 + G + B/256) - 32768. Pure-sea tiles at z13 are not
// generated (Option B — see the design doc) — a missing tile decodes to null (= 0 m).

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
export async function fetchTile(zoom, tx, ty) {
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
