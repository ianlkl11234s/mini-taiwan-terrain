import * as THREE from 'three'
import { FLOOR_Y } from './terrain.js'

// The hovering monolith: inverted cone with a target-pattern cap,
// idle bob + spin, tilts and drifts toward the cursor.

function makeCapTexture() {
  const size = 1024
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const cx = size / 2
  const R = size / 2

  ctx.fillStyle = '#e9e9e9'
  ctx.fillRect(0, 0, size, size)

  const disc = (r, color) => {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(cx, cx, r * R, 0, Math.PI * 2)
    ctx.fill()
  }

  disc(0.93, '#101010') // outer black band
  disc(0.66, '#e6e6e6') // white field
  disc(0.3, '#101010') // center black disc
  disc(0.13, '#dcdcdc') // center dot

  // faint radial tick so the spin is readable
  ctx.strokeStyle = 'rgba(16,16,16,0.5)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(cx, cx - R * 0.66)
  ctx.lineTo(cx, cx - R * 0.93)
  ctx.stroke()

  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 8
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function createCone() {
  const group = new THREE.Group()

  const radius = 1.18
  const height = 2.35
  const tipY = 0.62 // world height of the tip above the basin floor structures

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xefefef,
    roughness: 0.3,
    metalness: 0.05,
    envMapIntensity: 0.9,
  })

  const coneGeo = new THREE.ConeGeometry(radius, height, 128, 1)
  coneGeo.rotateX(Math.PI) // tip down
  const cone = new THREE.Mesh(coneGeo, bodyMat)
  cone.castShadow = true
  group.add(cone)

  // soft lip around the top edge
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius - 0.035, 0.05, 24, 128), bodyMat)
  rim.rotation.x = Math.PI / 2
  rim.position.y = height / 2
  rim.castShadow = true
  group.add(rim)

  const cap = new THREE.Mesh(
    new THREE.CircleGeometry(radius - 0.03, 128),
    new THREE.MeshStandardMaterial({
      map: makeCapTexture(),
      roughness: 0.42,
      metalness: 0,
      envMapIntensity: 0.5,
    })
  )
  cap.rotation.x = -Math.PI / 2
  cap.position.y = height / 2 + 0.051
  group.add(cap)

  const baseY = FLOOR_Y + tipY + height / 2
  group.position.set(0, baseY, 0)

  const state = { spinBoost: 0 }
  const focusPoint = new THREE.Vector3()

  return {
    group,
    // world-space point the DOF autofocus locks onto (the cap center)
    getFocusPoint() {
      return focusPoint.set(group.position.x, group.position.y + height * 0.3, group.position.z)
    },
    kick(amount) {
      state.spinBoost = Math.min(6, state.spinBoost + amount)
    },
    update(dt, t, mouse, params) {
      // idle spin + cursor-energy boost that decays
      cone.rotation.y += (params.coneSpin + state.spinBoost) * dt
      cap.rotation.z = -cone.rotation.y
      state.spinBoost *= Math.exp(-dt * 1.8)

      // lean toward the cursor
      const targetRX = mouse.y * params.coneTilt
      const targetRZ = -mouse.x * params.coneTilt
      group.rotation.x = THREE.MathUtils.damp(group.rotation.x, targetRX, 3, dt)
      group.rotation.z = THREE.MathUtils.damp(group.rotation.z, targetRZ, 3, dt)

      // gentle positional drift + idle bob
      group.position.x = THREE.MathUtils.damp(group.position.x, mouse.x * params.coneDrift, 2, dt)
      group.position.z = THREE.MathUtils.damp(group.position.z, -mouse.y * params.coneDrift, 2, dt)
      group.position.y = baseY + Math.sin(t * 0.8) * params.bob + Math.sin(t * 2.1) * params.bob * 0.2
    },
  }
}
