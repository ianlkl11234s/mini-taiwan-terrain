// Seedable simplex noise + fractal helpers.
// Simplex 2D based on Stefan Gustavson's public-domain reference implementation.

export function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const F2 = 0.5 * (Math.sqrt(3) - 1)
const G2 = (3 - Math.sqrt(3)) / 6

const grad3 = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 1, 0, -1, 0,
  0, 1, 0, -1, 0, 1, 0, -1,
])

export class Simplex2 {
  constructor(rng = Math.random) {
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    for (let i = 255; i > 0; i--) {
      const n = Math.floor(rng() * (i + 1))
      const t = p[i]
      p[i] = p[n]
      p[n] = t
    }
    this.perm = new Uint8Array(512)
    this.permMod12 = new Uint8Array(512)
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255]
      this.permMod12[i] = this.perm[i] % 12
    }
  }

  noise(xin, yin) {
    const perm = this.perm
    const permMod12 = this.permMod12
    let n0 = 0
    let n1 = 0
    let n2 = 0

    const s = (xin + yin) * F2
    const i = Math.floor(xin + s)
    const j = Math.floor(yin + s)
    const t = (i + j) * G2
    const x0 = xin - (i - t)
    const y0 = yin - (j - t)

    let i1, j1
    if (x0 > y0) {
      i1 = 1
      j1 = 0
    } else {
      i1 = 0
      j1 = 1
    }

    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1 + 2 * G2
    const y2 = y0 - 1 + 2 * G2

    const ii = i & 255
    const jj = j & 255

    let t0 = 0.5 - x0 * x0 - y0 * y0
    if (t0 >= 0) {
      const gi0 = permMod12[ii + perm[jj]] % 8
      t0 *= t0
      n0 = t0 * t0 * (grad3[gi0 * 2] * x0 + grad3[gi0 * 2 + 1] * y0)
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1
    if (t1 >= 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1]] % 8
      t1 *= t1
      n1 = t1 * t1 * (grad3[gi1 * 2] * x1 + grad3[gi1 * 2 + 1] * y1)
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2
    if (t2 >= 0) {
      const gi2 = permMod12[ii + 1 + perm[jj + 1]] % 8
      t2 *= t2
      n2 = t2 * t2 * (grad3[gi2 * 2] * x2 + grad3[gi2 * 2 + 1] * y2)
    }

    return 70 * (n0 + n1 + n2)
  }
}

// Standard fractal brownian motion, output roughly in [-1, 1].
export function fbm(simplex, x, y, octaves, lacunarity = 2, gain = 0.5) {
  let amp = 0.5
  let freq = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex.noise(x * freq, y * freq)
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

// Ridged multifractal — sharp crests, crater-like basins. Output in [0, 1].
export function ridged(simplex, x, y, octaves, lacunarity = 2, gain = 0.5) {
  let amp = 0.5
  let freq = 1
  let sum = 0
  let norm = 0
  let weight = 1
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(simplex.noise(x * freq, y * freq))
    n *= n
    n *= weight
    weight = Math.min(1, Math.max(0, n * 2))
    sum += n * amp
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function lerp(a, b, t) {
  return a + (b - a) * t
}
