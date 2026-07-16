import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { metersToWorldY, zFightLift } from './geo.js'

// Regional context layer: the neighbouring coastlines (Taiwan's outlying islands,
// N Philippines, the Ryukyus, S Japan, S Korea, SE China) as flat sea-level
// strokes, over a single sea-coloured plane. Gives the storm a geographic frame
// beyond the DEM footprint (which only covers the Taiwan bbox).
//
//   - sea plane: one big flat sheet a hair ABOVE sea level, so it hides the white
//     DEM "sea" (elevation-0 tiles) under a real ocean colour AND fills the open
//     ocean past the DEM. Land (terrain above sea level) pokes through and
//     occludes it by depthTest; it sits just BELOW the coast strokes' lift so the
//     lines always draw on top.
//   - coastlines: disjoint LineSegments2 (one draw call), baked from
//     public/layers/region_coast.json ([lon,lat] pairs), placed at sea level.
//
// Deferred like rail/rivers: registers empty, fed via setData() on first
// switch-on. Data is standard Web Mercator (projection.lonLatToWorld), so the
// far neighbours land in the correct position relative to Taiwan (with the usual
// Mercator inflation up north — fine for a context map).

const SEA_SIZE = 12000 // world units — covers the whole region from the origin
// Sea plane height: sits AT sea level (0 m). Previously offset a few metres up
// to clear the 0 m DEM "sea" (NODATA→0) so the near sea read blue instead of
// white; now that real GEBCO bathymetry is baked into the mesh (see
// docs/BATHYMETRY_DESIGN.md), the terrain itself dips below 0 m, so hugging
// the true sea level reads as a proper water surface instead of a floating
// slab. Land is NOT excluded by height — low plains would flood / z-fight —
// it is cut out by a land/sea MASK (region_sea_mask.png, from the exact
// Taiwan coastline ring) the plane samples as an alphaMap: mask sea=255 →
// drawn, land=0 → discarded by a custom shader test (onBeforeCompile below,
// NOT material.alphaTest — that would multiply in the user's opacity slider
// and false-discard the sea too, see the constructor comment).
const SEA_PLANE_M = 0
// Both offsets below are additional anti-z-fight LIFTS on top of SEA_PLANE_M
// (world units, fogScale-scaled per geo.zFightLift — same helper water.js and
// polyline.js use). This is the piece the fixed 3 m elevation offset above was
// missing: at far/grazing views the depth buffer loses precision, so a lift
// that stays constant regardless of camera distance eventually falls below it
// and the sea plane streaks through the DEM's flat 0 m "sea" mesh. Scaling
// linearly with fogScale (like every other overlay layer) keeps it clear of
// that floor while staying sub-pixel up close, so the near view is unchanged.
const SEA_LIFT_BASE = 0.06 // matches water.js's reservoir-sheet magnitude — same DEM "sea" mesh it fights
const LINE_LIFT_BASE = 0.03 // coastlines float a hair above the sea plane's own lift

export function createRegionLayer(params) {
  const group = new THREE.Group()
  group.visible = false

  const seaMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(params.regionSeaColor),
    transparent: true,
    opacity: params.regionSeaOpacity,
    depthTest: true,
    depthWrite: false,
    fog: true,
    // 陸海遮罩 discard 不用 material.alphaTest（見下方 onBeforeCompile 自行 discard）
    // ——alphaTest 比較的是最終 diffuseColor.a（= opacity * mask），使用者把
    // 海透明度滑桿拖到門檻以下時，連合法的海面像素也會被誤判「未達標」整片消失
    // （回報 bug：0.5 以下海面直接消失）。改成比較 opacity*0.5，等價於只看 mask
    // 本身、不受 opacity 影響。
    // at far/grazing views this plane and the terrain's own (now bathymetric,
    // no longer flat) "sea" mesh can still read as near-coplanar right at the
    // coastline and z-fight into horizontal streaks. polygonOffset pulls the
    // plane's depth toward the camera so it wins cleanly (land is still cut
    // out by the mask, so this never paints over terrain). Relaxed from -4 to
    // -1 now that the real seafloor actually dips below 0 m instead of
    // sitting flat at the same depth as this plane — less separation is
    // needed to avoid the fight.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  const seaGeo = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE, 1, 1)
  seaGeo.rotateX(-Math.PI / 2) // lie flat, normal +Y
  const sea = new THREE.Mesh(seaGeo, seaMat)
  sea.renderOrder = 1
  sea.frustumCulled = false
  group.add(sea)

  // --- sea ripple decoration (docs/MARINE_DESIGN.md §2) ------------------
  // opus M1: never swap seaMat for a raw ShaderMaterial — its alphaMap (land
  // mask, discarded via the onBeforeCompile injection below) / fog / opacity
  // (the bathymetryVisible HANDLER's 0.5⇄1.0 toggle) / polygonOffset are
  // load-bearing and must survive untouched.
  // Instead, onBeforeCompile injects fragment-only fresnel/specular GLSL into
  // the material's own generated shader (same technique as terrain.js:79).
  // No vertex displacement: this repo's ~480 m/world-unit scale makes real
  // wave amplitude (~0.5 m) sub-pixel, so only the visual language is worth
  // borrowing (see z_japan_virtual_town/web/island/src/water.js's fresnel/
  // specular, NOT its Gerstner geometry).
  //
  // Uniform VALUE OBJECTS are created once here (not inside onBeforeCompile,
  // which can re-run on recompile — e.g. setMask() flips seaMat.needsUpdate)
  // so every recompile re-attaches the SAME references via Object.assign,
  // and outside code (applyStyle below, tickView's uSeaTime advance) keeps
  // driving objects it already holds. Also parked on seaMat.userData for
  // external inspection/driving (debug handle, future callers).
  // Environment-system hooks (docs/ENVIRONMENT_DESIGN.md): three uniforms that
  // used to be hardcoded constants inside the onBeforeCompile GLSL below
  // (fresnel sky tint + specular sun direction), now driven live by
  // environment.js so the sea reads the same time-of-day light as everything
  // else. Defaults below are EXACTLY the old hardcoded values (verified: the
  // old vec3(0.4145,0.3256,0.8496) sun direction is precisely
  // normalize(cos(el)*cos(az), sin(el), cos(el)*sin(az)) at the DEFAULT_PARAMS
  // sunAzimuth 64°/sunElevation 19° — see typhoon.js's applyLight for the same
  // formula) — envAuto=false must reproduce the pre-existing look byte-for-byte.
  const rippleUniforms = {
    uSeaTime: { value: 0 },
    uRippleStrength: { value: params.seaRippleStrength },
    uRippleSpeed: { value: params.seaRippleSpeed },
    uSkyColor: { value: new THREE.Color(0.8745, 0.9020, 0.8863) },
    uSunDir: { value: new THREE.Vector3(0.4145, 0.3256, 0.8496) },
    uEnvTint: { value: new THREE.Color(1, 1, 1) }, // multiplies final sea color — night/storm dimming
  }
  seaMat.userData.uniforms = rippleUniforms
  // three 的 program cache key 不含 onBeforeCompile（r172）：任何未來新增的
  // alphaMap+alphaTest BasicMaterial 若指紋相同會與本材質共用 program——
  // 靜默偷走或剝掉波紋注入。獨立 key 永久隔離（opus 終審硬化建議）。
  seaMat.customProgramCacheKey = () => 'region-sea-ripple'
  seaMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, rippleUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldPos;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;
uniform float uSeaTime;
uniform float uRippleStrength;
uniform float uRippleSpeed;
uniform vec3 uSkyColor;
uniform vec3 uSunDir;
uniform vec3 uEnvTint;`
      )
      // 陸海遮罩 discard 就地換成手刻版本（不再借用 material.alphaTest，理由見
      // constructor 那段註解）：diffuseColor.a 在這裡已經是 opacity * mask
      // （map_fragment → color_fragment → alphamap_fragment 前面都跑完了），
      // 拿 opacity*0.5 當門檻等價於「mask < 0.5 才丟」，且與 opacity 滑桿無關
      // ——opacity 拖多低，合法的海面像素都不會被這行誤殺。下面的波紋 decoration
      // 接在這行之後，只會碰到存活下來的海面像素，不會救回被丟棄的陸地像素。
      .replace(
        '#include <alphatest_fragment>',
        `if (diffuseColor.a < opacity * 0.5) discard;
{
  // three independently-scrolling analytic sine fields fake a perturbed
  // normal via their own slope (no dFdx/dFdy — portable to SwiftShader),
  // which drives a fresnel sky-tint + a faint specular glint. At
  // uRippleStrength 0 every term collapses back to the flat plane's original
  // diffuseColor (rSlope*0 -> rN=(0,1,0), and every mix/add below is ALSO
  // scaled by uRippleStrength again) — "拖到 0 = 現狀靜態海面" is a hard UI
  // requirement, verified by this double-gating.
  vec2 rp = vWorldPos.xz;
  float rt = uSeaTime * uRippleSpeed;

  vec2 rDir0 = vec2(0.79, 0.61);
  vec2 rDir1 = vec2(-0.54, 0.84);
  vec2 rDir2 = vec2(0.35, -0.94);
  float rK0 = 1.7, rK1 = 2.6, rK2 = 4.1;    // 2*pi/wavelength, world units
  float rW0 = 0.55, rW1 = 0.35, rW2 = 0.80; // angular rate
  float rA0 = 1.0, rA1 = 0.65, rA2 = 0.4;   // relative weight

  float rPh0 = dot(rDir0, rp) * rK0 - rt * rW0;
  float rPh1 = dot(rDir1, rp) * rK1 - rt * rW1;
  float rPh2 = dot(rDir2, rp) * rK2 - rt * rW2;

  // analytic slope of the summed sine field = fake normal, kept tiny by design
  vec2 rSlope = rDir0 * (rK0 * rA0 * cos(rPh0))
              + rDir1 * (rK1 * rA1 * cos(rPh1))
              + rDir2 * (rK2 * rA2 * cos(rPh2));
  rSlope *= 0.05 * uRippleStrength;
  vec3 rN = normalize(vec3(-rSlope.x, 1.0, -rSlope.y));
  vec3 rV = normalize(cameraPosition - vWorldPos);
  float rFres = pow(1.0 - clamp(dot(rN, rV), 0.0, 1.0), 5.0);

  // paper-toned sky tint at grazing angles (#dfe6e2 direction by default) —
  // NOT a saturated blue, matches the theme's paper aesthetic. uSkyColor is
  // environment.js-driven (docs/ENVIRONMENT_DESIGN.md); default value is the
  // original hardcoded constant, so envAuto=false is pixel-identical.
  diffuseColor.rgb = mix(diffuseColor.rgb, uSkyColor, rFres * 0.5 * uRippleStrength);

  // faint specular glint off the sun direction (uSunDir — environment.js
  // syncs this to the real sun az/el; default matches the old fixed decorative
  // direction, which was itself sunAzimuth 64deg/sunElevation 19deg baked in)
  vec3 rH = normalize(uSunDir + rV);
  float rSpec = pow(max(dot(rN, rH), 0.0), 200.0);
  diffuseColor.rgb += vec3(1.0) * rSpec * 0.12 * uRippleStrength;

  // opacity: gentle +0..0.05 lift at grazing angles only — "很淡、接近透明"
  // is a hard requirement, this must never push the sea toward opaque
  diffuseColor.a = clamp(diffuseColor.a + rFres * 0.05 * uRippleStrength, 0.0, 1.0);
}
// uEnvTint: night/storm dimming multiplier from environment.js — this
// MeshBasicMaterial ignores scene lights entirely, so without an explicit
// tint the sea would stay full-bright at midnight and give away the trick.
// Default (1,1,1) is a no-op, applied OUTSIDE the ripple-strength gate above
// so it still dims the sea even with ripple decoration off.
diffuseColor.rgb *= uEnvTint;`
      )
  }

  const lineMat = new LineMaterial({
    color: new THREE.Color(params.regionLineColor),
    linewidth: params.regionLineWidth,
    transparent: true,
    opacity: params.regionLineOpacity,
    fog: true,
  })
  const lines = new LineSegments2(new LineSegmentsGeometry(), lineMat)
  lines.renderOrder = 2
  lines.visible = false
  group.add(lines)

  let coast = [] // [[ [lon,lat], ... ], ...]
  let seg = null // Float32Array segment pairs (xz baked, y stays 0)
  let built = false
  let hf = null
  let resolutionSet = false
  let maskBbox = null // {minLon,maxLon,minLat,maxLat} of the land/sea mask
  let maskReady = false
  let uvSet = false // sea-plane UVs mapped to the mask (needs the projection)
  let seaLift = SEA_LIFT_BASE
  let lineLift = LINE_LIFT_BASE

  function gate() {
    return params.source === 'real' && !!hf && params.regionVisible
  }

  // map the sea plane's vertex UVs so the mask covers its geographic bbox in
  // world space (nw = west/north, se = east/south); ClampToEdge means anything
  // beyond Taiwan samples the mask's sea border → open ocean stays sea
  function applyMaskUVs(projection) {
    if (!maskBbox) return
    const nw = projection.lonLatToWorld(maskBbox.minLon, maskBbox.maxLat)
    const se = projection.lonLatToWorld(maskBbox.maxLon, maskBbox.minLat)
    const dx = se.x - nw.x
    const dz = se.z - nw.z
    const pos = seaGeo.attributes.position
    const uv = seaGeo.attributes.uv
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, (pos.getX(i) - nw.x) / dx, (pos.getZ(i) - nw.z) / dz)
    }
    uv.needsUpdate = true
    uvSet = true
  }

  function bake(projection) {
    let nSeg = 0
    for (const l of coast) nSeg += Math.max(0, l.length - 1)
    seg = new Float32Array(nSeg * 6)
    let s = 0
    for (const line of coast) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = projection.lonLatToWorld(line[i][0], line[i][1])
        const b = projection.lonLatToWorld(line[i + 1][0], line[i + 1][1])
        seg[s * 6] = a.x
        seg[s * 6 + 2] = a.z
        seg[s * 6 + 3] = b.x
        seg[s * 6 + 5] = b.z
        s++
      }
    }
    // fresh geometry: three memoizes _maxInstanceCount at first render, so an
    // already-rendered empty geometry would keep drawing 0 instances (see polyline.js)
    lines.geometry.dispose()
    lines.geometry = new LineSegmentsGeometry()
    lines.geometry.setPositions(seg)
    built = true
  }

  function placeVertical() {
    if (!hf) return
    const y = metersToWorldY(hf, SEA_PLANE_M, params.demExaggeration)
    sea.position.y = y + seaLift
    lines.position.y = y + seaLift + lineLift
  }

  function applyStyle() {
    seaMat.color.set(params.regionSeaColor)
    seaMat.opacity = params.regionSeaOpacity
    rippleUniforms.uRippleStrength.value = params.seaRippleStrength
    rippleUniforms.uRippleSpeed.value = params.seaRippleSpeed
    lineMat.color.set(params.regionLineColor)
    lineMat.linewidth = params.regionLineWidth
    lineMat.opacity = params.regionLineOpacity
  }

  return {
    id: 'region',
    kind: 'area',
    label: 'Region',
    rowLabel: '周邊 Region',
    object3d: group,
    visibleParam: 'regionVisible',
    paramMap: {
      visible: 'regionVisible',
      seaColor: 'regionSeaColor',
      seaOpacity: 'regionSeaOpacity',
      seaAnimated: 'seaAnimated',
      seaRippleStrength: 'seaRippleStrength',
      seaRippleSpeed: 'seaRippleSpeed',
      lineColor: 'regionLineColor',
      lineWidth: 'regionLineWidth',
      lineOpacity: 'regionLineOpacity',
    },

    // environment.js hook: the sea's onBeforeCompile uniforms (uSkyColor/
    // uSunDir/uEnvTint) live on this same object as uSeaTime/uRippleStrength
    // — expose it so environment.js can drive them without region.js needing
    // to know anything about time-of-day/weather itself.
    getSeaEnvUniforms() {
      return rippleUniforms
    },

    build(ctx) {
      if (!resolutionSet && ctx.lineResolution) {
        lineMat.uniforms.resolution.value = ctx.lineResolution
        resolutionSet = true
      }
    },

    // deferred data: the baked coastline polylines ([lon,lat] pairs)
    setData(newLines) {
      coast = newLines || []
      built = false
      seg = null
      lines.geometry.dispose()
      lines.geometry = new LineSegmentsGeometry()
    },

    update(ctx) {
      hf = ctx.heightField
      const show = gate()
      if (hf) {
        if (show && !built && coast.length) bake(hf.projection)
        if (maskReady && !uvSet) applyMaskUVs(hf.projection)
        placeVertical()
        applyStyle()
      }
      // the sea plane needs its land/sea mask before it can show (else it would
      // paint over the low plains) — gate it on maskReady, lines on their data
      sea.visible = show && maskReady
      lines.visible = show && built
      group.visible = show
    },

    // per-frame (from the tick, alongside the other fogScale consumers — see
    // water.js / polyline.js): recompute the anti-z-fight lifts as the camera
    // dollies out so they stay above the depth-buffer precision floor at the
    // far/grazing views this layer is meant for.
    tickView(ctx) {
      const nextSea = zFightLift(SEA_LIFT_BASE, ctx.fogScale)
      const nextLine = zFightLift(LINE_LIFT_BASE, ctx.fogScale)
      if (nextSea !== seaLift || nextLine !== lineLift) {
        seaLift = nextSea
        lineLift = nextLine
        placeVertical()
      }
      // sea ripple decoration: a wall-clock animation (not gated on the
      // timeline), same as typhoon's uTime. gate() (not just group.visible)
      // matches the isAnimating() proxy in index.js — regionVisible is used
      // there without waiting on maskReady/hf, so a brief idle-spin before
      // the mask loads is expected (docs/MARINE_DESIGN.md §2.2 opus m3);
      // this only actually advances once gate() is fully true.
      if (params.seaAnimated && gate()) rippleUniforms.uSeaTime.value += ctx.dt
    },

    // deferred land/sea mask: sea=255 / land=0, sampled as the sea plane's
    // alphaMap so land is cut out independent of elevation. flipY false → row 0
    // (north) reads at uv v=0, matching applyMaskUVs.
    setMask(tex, bbox) {
      maskBbox = bbox
      seaMat.alphaMap = tex
      seaMat.needsUpdate = true
      maskReady = true
      uvSet = false
    },

    describe() {
      return {
        id: 'region',
        kind: 'area',
        label: 'Region',
        rowLabel: '周邊 Region',
        count: coast.length,
        visible: params.regionVisible,
        styleSchema: {
          seaColor: { type: 'color', label: '海色 Sea' },
          seaOpacity: { type: 'slider', label: '海透明度 Sea opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
          seaAnimated: { type: 'toggle', label: '海面動態 Ripple' },
          seaRippleStrength: { type: 'slider', label: '波紋強度 Ripple strength', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
          seaRippleSpeed: { type: 'slider', label: '波紋速度 Ripple speed', min: 0, max: 3, step: 0.1, format: (v) => v.toFixed(1) },
          lineColor: { type: 'color', label: '海岸線色 Coast' },
          lineWidth: { type: 'slider', label: '線寬 Width', min: 0.3, max: 4, step: 0.1, format: (v) => v.toFixed(1) },
          lineOpacity: { type: 'slider', label: '線透明度 Line opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
        },
        style: {
          seaColor: params.regionSeaColor,
          seaOpacity: params.regionSeaOpacity,
          seaAnimated: params.seaAnimated,
          seaRippleStrength: params.seaRippleStrength,
          seaRippleSpeed: params.seaRippleSpeed,
          lineColor: params.regionLineColor,
          lineWidth: params.regionLineWidth,
          lineOpacity: params.regionLineOpacity,
        },
      }
    },

    dispose() {
      seaGeo.dispose()
      seaMat.dispose()
      lines.geometry.dispose()
      lineMat.dispose()
    },
  }
}
