import * as THREE from 'three'

// Generic marker sets: named points draped on the real-world terrain. Pure
// display layer — markers never enter the POI/tour system and are not
// clickable. The facade exposes:
//   engine.setMarkerSet(id, { points: [{name, lon, lat, elev?}], color?, visible? })
//   engine.removeMarkerSet(id) / engine.listMarkerSets()
// Calling setMarkerSet again with `points` replaces the set; without `points`
// it patches color/visible in place (how the GUI demo toggle works).
//
// Rendering per set: one InstancedMesh of flat ink discs (drawn on top —
// depthTest off, like printed map symbols; radius scales with fogScale so the
// dot holds ~constant screen size across the dolly range) + one canvas-sprite
// name tag per point, echoing the HUD peak tags' visual language (paper
// background, hairline border, ink text). Tags are sizeAttenuation:false so
// they stay legible at any distance; when a set has many points only the
// MAX_LABELS nearest-to-camera tags show (the peaks top-8 crowd-control
// pattern), with a fade over the swap.
//
// Heights: points with a baked `elev` use (elev - datumM) * K * demExaggeration
// (same math as the terrain sampler). Points without one sample
// heightField.heightAtWorld — tiles not yet streamed in read as 0 m (sea
// level), so tick() re-samples those points every 2 s and they settle onto
// the terrain as chunks load. Prefer providing `elev` for instant accuracy.

const MAX_LABELS = 8
const DOT_R = 0.14 // world units at fogScale 1 (~4–5 px on screen)
const TAG_PX = 22 // tag height in screen pixels
// tag palette leans darker/opaquer than the DOM peak tags: sprites live in the
// 3D frame, so the ACES tone map + grain wash them out a little
const INK = '#0d0f11'
const PAPER = 'rgba(252, 251, 248, 0.98)'
const BORDER = 'rgba(20, 22, 24, 0.6)'

function tagTexture(name) {
  const S = 3 // supersample for crisp text
  const h = TAG_PX * S
  const padX = 7 * S
  const probe = document.createElement('canvas').getContext('2d')
  const font = `600 ${12 * S}px "SF Mono", ui-monospace, "PingFang TC", monospace`
  probe.font = font
  const w = Math.ceil(probe.measureText(name).width + padX * 2)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = BORDER
  ctx.lineWidth = S
  ctx.strokeRect(S / 2, S / 2, w - S, h - S)
  ctx.font = font
  ctx.fillStyle = INK
  ctx.textBaseline = 'middle'
  ctx.fillText(name, padX, h / 2 + S * 0.5)
  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 4
  tex.colorSpace = THREE.SRGBColorSpace
  return { tex, aspect: w / h }
}

export function createMarkers(params) {
  const group = new THREE.Group() // master: visible only in real mode with a world
  group.visible = false
  const sets = new Map() // id → entry
  let heightField = null
  let fogScale = 1
  let builtFog = 1
  let refreshAcc = 0
  let labelAcc = 0

  const _dotGeo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2)
  const _m = new THREE.Matrix4()
  const _p = new THREE.Vector3()

  function pointY(pt) {
    const scale = heightField.projection.K * params.demExaggeration
    const m = pt.elev ?? heightField.heightAtWorld(pt._x, pt._z)
    return (m - heightField.datumM) * scale
  }

  // (re)compute world positions + instance matrices for one set
  function layout(entry) {
    if (!heightField || !entry.dots) return
    const r = DOT_R * fogScale
    entry.def.points.forEach((pt, i) => {
      if (pt._x === undefined) {
        const w = heightField.projection.lonLatToWorld(pt.lon, pt.lat)
        pt._x = w.x
        pt._z = w.z
      }
      const y = pointY(pt) + 0.02
      _m.makeScale(r, 1, r)
      _m.setPosition(pt._x, y, pt._z)
      entry.dots.setMatrixAt(i, _m)
      entry.sprites[i].position.set(pt._x, y, pt._z)
    })
    entry.dots.instanceMatrix.needsUpdate = true
    entry.dots.computeBoundingSphere()
  }

  function build(entry) {
    if (!heightField || entry.dots || !entry.def.points.length) return
    const n = entry.def.points.length
    entry.dotMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(entry.def.color),
      transparent: true,
      opacity: 0.9,
      depthTest: false, // map-symbol ink: draws over the terrain skin, never z-fights
      depthWrite: false,
      fog: true,
    })
    entry.dots = new THREE.InstancedMesh(_dotGeo, entry.dotMat, n)
    entry.dots.renderOrder = 4
    entry.group.add(entry.dots)
    entry.sprites = entry.def.points.map((pt) => {
      const { tex, aspect } = tagTexture(pt.name ?? '')
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 1,
        depthTest: false,
        sizeAttenuation: false, // constant screen size
        fog: false,
      })
      const s = new THREE.Sprite(mat)
      s.center.set(-0.12, 0.5) // tag floats to the right of its dot, HUD-style
      s.renderOrder = 5
      s.userData.aspect = aspect
      s.visible = false // tick() reveals it with the correct pixel scale
      entry.group.add(s)
      return s
    })
    layout(entry)
  }

  function disposeSet(entry) {
    group.remove(entry.group)
    if (entry.dots) {
      entry.dots.dispose()
      entry.dotMat.dispose()
      for (const s of entry.sprites) {
        s.material.map.dispose()
        s.material.dispose()
      }
    }
  }

  return {
    group,
    setSet(id, def = {}) {
      const prev = sets.get(id)
      if (!def.points && prev) {
        // patch: color / visibility only, geometry untouched
        if (def.visible !== undefined) prev.def.visible = def.visible
        if (def.color !== undefined) {
          prev.def.color = def.color
          prev.dotMat?.color.set(def.color)
        }
        prev.group.visible = prev.def.visible
        return
      }
      if (prev) disposeSet(prev)
      const entry = {
        def: {
          // shallow-copy points: layout caches world coords on them (_x/_z)
          points: (def.points ?? []).map((p) => ({ ...p })),
          color: def.color ?? INK,
          visible: def.visible ?? true,
        },
        group: new THREE.Group(),
        dots: null,
        dotMat: null,
        sprites: [],
      }
      entry.group.visible = entry.def.visible
      group.add(entry.group)
      sets.set(id, entry)
      build(entry) // no-op until the DEM world exists; update() finishes the job
    },
    removeSet(id) {
      const entry = sets.get(id)
      if (!entry) return false
      disposeSet(entry)
      sets.delete(id)
      return true
    },
    listSets() {
      return [...sets.entries()].map(([id, e]) => ({
        id,
        count: e.def.points.length,
        color: e.def.color,
        visible: e.def.visible,
      }))
    },
    // regenerateTerrain path: real-mode visibility, deferred builds once the
    // world exists, vertical re-layout on demExaggeration changes
    update(params, hf) {
      heightField = hf
      const real = params.source === 'real' && !!hf
      group.visible = real
      if (!real) return
      for (const entry of sets.values()) {
        if (!entry.dots) build(entry)
        else layout(entry)
      }
      builtFog = fogScale
    },
    // per-frame: dot rescale with the view scale, tag sizing, label crowd
    // control, and the 2 s re-sample for elev-less points on streaming tiles
    tick(dt, camera) {
      if (!group.visible) return
      fogScale = Math.max(1, fogScale) // guard
      labelAcc += dt
      refreshAcc += dt
      const doLabels = labelAcc > 0.25
      if (doLabels) labelAcc = 0
      const doRefresh = refreshAcc > 2
      if (doRefresh) refreshAcc = 0
      const rescale = Math.abs(fogScale - builtFog) / builtFog > 0.04
      if (rescale || doRefresh) {
        builtFog = fogScale
        for (const entry of sets.values()) layout(entry)
      }
      if (!doLabels) return
      // constant-pixel tag scale (sizeAttenuation:false → NDC-ish units)
      const k = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * TAG_PX) / window.innerHeight
      for (const entry of sets.values()) {
        if (!entry.dots || !entry.def.visible) continue
        const order = entry.sprites
          .map((s, i) => ({ i, d: _p.copy(s.position).sub(camera.position).lengthSq() }))
          .sort((a, b) => a.d - b.d)
        order.forEach(({ i }, rank) => {
          const s = entry.sprites[i]
          const show = rank < MAX_LABELS
          s.visible = show
          if (show) s.scale.set(k * s.userData.aspect, k, 1)
        })
      }
    },
    setFogScale(v) {
      fogScale = v
    },
  }
}
