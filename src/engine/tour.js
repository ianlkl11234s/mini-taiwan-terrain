import * as THREE from 'three'

// Camera motion: the fly-to tween (POI focus, presets, home) and the
// cinematic tour. One continuous Catmull-Rom spline sampled by ARC LENGTH
// (uniform speed), driven by a trapezoidal velocity profile, with all rotation
// going through a damped "gimbal" controller so snaps are impossible.
//
// Three tour modes, all planned ASYNCHRONOUSLY (planTour → beginTour) so the
// route can pre-stream terrain tiles before it commits to an altitude:
//   - 'p2p'     : current camera pose → over the FROM poi → arc → short of TO.
//                 Clearance envelope (rolling max) + a collision-guarantee pass
//                 that raises control points until the spline clears the relief.
//   - 'orbit'   : one closed ring around a summit, gaze locked on the peak.
//   - 'contour' : a gradient-marched iso-elevation loop below the summit, flown
//                 at a constant clearance band with the peak framed off-centre.

const EASINGS = {
  smooth: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2), // cubic in-out
  glide: (t) => 1 - Math.pow(1 - t, 5), // quintic out
  linear: (t) => t,
}

const TOUR_N = 240
const GRAD_EPS = 0.25 // gradient probe, world units (≈3 DEM z12 cells — dodges noise)

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

// `sample(x, z)` is the terrain height sampler; `getPois()` returns the current
// POI list; `ensureTiles`/`ensureDisk` pre-stream DEM tiles (async, timeout-
// bounded) so long routes aren't planned against unloaded 0 m relief;
// `worldPerMeter()` converts elevation offsets (meters) into scene-Y.
export function createMotion({ params, camera, controls, sample, getPois, ensureTiles, ensureDisk, worldPerMeter }) {
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
    curve: null,
    closed: false,
    mode: 'p2p',
    gaze: null, // (s, camPos, out) → out
  }
  // planning generation: bumped by cancel(), so a plan that resolves after the
  // user grabbed the camera (drag → cancel) is discarded instead of hijacking
  // the view. beginTour() only commits a plan whose gen still matches.
  let planGen = 0

  const _tp = new THREE.Vector3()
  const _tg = new THREE.Vector3()
  const _tt0 = new THREE.Vector3()
  const _tt1 = new THREE.Vector3()
  const _tm = new THREE.Matrix4()
  const _tq = new THREE.Quaternion()
  const _tqr = new THREE.Quaternion()
  const _scan = new THREE.Vector3()
  const _probe = new THREE.Vector3()
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

  // ---------------------------------------------------------------- geometry helpers

  function buildCurve(pts, closed) {
    const c = new THREE.CatmullRomCurve3(pts, closed, 'centripetal', 0.5)
    c.arcLengthDivisions = 400
    c.updateArcLengths()
    return c
  }

  // world-space xz gradient of the height field (central differences). Returns
  // magnitude; writes the (gx, gz) components into `out` = {x, z}.
  function gradient(x, z, out) {
    const gx = (sample(x + GRAD_EPS, z) - sample(x - GRAD_EPS, z)) / (2 * GRAD_EPS)
    const gz = (sample(x, z + GRAD_EPS) - sample(x, z - GRAD_EPS)) / (2 * GRAD_EPS)
    out.x = gx
    out.z = gz
    return Math.hypot(gx, gz)
  }

  // pitch clamp shared by the p2p + contour gaze: never let the gaze drop
  // steeper than ~72° below horizontal (guards every config against a gimbal
  // flip while passing over a target), pushing the gaze point forward instead.
  function clampPitch(out, camPos, curve, s) {
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
        curve.getTangentAt(s, _tt0)
        out.x = camPos.x + _tt0.x * minHoriz
        out.z = camPos.z + _tt0.z * minHoriz
      }
    }
  }

  // ---------------------------------------------------------------- collision guarantee
  // Dense-sample the built spline; return the minimum clearance (spline y −
  // terrain y) and the list of samples, so violators can raise nearby control
  // points.
  function scanClearance(curve, M) {
    let min = Infinity
    const viol = []
    for (let j = 0; j < M; j++) {
      const s = j / (M - 1)
      curve.getPointAt(s, _scan)
      const cl = _scan.y - sample(_scan.x, _scan.z)
      if (cl < min) min = cl
      viol.push({ x: _scan.x, z: _scan.z, cl })
    }
    return { min, viol }
  }

  // Raise interior control points (never index 0 = the fixed camera pose) until
  // every densely-sampled point clears tourAltitude×0.5. At most 3 iterations;
  // over-raising is safe (higher = further from the ground). Returns the final
  // curve + stats for the report/summary.
  function fixClearance(pts, alt) {
    const needMin = alt * 0.5
    const target = alt * 0.75 // restore violators to a comfortable band
    const M = Math.max(80, (pts.length - 1) * 30)
    let curve = buildCurve(pts, false)
    let { min, viol } = scanClearance(curve, M)
    const before = min
    let iter = 0
    while (min < needMin && iter < 3) {
      iter++
      const raise = new Float32Array(pts.length)
      for (const v of viol) {
        if (v.cl >= needMin) continue
        let bi = 1
        let bd = Infinity
        for (let k = 1; k < pts.length; k++) {
          const d = (pts[k].x - v.x) ** 2 + (pts[k].z - v.z) ** 2
          if (d < bd) {
            bd = d
            bi = k
          }
        }
        const deficit = target - v.cl
        if (deficit > raise[bi]) raise[bi] = deficit
      }
      for (let k = 1; k < pts.length; k++) pts[k].y += raise[k]
      curve = buildCurve(pts, false)
      ;({ min, viol } = scanClearance(curve, M))
    }
    return { curve, minClearance: min, before, iterations: iter }
  }

  // ---------------------------------------------------------------- plan: point-to-point

  async function planP2P(gen) {
    const pois = getPois()
    const A = pois.find((p) => p.id === params.tourFrom)
    const B = pois.find((p) => p.id === params.tourTo)
    if (!A || !B || A === B) return null

    // ground path A → standoff short of B, arced sideways for a livelier line
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
    }

    // pre-stream every tile the route crosses so the envelope is built against
    // real relief, not the datum-low 0 m that unloaded tiles read
    const seeds = []
    for (let i = 0; i < TOUR_N; i += 8) seeds.push({ x: px[i], z: pz[i] })
    await ensureTiles(seeds, { radiusTiles: 1, timeoutMs: 4500 })
    if (gen !== planGen) return null

    for (let i = 0; i < TOUR_N; i++) ground[i] = sample(px[i], pz[i])

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

    const fix = fixClearance(pts, params.tourAltitude)
    const curve = fix.curve

    // arc-length fraction where we pass over the FROM poi (gaze switches there)
    let uA = 0.2
    let bestD = Infinity
    for (let i = 0; i <= 200; i++) {
      const s = i / 200
      curve.getPointAt(s, _tp)
      const d = Math.hypot(_tp.x - A.x, _tp.z - A.z)
      if (d < bestD) {
        bestD = d
        uA = s
      }
    }
    const aTop = new THREE.Vector3(A.x, A.h + 0.6, A.z)
    const bTop = new THREE.Vector3(B.x, B.h + 0.6, B.z)

    const gaze = (s, camPos, out) => {
      const ahead = Math.min(s + params.tourLook, 1)
      curve.getPointAt(ahead, out)
      out.y -= params.tourAltitude * 0.7 // gaze slightly below the flight line
      const fromBlend = THREE.MathUtils.smoothstep(s, uA * 0.15, uA * 0.75)
      out.lerp(aTop, 1 - fromBlend)
      out.lerp(bTop, THREE.MathUtils.smoothstep(s, 0.85, 1))
      clampPitch(out, camPos, curve, s)
      return out
    }

    return {
      gen,
      mode: 'p2p',
      curve,
      closed: false,
      gaze,
      previewPoints: curve.getPoints(220),
      summary: {
        mode: 'p2p',
        from: A.id,
        to: B.id,
        controlPoints: pts.length,
        minClearance: +fix.minClearance.toFixed(3),
        clearanceBefore: +fix.before.toFixed(3),
        fixIterations: fix.iterations,
      },
    }
  }

  // ---------------------------------------------------------------- plan: orbit

  async function planOrbit(gen, peak) {
    const pois = getPois()
    const A = peak || pois.find((p) => p.id === params.tourFrom)
    if (!A) return null
    const cx = A.x
    const cz = A.z
    const R = Math.max(6, params.tourAltitude * 3.5) // orbit radius ~ visual scale
    await ensureDisk(cx, cz, R + 3, { timeoutMs: 4500 })
    if (gen !== planGen) return null

    const summitY = sample(cx, cz)
    const N = 64
    // ring height clears the tallest relief in the disk (the summit itself),
    // so the whole loop looks DOWN onto the peak at a comfortable depression
    let maxT = summitY
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2
      maxT = Math.max(maxT, sample(cx + Math.cos(th) * R, cz + Math.sin(th) * R))
    }
    const ringY = maxT + params.tourAltitude

    // start the ring at the bearing nearest the current camera → smallest cut
    const camBear = Math.atan2(camera.position.z - cz, camera.position.x - cx)
    const pts = []
    for (let i = 0; i < N; i++) {
      const th = camBear + (i / N) * Math.PI * 2
      pts.push(new THREE.Vector3(cx + Math.cos(th) * R, ringY, cz + Math.sin(th) * R))
    }
    const curve = buildCurve(pts, true)
    const summit = new THREE.Vector3(cx, summitY + 0.5, cz)
    const gaze = (_s, _camPos, out) => out.copy(summit) // fixed gaze on the peak

    return {
      gen,
      mode: 'orbit',
      curve,
      closed: true,
      gaze,
      previewPoints: curve.getPoints(240),
      summary: { mode: 'orbit', from: A.id, radius: +R.toFixed(2), ringPoints: N, ringClearance: +params.tourAltitude.toFixed(2) },
    }
  }

  // ---------------------------------------------------------------- plan: contour
  // Gradient-march an iso-elevation loop: from the summit walk downhill to the
  // target elevation E, then step along the contour tangent (⊥ gradient),
  // Newton-correcting back onto E each step, until the walk returns to the
  // start (closed) or leaves the pre-streamed disk.
  function extractContour(cx, cz, targetY, Rmax, stepLen) {
    const g = { x: 0, z: 0 }
    // 1. descend from the summit to the target band
    let px = cx
    let pz = cz
    let reached = false
    for (let i = 0; i < 4000; i++) {
      const gm = gradient(px, pz, g)
      let dx = 1
      let dz = 0
      if (gm > 1e-5) {
        dx = -g.x / gm
        dz = -g.z / gm
      }
      px += dx * stepLen
      pz += dz * stepLen
      if (sample(px, pz) <= targetY) {
        reached = true
        break
      }
      if (Math.hypot(px - cx, pz - cz) > Rmax) return { points: [], closed: false, exited: true }
    }
    if (!reached) return { points: [], closed: false, exited: false }
    // Newton-refine onto E
    for (let k = 0; k < 3; k++) {
      const err = sample(px, pz) - targetY
      const gm = gradient(px, pz, g)
      if (gm < 1e-5) break
      const f = err / (gm * gm)
      px -= f * g.x
      pz -= f * g.z
    }

    // 2. march the contour
    const sx = px
    const sz = pz
    const points = [new THREE.Vector3(px, sample(px, pz), pz)]
    let prevTx = 0
    let prevTz = 0
    let have = false
    let closed = false
    let exited = false
    // a clean loop around an isolated peak closes in far fewer steps than this;
    // blowing the cap means the iso-line is wandering a ridge (not a simple
    // loop) — treated as a failed extraction so the planner falls back
    const MAX = 1200
    for (let i = 0; i < MAX; i++) {
      const gm = gradient(px, pz, g)
      if (gm < 1e-5) break // flat spot — can't follow a contour
      let tx = -g.z / gm
      let tz = g.x / gm
      if (!have) {
        // first step: go counter-clockwise around the summit (radial × tangent > 0)
        const rx = px - cx
        const rz = pz - cz
        if (rx * tz - rz * tx < 0) {
          tx = -tx
          tz = -tz
        }
        have = true
      } else if (tx * prevTx + tz * prevTz < 0) {
        tx = -tx // keep travelling the same way around
        tz = -tz
      }
      prevTx = tx
      prevTz = tz
      px += tx * stepLen
      pz += tz * stepLen
      for (let k = 0; k < 2; k++) {
        const err = sample(px, pz) - targetY
        const gm2 = gradient(px, pz, g)
        if (gm2 < 1e-5) break
        const f = err / (gm2 * gm2)
        px -= f * g.x
        pz -= f * g.z
      }
      if (Math.hypot(px - cx, pz - cz) > Rmax) {
        exited = true
        break
      }
      points.push(new THREE.Vector3(px, sample(px, pz), pz))
      if (i > 16 && Math.hypot(px - sx, pz - sz) < stepLen * 1.5) {
        closed = true
        break
      }
    }
    return { points, closed, exited }
  }

  async function planContour(gen, opts) {
    const pois = getPois()
    const A = peakFor(pois)
    if (!A) return null
    const cx = A.x
    const cz = A.z
    const scale = worldPerMeter() || 1 / 300 // world-Y per meter
    let offsetM = opts.contourOffset ?? params.contourOffset ?? 300

    // too-short peak → orbit fallback (a 200 m band would be all cliff/coast)
    if (A.elevM - offsetM < 200) {
      console.info(`[tour] contour: ${A.name ?? A.id} target ${A.elevM - offsetM} m < 200 m — falling back to orbit`)
      return planOrbit(gen, A)
    }

    const stepLen = 0.5 // contour smoothness (world units)
    let offsetWorld = offsetM * scale
    let Rpre = THREE.MathUtils.clamp(offsetWorld * 8 + 4, 12, 30)
    await ensureDisk(cx, cz, Rpre, { timeoutMs: 5000 })
    if (gen !== planGen) return null

    const summitY = sample(cx, cz)
    let res = extractContour(cx, cz, summitY - offsetWorld, Rpre - stepLen * 2, stepLen)

    // boundary case: no clean closed loop (ran off the loaded disk, wandered a
    // ridge past the step cap, or barely started) → shrink the offset once and
    // retry closer to the summit, where the iso-line is more likely to close
    if (!res.closed) {
      offsetM *= 0.6
      offsetWorld = offsetM * scale
      Rpre = THREE.MathUtils.clamp(offsetWorld * 8 + 4, 12, 30)
      await ensureDisk(cx, cz, Rpre, { timeoutMs: 4000 })
      if (gen !== planGen) return null
      console.info(`[tour] contour: no closed loop — retrying at offset ${Math.round(offsetM)} m`)
      res = extractContour(cx, cz, summitY - offsetWorld, Rpre - stepLen * 2, stepLen)
    }
    // still no clean loop → orbit fallback (a ridge peak has no simple contour)
    if (!res.closed || res.points.length < 12) {
      console.info('[tour] contour: extraction did not close — falling back to orbit')
      return planOrbit(gen, A)
    }

    // flight line: the contour lifted by the clearance altitude (≈ a level band)
    const pts = res.points.map((p) => new THREE.Vector3(p.x, p.y + params.tourAltitude, p.z))
    // measure the loop length for the report
    let loopLen = 0
    for (let i = 1; i < res.points.length; i++) loopLen += res.points[i].distanceTo(res.points[i - 1])
    const curve = buildCurve(pts, res.closed)
    const summit = new THREE.Vector3(cx, summitY + 0.6, cz)

    const gaze = (s, camPos, out) => {
      const ahead = res.closed ? (s + params.tourLook) % 1 : Math.min(s + params.tourLook, 1)
      curve.getPointAt(ahead, out)
      out.lerp(summit, 0.35) // pull the gaze toward the peak so it stays framed
      clampPitch(out, camPos, curve, s)
      return out
    }

    return {
      gen,
      mode: 'contour',
      curve,
      closed: res.closed,
      gaze,
      previewPoints: curve.getPoints(Math.max(120, pts.length)),
      summary: {
        mode: 'contour',
        from: A.id,
        offsetM: Math.round(offsetM),
        targetElevM: Math.round(A.elevM - offsetM),
        contourPoints: res.points.length,
        loopLength: +loopLen.toFixed(1),
        closed: res.closed,
        stepLen,
      },
    }
  }

  // resolve the FROM peak (shared by the contour + orbit planners)
  function peakFor(pois) {
    return pois.find((p) => p.id === params.tourFrom)
  }

  // ---------------------------------------------------------------- plan/begin

  // Async route planner (pre-stream + build + verify). Returns a plan object or
  // null; NEVER mutates the live tour. The caller commits it via beginTour().
  function planTour(opts = {}) {
    const gen = planGen
    const mode = opts.mode || params.tourMode || 'p2p'
    if (mode === 'orbit') return planOrbit(gen)
    if (mode === 'contour') return planContour(gen, opts)
    return planP2P(gen)
  }

  // Commit a plan produced by planTour. Rejects a stale plan (the user grabbed
  // the camera while it was being planned → cancel() bumped planGen).
  function beginTour(plan) {
    if (!plan || plan.gen !== planGen) return false
    tour.curve = plan.curve
    tour.closed = plan.closed
    tour.mode = plan.mode
    tour.gaze = plan.gaze
    tour.bank = 0
    tour.t = 0
    tour.active = true
    tween.active = false
    camera.up.set(0, 1, 0)
    return true
  }

  function stopTour() {
    tour.active = false
    camera.up.set(0, 1, 0)
  }

  // user grabbing the camera cancels any fly-to or tour (and aborts planning)
  function cancel() {
    planGen++
    tween.active = false
    tour.active = false
    camera.up.set(0, 1, 0)
  }

  // advance whichever motion is active; returns 'tour' | 'tween' | null so the
  // engine knows whether free navigation (controls + pan clamp) applies
  function tick(dt) {
    // cinematic tour: arc-length uniform speed + trapezoid profile + damped gimbal
    if (tour.active) {
      tour.t = Math.min(1, tour.t + dt / params.tourDuration)
      const s = trapezoid(tour.t, 0.18)

      // position: exact on the spline, constant speed thanks to getPointAt
      tour.curve.getPointAt(s, _tp)
      camera.position.copy(_tp)

      // desired orientation: look at the gaze target, rolled into the turn
      tour.gaze(s, _tp, _tg)
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
    planTour,
    beginTour,
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
