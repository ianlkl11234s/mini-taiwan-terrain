import * as THREE from 'three'
import { mulberry32 } from './noise.js'
import { BASIN_BLEND } from './terrain.js'

// Map-style typography draped flat on the terrain: place names + spot elevations,
// drawn to canvas textures so they read like printed cartography.

const PLACE_NAMES = [
  'HUNTS MESA',
  'RAIN GOD MESA',
  'MITCHELL BUTTE',
  'SENTINEL FLAT',
  'GYPSUM CREEK',
  'YAZZIE DRAW',
  'CAIRN RIDGE',
  'THREE SISTERS',
  'SUBMARINE ROCK',
  'EAR OF THE WIND',
]

function textTexture(text, { size = 96, italic = true, spacing = 0.35, color = '#2e2820' }) {
  const font = `${italic ? 'italic ' : ''}500 ${size}px Georgia, 'Times New Roman', serif`
  const probe = document.createElement('canvas').getContext('2d')
  probe.font = font
  const gap = size * spacing
  let width = 0
  for (const ch of text) width += probe.measureText(ch).width + gap
  width -= gap

  const pad = size * 0.4
  const c = document.createElement('canvas')
  c.width = Math.ceil(width + pad * 2)
  c.height = Math.ceil(size * 1.6)
  const ctx = c.getContext('2d')
  ctx.font = font
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  let x = pad
  for (const ch of text) {
    ctx.fillText(ch, x, c.height / 2)
    x += ctx.measureText(ch).width + gap
  }

  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 8
  tex.colorSpace = THREE.SRGBColorSpace
  return { tex, aspect: c.width / c.height }
}

function makeLabelMesh(text, opts, worldWidth) {
  const { tex, aspect } = textTexture(text, opts)
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: opts.opacity ?? 0.9,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth, worldWidth / aspect), mat)
  mesh.renderOrder = 3
  return mesh
}

// sample a few points under the label footprint so it floats just above ridges
function settleHeight(sample, x, z, halfW) {
  let h = -Infinity
  for (let i = -2; i <= 2; i++) h = Math.max(h, sample(x + (i * halfW) / 2, z))
  return h + 0.14
}

// `center` follows the pan target in streamed real-world mode: labels re-sow
// around wherever the camera is (P1 degraded placement — same seeded pattern,
// translated; smarter per-feature placement is a P3 item).
export function createLabels(sample, seed, { real = false, toFeet, center = { x: 0, z: 0 } } = {}) {
  const group = new THREE.Group()
  const rng = mulberry32(seed * 13 + 29)

  // fictional cartography only in procedural mode — real-world maps get real data only
  if (!real) {
    const region = makeLabelMesh('N A V A J O   P L A T E A U', { size: 110, italic: false, spacing: 0.9, opacity: 0.78 }, 22)
    region.rotation.x = -Math.PI / 2
    region.position.set(center.x, 0, center.z - 12.5)
    region.position.y = settleHeight(sample, center.x, center.z - 12.5, 11)
    group.add(region)

    const names = [...PLACE_NAMES].sort(() => rng() - 0.5).slice(0, 7)
    names.forEach((name) => {
      const angle = rng() * Math.PI * 2
      const dist = BASIN_BLEND + 2.5 + rng() * 12
      const x = center.x + Math.cos(angle) * dist
      const z = center.z + Math.sin(angle) * dist
      const width = 3.6 + rng() * 1.8
      const mesh = makeLabelMesh(name, { size: 96, italic: true, spacing: 0.3, opacity: 0.85 }, width)
      mesh.rotation.x = -Math.PI / 2
      mesh.rotation.z = (rng() - 0.5) * 0.7
      mesh.position.set(x, settleHeight(sample, x, z, width / 2), z)
      group.add(mesh)
    })
  }

  // spot elevations: real feet when a DEM drives the terrain
  const spotCount = real ? 14 : 9
  const minDist = real ? 3 : BASIN_BLEND + 1
  for (let i = 0; i < spotCount; i++) {
    const angle = rng() * Math.PI * 2
    const dist = minDist + rng() * (24 - minDist)
    const x = center.x + Math.cos(angle) * dist
    const z = center.z + Math.sin(angle) * dist
    const h = sample(x, z)
    const feet = toFeet ? toFeet(h) : Math.round(4800 + h * 420 + rng() * 40)
    const mesh = makeLabelMesh(`· ${feet}`, { size: 78, italic: false, spacing: 0.06, opacity: 0.85, color: '#2a241c' }, 1.5)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(x, h + 0.12, z)
    group.add(mesh)
  }

  return group
}

export function disposeLabels(group) {
  group.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose()
      o.material.map?.dispose()
      o.material.dispose()
    }
  })
}
