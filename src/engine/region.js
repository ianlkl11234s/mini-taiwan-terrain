import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { metersToWorldY, zFightLift, worldYScale } from './geo.js'
import { TILE_PX } from './dem.js'

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

// ---------------------------------------------------------------- 工作包 A: 近景 Gerstner 海面 patch
// docs/PHASE3_VISUAL_DESIGN.md 工作包 A. A high-subdivision plane that follows
// the camera (snapped to a coarse grid to avoid a "swimming" recentre), only
// faded in at low camGroundM — the far sea plane above stays untouched and
// pixel-identical at orbit/overview distances (real wave amplitude at
// 480 m/world-unit is sub-pixel there, same reasoning the ripple decoration's
// header already gives). MeshBasicMaterial + onBeforeCompile (same trick as
// the ripple decoration above) so fog/tonemapping/colorspace come free from
// the shared template instead of being hand-reimplemented.
const PATCH_SIZE = 4 // world units — plane spans -2..2 in local x/z (~1.9 km, see header math)
const PATCH_SEG = 224 // subdivisions per side → vertex spacing ≈ PATCH_SIZE/PATCH_SEG*480.78 ≈ 8.6 m
const PATCH_SNAP = 0.5 // world units (~240 m) — anchor re-centre grid, avoids per-frame swimming
const DEEP_DEFAULT_M = 999 // depth (m) assigned to vertices whose DEM tile isn't resident yet — "unloaded ⇒ deep water", NEVER 0 m (0 m would misread as shoreline and falsely trigger the shoaling/foam falloff below)
// Anti-z-fight lift for the patch's REST plane against the coplanar far sea
// plane it sits just above. Deliberately far smaller than SEA_LIFT_BASE/
// LINE_LIFT_BASE above: those were tuned for orbit/overview viewing where a
// few dozen metres of vertical slop is sub-pixel on screen — but the patch
// only ever renders at near-camera/walk-eye distances (camGroundM gate below)
// where that same slop would read as a visibly floating sheet. A few
// centimetres is still comfortably above float32 depth-buffer noise at close
// range while staying invisible at eye level.
const PATCH_LIFT_BASE = 0.0005
const CAM_FADE_NEAR_M = 800 // camGroundM ≤ this ⇒ patch fully opaque
const CAM_FADE_FAR_M = 2000 // camGroundM ≥ this ⇒ patch fully faded (matches the far sea plane taking over)

// 4-wave Gerstner table (docs/PHASE3_VISUAL_DESIGN.md 工作包 A spec: wavelength
// 35-160 m, spread directions, steepness sum < 1). Fixed design constants —
// not parametrized — baked into the shader as GLSL consts (see
// PATCH_CONSTS_GLSL below); only amplitude/steepness SCALE with the live
// seaWaveHeight/seaWaveChop params (uniforms, see applyPatchWaves()). No GLSL
// arrays/loops: matches this file's existing ripple decoration's hand-
// unrolled style (rDir0/rDir1/rDir2 above), which is also the more
// SwiftShader-portable form.
//
// DEVIATION from the spec'd 35 m floor, found during visual verification: the
// per-vertex analytic normal (nx/nz below) is Nyquist-limited by the patch's
// own ~8.6 m vertex spacing (PATCH_SIZE/PATCH_SEG). A 35 m wave is only ~4
// vertices/cycle — right at the sampling floor — so the interpolated normal
// facets sharply between vertices; screenshotted at close range it reads as
// per-pixel salt-and-pepper sparkle rather than a whitecap texture (confirmed
// by A/B: swapping regionVisible off/seaWaveHeight 0 removed it, so it's this
// wave table, not a SwiftShader-only artifact — reproduced identically under
// real Chrome/GPU). Raised the floor to 55 m (~6.4 verts/cycle) — still the
// shortest "chop" wave of the four, just inside a comfortably-sampled range —
// and lightened its weight/steepness share a touch further below.
const WAVE_LEN_M = [155, 105, 78, 55] // wavelength, meters
const WAVE_WEIGHT = [0.44, 0.28, 0.18, 0.1] // amplitude share of seaWaveHeight — sums to 1
const WAVE_Q = [0.35, 0.27, 0.19, 0.1] // base steepness per wave — sums to 0.91 < 1 (chop param is an extra ≤1 multiplier, so the sum can never reach 1 and self-intersect)
const WAVE_ANGLE_DEG = [12, 58, -30, 100] // spread directions — open-ocean cross-chop look
const WAVE_DIR = WAVE_ANGLE_DEG.map((deg) => {
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
})
const G_MPS2 = 9.81
// deep-water dispersion relation (ω = sqrt(g·k), k in rad/METER — this is
// real-world physics, independent of the scene's world-unit scale, hence
// computed from WAVE_LEN_M directly rather than through hf.projection.K):
// shorter wavelengths correctly animate slower than long swell.
const WAVE_OMEGA = WAVE_LEN_M.map((L) => Math.sqrt((G_MPS2 * 2 * Math.PI) / L))
const SHALLOW_TINT = new THREE.Color(0xdff5ec) // fixed light turquoise the shallow-water color lerps toward (see applyStyle) — not a param, keeps this package at 3 new sliders

// GLSL consts shared by the patch's vertex + fragment injections (duplicated
// into both stages below — separate WebGL programs, no shared scope, same as
// how three.js's own chunk system repeats small consts per stage)
const PATCH_CONSTS_GLSL = /* glsl */ `
const vec2 pDir0 = vec2(${WAVE_DIR[0][0].toFixed(6)}, ${WAVE_DIR[0][1].toFixed(6)});
const vec2 pDir1 = vec2(${WAVE_DIR[1][0].toFixed(6)}, ${WAVE_DIR[1][1].toFixed(6)});
const vec2 pDir2 = vec2(${WAVE_DIR[2][0].toFixed(6)}, ${WAVE_DIR[2][1].toFixed(6)});
const vec2 pDir3 = vec2(${WAVE_DIR[3][0].toFixed(6)}, ${WAVE_DIR[3][1].toFixed(6)});
const float pOmega0 = ${WAVE_OMEGA[0].toFixed(6)};
const float pOmega1 = ${WAVE_OMEGA[1].toFixed(6)};
const float pOmega2 = ${WAVE_OMEGA[2].toFixed(6)};
const float pOmega3 = ${WAVE_OMEGA[3].toFixed(6)};
const float pPatchHalf = ${(PATCH_SIZE / 2).toFixed(4)};
`

// vertex injection: Gerstner displacement (4 waves, analytic partial-
// derivative normal — no dFdx/dFdy, SwiftShader-portable per the global
// rule) + shoreline amplitude falloff via the per-vertex aDepthM attribute.
const PATCH_VERT_COMMON = /* glsl */ `
attribute float aDepthM;
varying vec3 vPWorldPos;
varying float vPDepthM;
varying vec3 vPNormal;
uniform vec2 uPatchOrigin;
uniform float uWaveK0, uWaveK1, uWaveK2, uWaveK3;
uniform float uWaveAmp0, uWaveAmp1, uWaveAmp2, uWaveAmp3;
uniform float uWaveQ0, uWaveQ1, uWaveQ2, uWaveQ3;
uniform float uSeaTime;
${PATCH_CONSTS_GLSL}`

const PATCH_VERT_DISPLACE = /* glsl */ `
{
  // phase evaluated at the REST position (classic Gerstner loop) — restXZ is
  // the plane's local xz (transformed, pre-displacement) plus the patch's
  // snapped world-space origin (mesh has no rotation/scale, only translation,
  // so this equals the true world xz without needing a modelMatrix multiply)
  vec2 restXZ = transformed.xz + uPatchOrigin;
  float shoal = smoothstep(0.0, 8.0, aDepthM); // amp -> 0 at the coast, full by 8 m depth — never cuts into the beach

  float ph0 = dot(pDir0, restXZ) * uWaveK0 - pOmega0 * uSeaTime;
  float ph1 = dot(pDir1, restXZ) * uWaveK1 - pOmega1 * uSeaTime;
  float ph2 = dot(pDir2, restXZ) * uWaveK2 - pOmega2 * uSeaTime;
  float ph3 = dot(pDir3, restXZ) * uWaveK3 - pOmega3 * uSeaTime;
  float c0 = cos(ph0); float s0 = sin(ph0);
  float c1 = cos(ph1); float s1 = sin(ph1);
  float c2 = cos(ph2); float s2 = sin(ph2);
  float c3 = cos(ph3); float s3 = sin(ph3);

  vec2 dispXZ = pDir0 * (uWaveQ0 * uWaveAmp0 * c0)
              + pDir1 * (uWaveQ1 * uWaveAmp1 * c1)
              + pDir2 * (uWaveQ2 * uWaveAmp2 * c2)
              + pDir3 * (uWaveQ3 * uWaveAmp3 * c3);
  float dispY = uWaveAmp0 * s0 + uWaveAmp1 * s1 + uWaveAmp2 * s2 + uWaveAmp3 * s3;

  // analytic Gerstner normal (GPU Gems 1 ch.1 "Effective Water Simulation"):
  // N = normalize(-dHeight/dx, 1, -dHeight/dz) — the X/Z partials only (the
  // small ΣQ·sin Y-correction term is dropped: at this scale's slopes it's a
  // second-order-small refinement and normalize() re-unitizes regardless).
  //
  // Only waves 0+1 (the two LONGEST) feed the normal, unlike dispXZ/dispY
  // above which sum all 4. Found during visual verification: waves 2+3's
  // short wavelength is Nyquist-marginal against the patch's fixed ~8.6 m
  // vertex spacing (phase can swing >45° between adjacent vertices), so their
  // PER-VERTEX normal contribution flips sign faster than the mesh can
  // resolve — barycentric-interpolated across a triangle this reads as
  // per-pixel salt-and-pepper sparkle under the specular/fresnel terms below,
  // not a whitecap texture (confirmed by A/B screenshot comparison; the
  // slope magnitude itself is tiny — sub-1% off vertical even at the extreme
  // — so it's a sampling-rate problem, not an amplitude one). The short waves
  // still displace real geometry (dispXZ/dispY), just don't drive lighting.
  float nx = pDir0.x * uWaveK0 * uWaveAmp0 * c0 + pDir1.x * uWaveK1 * uWaveAmp1 * c1;
  float nz = pDir0.y * uWaveK0 * uWaveAmp0 * c0 + pDir1.y * uWaveK1 * uWaveAmp1 * c1;

  transformed.xz += dispXZ * shoal;
  transformed.y += dispY * shoal;

  vPWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vPDepthM = aDepthM;
  vPNormal = normalize(vec3(-nx * shoal, 1.0, -nz * shoal));
}`

const PATCH_FRAG_COMMON = /* glsl */ `
varying vec3 vPWorldPos;
varying float vPDepthM;
varying vec3 vPNormal;
uniform vec2 uPatchOrigin;
uniform float uSeaFoam;
uniform float uCamFade;
uniform float uCrestNorm;
uniform sampler2D uMaskTex;
uniform vec2 uMaskNW;
uniform vec2 uMaskInvSize;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uSkyColor;
uniform vec3 uSunDir;
uniform vec3 uEnvTint;
${PATCH_CONSTS_GLSL}`

const PATCH_FRAG_SHADE = /* glsl */ `
{
  // land/sea mask (SAME texture the far sea plane samples, world->UV via the
  // mask's own geographic bbox — see setMask()/applyMaskUVs() below)
  vec2 maskUV = (vPWorldPos.xz - uMaskNW) * uMaskInvSize;
  float maskV = texture2D(uMaskTex, maskUV).r;
  if (maskV < 0.5) discard; // land — mask sea=255/land=0, same 0.5 threshold convention as the far sea plane's own discard

  vec3 N = normalize(vPNormal);
  vec3 V = normalize(cameraPosition - vPWorldPos);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);

  // 0-40 m depth: shallow -> deep color mix, laid over the region sea color
  float depthT = clamp(vPDepthM / 40.0, 0.0, 1.0);
  vec3 col = mix(uShallowColor, uDeepColor, depthT);
  col = mix(col, uSkyColor, fres * 0.5); // grazing-angle sky tint, matches the far sea's fresnel language

  // specular exponent deliberately much softer than the far sea's decorative
  // ripple (200): the patch's per-vertex analytic normal is Nyquist-limited
  // by the mesh's ~8.6 m vertex spacing against its shortest wave (35 m
  // wavelength ~4 verts/cycle) — a mirror-sharp highlight turns that
  // per-vertex normal aliasing into visible salt-and-pepper sparkle
  // (confirmed empirically: screenshot comparison against the pre-existing
  // far-sea ripple, which uses its own much coarser decorative wavenumbers
  // and doesn't show this). A wider glint hides the same aliasing instead of
  // amplifying it, at the cost of a less mirror-like highlight — acceptable
  // for a wind-chopped sea look.
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 48.0);
  col += vec3(1.0) * spec * 0.2;

  // foam: shoreline wash band (depth < 2 m) + wave-crest whitecaps. uCrestNorm
  // self-calibrates the steepness->foam threshold against the actual max
  // combined slope (see applyPatchWaves()) so it stays meaningful as
  // seaWaveHeight/demExaggeration change, instead of a fixed magic number.
  float shoreFoam = 1.0 - smoothstep(0.0, 2.0, vPDepthM);
  float steepIndicator = (1.0 - N.y) * uCrestNorm;
  float crestFoam = smoothstep(0.4, 1.1, steepIndicator);
  float foam = clamp((shoreFoam + crestFoam) * uSeaFoam, 0.0, 1.0);
  col = mix(col, vec3(0.97, 0.98, 0.97), foam);

  // radial fade over the outer 15% of the patch — hides the square boundary,
  // blends into the far sea plane underneath instead of a visible seam
  float edgeR = length(vPWorldPos.xz - uPatchOrigin) / pPatchHalf;
  float edgeFade = 1.0 - smoothstep(0.85, 1.0, edgeR);

  diffuseColor.rgb = col * uEnvTint;
  diffuseColor.a = opacity * uCamFade * edgeFade;
}
if (diffuseColor.a < 0.02) discard;`

// Is the DEM tile under (x,z) actually resident (fetched-and-resolved) as
// opposed to simply not-yet-streamed? Same reasoning + same public-surface-
// only implementation as walk.js's identical helper (heightField.
// heightAtWorld returns exactly 0 m for BOTH outcomes, so the raw sample
// alone can't tell "open sea" from "not loaded yet" apart) — copied rather
// than imported since walk.js keeps its own copy too (small pure function,
// no shared module for it).
function tileResident(hf, x, z) {
  const { px, py } = hf.projection.worldToPixel(x, z)
  return hf.tiles.has(hf.key(Math.floor(px / TILE_PX), Math.floor(py / TILE_PX)))
}

// ctx.camGroundM -> patch opacity: 1 at/below CAM_FADE_NEAR_M, 0 at/above
// CAM_FADE_FAR_M, linear between. Infinity (DEM not up yet) -> 0.
function patchCamFade(camGroundM) {
  if (!Number.isFinite(camGroundM)) return 0
  if (camGroundM <= CAM_FADE_NEAR_M) return 1
  if (camGroundM >= CAM_FADE_FAR_M) return 0
  return 1 - (camGroundM - CAM_FADE_NEAR_M) / (CAM_FADE_FAR_M - CAM_FADE_NEAR_M)
}

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

  // --- 工作包 A: 近景 Gerstner 海面 patch (docs/PHASE3_VISUAL_DESIGN.md) -----
  // Built once, always the same vertex/index count (no "empty geometry
  // memoizes 0" pitfall — that's an InstancedMesh-count issue, not a factor
  // here); gated purely by visible=false until data/camera conditions allow
  // it to show (see tickView below), same as sea/lines' own show-gates.
  const patchGeo = new THREE.PlaneGeometry(PATCH_SIZE, PATCH_SIZE, PATCH_SEG, PATCH_SEG)
  patchGeo.rotateX(-Math.PI / 2) // lie flat, matches the sea plane's own construction
  const patchDepthArr = new Float32Array((PATCH_SEG + 1) * (PATCH_SEG + 1)).fill(DEEP_DEFAULT_M)
  patchGeo.setAttribute('aDepthM', new THREE.BufferAttribute(patchDepthArr, 1))

  // per-wave uniform triples (k/amp/q) — amp+q are live (seaWaveHeight/
  // seaWaveChop/demExaggeration-driven, see applyPatchWaves), direction+omega
  // are baked GLSL consts (PATCH_CONSTS_GLSL above)
  const patchWave = [0, 1, 2, 3].map(() => ({ k: { value: 0 }, amp: { value: 0 }, q: { value: 0 } }))
  const patchUniforms = {
    uPatchOrigin: { value: new THREE.Vector2() },
    uCamFade: { value: 0 },
    uSeaFoam: { value: params.seaFoam },
    uCrestNorm: { value: 0 },
    uMaskTex: { value: null },
    uMaskNW: { value: new THREE.Vector2() },
    uMaskInvSize: { value: new THREE.Vector2() },
    uShallowColor: { value: new THREE.Color() },
    uDeepColor: { value: new THREE.Color() },
    uWaveK0: patchWave[0].k, uWaveAmp0: patchWave[0].amp, uWaveQ0: patchWave[0].q,
    uWaveK1: patchWave[1].k, uWaveAmp1: patchWave[1].amp, uWaveQ1: patchWave[1].q,
    uWaveK2: patchWave[2].k, uWaveAmp2: patchWave[2].amp, uWaveQ2: patchWave[2].q,
    uWaveK3: patchWave[3].k, uWaveAmp3: patchWave[3].amp, uWaveQ3: patchWave[3].q,
    // SAME .value containers as the far-sea ripple decoration above (NOT
    // copies) — environment.js's getSeaEnvUniforms()-driven day/night+weather
    // writes land here for free, zero environment.js changes needed
    uSkyColor: rippleUniforms.uSkyColor,
    uSunDir: rippleUniforms.uSunDir,
    uEnvTint: rippleUniforms.uEnvTint,
    uSeaTime: rippleUniforms.uSeaTime,
  }
  const patchMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(params.regionSeaColor),
    transparent: true,
    opacity: params.regionSeaOpacity,
    depthTest: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  patchMat.userData.uniforms = patchUniforms
  // own program cache key (see seaMat.customProgramCacheKey above for why —
  // same three r172 onBeforeCompile cache-key hardening)
  patchMat.customProgramCacheKey = () => 'region-sea-patch'
  patchMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, patchUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PATCH_VERT_COMMON}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${PATCH_VERT_DISPLACE}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PATCH_FRAG_COMMON}`)
      .replace('#include <alphatest_fragment>', PATCH_FRAG_SHADE)
  }
  const patchMesh = new THREE.Mesh(patchGeo, patchMat)
  patchMesh.renderOrder = 3 // above sea (1) and coastlines (2)
  patchMesh.frustumCulled = false // always centred on the camera — always "in view" by construction
  patchMesh.visible = false
  group.add(patchMesh)
  let patchLift = PATCH_LIFT_BASE
  let patchAnchorX = NaN // world x/z of the last depth-refill — NaN forces the first fill
  let patchAnchorZ = NaN

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
    // patch samples the SAME mask analytically from world position (no UV
    // attribute of its own — it would need rebaking on every camera snap,
    // whereas this world->UV linear map is a one-time constant): mirrors the
    // sea plane's own nw/dx,dz transform above, feeding the same numbers into
    // the patch's uMaskNW/uMaskInvSize uniforms instead of a uv attribute.
    patchUniforms.uMaskNW.value.set(nw.x, nw.z)
    patchUniforms.uMaskInvSize.value.set(1 / dx, 1 / dz)
  }

  // snap-time depth refill: heightField.heightAtWorld across the patch's
  // (PATCH_SEG+1)^2 grid (~50k taps), scanline order to lean on heightAtWorld's
  // 1-slot tile memo (geo.js) exactly like a chunk build does. tile 未載入
  // (tileResident false) 記為 DEEP_DEFAULT_M（深水), never 0 m — see that
  // constant's comment. Measured cost logged once per session in DEV so a
  // regression against the <10ms/frame budget (docs/PHASE3_VISUAL_DESIGN.md
  // 工作包 A) is visible without permanent instrumentation.
  let patchFillLogged = false
  function fillPatchDepth(heightField, cx, cz) {
    const t0 = performance.now()
    const n = PATCH_SEG + 1
    const step = PATCH_SIZE / PATCH_SEG
    const half = PATCH_SIZE / 2
    const arr = patchGeo.getAttribute('aDepthM').array
    let idx = 0
    for (let j = 0; j < n; j++) {
      const z = cz - half + j * step
      for (let i = 0; i < n; i++) {
        const x = cx - half + i * step
        arr[idx++] = tileResident(heightField, x, z) ? -heightField.heightAtWorld(x, z) : DEEP_DEFAULT_M
      }
    }
    patchGeo.getAttribute('aDepthM').needsUpdate = true
    if (!patchFillLogged && import.meta.env.DEV) {
      patchFillLogged = true
      const ms = performance.now() - t0
      // eslint-disable-next-line no-console
      console.debug(`[region] patch depth refill: ${ms.toFixed(2)}ms for ${n * n} verts (budget 10ms)`)
    }
  }

  // seaWaveHeight/seaWaveChop/demExaggeration -> per-wave k/amp/q uniforms.
  // amp uses worldYScale (K × exaggeration, meters -> world Y units) — same
  // convention every other draped vertical quantity in this app uses, so the
  // waves scale with the same exaggeration slider the terrain itself does.
  // uCrestNorm self-calibrates the whitecap threshold against the actual max
  // combined slope (Σ k·amp) instead of a fixed magic number.
  function applyPatchWaves() {
    if (!hf) return
    const scaleY = worldYScale(hf, params.demExaggeration)
    const K = hf.projection.K
    const chop = params.seaWaveChop
    const h = params.seaWaveHeight
    let slopeSum = 0
    for (let i = 0; i < 4; i++) {
      const ampWorld = h * WAVE_WEIGHT[i] * scaleY
      const kWorld = (2 * Math.PI) / (WAVE_LEN_M[i] * K)
      patchWave[i].amp.value = ampWorld
      patchWave[i].k.value = kWorld
      patchWave[i].q.value = WAVE_Q[i] * chop
      slopeSum += kWorld * ampWorld
    }
    patchUniforms.uCrestNorm.value = slopeSum > 1e-9 ? 1 / slopeSum : 0
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
    patchMesh.position.y = y + seaLift + patchLift
    // demExaggeration rebuild path (index.js REAL_REBUILD_KEYS -> regenerateTerrain
    // -> layers.updateAll() -> this update() -> placeVertical()): wave amplitude
    // is exaggeration-scaled too (applyPatchWaves), keep both in lockstep here
    applyPatchWaves()
  }

  function applyStyle() {
    seaMat.color.set(params.regionSeaColor)
    seaMat.opacity = params.regionSeaOpacity
    rippleUniforms.uRippleStrength.value = params.seaRippleStrength
    rippleUniforms.uRippleSpeed.value = params.seaRippleSpeed
    lineMat.color.set(params.regionLineColor)
    lineMat.linewidth = params.regionLineWidth
    lineMat.opacity = params.regionLineOpacity

    // near-camera wave patch: "deep" = the region sea color itself (reads as
    // one continuous surface with the far sea plane); "shallow" is a fixed
    // lighter derived tint — no separate param, this package is capped at 3
    // new sliders (seaWaveHeight/seaWaveChop/seaFoam)
    patchMat.color.set(params.regionSeaColor)
    patchMat.opacity = params.regionSeaOpacity
    patchUniforms.uSeaFoam.value = params.seaFoam
    patchUniforms.uDeepColor.value.set(params.regionSeaColor).multiplyScalar(0.6)
    patchUniforms.uShallowColor.value.set(params.regionSeaColor).lerp(SHALLOW_TINT, 0.6)
    // applyPatchWaves() intentionally NOT called here — every applyStyle()
    // callsite (update() below) calls placeVertical() immediately before it,
    // which already refreshes the wave uniforms; see that function.
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
      seaWaveHeight: 'seaWaveHeight',
      seaWaveChop: 'seaWaveChop',
      seaFoam: 'seaFoam',
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
      const nextPatch = zFightLift(PATCH_LIFT_BASE, ctx.fogScale)
      if (nextSea !== seaLift || nextLine !== lineLift || nextPatch !== patchLift) {
        seaLift = nextSea
        lineLift = nextLine
        patchLift = nextPatch
        placeVertical()
      }
      // sea ripple decoration: a wall-clock animation (not gated on the
      // timeline), same as typhoon's uTime. gate() (not just group.visible)
      // matches the isAnimating() proxy in index.js — regionVisible is used
      // there without waiting on maskReady/hf, so a brief idle-spin before
      // the mask loads is expected (docs/MARINE_DESIGN.md §2.2 opus m3);
      // this only actually advances once gate() is fully true.
      if (params.seaAnimated && gate()) rippleUniforms.uSeaTime.value += ctx.dt

      // 工作包 A: near-camera Gerstner patch — follow + fade + snap-refill.
      // Time itself is NOT advanced here: uSeaTime IS rippleUniforms.uSeaTime
      // (same object, see patchUniforms above), already driven by the
      // seaAnimated branch just above — no new isAnimating() condition needed
      // (docs/PHASE3_VISUAL_DESIGN.md 全域鐵則 #1/#6), the patch simply reads
      // whatever uSeaTime the ripple decoration already advanced this frame.
      const canShow = gate() && maskReady && params.seaWaveHeight > 0
      if (!canShow) {
        patchMesh.visible = false
      } else {
        const camFade = patchCamFade(ctx.camGroundM)
        if (camFade <= 0) {
          patchMesh.visible = false
        } else {
          patchUniforms.uCamFade.value = camFade
          const cam = ctx.camera
          const snapX = Math.round(cam.position.x / PATCH_SNAP) * PATCH_SNAP
          const snapZ = Math.round(cam.position.z / PATCH_SNAP) * PATCH_SNAP
          if (snapX !== patchAnchorX || snapZ !== patchAnchorZ) {
            patchAnchorX = snapX
            patchAnchorZ = snapZ
            patchMesh.position.x = snapX // .y stays whatever placeVertical() last set
            patchMesh.position.z = snapZ
            patchUniforms.uPatchOrigin.value.set(snapX, snapZ)
            fillPatchDepth(hf, snapX, snapZ)
          }
          patchMesh.visible = true
        }
      }
    },

    // deferred land/sea mask: sea=255 / land=0, sampled as the sea plane's
    // alphaMap so land is cut out independent of elevation. flipY false → row 0
    // (north) reads at uv v=0, matching applyMaskUVs. Also handed to the patch
    // (uMaskTex, see createRegionLayer above) — same texture object, sampled
    // manually there via a world-position UV instead of material.alphaMap.
    setMask(tex, bbox) {
      maskBbox = bbox
      seaMat.alphaMap = tex
      seaMat.needsUpdate = true
      patchUniforms.uMaskTex.value = tex
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
          seaWaveHeight: { type: 'slider', label: '近景浪高 Wave height', min: 0, max: 4, step: 0.1, format: (v) => `${v.toFixed(1)}m` },
          seaWaveChop: { type: 'slider', label: '浪形 Chop', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
          seaFoam: { type: 'slider', label: '浪花 Foam', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
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
          seaWaveHeight: params.seaWaveHeight,
          seaWaveChop: params.seaWaveChop,
          seaFoam: params.seaFoam,
        },
      }
    },

    dispose() {
      seaGeo.dispose()
      seaMat.dispose()
      patchGeo.dispose()
      patchMat.dispose()
      lines.geometry.dispose()
      lineMat.dispose()
    },
  }
}
