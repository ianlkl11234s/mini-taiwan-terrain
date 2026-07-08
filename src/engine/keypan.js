import * as THREE from 'three'

// Smooth keyboard pan (arrows + WASD): screen-relative ground-plane panning of
// controls.target + camera. ↑/W moves along the camera's forward direction
// projected onto the ground, ←/→ strafe. Speed scales with camera distance
// (near slow / far fast — map convention) with exponential ease-in and a
// glide-to-stop after release. Handwritten instead of
// OrbitControls.listenToKeyEvents: that helper doesn't guard editable
// elements and steps in fixed pixel jumps (no easing).
//
// Guards: typing in an input/select/textarea never pans; a mapped keydown
// cancels any active tour/fly-to via onEngage (same semantics as grabbing
// the camera). The engine calls tick() only during free navigation and
// reset() while a tour/tween owns the camera.

const KEYMAP = {
  ArrowUp: 'f',
  KeyW: 'f',
  ArrowDown: 'b',
  KeyS: 'b',
  ArrowLeft: 'l',
  KeyA: 'l',
  ArrowRight: 'r',
  KeyD: 'r',
}
const SPEED = 0.85 // max speed = camera distance × SPEED → ~1 screen-height/s at any zoom
const ACCEL = 7 // damp λ toward full speed (ease-in)
const GLIDE = 4 // damp λ toward zero after release (slide to a stop)

function isEditable(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function createKeyPan({ camera, controls, onEngage }) {
  const held = new Set()
  const vel = new THREE.Vector3()
  const _fwd = new THREE.Vector3()
  const _want = new THREE.Vector3()

  const onKeyDown = (e) => {
    const dir = KEYMAP[e.code]
    if (!dir || e.metaKey || e.ctrlKey || e.altKey) return
    if (isEditable(document.activeElement)) return // arrow keys belong to the field
    e.preventDefault()
    held.add(dir)
    onEngage?.() // cancel tour/fly-to — keys take over (fires on repeats too; cancel is idempotent)
  }
  const onKeyUp = (e) => {
    const dir = KEYMAP[e.code]
    if (dir) held.delete(dir)
  }
  const onBlur = () => held.clear() // window losing focus eats the keyup
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  return {
    tick(dt) {
      const f = (held.has('f') ? 1 : 0) - (held.has('b') ? 1 : 0)
      const r = (held.has('r') ? 1 : 0) - (held.has('l') ? 1 : 0)
      if (!f && !r && vel.lengthSq() < 1e-6) return
      // screen-relative frame: camera forward projected onto the ground plane
      _fwd.subVectors(controls.target, camera.position)
      _fwd.y = 0
      if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1) // looking straight down: pan north
      _fwd.normalize()
      _want.set(0, 0, 0).addScaledVector(_fwd, f)
      _want.x += -_fwd.z * r // right = forward × up
      _want.z += _fwd.x * r
      if (f || r) _want.normalize().multiplyScalar(camera.position.distanceTo(controls.target) * SPEED)
      const lambda = f || r ? ACCEL : GLIDE
      vel.x = THREE.MathUtils.damp(vel.x, _want.x, lambda, dt)
      vel.z = THREE.MathUtils.damp(vel.z, _want.z, lambda, dt)
      // move target and camera together — the engine's per-frame clampPan
      // (Taiwan bbox) runs right after and corrects both the same way
      controls.target.addScaledVector(vel, dt)
      camera.position.addScaledVector(vel, dt)
    },
    reset() {
      vel.set(0, 0, 0)
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    },
  }
}
