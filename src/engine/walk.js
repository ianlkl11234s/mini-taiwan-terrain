import * as THREE from 'three'
import { TILE_PX } from './dem.js'
import { metersToWorldY } from './geo.js'

// Walk mode — first-person WASD camera on the real terrain. Immersive-mode
// Phase 2 prototype (docs/IMMERSIVE_MODE_RESEARCH.md §五-1, full writeup in
// docs/WALK_MODE_DESIGN.md). Same family as ride.js — a standalone camera
// mode with save/restore pose, controls.enabled=false while active, ESC to
// exit — but unlike ride (glued to a followed train) walk has no entity: the
// walker's own xz position + yaw/pitch IS the state.
//
// index.js wiring (mirrors ride.js's slot):
//   - walk.tick(dt) runs in the same per-frame slot ride.tick() uses — after
//     follow.tick()/ride.tick(), before chunkManager.update() — so writing
//     controls.target here every frame drives tile streaming/LOD exactly the
//     way ride's delta-carry does (see module header note in ride.js).
//   - isAnimating() must OR in walk.isMoving() so the on-demand render loop
//     stays awake while walking and freezes the instant the walker (and the
//     vertical settle damper) both stop.
//   - keyPan (arrow/WASD map-pan) and walk share the W/A/S/D keys — index.js
//     gates keyPan.tick() off (keyPan.reset() instead) while walk.active, the
//     same way it already does for an active tour/tween.

const YAW_SPEED = 0.0025 // rad per px of pointer-lock movementX — plain FPS-mouse feel, no config surface (prototype scope)
const PITCH_MAX = THREE.MathUtils.degToRad(85) // never quite vertical — avoids the lookAt/quaternion singularity at the poles
const EYE_DAMP_LAMBDA = 6 // THREE.MathUtils.damp rate for vertical settle — climbing/descending a slope eases instead of snapping
const SNAP_EPS = 1e-6 // world units — see ride.js's identical note: an un-snapped damp() never becomes an EXACT no-op frame-to-frame, which would hold isMoving()/on-demand-render out of idle forever on a motionless walker
const SPRINT_MULT = 4
// jump gravity, real-world m/s² — NOT the true 9.8: at this world's scale
// (40 m/s walkSpeed default, K ≈ 1/480.78 world-units/meter) real gravity
// reads floaty/slow-motion. Hand-tuned by feel (verify: docs/WALK_MODE_DESIGN.md
// §Jump) — same real-world-meters-through-K convention as walkSpeed/eyeOffsetY
// below, converted to world units per frame, never through metersToWorldY/
// demExaggeration (a jump's height is a body-scale quantity, same reasoning
// walkEyeHeight already documents — it shouldn't stretch with vertical terrain
// exaggeration).
const WALK_GRAVITY_MPS2 = 25

const KEYMAP = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' }

function isEditable(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

// Is the DEM tile under (x,z) actually resident (fetched-and-resolved, land
// OR sea) as opposed to simply not-yet-requested/in-flight? HeightField.
// heightAtWorld() returns exactly 0m for BOTH "tile missing" and "tile
// resolved as open sea" (geo.js: `if (!t) return 0`), so the raw sample alone
// can't tell them apart — walking off the streamed edge would otherwise read
// as "at sea level" for one frame, and (more importantly) walking onto REAL
// open sea would permanently read as "still missing" and never settle,
// holding the walker frozen at their last inland height forever. Only
// `heightField.tiles` (public Map, keyed exactly like `.key()`) records which
// outcome actually happened, so this checks tile residency directly instead
// of alone. Uses only HeightField's public surface (`tiles`, `key()`,
// `projection.worldToPixel()`) — no change to geo.js needed.
function tileResident(hf, x, z) {
  const { px, py } = hf.projection.worldToPixel(x, z)
  return hf.tiles.has(hf.key(Math.floor(px / TILE_PX), Math.floor(py / TILE_PX)))
}

export function createWalk({ camera, controls, params, motion, follow, getHeightField, invalidate, onChange, domElement = document.body }) {
  const state = {
    active: false,
    savedPos: new THREE.Vector3(),
    savedTarget: new THREE.Vector3(),
    savedNear: 0,
    x: 0,
    z: 0, // walker footprint (world xz) — the source of truth; camera.position.y is derived
    yaw: 0,
    pitch: 0,
    eyeY: 0, // damped camera Y (world units)
    lastGroundM: 0, // meters — last resident-tile ground reading (tile-miss fallback, see tileResident above)
    moving: false, // WASD held, airborne, OR the vertical damper hasn't snapped yet — isAnimating() input
    vy: 0, // vertical velocity, world units/sec — only meaningful while airborne
    airborne: false, // true from jump takeoff until landing snap; while true, eyeY integrates vy instead of damping to the ground
  }
  const held = new Set() // mirrors keypan.js's held-key-set pattern
  let jumpQueued = false // Space keydown → one-shot; consumed (and cleared) by the very next tick() whether or not it actually launched a jump
  // DEV headless test hook (window.__exp.walk.setInput) — pointer lock is
  // frequently unavailable in a headless/automated browser (agent-browser
  // SwiftShader session included), so the movement math must be drivable
  // without a real mouse/keyboard. Not gated behind import.meta.env.DEV
  // internally — same convention the rest of engine.debug already follows
  // (only the window.__exp assignment in App.jsx is DEV-gated).
  const debugInput = { forward: 0, right: 0, sprint: false, jump: false }

  function notify() {
    onChange?.({ active: state.active })
  }

  function onKeyDown(e) {
    if (!state.active) return
    if (e.key === 'Escape') {
      exit()
      return
    }
    if (isEditable(document.activeElement)) return
    const dir = KEYMAP[e.code]
    if (dir) {
      held.add(dir)
      invalidate()
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') held.add('sprint')
    if (e.code === 'Space') {
      jumpQueued = true
      invalidate() // wake the on-demand loop so the very next tick() actually consumes the request (see module header: tick() is skipped entirely while idle)
      e.preventDefault() // pointer lock is active during walk — an un-prevented Space scrolls the (invisible) page behind the canvas
    }
  }
  function onKeyUp(e) {
    const dir = KEYMAP[e.code]
    if (dir) held.delete(dir)
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') held.delete('sprint')
  }
  function onBlur() {
    held.clear()
  }
  function onMouseMove(e) {
    if (!state.active || document.pointerLockElement !== domElement) return
    state.yaw -= e.movementX * YAW_SPEED
    state.pitch = THREE.MathUtils.clamp(state.pitch - e.movementY * YAW_SPEED, -PITCH_MAX, PITCH_MAX)
    invalidate() // mouse-look is event-driven, not polled — one invalidate per look tick, same pattern controls' own 'change' listener uses elsewhere
  }
  // native pointer-lock exit (browser ESC, or the user alt-tabbing away) must
  // exit walk too — our own onKeyDown Escape branch never fires in that path
  // since pointer lock already ate the ESC keystroke before it became a DOM
  // keydown event.
  function onPointerLockChange() {
    if (state.active && document.pointerLockElement !== domElement) exit()
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  window.addEventListener('mousemove', onMouseMove)
  document.addEventListener('pointerlockchange', onPointerLockChange)

  function enter() {
    if (state.active) return false
    const hf = getHeightField()
    if (!hf) return false
    motion.cancel() // grabbing the camera cancels any tour/fly-tween — same discipline keyPan.onEngage already applies
    follow.stopFollow() // also cascades to ride.exit() via index.js's follow onChange wiring
    state.savedPos.copy(camera.position)
    state.savedTarget.copy(controls.target)
    state.savedNear = camera.near
    state.x = controls.target.x
    state.z = controls.target.z
    // start facing wherever the camera already looks (projected to yaw) so
    // entering doesn't snap-rotate the view out from under the user
    const dir = new THREE.Vector3()
    camera.getWorldDirection(dir)
    state.yaw = Math.atan2(-dir.x, -dir.z)
    state.pitch = 0
    state.lastGroundM = tileResident(hf, state.x, state.z) ? hf.heightAtWorld(state.x, state.z) : 0
    const groundY = metersToWorldY(hf, Math.max(state.lastGroundM, 0), params.demExaggeration)
    state.eyeY = groundY + params.walkEyeHeight * hf.projection.K
    // near 0.02 (scene.js) ≈ 10m — clips the ground plane right at eye level;
    // 0.002 clears it. Restored verbatim on exit.
    camera.near = 0.002
    camera.updateProjectionMatrix()
    camera.position.set(state.x, state.eyeY, state.z)
    camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ')
    controls.enabled = false
    held.clear()
    debugInput.forward = 0
    debugInput.right = 0
    debugInput.sprint = false
    debugInput.jump = false
    jumpQueued = false
    state.vy = 0
    state.airborne = false
    state.moving = false
    state.active = true
    // best-effort: rejects in some automated/headless browser contexts
    // (verify's agent-browser session included — modern Chrome returns a
    // Promise from requestPointerLock) and must never surface as a console
    // error. The debug setInput() hook (module header) covers movement
    // without it; mouse-look simply stays unavailable in that case.
    domElement.requestPointerLock?.()?.catch?.(() => {})
    invalidate()
    notify()
    return true
  }

  function exit() {
    if (!state.active) return false
    state.active = false
    held.clear()
    controls.enabled = true
    camera.near = state.savedNear
    camera.updateProjectionMatrix()
    camera.position.copy(state.savedPos)
    controls.target.copy(state.savedTarget)
    controls.update()
    if (document.pointerLockElement === domElement) document.exitPointerLock?.()
    invalidate()
    notify()
    return true
  }

  function toggle() {
    return state.active ? exit() : enter()
  }

  function isMoving() {
    return state.moving
  }

  // DEV/test hook: merge into the synthetic input used alongside held keys
  // (see computeInput below) — {forward, right} in [-1,1], sprint boolean.
  // Also accepts {yaw, pitch} (radians) to steer look direction without a
  // real pointer-lock mouse, handy for aiming the walker downhill in a verify
  // script before pushing forward. {jump: true} queues a one-shot jump
  // request exactly like a real Space keydown — consumed (and reset to
  // false) by the very next tick() regardless of whether it actually
  // launched a jump (only fires when grounded — see tick()).
  function setInput(patch = {}) {
    if (patch.forward !== undefined) debugInput.forward = patch.forward
    if (patch.right !== undefined) debugInput.right = patch.right
    if (patch.sprint !== undefined) debugInput.sprint = patch.sprint
    if (patch.jump !== undefined) debugInput.jump = patch.jump
    if (patch.yaw !== undefined) state.yaw = patch.yaw
    if (patch.pitch !== undefined) state.pitch = THREE.MathUtils.clamp(patch.pitch, -PITCH_MAX, PITCH_MAX)
    invalidate()
  }

  const _fwd = new THREE.Vector3()
  const _right = new THREE.Vector3()
  const _move = new THREE.Vector3()

  function tick(dt) {
    if (!state.active) return
    const hf = getHeightField()
    if (!hf) {
      exit()
      return
    }

    // one-shot jump request, consumed this frame regardless of outcome (see
    // onKeyDown/setInput — real Space keydowns and the debug hook both just
    // set these flags; grounded-gating happens below)
    const jumpRequested = jumpQueued || debugInput.jump
    jumpQueued = false
    debugInput.jump = false

    const fKey = (held.has('f') ? 1 : 0) - (held.has('b') ? 1 : 0)
    const rKey = (held.has('r') ? 1 : 0) - (held.has('l') ? 1 : 0)
    // real keys win when present; debugInput is the headless-test fallback
    // (both sources are never expected to drive at once in practice)
    const f = fKey || debugInput.forward
    const r = rKey || debugInput.right
    const sprint = held.has('sprint') || debugInput.sprint
    const walking = !!f || !!r

    if (walking) {
      // yaw-only forward/right — pitch is deliberately excluded so looking
      // up/down never lifts the walker off the ground. A YXZ camera LOOKS
      // along (-sin(yaw), 0, -cos(yaw)) — both components negated, or W
      // walks backward (user-reported). Runs the same whether airborne or
      // grounded — mid-air steering is deliberate (spec: better feel than a
      // locked ballistic trajectory), it's a horizontal xz delta either way.
      _fwd.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw))
      _right.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw))
      _move.set(0, 0, 0).addScaledVector(_fwd, f).addScaledVector(_right, r)
      if (_move.lengthSq() > 1e-8) _move.normalize()
      const speedWorldPerSec = params.walkSpeed * (sprint ? SPRINT_MULT : 1) * hf.projection.K
      state.x += _move.x * speedWorldPerSec * dt
      state.z += _move.z * speedWorldPerSec * dt
    }

    // ground clamp: hold the last resident reading while the tile under the
    // walker hasn't streamed in yet (module header), never dip below sea
    // level (walk ON the water, not through the seabed)
    if (tileResident(hf, state.x, state.z)) state.lastGroundM = hf.heightAtWorld(state.x, state.z)
    const clampedM = Math.max(state.lastGroundM, 0)
    const targetGroundY = metersToWorldY(hf, clampedM, params.demExaggeration)
    const eyeOffsetY = params.walkEyeHeight * hf.projection.K // real-world eye height, NOT stretched by demExaggeration — a person's height doesn't grow with vertical exaggeration
    const targetEyeY = targetGroundY + eyeOffsetY

    // gravity/jump-impulse in world units — same real-meters-through-K
    // conversion as eyeOffsetY above, deliberately not run through
    // metersToWorldY/demExaggeration (module header)
    const gWorld = WALK_GRAVITY_MPS2 * hf.projection.K

    if (!state.airborne && jumpRequested) {
      // v0 = sqrt(2·g·h) — projectile-motion peak-height inversion, both g
      // and h already in world units so this falls out directly
      const jumpHeightWorld = params.walkJumpHeight * hf.projection.K
      state.vy = Math.sqrt(2 * gWorld * jumpHeightWorld)
      state.airborne = true
    }

    if (state.airborne) {
      // semi-implicit Euler: velocity integrates first, then position —
      // matches the rest of the engine's per-frame integrators (e.g. cone
      // kick decay) and is stable at the dt this loop runs at (capped 0.05s)
      state.vy -= gWorld * dt
      state.eyeY += state.vy * dt
      if (state.eyeY <= targetEyeY) {
        // landed — snap exactly onto the ground+eye target (no vertical
        // penetration/overshoot) and hand back off to the damp-based
        // ground-follow below next tick
        state.eyeY = targetEyeY
        state.vy = 0
        state.airborne = false
      }
    } else {
      state.eyeY = THREE.MathUtils.damp(state.eyeY, targetEyeY, EYE_DAMP_LAMBDA, dt)
      if (Math.abs(state.eyeY - targetEyeY) < SNAP_EPS) state.eyeY = targetEyeY // exact snap — see module header's isMoving()/idle-freeze note
    }
    const settling = !state.airborne && state.eyeY !== targetEyeY
    state.moving = walking || settling || state.airborne // airborne must stay "moving" — render can't freeze mid-flight

    camera.position.set(state.x, state.eyeY, state.z)
    camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ')
    // controls.target rides the ground point directly under the walker (not
    // the camera itself) — camDist collapses to ~walkEyeHeight, which is the
    // documented/expected floor for fogScale/streaming-radius while walking
    // (see module header + docs/WALK_MODE_DESIGN.md)
    controls.target.set(state.x, targetGroundY, state.z)
  }

  return {
    enter,
    exit,
    toggle,
    tick,
    isMoving,
    setInput,
    debugState() {
      return {
        active: state.active,
        x: state.x,
        z: state.z,
        eyeY: state.eyeY,
        groundM: state.lastGroundM,
        moving: state.moving,
        yaw: state.yaw,
        pitch: state.pitch,
        airborne: state.airborne,
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
    },
    get active() {
      return state.active
    },
  }
}
