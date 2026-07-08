// Real-world elevation via NLSC 20m DTM (2024) re-encoded as terrarium RGB PNGs.
// Self-hosted XYZ tiles, z10–13, Taiwan only. meters = (R*256 + G + B/256) - 32768
// Pure-sea tiles are not generated — a missing tile reads as elevation 0.

const TILE_BASE = import.meta.env.VITE_TILE_BASE ?? '/tiles'
const TILE_URL = (z, x, y) => `${TILE_BASE}/${z}/${x}/${y}.png`
const TILE_PX = 256

export async function loadDem({ lat, lon, zoom, tilesAcross = 3 }) {
  const n = 2 ** zoom
  const latRad = (lat * Math.PI) / 180
  const cx = Math.floor(((lon + 180) / 360) * n)
  const cy = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)

  const half = Math.floor(tilesAcross / 2)
  const sizePx = tilesAcross * TILE_PX
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = sizePx
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  // pre-fill with terrarium sea level (0 m = R128 G0 B0) so missing tiles read as 0
  ctx.fillStyle = 'rgb(128, 0, 0)'
  ctx.fillRect(0, 0, sizePx, sizePx)

  const jobs = []
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const tx = (cx + dx + n) % n
      const ty = cy + dy
      if (ty < 0 || ty >= n) continue
      jobs.push(
        fetch(TILE_URL(zoom, tx, ty))
          .then((r) => {
            // vite's SPA fallback answers missing tiles with 200 + index.html — treat as missing
            if (!r.ok || !(r.headers.get('content-type') || '').includes('image')) {
              throw new Error(`elevation tile ${zoom}/${tx}/${ty} → HTTP ${r.status}`)
            }
            return r.blob()
          })
          .then(createImageBitmap)
          .then((img) => ctx.drawImage(img, (dx + half) * TILE_PX, (dy + half) * TILE_PX))
          // missing / failed tile = open sea → keep the pre-filled 0 m, never reject
          .catch(() => {})
      )
    }
  }
  await Promise.all(jobs)

  const rgba = ctx.getImageData(0, 0, sizePx, sizePx).data
  const data = new Float32Array(sizePx * sizePx)
  let minM = Infinity
  let maxM = -Infinity
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const m = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768
    data[i] = m
    if (m < minM) minM = m
    if (m > maxM) maxM = m
    sum += m
  }

  const metersPerPixel = (156543.03392 * Math.cos(latRad)) / 2 ** zoom
  return {
    data,
    size: sizePx,
    metersPerPixel,
    extentMeters: metersPerPixel * sizePx,
    minM,
    maxM,
    meanM: sum / data.length,
    lat,
    lon,
    zoom,
  }
}

// bilinear sample of the height grid at fractional pixel coords
export function sampleDem(dem, px, py) {
  const { data, size } = dem
  const x = Math.min(Math.max(px, 0), size - 1.001)
  const y = Math.min(Math.max(py, 0), size - 1.001)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const i = y0 * size + x0
  const a = data[i]
  const b = data[i + 1]
  const c = data[i + size]
  const d = data[i + size + 1]
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}
