// Real-world elevation via NLSC 20m DTM (2024) re-encoded as terrarium RGB PNGs.
// Self-hosted XYZ tiles, z10–13, Taiwan only. meters = (R*256 + G + B/256) - 32768
// Pure-sea tiles are not generated — a missing tile decodes to null (= 0 m).

const TILE_BASE = import.meta.env.VITE_TILE_BASE ?? '/tiles'
const TILE_URL = (z, x, y) => `${TILE_BASE}/${z}/${x}/${y}.png`
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
    data[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768
  }
  return data
}
