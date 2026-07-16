import * as THREE from 'three'
import { drapeAt } from './geo.js'

// Ride view — cockpit/roof camera glued to a followed train, looking forward
// along the track. Immersive-mode Phase 1's second piece (see
// docs/IMMERSIVE_MODE_RESEARCH.md's roadmap + docs/FOLLOW_CAMERA_DESIGN.md's
// own "Ride view" section for the full writeup).
//
// This is layered ON TOP of an already-active follow.js session — it is NOT
// a sixth independent camera-motion source with its own entry in follow's
// mutex table. It never touches follow's state machine; it only:
//   - polls follow.active / follow.layerId / follow.entityId every tick
//   - piggybacks an ABSOLUTE camera placement AFTER follow.tick() already ran
//     that frame (index.js calls ride.tick() immediately after follow.tick())
//   - is wired to auto-exit the INSTANT follow stops, via follow's own
//     onChange callback (index.js: `onChange: (s) => { if (!s.active)
//     ride.exit() ... }`) — this fires synchronously inside stopFollow(),
//     which every mutex caller (startTour/flyToLonLat/selectPoi/deselect/
//     keyPan.onEngage/pan-drag-detect/entity-vanished) already invokes BEFORE
//     starting whatever new tween/tour is about to own the camera. That
//     ordering is what lets ride.js stay a dumb passenger with zero mutex
//     logic of its own: by the time a competing motion source's tween
//     actually begins, ride has already restored the saved pose and handed
//     controls back — no tweenActive/tourActive guard needed here.
//
// follow.tick() keeps running completely unmodified while riding: its writes
// to camera.position get overwritten below every frame (harmless — this
// module's tick() always runs after it), and its writes to controls.target
// are actively USEFUL — delta-carry keeps controls.target exactly equal to
// the entity's live world position every frame (target started there at
// follow-engage and receives the identical per-frame delta pos does). That
// collapses camDist (camera↔target distance) to ~rideHeight for the whole
// ride, which is what pins trains.js into its near-view car-chain LOD the
// entire time (see the layer's setEntityHidden — this module's chosen fix for
// "own car chain sits right where the camera is").

const LOOK_DAMP_TAU = 0.35 // seconds — response time of the low-pass filter on
// the look-ahead target point (not a per-frame lerp constant, so it stays
// frame-rate independent, see tick()). Smooths out the small heading kinks a
// real polyline has between sampled vertices — a bare per-frame camera.lookAt
// at the raw look-ahead sample would visibly snap-rotate crossing each vertex.

export function createRide({ camera, controls, follow, motion, layers, params, getHeightField, invalidate, onChange }) {
  const state = {
    active: false,
    savedPos: new THREE.Vector3(),
    savedTarget: new THREE.Vector3(),
    lookTarget: new THREE.Vector3(),
    lookInit: false,
    hiddenLayerId: null,
    hiddenEntityId: null,
  }
  const _lookWant = new THREE.Vector3()

  function notify() {
    onChange?.({ active: state.active, layerId: follow.layerId, entityId: follow.entityId })
  }

  // ride is only offered on layers that opt into the forward-sample query —
  // today that's trains.js (both its TRA and THSR instances share one
  // factory, see trains.js header); ships.js doesn't implement follow at all
  // yet (phase 2, see follow.js §2), so it never reaches here.
  //
  // `follow.active` alone is NOT enough: it flips true the instant
  // followEntity() is called (follow.js sets state.layerId synchronously,
  // before its fly-in tween even starts — see follow.js's own header on
  // active vs "engaged") — the SAME frame the UI's Follow button (and its
  // Ride button, which only appears once isFollowingThis is true) reflects
  // that. A user clicking Ride during that ~1.8s fly-in would otherwise have
  // ride.tick() start writing an absolute camera.position on top of
  // motion.tick(dt)'s own tween write every frame (ride runs later in
  // index.js's per-frame order, so it would always win — silently hijacking
  // the fly-in instead of letting it land), and `enter()` would snapshot a
  // mid-flight, not-yet-hovering pose as `savedPos`/`savedTarget` for later
  // restore. Gating on `!motion.tweenActive && !motion.tourActive` too means
  // enter() simply no-ops during that brief window — same discipline
  // follow.js's own tick() guard already applies for the identical reason
  // (design doc §3's "opus major 2").
  function canRide() {
    if (!follow.active || motion.tweenActive || motion.tourActive) return false
    const layer = layers.get(follow.layerId)
    return !!layer && typeof layer.getEntityLookahead === 'function'
  }

  function setHidden(hidden) {
    const layer = layers.get(state.hiddenLayerId)
    layer?.setEntityHidden?.(state.hiddenEntityId, hidden)
  }

  function enter() {
    if (state.active || !canRide()) return false
    state.savedPos.copy(camera.position)
    state.savedTarget.copy(controls.target)
    state.lookInit = false
    state.hiddenLayerId = follow.layerId
    state.hiddenEntityId = follow.entityId
    setHidden(true) // own car chain would otherwise render right where the camera sits — see module header
    controls.enabled = false
    state.active = true
    invalidate()
    notify()
    return true
  }

  // full restore — saved pose back, MapControls back on. Same path whether
  // triggered by the user (toggle/ESC) or by follow stopping underneath us
  // (see module header's onChange wiring).
  function exit() {
    if (!state.active) return false
    setHidden(false)
    state.active = false
    controls.enabled = true
    camera.position.copy(state.savedPos)
    controls.target.copy(state.savedTarget)
    controls.update()
    invalidate()
    notify()
    return true
  }

  function toggle() {
    return state.active ? exit() : enter()
  }

  // per-frame — index.js calls this once per tick(), immediately after
  // follow.tick() and before chunkManager.update()/camera.updateMatrixWorld()
  // (same slot in the frame follow itself uses, see design doc).
  function tick(dt) {
    if (!state.active) return
    // defensive backstop only — the onChange wiring (module header) already
    // exits synchronously the instant follow stops, so this should rarely if
    // ever actually fire.
    if (!follow.active) {
      exit()
      return
    }
    const layer = layers.get(follow.layerId)
    const hf = getHeightField()
    const pos = layer?.getEntityPosition?.(follow.entityId)
    if (!pos || !hf) {
      exit()
      return
    }

    // clamp above terrain: the baked track elevation (pos.y) is a 2D-polyline
    // drape and can sit slightly under the actual heightfield in places
    // (bridges/cuttings/DEM mismatch) — never let the ride camera dip into a
    // hillside crossing a saddle.
    const groundY = drapeAt(hf, pos.x, pos.z, params.demExaggeration)
    const camY = Math.max(pos.y, groundY) + params.rideHeight
    camera.position.set(pos.x, camY, pos.z)

    // look-ahead sample, offset by the SAME rideHeight so the camera pitches
    // with the track's own grade instead of forcing an artificial level view
    const ahead = layer.getEntityLookahead?.(follow.entityId, params.rideLookAhead)
    if (ahead) _lookWant.set(ahead.x, ahead.y + params.rideHeight, ahead.z)
    else _lookWant.set(pos.x, camY, pos.z + 1) // defensive fallback — practically unreachable whenever getEntityPosition succeeded, see trains.js

    if (!state.lookInit) {
      state.lookTarget.copy(_lookWant)
      state.lookInit = true
    } else {
      const alpha = 1 - Math.exp(-dt / LOOK_DAMP_TAU) // frame-rate independent low-pass, see module header
      state.lookTarget.lerp(_lookWant, alpha)
      // snap once the remaining gap is imperceptible (~1cm) instead of letting
      // the lerp crawl toward it asymptotically forever: an un-snapped lerp
      // never becomes an EXACT no-op frame-to-frame, so camera.lookAt() below
      // keeps producing a (vanishingly) different quaternion every frame even
      // once the train has stopped (timeline paused) — OrbitControls.update()
      // (which still runs every frame regardless of controls.enabled) detects
      // that as camera motion and fires 'change' -> invalidate(), which would
      // hold the on-demand render loop out of idle far longer than the
      // instant-freeze this app's on-demand render rule expects (caught via
      // manual renderCount polling while paused mid-ride — see verify notes).
      // follow.tick()'s own delta-carry doesn't need this: dx/dy/dz land on
      // EXACTLY 0 the frame after pos stops changing, a true no-op already.
      if (state.lookTarget.distanceToSquared(_lookWant) < 1e-8) state.lookTarget.copy(_lookWant)
    }
    camera.lookAt(state.lookTarget)
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') exit() // no-op when not riding (exit() self-guards)
  }
  window.addEventListener('keydown', onKeyDown)

  return {
    enter,
    exit,
    toggle,
    tick,
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
    },
    get active() {
      return state.active
    },
  }
}
