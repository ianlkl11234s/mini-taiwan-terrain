import * as THREE from 'three'
import { metersToWorldY, drapeAt } from './geo.js'

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

export function createMarkers(params, { dotRadius = DOT_R, showLabels = true } = {}) {
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
    // baked elev → exact placement; otherwise live-drape (unstreamed tiles read
    // 0 m, so tick() re-samples every 2 s until chunks settle it)
    return pt.elev != null
      ? metersToWorldY(heightField, pt.elev, params.demExaggeration)
      : drapeAt(heightField, pt._x, pt._z, params.demExaggeration)
  }

  // (re)compute world positions + instance matrices for one set
  function layout(entry) {
    if (!heightField || !entry.dots) return
    const r = dotRadius * fogScale
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
      const s = entry.sprites[i]
      if (s) s.position.set(pt._x, y, pt._z) // tag not built yet (lazy) — nothing to move
    })
    entry.dots.instanceMatrix.needsUpdate = true
    entry.dots.computeBoundingSphere()
  }

  // lazily materialize one point's name-tag sprite (canvas texture) — called
  // from tick()'s crowd control the first time a point ranks in the visible
  // top-MAX_LABELS. Large sets (e.g. 500+ stations) never pay for the
  // canvases of points that never surface, only ever building at most
  // MAX_LABELS-worth per set over the session.
  function ensureSprite(entry, i) {
    let s = entry.sprites[i]
    if (s) return s
    const pt = entry.def.points[i]
    const { tex, aspect } = tagTexture(pt.name ?? '')
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 1,
      depthTest: false,
      sizeAttenuation: false, // constant screen size
      fog: false,
    })
    s = new THREE.Sprite(mat)
    s.center.set(-0.12, 0.5) // tag floats to the right of its dot, HUD-style
    s.renderOrder = 5
    s.userData.aspect = aspect
    s.visible = false // caller reveals it with the correct pixel scale
    if (pt._x !== undefined) s.position.set(pt._x, pointY(pt) + 0.02, pt._z)
    entry.group.add(s)
    entry.sprites[i] = s
    return s
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
    entry.sprites = new Array(n).fill(null) // filled lazily by ensureSprite (crowd control)
    layout(entry)
  }

  function disposeSet(entry) {
    group.remove(entry.group)
    if (entry.dots) {
      entry.dots.dispose()
      entry.dotMat.dispose()
      for (const s of entry.sprites) {
        if (!s) continue
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
      if (!showLabels) return // dots-only set (e.g. trail signs) — skip the ranking/sprite work entirely
      if (!doLabels) return
      // constant-pixel tag scale (sizeAttenuation:false → NDC-ish units)
      const k = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * TAG_PX) / window.innerHeight
      for (const entry of sets.values()) {
        if (!entry.dots || !entry.def.visible) continue
        // distance from the point's own world position (not the sprite's —
        // most points never get one built) so ranking never forces a build
        const order = entry.def.points
          .map((pt, i) => ({ i, d: _p.set(pt._x ?? 0, pointY(pt), pt._z ?? 0).sub(camera.position).lengthSq() }))
          .sort((a, b) => a.d - b.d)
        order.forEach(({ i }, rank) => {
          const show = rank < MAX_LABELS
          if (show) {
            const s = ensureSprite(entry, i) // built on first need, kept afterward
            s.visible = true
            s.scale.set(k * s.userData.aspect, k, 1)
          } else if (entry.sprites[i]) {
            entry.sprites[i].visible = false
          }
        })
      }
    },
    setFogScale(v) {
      fogScale = v
    },
  }
}

// Layer adapter over createMarkers — presents the marker-set collection to the
// LayerManager as one 'point' layer while keeping the imperative set API
// (setSet/removeSet/listSets, surfaced by the facade as setMarkerSet/…) intact.
// Per-set visibility is the panel's control surface, so describe() carries the
// full `sets` list instead of a single layer toggle/style.
//
// Second use (stations): `onActivate` turns the layer's FIRST setVisible(true)
// into a one-shot hook (e.g. fetch a manifest-driven dataset and populate
// sets). Until it has fired at least once, describe() omits `sets` entirely
// so the Layers panel renders a single toggle row instead of an empty
// "NO MARKER SETS" list — that toggle is what the user clicks to trigger the
// fetch. If onActivate's promise rejects, activation resets so the row
// reverts to a toggle the user can retry.
//
// Third use (trail signs): `dotRadius`/`showLabels` tune a set collection
// whose points are much denser than stations (waypoints every ~13-90 m along
// a route, sometimes literally the SAME coordinates as the trail LINE's own
// baked vertices — see polyline.js createTrailsLayer). Per-point name tags
// there would repeat one trail's name across every waypoint that ranks in
// the nearest-MAX_LABELS window (a wall of duplicate tags), so
// showLabels:false skips the tag ranking/sprite work entirely — dots only,
// same visual language as stations otherwise. dotRadius lets that dense set
// use a smaller mark than the default DOT_R so it doesn't read as a solid
// tube that swallows the thinner trail line drawn at the same positions.
export function createPointLayer(params, { id = 'markers', label = 'Markers', rowLabel, onActivate, dotRadius, showLabels } = {}) {
  const markers = createMarkers(params, { dotRadius, showLabels })
  let activated = false
  return {
    id,
    kind: 'point',
    label,
    rowLabel,
    object3d: markers.group,
    // imperative set API (facade back-compat)
    setSet: (setId, def) => markers.setSet(setId, def),
    removeSet: (setId) => markers.removeSet(setId),
    listSets: () => markers.listSets(),

    build() {},
    update(ctx) {
      markers.update(ctx.params, ctx.heightField)
    },
    tickView(ctx) {
      markers.setFogScale(ctx.fogScale)
      markers.tick(ctx.dt, ctx.camera)
    },
    setVisible(v) {
      if (!v || activated || !onActivate) return
      activated = true
      Promise.resolve(onActivate()).catch((err) => {
        console.warn(`[layers] ${id} activation failed`, err)
        activated = false
      })
    },
    setStyle() {}, // per-set only
    describe() {
      const sets = markers.listSets()
      return {
        id,
        kind: 'point',
        label,
        rowLabel,
        count: sets.reduce((n, s) => n + s.count, 0),
        visible: sets.some((s) => s.visible),
        styleSchema: null,
        style: null,
        sets: sets.length > 0 || activated ? sets : undefined,
      }
    },
    dispose() {},
  }
}
