import * as THREE from 'three'

// Follow camera: the fifth camera-motion source (tour / fly tween / free
// OrbitControls nav / keypan already exist — see docs/FOLLOW_CAMERA_DESIGN.md
// for the full state-machine review). Core model is "delta-carry": every
// frame the followed entity's world-position delta gets added to BOTH
// controls.target and camera.position, so the user's relative orbit/zoom
// pose is preserved untouched — no chase-cam, no path planning, no smoothing
// (the entity itself already moves continuously frame-to-frame, so the carry
// is naturally smooth).
//
// Any layer opts in by implementing the optional Layer interface method
// `getEntityPosition(entityId) -> {x,y,z} | null` (null = entity currently
// doesn't exist — collapsed schedule window, rebuild, or the owning layer
// itself hidden; see trains.js). A null return is this module's ONLY signal
// to disengage on "entity vanished" — no special-casing per layer here.
//
// Engage sequencing (opus-reviewed, see design doc §3): followEntity() does
// NOT start the delta-carry immediately. It first cancels any in-flight
// tour/tween, then flies the camera to hover over the entity's CURRENT spot
// via motion.flyTo(pos, target, onArrive) — delta-carry only starts inside
// that onArrive callback (called by tour.js's tick() the frame tween.t
// reaches 1). This is what makes state.lastPos double as the engage flag:
// null = "requested, not yet following" (chip shows, camera not carried
// yet); non-null = actually carrying. If the user interrupts the flight
// (rotate/pan/click elsewhere → motion.cancel(), which also clears the
// pending onArrive — see tour.js), onArrive never fires, so lastPos stays
// null forever; the next tick() call below (guarded by !tweenActive) finds
// lastPos still null and treats that as "pending flight died without
// arriving" → aborts cleanly (chip disappears, no ghost-engage).
//
// Mutex with the other four motion sources is NOT owned here — this module
// only reacts to what it's told (followEntity/stopFollow) plus per-frame
// polling of motion.tweenActive/tourActive and controls.state. The actual
// "who cancels whom" wiring (startTour/flyToLonLat/selectPoi/deselect/
// keyPan.onEngage all call stopFollow() first) lives in index.js, per design
// doc §3's mutex table — kept there so this module stays a dumb, reusable
// "track this entity" primitive with zero knowledge of tour/selection/keypan.

// OrbitControls internal STATE.PAN numeric value. Not exported by three.js —
// hard-coded per docs/FOLLOW_CAMERA_DESIGN.md §3 (flagged there in case a
// future three.js upgrade renumbers its internal enum).
const PAN_STATE = 2
// controls.target XZ displacement (world units) above which a PAN_STATE tick
// reads as a real user drag rather than floating-point noise or the per-frame
// clampPan/anti-penetration boundary micro-correction (index.js tick(), which
// runs unconditionally in free-nav and can nudge target.x/z by a hair even
// when the user isn't panning at all — see design doc §3's dual-condition note).
const PAN_EPS = 1e-4

export function createFollow({ camera, controls, motion, layers, invalidate, onChange }) {
  const state = {
    layerId: null,
    entityId: null,
    title: null, // opaque display label (e.g. "台鐵 1234 自強") passed through from the caller — UI-only, never read by this module
    lastPos: null, // null = requested but not yet engaged (mid fly-in); non-null = carrying
    lastTargetXZ: null, // controls.target.{x,z} as WE last left it — pan-drag detector's baseline
  }
  const _offset = new THREE.Vector3()
  const _target = new THREE.Vector3()

  function notify(active) {
    onChange?.({ active, layerId: state.layerId, entityId: state.entityId, title: state.title })
  }

  function reset() {
    state.layerId = null
    state.entityId = null
    state.title = null
    state.lastPos = null
    state.lastTargetXZ = null
  }

  function stopFollow() {
    if (!state.layerId) return false
    reset()
    notify(false)
    invalidate() // freeze the camera exactly where the carry left it
    return true
  }

  // called by tour.js's tick() once the fly-in tween reaches t=1 (never on a
  // cancelled/interrupted flight — see module header). Samples the entity's
  // position NOW (i.e. as of last frame's layout, since this fires from
  // motion.tick() which runs before layers.tickAll() in index.js's frame —
  // see design doc §4) as the delta-carry baseline; the very next
  // layers.tickAll() this same frame advances the entity, and this tick's
  // follow.tick() below carries exactly that one frame's delta — same shape
  // as every subsequent frame, no special-cased first-frame jump.
  function engageArrive() {
    if (!state.layerId) return // stopFollow() already fired between flyTo() and arrival
    const layer = layers.get(state.layerId)
    const pos = layer?.getEntityPosition?.(state.entityId)
    if (!pos) {
      reset()
      notify(false)
      return
    }
    state.lastPos = { x: pos.x, y: pos.y, z: pos.z }
    state.lastTargetXZ = { x: controls.target.x, z: controls.target.z }
    invalidate()
  }

  // entry point (index.js facade + LayerPickCard's Follow button). `title` is
  // an optional opaque display label (LayerPickCard passes its pick card's
  // own `pick.title`) — carried through to the 'follow' event for the corner
  // chip (App.jsx), which otherwise has no way to know a friendly name for a
  // bare entityId (this module stays layer-agnostic, see header). Returns
  // false without side effects if the layer doesn't support following or the
  // entity isn't currently resolvable (e.g. clicked a train whose service
  // window just ended between pick and click).
  function followEntity(layerId, entityId, title) {
    const layer = layers.get(layerId)
    if (!layer || typeof layer.getEntityPosition !== 'function') return false
    const pos = layer.getEntityPosition(entityId)
    if (!pos) return false

    motion.cancel() // stop whatever tour/tween owned the camera before this

    state.layerId = layerId
    state.entityId = entityId
    state.title = title ?? String(entityId)
    state.lastPos = null // pending — engageArrive() sets this once the fly-in lands
    state.lastTargetXZ = null

    // fly to hover over the entity, preserving the CURRENT view offset (same
    // pattern as flyToLonLat's _flyOffset) so switching follow targets or
    // engaging from wherever the user was looking doesn't reset zoom/angle
    _offset.subVectors(camera.position, controls.target)
    _target.set(pos.x, pos.y, pos.z)
    motion.flyTo(_target.clone().add(_offset), _target.clone(), engageArrive)

    notify(true)
    invalidate()
    return true
  }

  // per-frame — index.js calls this once per tick(), after layers.tickAll()
  // (entities already advanced this frame) and before chunkManager.update()
  // (so DEM streaming follows the carried target) — see design doc §4.
  function tick() {
    if (!state.layerId) return
    // guard (design doc §3): a pre-engage flight (or a tour that somehow got
    // started without going through the stopFollow() mutex wiring) owns the
    // camera right now — never delta-carry on top of it.
    if (motion.tweenActive || motion.tourActive) return

    if (state.lastPos === null) {
      // tween is inactive but we never engaged — the pending fly-in was
      // interrupted (rotate/pan/click elsewhere → motion.cancel(), which
      // drops the pending onArrive). Abort rather than silently engaging
      // from wherever the camera happens to be now.
      reset()
      notify(false)
      return
    }

    const layer = layers.get(state.layerId)
    const pos = layer?.getEntityPosition?.(state.entityId)
    if (!pos) {
      // entity gone (service ended, rebuild dropped it, or its layer got
      // hidden — getEntityPosition returns null for all three, see trains.js)
      reset()
      notify(false)
      invalidate()
      return
    }

    // pan-drag detector: PAN_STATE alone would misfire on a plain click
    // (pointerdown sets state=PAN before any movement); XZ displacement
    // alone would misfire on clampPan's every-frame boundary micro-correction
    // (which isn't gated on controls.state at all). Both together = a real drag.
    if (controls.state === PAN_STATE) {
      const dx = controls.target.x - state.lastTargetXZ.x
      const dz = controls.target.z - state.lastTargetXZ.z
      if (Math.hypot(dx, dz) > PAN_EPS) {
        reset()
        notify(false)
        invalidate()
        return
      }
    }

    const dx = pos.x - state.lastPos.x
    const dy = pos.y - state.lastPos.y
    const dz = pos.z - state.lastPos.z
    controls.target.x += dx
    controls.target.y += dy
    controls.target.z += dz
    camera.position.x += dx
    camera.position.y += dy
    camera.position.z += dz
    state.lastPos.x = pos.x
    state.lastPos.y = pos.y
    state.lastPos.z = pos.z
    state.lastTargetXZ.x = controls.target.x
    state.lastTargetXZ.z = controls.target.z
    // no invalidate() here — isAnimating() already keeps the loop non-idle
    // while the followed layer is visible+playing (design doc §4); an entity
    // that isn't moving (paused timeline) means dx=dy=dz=0, a no-op write.
  }

  return {
    followEntity,
    stopFollow,
    tick,
    get active() {
      return state.layerId !== null
    },
    get layerId() {
      return state.layerId
    },
    get entityId() {
      return state.entityId
    },
    get title() {
      return state.title
    },
  }
}
