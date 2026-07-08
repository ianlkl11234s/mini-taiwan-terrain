import * as THREE from 'three'

// Camera motion: the fly-to tween (POI focus, presets, home) and the
// cinematic tour. One continuous Catmull-Rom spline: current camera pose →
// above the FROM poi → arc across the terrain → standoff short of the TO poi.
// Sampled by ARC LENGTH (uniform speed), driven by a trapezoidal velocity
// profile, with all rotation going through a damped "gimbal" controller so
// snaps are impossible.

const EASINGS = {
  smooth: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2), // cubic in-out
  glide: (t) => 1 - Math.pow(1 - t, 5), // quintic out
  linear: (t) => t,
}

const TOUR_N = 240

function boxBlur(arr, radius, passes = 1) {
  let a = arr
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(a.length)
    for (let i = 0; i < a.length; i++) {
      let s = 0
      let c = 0
      for (let j = Math.max(0, i - radius); j <= Math.min(a.length - 1, i + radius); j++) {
        s += a[j]
        c++
      }
      out[i] = s / c
    }
    a = out
  }
  return a
}

// trapezoidal velocity: accelerate → cruise at constant speed → decelerate
function trapezoid(t, r) {
  t = THREE.MathUtils.clamp(t, 0, 1)
  if (t < r) return (t * t) / (2 * r * (1 - r))
  if (t > 1 - r) {
    const u = 1 - t
    return 1 - (u * u) / (2 * r * (1 - r))
  }
  return (t - r / 2) / (1 - r)
}

// `sample(x, z)` is the terrain height sampler; `getPois()` returns the
// current POI list (tourFrom/tourTo ids are looked up in it at start time).
export function createMotion({ params, camera, controls, sample, getPois }) {
  const tween = {
    active: false,
    t: 0,
    p0: new THREE.Vector3(),
    p1: new THREE.Vector3(),
    t0: new THREE.Vector3(),
    t1: new THREE.Vector3(),
  }

  const tour = {
    active: false,
    t: 0,
    bank: 0,
    uA: 0.2, // arc-length fraction where the path passes over the FROM poi
    curve: null,
    aTop: new THREE.Vector3(),
    bTop: new THREE.Vector3(),
  }
  const _tp = new THREE.Vector3()
  const _tg = new THREE.Vector3()
  const _tt0 = new THREE.Vector3()
  const _tt1 = new THREE.Vector3()
  const _tm = new THREE.Matrix4()
  const _tq = new THREE.Quaternion()
  const _tqr = new THREE.Quaternion()
  const Z_AXIS = new THREE.Vector3(0, 0, 1)
  const UP = new THREE.Vector3(0, 1, 0)

  function flyTo(pos, target) {
    tween.p0.copy(camera.position)
    tween.t0.copy(controls.target)
    tween.p1.copy(pos)
    tween.t1.copy(target)
    tween.t = 0
    tween.active = true
  }

  function startTour() {
    const pois = getPois()
    const A = pois.find((p) => p.id === params.tourFrom)
    const B = pois.find((p) => p.id === params.tourTo)
    if (!A || !B || A === B) return false

    // ground path A → standoff short of B (ending on B itself would degenerate
    // to a vertical view), arced sideways for a more interesting line
    const a = new THREE.Vector3(A.x, 0, A.z)
    const bFull = new THREE.Vector3(B.x, 0, B.z)
    const dist = a.distanceTo(bFull)
    const dirAB = bFull.clone().sub(a).normalize()
    const b = bFull.clone().addScaledVector(dirAB, -Math.min(7, dist * 0.4))
    const mid = a.clone().add(b).multiplyScalar(0.5)
    mid.addScaledVector(new THREE.Vector3(-dirAB.z, 0, dirAB.x), dist * 0.22)

    const px = new Float32Array(TOUR_N)
    const pz = new Float32Array(TOUR_N)
    const ground = new Float32Array(TOUR_N)
    for (let i = 0; i < TOUR_N; i++) {
      const t = i / (TOUR_N - 1)
      const u = 1 - t
      px[i] = u * u * a.x + 2 * u * t * mid.x + t * t * b.x
      pz[i] = u * u * a.z + 2 * u * t * mid.z + t * t * b.z
      ground[i] = sample(px[i], pz[i])
    }

    // altitude: clearance envelope (rolling max) blurred hard — rises over
    // mountains as one long swell, never tracks bumps
    const radius = Math.round(4 + params.tourSmoothing * 30)
    const envelope = new Float32Array(TOUR_N)
    for (let i = 0; i < TOUR_N; i++) {
      let m = -Infinity
      for (let j = Math.max(0, i - radius); j <= Math.min(TOUR_N - 1, i + radius); j++) m = Math.max(m, ground[j])
      envelope[i] = m
    }
    const smoothY = boxBlur(envelope, radius, 3)

    // one continuous spline starting at the CURRENT camera position — the
    // approach is just the first leg of the same flight, no phase transition
    const pts = [camera.position.clone()]
    for (let i = 0; i < TOUR_N; i += 20) pts.push(new THREE.Vector3(px[i], smoothY[i] + params.tourAltitude, pz[i]))
    pts.push(new THREE.Vector3(px[TOUR_N - 1], smoothY[TOUR_N - 1] + params.tourAltitude, pz[TOUR_N - 1]))
    tour.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5)
    tour.curve.arcLengthDivisions = 400
    tour.curve.updateArcLengths()

    // arc-length fraction where we pass over the FROM poi (gaze switches there)
    let bestD = Infinity
    for (let i = 0; i <= 200; i++) {
      const s = i / 200
      tour.curve.getPointAt(s, _tp)
      const d = Math.hypot(_tp.x - A.x, _tp.z - A.z)
      if (d < bestD) {
        bestD = d
        tour.uA = s
      }
    }

    tour.aTop.set(A.x, A.h + 0.6, A.z)
    tour.bTop.set(B.x, B.h + 0.6, B.z)
    tour.bank = 0
    tour.t = 0
    tour.active = true
    tween.active = false
    return true
  }

  function stopTour() {
    tour.active = false
    camera.up.set(0, 1, 0)
  }

  // user grabbing the camera cancels any fly-to or tour
  function cancel() {
    tween.active = false
    tour.active = false
    camera.up.set(0, 1, 0)
  }

  // gaze target along the flight: frame the FROM poi on approach, then look
  // ahead down the path, converging onto the TO poi at the end
  function tourGaze(s, camPos, out) {
    const ahead = Math.min(s + params.tourLook, 1)
    tour.curve.getPointAt(ahead, out)
    out.y -= params.tourAltitude * 0.7 // gaze slightly below the flight line
    // hand the gaze off BEFORE we're overhead the FROM poi — looking straight
    // down while passing over it flips the heading violently
    const fromBlend = THREE.MathUtils.smoothstep(s, tour.uA * 0.15, tour.uA * 0.75)
    out.lerp(tour.aTop, 1 - fromBlend)
    out.lerp(tour.bTop, THREE.MathUtils.smoothstep(s, 0.85, 1))

    // pitch clamp: never look down steeper than ~72°, pushing the gaze point
    // forward instead — guards against gimbal flips in every configuration
    const dx = out.x - camPos.x
    const dz = out.z - camPos.z
    const horiz = Math.hypot(dx, dz)
    const drop = camPos.y - out.y
    const minHoriz = drop * 0.33
    if (drop > 0 && horiz < minHoriz) {
      if (horiz > 1e-4) {
        const k = minHoriz / horiz
        out.x = camPos.x + dx * k
        out.z = camPos.z + dz * k
      } else {
        tour.curve.getTangentAt(s, _tt0)
        out.x = camPos.x + _tt0.x * minHoriz
        out.z = camPos.z + _tt0.z * minHoriz
      }
    }
    return out
  }

  // advance whichever motion is active; returns 'tour' | 'tween' | null so
  // the engine knows whether free navigation (controls + pan clamp) applies
  function tick(dt) {
    // cinematic tour: arc-length uniform speed + trapezoid profile + damped gimbal
    if (tour.active) {
      tour.t = Math.min(1, tour.t + dt / params.tourDuration)
      const s = trapezoid(tour.t, 0.18)

      // position: exact on the spline, constant speed thanks to getPointAt
      tour.curve.getPointAt(s, _tp)
      camera.position.copy(_tp)

      // desired orientation: look at the gaze target, rolled into the turn
      tourGaze(s, _tp, _tg)
      controls.target.copy(_tg)
      _tm.lookAt(camera.position, _tg, UP)
      _tq.setFromRotationMatrix(_tm)
      tour.curve.getTangentAt(s, _tt0)
      tour.curve.getTangentAt(Math.min(s + 0.02, 1), _tt1)
      const curl = _tt0.x * _tt1.z - _tt0.z * _tt1.x // signed xz turn over the window
      const arrived = tour.t >= 1
      // after arrival: settle — unwind the bank and let the gimbal fully converge
      // before handing off, so OrbitControls has nothing to snap to
      const bankTarget = arrived ? 0 : THREE.MathUtils.clamp(curl * 15 * params.tourBank, -0.5, 0.5)
      tour.bank = THREE.MathUtils.damp(tour.bank, bankTarget, 2.5, dt)
      _tq.multiply(_tqr.setFromAxisAngle(Z_AXIS, tour.bank))

      // gimbal: rotation chases the desired orientation with a max slew rate,
      // so it can never jump — 80°/s hard ceiling
      const angle = camera.quaternion.angleTo(_tq)
      if (angle > 1e-5) {
        const f = Math.min(1 - Math.exp(-3.2 * dt), (1.4 * dt) / angle)
        camera.quaternion.slerp(_tq, f)
      }

      if (arrived && angle < 0.001 && Math.abs(tour.bank) < 0.001) tour.active = false
      return 'tour'
    }
    if (tween.active) {
      tween.t = Math.min(1, tween.t + dt / params.flyDuration)
      const e = EASINGS[params.flyEasing](tween.t)
      camera.position.lerpVectors(tween.p0, tween.p1, e)
      controls.target.lerpVectors(tween.t0, tween.t1, e)
      camera.lookAt(controls.target)
      if (tween.t >= 1) tween.active = false
      return 'tween'
    }
    return null
  }

  return {
    flyTo,
    startTour,
    stopTour,
    cancel,
    tick,
    get tourActive() {
      return tour.active
    },
    get tweenActive() {
      return tween.active
    },
  }
}
