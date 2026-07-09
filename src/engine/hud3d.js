import * as THREE from 'three'
import { mulberry32 } from './noise.js'
import { FLOOR_Y } from './terrain.js'

// FUI instrument layer replacing the ring city: an engraved dial on the basin
// floor, rotating tick rings, a radar sweep, POI stems and scan pulses.

const DEG = Math.PI / 180

function canvasTex(size, draw) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  draw(ctx, size)
  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 8
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function flatPlane(tex, worldSize, y, opacity = 1) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(worldSize, worldSize),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false })
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = y
  mesh.renderOrder = 2
  return mesh
}

// Hill-climb from a coarse candidate to the true local extreme of the height field.
function refine(sample, x, z, sign = 1) {
  let best = { x, z, h: sample(x, z) }
  let step = 0.7
  while (step > 0.015) {
    let improved = false
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const nx = best.x + Math.cos(a) * step
      const nz = best.z + Math.sin(a) * step
      const r = Math.hypot(nx, nz)
      if (r < 8.5 || r > 24) continue
      const nh = sample(nx, nz)
      if (nh * sign > best.h * sign) {
        best = { x: nx, z: nz, h: nh }
        improved = true
      }
    }
    if (!improved) step *= 0.5
  }
  return best
}

// Scan the terrain for named points of interest: 4 highest peaks + 1 depression.
export function findPois(sample, seed, toFeet = (h) => Math.round(4800 + h * 420)) {
  const cands = []
  for (let a = 0; a < 360; a += 4) {
    for (let r = 9.5; r <= 20.5; r += 1.2) {
      const x = Math.cos(a * DEG) * r
      const z = Math.sin(a * DEG) * r
      cands.push({ x, z, h: sample(x, z) })
    }
  }
  cands.sort((p, q) => q.h - p.h)
  // refine to true summits, then dedupe (nearby candidates climb to the same top)
  const picked = []
  for (const c of cands) {
    const summit = refine(sample, c.x, c.z, 1)
    if (picked.every((p) => Math.hypot(p.x - summit.x, p.z - summit.z) >= 5.5)) {
      picked.push(summit)
      if (picked.length === 4) break
    }
  }
  const low = refine(sample, cands[cands.length - 1].x, cands[cands.length - 1].z, -1)
  const pois = picked.map((p, i) => ({ ...p, id: `PK-0${i + 1}`, kind: 'PEAK' }))
  pois.push({ ...low, id: 'DEP-05', kind: 'BASIN' })
  pois.forEach((p) => {
    p.feet = toFeet(p.h)
    p.elevM = Math.round(p.feet / 3.28084)
    p.grid = `E ${(p.x + 28).toFixed(1)} · N ${(p.z + 28).toFixed(1)}`
    p.top = new THREE.Vector3(p.x, p.h + 2.1, p.z)
  })
  return pois
}

function drawDial(ctx, size, ink, accent, rng) {
  const cx = size / 2
  const R = size * 0.48
  ctx.translate(cx, cx)
  ctx.strokeStyle = ink
  ctx.fillStyle = ink
  ctx.lineWidth = 2

  // concentric engraved circles
  for (const f of [0.2, 0.34, 0.55, 0.78, 0.985]) {
    ctx.globalAlpha = f > 0.9 ? 0.85 : 0.45
    ctx.beginPath()
    ctx.arc(0, 0, R * f, 0, Math.PI * 2)
    ctx.stroke()
  }

  // degree ticks + labels every 30°
  ctx.globalAlpha = 0.8
  ctx.font = `${size * 0.018}px "SF Mono", ui-monospace, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let d = 0; d < 360; d += 2) {
    const major = d % 30 === 0
    const mid = d % 10 === 0
    const len = major ? R * 0.035 : mid ? R * 0.02 : R * 0.01
    const a = d * DEG
    ctx.save()
    ctx.rotate(a)
    ctx.lineWidth = major ? 3 : 2
    ctx.beginPath()
    ctx.moveTo(R * 0.985, 0)
    ctx.lineTo(R * 0.985 - len, 0)
    ctx.stroke()
    if (major) {
      ctx.translate(R * 0.915, 0)
      ctx.rotate(Math.PI / 2)
      ctx.globalAlpha = 0.7
      ctx.fillText(String(d).padStart(3, '0'), 0, 0)
      ctx.globalAlpha = 0.8
    }
    ctx.restore()
  }

  // crosshair with a gap at center
  ctx.globalAlpha = 0.4
  ctx.lineWidth = 2
  for (const a of [0, 90, 180, 270]) {
    ctx.save()
    ctx.rotate(a * DEG)
    ctx.beginPath()
    ctx.moveTo(R * 0.08, 0)
    ctx.lineTo(R * 0.97, 0)
    ctx.stroke()
    ctx.restore()
  }

  // scattered data glyphs: squares, plusses, dots
  for (let i = 0; i < 90; i++) {
    const a = rng() * Math.PI * 2
    const r = R * (0.22 + rng() * 0.72)
    const x = Math.cos(a) * r
    const y = Math.sin(a) * r
    const t = rng()
    ctx.globalAlpha = 0.25 + rng() * 0.4
    if (t < 0.4) ctx.fillRect(x - 3, y - 3, 6, 6)
    else if (t < 0.7) {
      ctx.fillRect(x - 7, y - 1, 14, 2)
      ctx.fillRect(x - 1, y - 7, 2, 14)
    } else {
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // accent arcs + chips
  ctx.strokeStyle = accent
  ctx.fillStyle = accent
  ctx.lineWidth = 5
  for (let i = 0; i < 4; i++) {
    const start = rng() * Math.PI * 2
    const len = (14 + rng() * 55) * DEG
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    ctx.arc(0, 0, R * [0.34, 0.55, 0.78, 0.985][i], start, start + len)
    ctx.stroke()
  }
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2
    const r = R * (0.25 + rng() * 0.68)
    ctx.globalAlpha = 0.9
    ctx.fillRect(Math.cos(a) * r - 4, Math.sin(a) * r - 4, 8, 8)
  }
}

function drawDashRing(ctx, size, ink, fraction, dashes) {
  const cx = size / 2
  const R = size * 0.48 * fraction
  ctx.translate(cx, cx)
  ctx.strokeStyle = ink
  ctx.lineWidth = size * 0.006
  ctx.globalAlpha = 0.75
  const step = (Math.PI * 2) / dashes
  for (let i = 0; i < dashes; i++) {
    ctx.beginPath()
    ctx.arc(0, 0, R, i * step, i * step + step * 0.55)
    ctx.stroke()
  }
  // 4 bracket accents
  ctx.lineWidth = size * 0.012
  ctx.globalAlpha = 0.9
  for (const a of [45, 135, 225, 315]) {
    ctx.beginPath()
    ctx.arc(0, 0, R * 1.06, (a - 6) * DEG, (a + 6) * DEG)
    ctx.stroke()
  }
}

function drawSweep(ctx, size, accent) {
  const cx = size / 2
  const R = size * 0.48
  const segs = 90
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * 70 * DEG
    ctx.fillStyle = accent
    ctx.globalAlpha = 0.28 * (1 - i / segs)
    ctx.beginPath()
    ctx.moveTo(cx, cx)
    ctx.arc(cx, cx, R, -a0 - (70 / segs) * DEG * 1.2, -a0)
    ctx.closePath()
    ctx.fill()
  }
}

function drawPulseRing(ctx, size, accent) {
  const cx = size / 2
  ctx.strokeStyle = accent
  ctx.lineWidth = size * 0.012
  ctx.globalAlpha = 1
  ctx.beginPath()
  ctx.arc(cx, cx, size * 0.47, 0, Math.PI * 2)
  ctx.stroke()
}

export function createHud3D(seed, pois, { ink, accent, platform: withPlatform = true }) {
  const rng = mulberry32(seed * 51 + 17)
  const group = new THREE.Group()
  const baseY = FLOOR_Y + 0.02

  // dial + rings + sweep live in their own subgroup. Real-world mode skips
  // building them entirely (they'd be hidden anyway, and the 2048² dial canvas
  // is too expensive for the throttled POI refreshes that happen mid-pan).
  const platform = new THREE.Group()
  let dial = null
  let ringA = null
  let ringB = null
  let sweep = null
  if (withPlatform) {
    dial = flatPlane(canvasTex(2048, (ctx, s) => drawDial(ctx, s, ink, accent, rng)), 12.6, baseY, 0.95)
    ringA = flatPlane(canvasTex(1024, (ctx, s) => drawDashRing(ctx, s, ink, 0.86, 24)), 10.6, baseY + 0.02, 0.85)
    ringB = flatPlane(canvasTex(1024, (ctx, s) => drawDashRing(ctx, s, accent, 0.62, 48)), 8.0, baseY + 0.03, 0.7)
    sweep = flatPlane(canvasTex(1024, (ctx, s) => drawSweep(ctx, s, accent)), 12.2, baseY + 0.01, 0.8)
    platform.add(dial, ringA, ringB, sweep)
  }
  group.add(platform)

  // POI stems: thin vertical hairline + accent cap marker
  const stemMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(ink), transparent: true, opacity: 0.6 })
  const capMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(accent), transparent: true, opacity: 0.95 })
  pois.forEach((p) => {
    const len = 2.1
    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.014, len, 0.014), stemMat)
    stem.position.set(p.x, p.h + len / 2, p.z)
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.11), capMat)
    cap.position.copy(p.top)
    cap.rotation.y = Math.PI / 4
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.015, 0.22), stemMat)
    base.position.set(p.x, p.h + 0.02, p.z)
    group.add(stem, cap, base)
  })

  // faint survey circles sweeping out over the terrain
  const lines = new THREE.Group()
  const lineMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(ink),
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  })
  for (const radius of [7.6, 9.6, 12.2, 15.2, 18.6]) {
    const torus = new THREE.TorusGeometry(radius, 0.014, 4, 320)
    torus.rotateX(Math.PI / 2)
    const ring = new THREE.Mesh(torus, lineMat)
    ring.position.y = 0.42
    lines.add(ring)
  }
  group.add(lines)

  // expanding scan pulses (spawned on demand)
  const pulseTex = canvasTex(512, (ctx, s) => drawPulseRing(ctx, s, accent))
  const pulses = []

  return {
    group,
    lines,
    platform,
    // on-demand render: an expanding pulse is a live animation → keep rendering
    pulseActive: () => pulses.length > 0,
    pulse() {
      const p = flatPlane(pulseTex, 1, baseY + 0.05, 0.8)
      p.userData.age = 0
      group.add(p)
      pulses.push(p)
    },
    update(dt, t, { ringSpeed, sweepSpeed }) {
      if (dial) {
        ringA.rotation.z += 0.11 * ringSpeed * dt
        ringB.rotation.z -= 0.07 * ringSpeed * dt
        sweep.rotation.z -= sweepSpeed * dt
        dial.material.opacity = 0.88 + Math.sin(t * 1.8) * 0.07
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i]
        p.userData.age += dt
        const k = p.userData.age / 2.2
        const s = 1 + k * 22
        p.scale.set(s, s, 1)
        p.material.opacity = Math.max(0, 0.8 * (1 - k))
        if (k >= 1) {
          group.remove(p)
          p.geometry.dispose()
          p.material.dispose()
          pulses.splice(i, 1)
        }
      }
    },
    dispose() {
      group.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose()
          o.material.map?.dispose()
          o.material.dispose()
        }
      })
    },
  }
}
