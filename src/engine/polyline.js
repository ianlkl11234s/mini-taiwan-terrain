import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { metersToWorldY, zFightLift } from './geo.js'
import RING from './data/coastline_taiwan.json'
import BORDERS from './data/counties_internal_borders.json'

// Shared fat-line polyline layer — the common base for coastline + county
// borders (and, next stage, rail / rivers / etc. from GeoJSON LineString /
// MultiLineString FeatureCollections). Two vertical modes:
//
//  - 'flat':   one connected ring at a fixed height (coastline, sea level).
//              Renders with Line2. Geometry vertices stay at y = 0; the whole
//              line rides up/down via object.position.y as the vertical datum
//              scales — sea level's world height moves with
//              metersToWorldY(0, exaggeration).
//  - 'draped': many disjoint polylines whose every vertex carries a baked DTM
//              elevation, so the line hugs the ridgelines (county borders).
//              Renders with LineSegments2 (all segment pairs in one instanced
//              geometry = one draw call); vertical y is rewritten in place when
//              the scale changes — the interleaved buffer wraps our Float32Array.
//
// W2: fat lines. THREE.Line renders at 1 px on WebGL; Line2 / LineSegments2 +
// LineMaterial extrude screen-space quads so linewidth is real pixels
// (worldUnits false). The material needs the viewport in its `resolution`
// uniform: we share the stage's live Vector2 (scene.js updates it on resize) by
// swapping it in as the uniform value in build() — the `.resolution` setter
// would copy instead of share. fog: true works: the shader includes the fog
// chunks so the line sinks into the white wall like the terrain does.
//
// Horizontal xz is projected once (the projection is anchored at the first DEM
// load and never rebuilt, so it never changes). Only meaningful in real mode;
// procedural terrain hides it. Anti-z-fight lift is fogScale-scaled (see
// geo.zFightLift).

function createPolylineLayer(config, params) {
  const { id, label, rowLabel, mode, liftBase, paramMap, styleSchema } = config
  // widthScale: a fixed multiplier on the width param so several sub-layers can
  // share ONE width slider at different thicknesses (rivers major/mid/minor).
  const widthScale = config.widthScale ?? 1
  const flat = mode === 'flat'
  // draped layers may start empty and be fed data later (see setData) — the
  // deferred manifest-driven layers (rail) register before their JSON has
  // been fetched. lineColors, when given, is one hex color per polyline
  // (per-vertex, via LineMaterial vertexColors) instead of the single
  // paramMap.color swatch — official rail-line colors, not user-tintable.
  let polylines = config.polylines ?? []
  let lineColors = config.lineColors ?? null

  const material = new LineMaterial({
    color: new THREE.Color(paramMap.color ? params[paramMap.color] : 0xffffff),
    linewidth: params[paramMap.width] * widthScale, // px
    transparent: true,
    opacity: params[paramMap.opacity],
    fog: true, // sinks into the white fog wall like the terrain does
    vertexColors: !!lineColors,
  })
  const object3d = flat ? new Line2(new LineGeometry(), material) : new LineSegments2(new LineSegmentsGeometry(), material)
  object3d.visible = false

  const computePointCount = () => (flat ? polylines.length : polylines.reduce((n, l) => n + l.length, 0))
  let pointCount = computePointCount()

  let resolutionSet = false
  let hf = null
  let seaY = 0 // flat: sea level in world units (before the anti-z-fight lift)
  let lift = liftBase

  // flat state
  let built = false
  // draped state — segment-pair buffers baked once: [x1 y1 z1 x2 y2 z2] per
  // segment + the endpoints' raw elevations (meters) for vertical rewrites.
  // col mirrors seg 1:1 (rgb, rgb) when lineColors is set — colors are static
  // (unlike positions) so they're uploaded once, not touched by applyVertical.
  let seg = null
  let elev = null
  let col = null
  let nSeg = 0
  let geomInit = false
  let lastVScale = NaN

  function bakeDraped(projection) {
    nSeg = polylines.reduce((n, l) => n + l.length - 1, 0)
    seg = new Float32Array(nSeg * 6)
    elev = new Float32Array(nSeg * 2)
    col = lineColors ? new Float32Array(nSeg * 6) : null
    const c = new THREE.Color()
    let s = 0
    for (let li = 0; li < polylines.length; li++) {
      const line = polylines[li]
      if (lineColors) c.set(lineColors[li])
      for (let i = 0; i < line.length - 1; i++) {
        const a = projection.lonLatToWorld(line[i][0], line[i][1])
        const b = projection.lonLatToWorld(line[i + 1][0], line[i + 1][1])
        seg[s * 6] = a.x
        seg[s * 6 + 2] = a.z
        seg[s * 6 + 3] = b.x
        seg[s * 6 + 5] = b.z
        elev[s * 2] = line[i][2]
        elev[s * 2 + 1] = line[i + 1][2]
        if (col) {
          col[s * 6] = c.r
          col[s * 6 + 1] = c.g
          col[s * 6 + 2] = c.b
          col[s * 6 + 3] = c.r
          col[s * 6 + 4] = c.g
          col[s * 6 + 5] = c.b
        }
        s++
      }
    }
  }

  // world y from baked elevation — datum/K math via the shared helper
  function applyVertical(field) {
    const scale = field.projection.K * params.demExaggeration
    if (scale === lastVScale) return
    lastVScale = scale
    for (let s = 0; s < nSeg; s++) {
      seg[s * 6 + 1] = metersToWorldY(field, elev[s * 2], params.demExaggeration)
      seg[s * 6 + 4] = metersToWorldY(field, elev[s * 2 + 1], params.demExaggeration)
    }
    if (!geomInit) {
      object3d.geometry.setPositions(seg) // instanced buffer wraps `seg` directly
      if (col) object3d.geometry.setColors(col) // static — uploaded once, never rewritten
      geomInit = true
    } else {
      object3d.geometry.attributes.instanceStart.data.needsUpdate = true
      object3d.geometry.computeBoundingBox()
      object3d.geometry.computeBoundingSphere()
    }
  }

  function bakeFlat(projection) {
    const pos = new Float32Array(polylines.length * 3)
    for (let i = 0; i < polylines.length; i++) {
      const { x, z } = projection.lonLatToWorld(polylines[i][0], polylines[i][1])
      pos[i * 3] = x
      pos[i * 3 + 1] = 0
      pos[i * 3 + 2] = z
    }
    object3d.geometry.setPositions(pos)
  }

  // lazy geometry build + vertical placement once the world exists
  function ensureBuilt(field) {
    if (flat) {
      if (!built) {
        bakeFlat(field.projection)
        built = true
      }
      seaY = metersToWorldY(field, 0, params.demExaggeration)
      placeLift()
    } else {
      if (!seg) bakeDraped(field.projection)
      applyVertical(field)
    }
  }

  function placeLift() {
    object3d.position.y = flat ? seaY + lift : lift
  }

  function applyStyle() {
    if (paramMap.color) material.color.set(params[paramMap.color]) // else: fixed white, vertexColors carries the real color
    material.linewidth = params[paramMap.width] * widthScale
    material.opacity = params[paramMap.opacity]
  }

  function gate() {
    return params.source === 'real' && !!hf && params[paramMap.visible]
  }

  return {
    id,
    kind: 'line',
    label,
    rowLabel,
    object3d,
    paramMap,
    visibleParam: paramMap.visible,

    build(ctx) {
      // share the stage's live resolution Vector2 (scene.js updates it on resize)
      if (!resolutionSet && ctx.lineResolution) {
        material.uniforms.resolution.value = ctx.lineResolution
        resolutionSet = true
      }
    },

    // regenerateTerrain path — covers initial load, source switches (noise ↔
    // real) and vertical-scale (demExaggeration) changes; the GUI toggle and
    // width/opacity/color sliders route here too via HANDLERS.
    update(ctx) {
      hf = ctx.heightField
      const show = gate()
      if (show && hf) ensureBuilt(hf)
      else if (hf && flat) {
        // vertical still tracks the datum even while hidden (matches legacy)
        seaY = metersToWorldY(hf, 0, params.demExaggeration)
        placeLift()
      } else if (hf && !flat && seg) applyVertical(hf)
      applyStyle()
      object3d.visible = show
    },

    // per-frame (from the tick, alongside the other fogScale consumers)
    tickView(ctx) {
      lift = zFightLift(liftBase, ctx.fogScale)
      placeLift()
    },

    setVisible(v) {
      params[paramMap.visible] = v
      if (v && hf) ensureBuilt(hf)
      object3d.visible = gate()
    },

    setStyle(patch) {
      for (const k in patch) if (paramMap[k]) params[paramMap[k]] = patch[k]
      applyStyle()
    },

    // draped only: (re)supply the polylines once deferred data has fetched —
    // resets the baked buffers so the next update()/ensureBuilt rebakes from
    // scratch. Vertex colors (one hex per polyline) rebake alongside.
    setData(newPolylines, newLineColors = null) {
      polylines = newPolylines ?? []
      lineColors = newLineColors
      pointCount = computePointCount()
      seg = null
      elev = null
      col = null
      nSeg = 0
      geomInit = false
      lastVScale = NaN
      // the old geometry may already have been rendered while empty (deferred
      // layers are visible during their fetch) — three memoizes
      // _maxInstanceCount at first render, so reusing it would keep drawing
      // 0 instances forever. Swap in a fresh geometry and dispose the old.
      object3d.geometry.dispose()
      object3d.geometry = new LineSegmentsGeometry()
    },

    describe() {
      return {
        id,
        kind: 'line',
        label,
        rowLabel,
        count: pointCount,
        visible: params[paramMap.visible],
        styleSchema,
        style: {
          width: params[paramMap.width],
          opacity: params[paramMap.opacity],
          ...(paramMap.color ? { color: params[paramMap.color] } : {}),
        },
      }
    },

    dispose() {
      object3d.geometry.dispose()
      material.dispose()
    },
  }
}

const POLYLINE_STYLE = (widthMax) => ({
  width: { type: 'slider', label: '線寬 Width', min: 0.5, max: widthMax, step: 0.1, format: (v) => v.toFixed(1) },
  opacity: { type: 'slider', label: '不透明度 Opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
  color: { type: 'color', label: '顏色 Color' },
})

// Taiwan main-island coastline: one closed sea-level ring (county boundaries
// unioned, largest polygon's exterior, simplified to 100 m — 1,289 points).
export function createCoastlineLayer(params) {
  return createPolylineLayer(
    {
      id: 'coastline',
      label: 'Coastline',
      rowLabel: '海岸線 Coastline',
      mode: 'flat',
      polylines: RING,
      liftBase: 0.03,
      paramMap: { visible: 'coastline', color: 'coastlineColor', width: 'coastlineWidth', opacity: 'coastlineOpacity' },
      styleSchema: POLYLINE_STYLE(8),
    },
    params
  )
}

// County borders: the main island's INTERNAL county boundaries (33 polylines,
// ~11k vertices) — the coastline ring already draws the outer edge. Every
// vertex carries a baked DTM elevation, so the lines ride the ridgelines. A
// slightly higher lift base than the coastline: these vertices sit ON the
// terrain skin (baked 20 m DTM vs the streamed tile mesh disagree by a few
// meters), not safely above it like the sea-level ring.
export function createCountiesLayer(params) {
  return createPolylineLayer(
    {
      id: 'counties',
      label: 'Counties',
      rowLabel: '縣市界 Counties',
      mode: 'draped',
      polylines: BORDERS.lines,
      liftBase: 0.05,
      paramMap: { visible: 'counties', color: 'countiesColor', width: 'countiesWidth', opacity: 'countiesOpacity' },
      styleSchema: POLYLINE_STYLE(6),
    },
    params
  )
}

// Rail network: manifest-driven deferred layer (see index.js) — registers
// empty at startup and is fed real polylines via setData() once
// public/layers/rail_lines.json has been fetched (first time the layer is
// switched on). Each line carries its own OFFICIAL color (LineMaterial
// vertexColors, baked once into the shared geometry alongside the draped
// elevations) — no single color swatch, so styleSchema only exposes
// width/opacity.
export function createRailLayer(params) {
  return createPolylineLayer(
    {
      id: 'rail',
      label: 'Rail',
      rowLabel: '鐵路 Rail',
      mode: 'draped',
      polylines: [],
      lineColors: [],
      liftBase: 0.05,
      paramMap: { visible: 'railVisible', width: 'railWidth', opacity: 'railOpacity' },
      styleSchema: {
        width: { type: 'slider', label: '線寬 Width', min: 0.5, max: 6, step: 0.1, format: (v) => v.toFixed(1) },
        opacity: { type: 'slider', label: '不透明度 Opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
      },
    },
    params
  )
}

// River water surfaces: a translucent sheet filling the wider downstream/
// midstream channels (public/layers/river_surfaces.json — the narrow upstream
// creeks stay as the river LINE). Every baked polygon is triangulated on the
// CPU (THREE.ShapeUtils.triangulateShape — boundary vertices + sandbar holes)
// and merged into ONE BufferGeometry, so the whole river-surface network draws
// in a single call. Same water visual language as the reservoirs (water.js):
// translucent MeshBasicMaterial, depthWrite off so terrain banks occlude it via
// depthTest. Per-vertex world Y comes from the baked water elevation (rewritten
// in place on a demExaggeration change, like the draped polylines); the mesh
// only rides the small anti-z-fight lift, kept a hair BELOW the river line's so
// the line sits on top of the sheet.
const RIVER_SURFACE_LIFT_BASE = 0.04

function createRiverSurface(params) {
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(params.riversColor),
    transparent: true,
    opacity: params.riversSurfaceOpacity,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  })
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
  mesh.visible = false
  mesh.renderOrder = 2 // translucent, below the reservoir sheets (3)

  let polys = [] // baked polygon specs { o:[[lon,lat,elev]...], h?:[[[..]]] }
  let positions = null // Float32Array xyz (xz baked once, y rewritten on scale)
  let elevs = null // Float32Array per-vertex baked meters
  let built = false
  let hf = null
  let lift = RIVER_SURFACE_LIFT_BASE
  let lastVScale = NaN

  function gate() {
    return params.source === 'real' && !!hf && params.riversVisible && params.riversSurfaceOpacity > 0
  }

  // triangulate every polygon (outer contour + holes) and concatenate into one
  // indexed geometry. ShapeUtils flattens [contour, ...holes] and returns
  // triangle indices into THAT list, matching the order we push vertices, so a
  // per-polygon base offset maps them into the shared buffer.
  function buildGeometry(projection) {
    const pos = []
    const elv = []
    const idx = []
    for (const poly of polys) {
      const base = pos.length / 3
      const contour = []
      for (const [lon, lat, e] of poly.o) {
        const w = projection.lonLatToWorld(lon, lat)
        contour.push(new THREE.Vector2(w.x, w.z))
        pos.push(w.x, 0, w.z)
        elv.push(e)
      }
      const holes = []
      for (const hole of poly.h || []) {
        const h2 = []
        for (const [lon, lat, e] of hole) {
          const w = projection.lonLatToWorld(lon, lat)
          h2.push(new THREE.Vector2(w.x, w.z))
          pos.push(w.x, 0, w.z)
          elv.push(e)
        }
        holes.push(h2)
      }
      const faces = THREE.ShapeUtils.triangulateShape(contour, holes)
      for (const f of faces) idx.push(base + f[0], base + f[1], base + f[2])
    }
    positions = new Float32Array(pos)
    elevs = new Float32Array(elv)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(idx) // setIndex auto-picks Uint32 when vertices exceed 65535
    mesh.geometry.dispose()
    mesh.geometry = geo
    built = true
    lastVScale = NaN
    applyVertical()
  }

  function applyVertical() {
    if (!hf || !positions) return
    const scale = hf.projection.K * params.demExaggeration
    if (scale === lastVScale) return
    lastVScale = scale
    for (let i = 0; i < elevs.length; i++) {
      positions[i * 3 + 1] = metersToWorldY(hf, elevs[i], params.demExaggeration)
    }
    mesh.geometry.attributes.position.needsUpdate = true
    mesh.geometry.computeBoundingSphere()
  }

  function applyStyle() {
    material.color.set(params.riversColor)
    material.opacity = params.riversSurfaceOpacity
  }

  return {
    object3d: mesh,

    // race trap: never render an empty mesh then fill it — build the geometry
    // only once real data has arrived AND the world exists (see update). Swap in
    // a fresh BufferGeometry so nothing stale is drawn in the meantime.
    setData(newPolys) {
      polys = newPolys || []
      built = false
      positions = null
      elevs = null
      lastVScale = NaN
      mesh.geometry.dispose()
      mesh.geometry = new THREE.BufferGeometry()
    },

    update() {
      const show = gate()
      if (show && hf) {
        if (!built && polys.length) buildGeometry(hf.projection)
        if (built) {
          applyVertical()
          applyStyle()
        }
      } else if (hf && built) {
        applyVertical() // keep tracking the datum/scale even while hidden
      }
      mesh.position.y = lift
      mesh.visible = show
    },

    setHeightField(field) {
      hf = field
    },

    tickView(fogScale) {
      const next = zFightLift(RIVER_SURFACE_LIFT_BASE, fogScale)
      if (next !== lift) {
        lift = next
        mesh.position.y = lift
      }
    },

    dispose() {
      mesh.geometry.dispose()
      material.dispose()
    },
  }
}

// River-name labels: canvas-text sprites (deep-blue ink on a paper chip) draped
// on the river network. Same crowd-control language as the station markers —
// only the MAX_RIVER_LABELS nearest-to-camera names show, each with a
// view-distance fade — so the name field never crowds at island scale. Gated by
// BOTH the rivers toggle and the dedicated "河名 Names" toggle (riverNames).
// Sprites are built lazily (only the names that actually surface pay for a
// canvas), like markers.js, and are sizeAttenuation:false → constant screen size.
const MAX_RIVER_LABELS = 10
const RIVER_LABEL_PX = 22 // tag height in screen pixels
const RIVER_LABEL_INK = '#0f4c81'
const RIVER_LABEL_PAPER = 'rgba(247, 251, 254, 0.94)'
const RIVER_LABEL_BORDER = 'rgba(20, 66, 112, 0.35)'
const RIVER_LABEL_LIFT = 0.16 // world units above the baked river elevation
// view-distance fade in ABSOLUTE world units (not fogScale-scaled): names are
// full-opacity up close and gone by the time the camera dollies out to island
// scale, so the field self-clears on zoom-out. Ranking is by proximity to the
// pan target (the look-at point), NOT the camera — at a tilted view the camera
// is nearest the foreground, so camera-ranking would surface labels behind the
// look direction instead of the ones the user is looking at.
const RIVER_LABEL_FADE_START = 46 // <= this camera distance → fully opaque
const RIVER_LABEL_FADE_END = 88 // >= this → hidden

function riverTagTexture(name) {
  const S = 3 // supersample for crisp CJK text
  const h = RIVER_LABEL_PX * S
  const padX = 7 * S
  const font = `600 ${12.5 * S}px "PingFang TC", "Heiti TC", ui-sans-serif, sans-serif`
  const probe = document.createElement('canvas').getContext('2d')
  probe.font = font
  const w = Math.ceil(probe.measureText(name).width + padX * 2)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  ctx.fillStyle = RIVER_LABEL_PAPER
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = RIVER_LABEL_BORDER
  ctx.lineWidth = S
  ctx.strokeRect(S / 2, S / 2, w - S, h - S)
  ctx.font = font
  ctx.fillStyle = RIVER_LABEL_INK
  ctx.textBaseline = 'middle'
  ctx.fillText(name, padX, h / 2 + S * 0.5)
  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 4
  tex.colorSpace = THREE.SRGBColorSpace
  return { tex, aspect: w / h }
}

function createRiverLabels(params) {
  const group = new THREE.Group()
  group.visible = false
  let defs = [] // {name, type, lon, lat, elev, _x?, _z?}
  let sprites = [] // parallel to defs, lazily materialized
  let hf = null
  let labelAcc = 0
  const _p = new THREE.Vector3()

  const gate = () => params.source === 'real' && !!hf && params.riversVisible && !!params.riverNames
  const labelY = (d) => metersToWorldY(hf, d.elev, params.demExaggeration) + RIVER_LABEL_LIFT

  function project() {
    if (!hf) return
    for (const d of defs) {
      if (d._x === undefined) {
        const w = hf.projection.lonLatToWorld(d.lon, d.lat)
        d._x = w.x
        d._z = w.z
      }
    }
  }

  function ensureSprite(i) {
    let s = sprites[i]
    if (s) return s
    const d = defs[i]
    const { tex, aspect } = riverTagTexture(d.name)
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 1, depthTest: false, sizeAttenuation: false, fog: false })
    s = new THREE.Sprite(mat)
    s.renderOrder = 6 // above the marker tags (5)
    s.userData.aspect = aspect
    s.visible = false
    if (d._x !== undefined) s.position.set(d._x, labelY(d), d._z)
    group.add(s)
    sprites[i] = s
    return s
  }

  return {
    object3d: group,

    // race trap: reset sprites when fresh labels land; positions/canvases are
    // (re)materialized lazily once the world exists (see project/ensureSprite).
    setData(newDefs) {
      for (const s of sprites) {
        if (!s) continue
        s.material.map.dispose()
        s.material.dispose()
        group.remove(s)
      }
      defs = (newDefs || []).map((d) => ({ ...d }))
      sprites = new Array(defs.length).fill(null)
    },
    setHeightField(field) {
      hf = field
    },
    update() {
      if (hf) project()
      group.visible = gate()
    },
    // per-frame crowd control: rank by camera distance, reveal the nearest
    // MAX_RIVER_LABELS, fade each by distance to the (scaled) fog wall. Throttled
    // like markers.js so ranking/canvas work isn't every frame.
    tickView(ctx) {
      if (!gate()) {
        group.visible = false
        return
      }
      group.visible = true
      labelAcc += ctx.dt
      if (labelAcc < 0.2) return
      labelAcc = 0
      project()
      const camera = ctx.camera
      const k = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * RIVER_LABEL_PX) / window.innerHeight
      const cx = ctx.labelCenter ? ctx.labelCenter.x : camera.position.x
      const cz = ctx.labelCenter ? ctx.labelCenter.z : camera.position.z
      const span = RIVER_LABEL_FADE_END - RIVER_LABEL_FADE_START
      // rank by horizontal proximity to the look-at point → the names nearest
      // the centre of the view win the MAX_RIVER_LABELS slots
      const order = defs
        .map((d, i) => ({ i, d2: (d._x - cx) * (d._x - cx) + (d._z - cz) * (d._z - cz) }))
        .sort((a, b) => a.d2 - b.d2)
      order.forEach(({ i }, rank) => {
        const d = defs[i]
        const camDist = _p.set(d._x, labelY(d), d._z).distanceTo(camera.position)
        const fade = Math.max(0, Math.min(1, (RIVER_LABEL_FADE_END - camDist) / span))
        if (rank < MAX_RIVER_LABELS && fade > 0.02) {
          const s = ensureSprite(i)
          s.position.set(d._x, labelY(d), d._z) // tracks the vertical datum/scale
          s.material.opacity = fade
          s.scale.set(k * s.userData.aspect, k, 1)
          s.visible = true
        } else if (sprites[i]) {
          sprites[i].visible = false
        }
      })
    },
    dispose() {
      for (const s of sprites) {
        if (!s) continue
        s.material.map.dispose()
        s.material.dispose()
      }
    },
  }
}

// Rivers: the river layer's BODY is the physics-derived flow-accumulation tint
// painted straight into the terrain shader (terrain.js uRiverTex, wired in
// index.js) — the old vector centerlines are retired. ONE toggle (riversVisible)
// brings the whole group up together: the sim tint (河川濃度 → uRiverSimOpacity),
// the translucent river SURFACE sheet (public/layers/river_surfaces.json) and
// the river-NAME sprites (public/layers/rivers.json → labels). All share the
// water-blue swatch + one visibility gate. The sim itself lives shader-side (see
// index.js applyRiverSim), so this layer object owns only the surface + labels.
export function createRiversLayer(params) {
  const surface = createRiverSurface(params)
  const labels = createRiverLabels(params)
  const group = new THREE.Group()
  group.add(surface.object3d)
  group.add(labels.object3d)

  return {
    id: 'rivers',
    kind: 'line',
    label: 'Rivers',
    rowLabel: '河川 Rivers',
    object3d: group,
    visibleParam: 'riversVisible',
    paramMap: {
      visible: 'riversVisible',
      color: 'riversColor', // feeds BOTH the sim tint (uRiverSimColor) and the surfaces
      surfaceOpacity: 'riversSurfaceOpacity',
      names: 'riverNames',
      // physics-derived river tint (terrain.js uRiverTex, wired in index.js) —
      // the layer's main visual; 河川濃度 drives uRiverSimOpacity.
      simOpacity: 'riverSimOpacity',
    },

    build() {},

    update(ctx) {
      surface.setHeightField(ctx.heightField)
      surface.update()
      labels.setHeightField(ctx.heightField)
      labels.update()
    },

    tickView(ctx) {
      surface.tickView(ctx.fogScale)
      labels.tickView(ctx)
    },

    // deferred data: the surface sheet + name labels each land from their own
    // fetch (see index.js loadRiversData). The river BODY is the sim texture,
    // fetched + wired separately (loadRiverSim).
    setSurfaceData(surfacePolys) {
      surface.setData(surfacePolys)
    },
    setLabels(labelDefs) {
      labels.setData(labelDefs)
    },

    describe() {
      return {
        id: 'rivers',
        kind: 'line',
        label: 'Rivers',
        rowLabel: '河川 Rivers',
        count: 0,
        visible: params.riversVisible,
        styleSchema: {
          // 河川濃度 — the physics river tint density (uRiverSimOpacity)
          simOpacity: {
            type: 'slider',
            label: '河川濃度 Intensity',
            min: 0,
            max: 1,
            step: 0.02,
            format: (v) => v.toFixed(2),
          },
          surfaceOpacity: {
            type: 'slider',
            label: '水面透明度 Surface opacity',
            min: 0,
            max: 1,
            step: 0.02,
            format: (v) => v.toFixed(2),
          },
          color: { type: 'color', label: '顏色 Color' },
          // rendered as a 0/1 slider — the Layers panel has no toggle control for
          // styleSchema entries (只有 color 與 slider)，用 0/1 當開關並顯示 開/關
          names: {
            type: 'slider',
            label: '河名 Names',
            min: 0,
            max: 1,
            step: 1,
            format: (v) => (v > 0.5 ? '開 ON' : '關 OFF'),
          },
        },
        style: {
          simOpacity: params.riverSimOpacity,
          surfaceOpacity: params.riversSurfaceOpacity,
          color: params.riversColor,
          names: params.riverNames ? 1 : 0,
        },
      }
    },

    dispose() {
      surface.dispose()
      labels.dispose()
    },
  }
}
