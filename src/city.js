import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry32 } from './noise.js'
import { FLOOR_Y } from './terrain.js'

// Concentric terraced ring-city inside the excavation basin.
// Rings are split across three groups that rotate at different speeds.

function sectorShape(rIn, rOut, a0, a1) {
  const s = new THREE.Shape()
  s.absarc(0, 0, rOut, a0, a1, false)
  s.absarc(0, 0, rIn, a1, a0, true)
  return s
}

// mergeGeometries requires uniform indexing — Extrude is non-indexed, Box/Cylinder are indexed
function flat(geo) {
  if (!geo.index) return geo
  const g = geo.toNonIndexed()
  geo.dispose()
  return g
}

function sectorGeometry(rIn, rOut, a0, a1, height, yBase) {
  const geo = new THREE.ExtrudeGeometry(sectorShape(rIn, rOut, a0, a1), {
    depth: height,
    bevelEnabled: false,
    curveSegments: Math.max(4, Math.ceil((a1 - a0) * 20)),
  })
  geo.rotateX(-Math.PI / 2) // extrusion depth becomes +Y
  geo.translate(0, yBase, 0)
  return geo
}

function boxAt(w, h, d, radius, angle, yBase) {
  const geo = new THREE.BoxGeometry(w, h, d)
  geo.translate(radius, yBase + h / 2, 0)
  geo.rotateY(angle)
  return flat(geo)
}

export function createCity(seed) {
  const rng = mulberry32(seed * 31 + 5)
  const group = new THREE.Group()

  const mat = new THREE.MeshStandardMaterial({
    color: 0xb2b2b2,
    roughness: 0.62,
    metalness: 0,
    envMapIntensity: 0.45,
  })

  const rotors = [
    { group: new THREE.Group(), speed: 0.03 },
    { group: new THREE.Group(), speed: -0.017 },
    { group: new THREE.Group(), speed: 0.009 },
  ]
  const rotorGeos = [[], [], []]

  const ringRadii = [1.55, 2.25, 2.95, 3.65, 4.35, 5.0, 5.6]
  ringRadii.forEach((r, ringIndex) => {
    const bucket = rotorGeos[ringIndex % 3]
    let a = rng() * Math.PI * 2
    const end = a + Math.PI * 2
    while (a < end) {
      const arc = 0.22 + rng() * 0.95
      const a1 = Math.min(a + arc, end)
      const gap = rng() < 0.28 ? 0.06 + rng() * 0.28 : 0.015
      const t = 0.13 + rng() * 0.3
      const h = (0.28 + rng() * rng() * 1.0) * (1.15 - ringIndex * 0.07)

      bucket.push(sectorGeometry(r - t / 2, r + t / 2, a, a1, h, FLOOR_Y))

      // stacked second tier on some segments
      if (rng() < 0.35 && a1 - a > 0.25) {
        const inset = (a1 - a) * 0.18
        bucket.push(
          sectorGeometry(r - t * 0.28, r + t * 0.28, a + inset, a1 - inset, h * (0.35 + rng() * 0.4), FLOOR_Y + h)
        )
      }
      // occasional rooftop greeble blocks
      if (rng() < 0.5) {
        const ga = a + (a1 - a) * rng()
        const s = 0.05 + rng() * 0.12
        bucket.push(boxAt(s, s * (0.6 + rng()), s, r, ga, FLOOR_Y + h))
      }
      a = a1 + gap
    }

    // radial connector bridges to the next ring outward
    if (ringIndex < ringRadii.length - 1) {
      const n = 1 + Math.floor(rng() * 3)
      for (let i = 0; i < n; i++) {
        const angle = rng() * Math.PI * 2
        const rNext = ringRadii[ringIndex + 1]
        const len = rNext - r + 0.25
        bucket.push(boxAt(len, 0.12 + rng() * 0.3, 0.12 + rng() * 0.22, (r + rNext) / 2, angle, FLOOR_Y))
      }
    }
  })

  // scattered floor debris blocks, orbiting with the rings
  for (let i = 0; i < 160; i++) {
    const bucket = rotorGeos[i % 3]
    const radius = 1.2 + rng() * 4.5
    const angle = rng() * Math.PI * 2
    const s = 0.04 + rng() * 0.15
    bucket.push(boxAt(s, s * (0.5 + rng() * 1.4), s * (0.6 + rng() * 0.9), radius, angle, FLOOR_Y))
  }

  rotors.forEach((rotor, i) => {
    if (rotorGeos[i].length) {
      const mesh = new THREE.Mesh(mergeGeometries(rotorGeos[i]), mat)
      mesh.castShadow = true
      mesh.receiveShadow = true
      rotor.group.add(mesh)
    }
    group.add(rotor.group)
  })

  // static center machine under the cone tip
  const centerGeos = []
  centerGeos.push(boxAt(1.35, 0.12, 0.12, 0, 0, FLOOR_Y + 0.1))
  centerGeos.push(boxAt(1.35, 0.12, 0.12, 0, Math.PI / 2, FLOOR_Y + 0.1))
  const hub = new THREE.CylinderGeometry(0.2, 0.24, 0.34, 32)
  hub.translate(0, FLOOR_Y + 0.17, 0)
  centerGeos.push(flat(hub))
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    centerGeos.push(boxAt(0.14, 0.2 + rng() * 0.2, 0.14, 0.55, a, FLOOR_Y))
  }
  const center = new THREE.Mesh(mergeGeometries(centerGeos), mat)
  center.castShadow = true
  center.receiveShadow = true
  group.add(center)

  // crisp quarry wall at the basin edge
  const wallGeo = new THREE.CylinderGeometry(6.35, 6.35, 1.15, 160, 1, true)
  const wall = new THREE.Mesh(
    wallGeo,
    new THREE.MeshStandardMaterial({
      color: 0xb4b4b4,
      roughness: 0.7,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.35,
    })
  )
  wall.position.y = FLOOR_Y + 0.45
  wall.receiveShadow = true
  group.add(wall)

  // faint etched survey circles sweeping out over the terrain
  const lines = new THREE.Group()
  const lineMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
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

  return {
    group,
    lines,
    update(dt, speedMul) {
      for (const rotor of rotors) rotor.group.rotation.y += rotor.speed * speedMul * dt
    },
  }
}
