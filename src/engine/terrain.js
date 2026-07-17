import * as THREE from 'three'
import { Simplex2, mulberry32, fbm, ridged, smoothstep, lerp } from './noise.js'
import { worldYScale, metersToWorldY } from './geo.js'

export const TERRAIN_SIZE = 56
export const BASIN_RADIUS = 6.6 // flat excavation floor
export const BASIN_BLEND = 9.0 // where flat floor blends back into mountains
export const FLOOR_Y = -0.35

// ramp-texture coordinate 0 m (sea level) is pinned to when bathymetry shading
// is on (see rebuildRamp / applyBathymetryShading below) — sea occupies
// [0, SEA_RAMP_SPLIT] of the ramp, land [SEA_RAMP_SPLIT, 1]
const SEA_RAMP_SPLIT = 0.35

// Phase 3 packet C (docs/PHASE3_VISUAL_DESIGN.md "工作包 C"): near-view
// procedural detail normal. DETAIL_HEIGHT_M is the characteristic bump
// height of the disguise noise, in real-world METERS — converted to world Y
// units the same way every other vertical quantity in this module is
// (metersToWorldY/worldYScale convention, §全域鐵則 5), even though this is a
// shading-only normal-perturbation strength rather than a real elevation, so
// it scales consistently with demExaggeration instead of a hand-picked
// world-unit magic number. WORLD_UNITS_PER_METER_FALLBACK is the documented
// 1 unit ≈ 480.78 m constant, used only when no heightField exists yet
// (procedural mode / before the first DEM tile lands).
const DETAIL_HEIGHT_M = 3.0
const WORLD_UNITS_PER_METER_FALLBACK = 1 / 480.78

// CPU-generated terrain: multi-scale FBM + ridged multifractal + domain warping,
// with real vertex normals so PBR lighting and DOF read the actual relief.
export class Terrain {
  constructor(params) {
    this.material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(params.color),
      roughness: 1, // actual roughness baked into the roughness map
      metalness: 0,
      vertexColors: true,
      envMapIntensity: params.envMapIntensity,
    })

    // topographic map overlay: hypsometric tint, contour lines and survey grid,
    // computed per-fragment in world space so they drape over the relief
    this.mapUniforms = {
      uTint: { value: params.mapTint },
      uContourInterval: { value: params.contourInterval },
      uContourOpacity: { value: params.contourOpacity },
      uGridStep: { value: params.gridStep },
      uGridOpacity: { value: params.gridOpacity },
      uHeightRange: { value: new THREE.Vector2(-0.5, 2) },
      // bathymetry two-stage ramp remap (see the fragment shader below):
      // uSeaLevelY is world-Y for 0 m; uSeaSplit is the ramp coordinate it's
      // pinned to. uSeaSplit 0 collapses the remap to the original
      // single-stage formula exactly — applyBathymetryShading sets both.
      uSeaLevelY: { value: 0 },
      uSeaSplit: { value: 0 },
      uRampTex: { value: null },
      uHeightContrast: { value: params.heightContrast },
      uHeightPivot: { value: params.heightPivot },
      uSlopeTint: { value: params.slopeTint },
      uContourColor: { value: new THREE.Color(params.contourColor) },
      uScanT: { value: -1 }, // scan progress 0..1, negative = inactive
      uScanR: { value: 42 }, // full sweep radius, world units (main.js ties it to fog far)
      uScanCenter: { value: new THREE.Vector2(0, 0) }, // pan target at trigger time
      uScanColor: { value: new THREE.Color(params.scanColor) },
      uScanWidth: { value: params.scanWidth },
      uScanBlur: { value: params.scanBlur },
      uScanDispH: { value: params.scanDispHeight },
      uScanDispW: { value: params.scanDispFalloff },
      // physics-derived river simulation (regional pilot). uRiverTex holds a
      // flow-accumulation intensity bake (scripts/pilot_flow_accum.py); it tints
      // valley floors blue where water physically accumulates, glued to the
      // thalweg by construction. uRiverBounds is the bake's world-XZ footprint
      // (minX,minZ,maxX,maxZ); uRiverSimOpacity 0 = layer off (branch skipped,
      // texture never sampled — no cost). Same water-blue as the vector rivers.
      uRiverTex: { value: null },
      uRiverBounds: { value: new THREE.Vector4(0, 0, 0, 0) },
      uRiverSimOpacity: { value: 0 },
      uRiverSimColor: { value: new THREE.Color(params.riversColor) },
      // physics-derived farmland-presence bake (scripts/bake_farm_sim.py) —
      // same shader-drape pattern as the river sim above: uFarmTex holds a
      // binary presence mask (scripts/bake_farm_sim.py), uFarmBounds is that
      // bake's own world-XZ footprint (NOT the same numeric bounds as the
      // river bake — different source dataset — but the same tile-pixel grid
      // convention, so the UV math is identical code). uFarmOpacity 0 = layer
      // off (branch skipped, uFarmTex never sampled — zero cost while hidden).
      // An INDEPENDENT overlay (agriculture, not hydrology) — own toggle/color.
      uFarmTex: { value: null },
      uFarmBounds: { value: new THREE.Vector4(0, 0, 0, 0) },
      uFarmOpacity: { value: 0 },
      uFarmColor: { value: new THREE.Color(params.farmColor) },
      // Phase 3 packet C: near-view procedural detail normal (see the
      // DETAIL_HEIGHT_M comment above). uTerrainDetail 0 = fully off — every
      // mix()/perturbation the fragment shader does with it collapses to a
      // byte-for-byte no-op. uDetailAmpWorld is kept in sync with
      // demExaggeration by _detailAmpWorld()/_prepareChunkShading below.
      uTerrainDetail: { value: params.terrainDetail },
      uDetailAmpWorld: { value: this._detailAmpWorld(params) },
    }
    this.rebuildRamp(params)
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.mapUniforms)
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWorldPos;
uniform float uScanT;
uniform float uScanR;
uniform vec2 uScanCenter;
uniform float uScanDispH;
uniform float uScanDispW;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
// scan wave physically lifts the surface as it sweeps outward
// (distance measured in WORLD space — chunk meshes are translated, so local
// coords would give each chunk its own wave center)
if (uScanT >= 0.0) {
  vec3 wPre = (modelMatrix * vec4(transformed, 1.0)).xyz;
  float dV = length(wPre.xz - uScanCenter);
  float RV = uScanT * uScanR;
  float bumpV = exp(-pow((dV - RV) / max(uScanDispW, 0.05), 2.0));
  transformed.y += uScanDispH * bumpV * (1.0 - smoothstep(0.6, 1.0, uScanT));
}
vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWorldPos;
uniform float uTint;
uniform float uContourInterval;
uniform float uContourOpacity;
uniform float uGridStep;
uniform float uGridOpacity;
uniform vec2 uHeightRange;
uniform float uSeaLevelY;
uniform float uSeaSplit;
uniform sampler2D uRampTex;
uniform float uHeightContrast;
uniform float uHeightPivot;
uniform float uSlopeTint;
uniform vec3 uContourColor;
uniform float uScanT;
uniform float uScanR;
uniform vec2 uScanCenter;
uniform vec3 uScanColor;
uniform float uScanWidth;
uniform float uScanBlur;
uniform sampler2D uRiverTex;
uniform vec4 uRiverBounds;
uniform float uRiverSimOpacity;
uniform vec3 uRiverSimColor;
uniform sampler2D uFarmTex;
uniform vec4 uFarmBounds;
uniform float uFarmOpacity;
uniform vec3 uFarmColor;
uniform float uTerrainDetail;
uniform float uDetailAmpWorld;
// --- Phase 3 packet C (docs/PHASE3_VISUAL_DESIGN.md): near-view procedural
// detail normal. Pure ALU, world-space XZ, no textures, no dFdx/dFdy
// (SwiftShader-safe — same analytic-slope discipline as region.js's sea
// ripple). Classic quintic-fade value noise WITH an analytic derivative
// (Inigo Quilez's "noise derivatives" technique) so the gradient used to
// tilt the normal stays continuous across cell borders — a linear-fade value
// noise's derivative is discontinuous at every integer cell and would show
// as faceted banding once used to perturb a normal.
float terrainDetailHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
// returns (value, dValue/dx, dValue/dy) for one octave, x already pre-scaled
// by that octave's frequency.
vec3 terrainDetailNoiseD(vec2 x) {
  vec2 p = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic fade
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0); // fade curve derivative
  float a = terrainDetailHash(p);
  float b = terrainDetailHash(p + vec2(1.0, 0.0));
  float c = terrainDetailHash(p + vec2(0.0, 1.0));
  float d = terrainDetailHash(p + vec2(1.0, 1.0));
  float k0 = a;
  float k1 = b - a;
  float k2 = c - a;
  float k4 = a - b - c + d;
  float value = k0 + k1 * u.x + k2 * u.y + k4 * u.x * u.y;
  vec2 deriv = du * (vec2(k1, k2) + k4 * u.yx);
  return vec3(value, deriv);
}
// 3-octave fbm with derivative accumulation — each octave's gradient is
// scaled by ITS OWN frequency before summing (chain rule: d/dp[n(f·p)] =
// f·n'(f·p)), exactly like the value sum is scaled by that octave's
// amplitude. Frequencies stay in the ~50–160 world-space band the design doc
// calls for (feature scale ~3–15 m at 1 world unit ≈ 480.78 m).
vec3 terrainDetailFbmD(vec2 p) {
  float freq = 60.0; // ≈8 m period
  float amp = 0.6;
  float value = 0.0;
  vec2 deriv = vec2(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 n = terrainDetailNoiseD(p * freq);
    value += amp * n.x;
    deriv += amp * freq * n.yz;
    freq *= 2.3;
    amp *= 0.45;
  }
  return vec3(value, deriv);
}
// shared strength: <500 m full strength → 2 km zero (fixed world-unit
// thresholds — 500 m≈1.04, 2 km≈4.16 at 1 unit≈480.78 m, the design doc's
// simplification for this horizontal-only distance gate). uTerrainDetail 0
// forces strength 0 everywhere, so every mix()/perturbation gated on it below
// is byte-for-byte a no-op — the param-zero-is-current-state contract.
float terrainDetailStrength(vec3 worldPos) {
  float distToCam = distance(cameraPosition, worldPos);
  float fade = 1.0 - smoothstep(1.04, 4.16, distToCam);
  return uTerrainDetail * fade;
}`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  // --- hypsometric tint: two-stage remap so bathymetry gets its own ramp
  // budget without disturbing the land gradient's contrast. uSeaLevelY is
  // world-Y for 0 m; uSeaSplit is the ramp coordinate 0 m is pinned to (0 when
  // bathymetry shading is off — see rebuildRamp/applyBathymetryShading —
  // which collapses this exactly to the original single-stage formula: the
  // land branch's hNorm/rampT below is bit-identical to the pre-bathymetry
  // code once uHeightRange.x == uSeaLevelY).
  float rampT;
  if (vWorldPos.y < uSeaLevelY) {
    // below sea level: [sea floor, sea level] into [0, uSeaSplit]. Real
    // continental-shelf depths (Taiwan Strait/Penghu channel, tens of metres)
    // are a tiny sliver of the full -7000 m domain and would read as almost
    // pure white on a linear scale — gamma-expand so shallow water gets its
    // own visible pale-blue band (same pow<1 boost the land vertex tint uses
    // for pow(hn, 0.85) — brightens/spreads out the low end).
    float seaT = clamp((vWorldPos.y - uHeightRange.x) / max(uSeaLevelY - uHeightRange.x, 1e-4), 0.0, 1.0);
    float depthT = pow(1.0 - seaT, 0.4);
    rampT = (1.0 - depthT) * uSeaSplit;
  } else {
    // at/above sea level: the ORIGINAL hNorm/contrast/pivot formula across
    // [sea level, summit], rescaled into [uSeaSplit, 1] — same land colors,
    // just budgeted a smaller slice of the ramp texture
    float hNorm = clamp((vWorldPos.y - uSeaLevelY) / max(uHeightRange.y - uSeaLevelY, 1e-4), 0.0, 1.0);
    float landT = clamp(0.5 + (hNorm - uHeightPivot) * uHeightContrast, 0.0, 1.0);
    rampT = uSeaSplit + landT * (1.0 - uSeaSplit);
  }
  vec3 ramp = texture2D(uRampTex, vec2(rampT, 0.5)).rgb;
  // smooth interpolated normal (world space) — screen-space derivatives look blotchy
  vec3 wN = inverseTransformDirection(normalize(vNormal), viewMatrix);
  float slope = 1.0 - clamp(wN.y, 0.0, 1.0);
  ramp = mix(ramp, vec3(0.42, 0.31, 0.21), smoothstep(0.3, 0.8, slope) * uSlopeTint);
  // keep the lighting/AO shading from the base surface but let the gradient own the color
  float luma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, ramp * clamp(luma * 2.4, 0.2, 1.4), uTint);

  // --- Phase 3 packet C: albedo micro-dither reuses the SAME analytic value
  // noise as the detail normal below (not a second unrelated noise call) —
  // ±3% luma jitter from its low-frequency (first-octave) component, gated
  // by the identical distance/terrainDetail strength so it's byte-for-byte a
  // no-op together with the normal perturbation (uTerrainDetail 0, or beyond
  // the 2 km distance fade).
  {
    float detailDitherStrength = terrainDetailStrength(vWorldPos);
    if (detailDitherStrength > 0.0005) {
      float lowFreqN = terrainDetailNoiseD(vWorldPos.xz * 60.0).x;
      diffuseColor.rgb *= 1.0 + (lowFreqN - 0.5) * 0.06 * detailDitherStrength;
    }
  }

  // --- physics-derived river tint: sample the flow-accumulation bake in the
  // pilot footprint and paint valley floors blue. Gated by uRiverSimOpacity
  // (0 → branch skipped, uRiverTex never sampled) and by the world-XZ bounds;
  // smoothstep soft-edges weak upstream flow, and the bake's own edge fade
  // means the pilot border dissolves rather than showing a hard rectangle.
  if (uRiverSimOpacity > 0.0) {
    vec2 rmin = uRiverBounds.xy;
    vec2 rmax = uRiverBounds.zw;
    if (vWorldPos.x >= rmin.x && vWorldPos.x <= rmax.x && vWorldPos.z >= rmin.y && vWorldPos.z <= rmax.y) {
      vec2 ruv = vec2((vWorldPos.x - rmin.x) / max(rmax.x - rmin.x, 1e-4),
                      (vWorldPos.z - rmin.y) / max(rmax.y - rmin.y, 1e-4));
      float rInt = texture2D(uRiverTex, ruv).r;
      float rw = smoothstep(0.02, 0.20, rInt) * uRiverSimOpacity;
      diffuseColor.rgb = mix(diffuseColor.rgb, uRiverSimColor, clamp(rw, 0.0, 0.95));
    }
  }

  // --- farmland-presence tint: sample the binary farm-field bake in its own
  // footprint and paint the plains green. Gated by uFarmOpacity (0 → branch
  // skipped, uFarmTex never sampled) and by the world-XZ bounds; the bake is a
  // hard 0/255 mask but LinearFilter interpolation gives soft texel edges, so
  // a narrow smoothstep around the mid-point antialiases the field boundary
  // instead of a hard-edged rectangle grid.
  if (uFarmOpacity > 0.0) {
    vec2 fmin = uFarmBounds.xy;
    vec2 fmax = uFarmBounds.zw;
    if (vWorldPos.x >= fmin.x && vWorldPos.x <= fmax.x && vWorldPos.z >= fmin.y && vWorldPos.z <= fmax.y) {
      vec2 fuv = vec2((vWorldPos.x - fmin.x) / max(fmax.x - fmin.x, 1e-4),
                      (vWorldPos.z - fmin.y) / max(fmax.y - fmin.y, 1e-4));
      float fInt = texture2D(uFarmTex, fuv).r;
      float fw = smoothstep(0.3, 0.6, fInt) * uFarmOpacity;
      diffuseColor.rgb = mix(diffuseColor.rgb, uFarmColor, clamp(fw, 0.0, 0.95));
    }
  }

  // --- contour lines: minor every interval, heavy line every 5th
  float ch = vWorldPos.y / uContourInterval;
  float dch = fwidth(ch);
  float distMinor = abs(fract(ch + 0.5) - 0.5);
  float minorLine = 1.0 - smoothstep(0.0, dch * 1.4, distMinor);
  float ch5 = ch / 5.0;
  float dch5 = fwidth(ch5);
  float distMajor = abs(fract(ch5 + 0.5) - 0.5);
  float majorLine = 1.0 - smoothstep(0.0, dch5 * 1.4, distMajor);
  // fade contours out only when they crowd below pixel size (far away / near-vertical)
  float crowd = clamp(1.0 - dch * 0.22, 0.0, 1.0);
  float contour = max(minorLine * 0.55, majorLine) * uContourOpacity * crowd;
  diffuseColor.rgb = mix(diffuseColor.rgb, uContourColor, contour);

  // --- survey grid in world x/z
  vec2 g = vWorldPos.xz / uGridStep;
  vec2 dg = fwidth(g);
  vec2 distGrid = abs(fract(g + 0.5) - 0.5);
  float gx = 1.0 - smoothstep(0.0, dg.x * 1.4, distGrid.x);
  float gz = 1.0 - smoothstep(0.0, dg.y * 1.4, distGrid.y);
  float grid = max(gx, gz) * uGridOpacity;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.14, 0.13, 0.12), grid);

  // --- radar scan wavefront paints the surface (additive-only washes out on white terrain)
  if (uScanT >= 0.0) {
    float dScan = length(vWorldPos.xz - uScanCenter);
    float Rs = uScanT * uScanR;
    float aaS = fwidth(dScan);
    float edgeS = abs(dScan - Rs) - uScanWidth * 0.5;
    float bandS = 1.0 - smoothstep(0.0, max(uScanBlur, aaS), edgeS);
    float fadeS = 1.0 - smoothstep(0.6, 1.0, uScanT);
    diffuseColor.rgb = mix(diffuseColor.rgb, uScanColor, clamp(bandS * fadeS, 0.0, 0.95));
  }
}`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
// --- Phase 3 packet C (docs/PHASE3_VISUAL_DESIGN.md): near-view procedural
// detail normal — tilt the (already bump-mapped) lighting normal by an
// analytic value-noise gradient in the world XZ plane. Slope-independent by
// design (the same absolute XZ tilt is added regardless of the underlying
// surface's own slope — see the design doc's "坡度無關"), so it disguises the
// 20 m DEM's "staircase" facets on flat ground and steep ridgelines alike
// without needing a tangent-space basis this material doesn't build (no
// normal-map UVs on the terrain mesh). 'normal' here is VIEW space (set by
// normal_fragment_begin above and optionally bump-mapped by
// normal_fragment_maps just above this injection) — round-trip through world
// space so the perturbation is a stable world-XZ tilt independent of camera
// orientation.
{
  float detailStrength = terrainDetailStrength(vWorldPos);
  if (detailStrength > 0.0005) {
    vec3 nd = terrainDetailFbmD(vWorldPos.xz);
    vec2 grad = nd.yz * uDetailAmpWorld;
    vec3 worldN = inverseTransformDirection(normal, viewMatrix);
    vec3 detailWorldN = normalize(worldN + vec3(-grad.x, 0.0, -grad.y) * detailStrength);
    normal = normalize((viewMatrix * vec4(detailWorldN, 0.0)).xyz);
  }
}`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
// radar scan ripple: an emissive wavefront expanding from the center across the relief
if (uScanT >= 0.0) {
  float d = length(vWorldPos.xz - uScanCenter);
  float R = uScanT * uScanR;
  float edgeE = abs(d - R) - uScanWidth * 0.5;
  float band = 1.0 - smoothstep(0.0, max(uScanBlur, fwidth(d)), edgeE);
  float fade = 1.0 - smoothstep(0.6, 1.0, uScanT);
  totalEmissiveRadiance += uScanColor * band * fade * 0.5;
}`
        )
    }
    // group holds both terrain forms; main.js adds terrain.group to the scene.
    // - procedural mode: the legacy single 56×56 plane (this.mesh)
    // - real mode: streamed chunk meshes, one per map tile (this.chunkGroup),
    //   built/removed by the ChunkManager (chunks.js) as the pan target moves
    // All chunks share this.material — one shader, world-space overlays, so
    // contours / grid / hypsometric tint run continuously across chunk borders.
    this.group = new THREE.Group()
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.mesh.receiveShadow = true
    this.mesh.castShadow = true
    this.group.add(this.mesh)
    this.chunkGroup = new THREE.Group()
    this.group.add(this.chunkGroup)
    this.chunkMap = new Map() // "zoom/tx/ty" → chunk mesh
    this.heightField = null // primary real-world height source (geo.js)
    this.heightFields = null // P2: Map zoom → HeightField, one tile pyramid level each
    this.primaryZoom = 12
    this.rebuild(params)
    this.rebuildRoughness(params)
  }

  // P2: one HeightField per LOD zoom, all sharing the same world coordinates
  // and vertical datum. `primaryZoom` names the field that labels, peaks and
  // GPS keep reading (the z12 anchor level).
  setHeightFields(fields, primaryZoom) {
    this.heightFields = fields
    this.primaryZoom = primaryZoom
    this.heightField = fields.get(primaryZoom)
  }

  // scene height → display elevation in feet (real when a DEM drives the terrain)
  heightToFeet(h) {
    return this._h2ft ? this._h2ft(h) : Math.round(4800 + h * 420)
  }

  // Phase 3 packet C: DETAIL_HEIGHT_M (real-world meters) → world Y units,
  // respecting demExaggeration like every other vertical quantity (see the
  // DETAIL_HEIGHT_M comment up top). Falls back to the documented 1 unit ≈
  // 480.78 m constant when no heightField exists yet.
  _detailAmpWorld(params) {
    const K = this.heightField ? this.heightField.projection.K : WORLD_UNITS_PER_METER_FALLBACK
    return K * params.demExaggeration * DETAIL_HEIGHT_M
  }

  // Sampler over the real-world height field: world xz → meters → scene units.
  // Heights are datum-shifted (initial-core mean → y 0) so framing, fog and
  // camera keep working; XY and Y share the projection's K so proportions are true.
  _makeDemSampler(params) {
    const hf = this.heightField
    const scale = worldYScale(hf, params.demExaggeration)
    const datumM = hf.datumM
    this._h2ft = (h) => Math.round((h / scale + datumM) * 3.28084)
    return this._makeDemSamplerFor(hf, params)
  }

  // Sampler bound to ONE zoom's tile cache — every LOD level shares the same
  // K and datum, so the same world xz reads (near enough) the same height.
  _makeDemSamplerFor(hf, params) {
    const scale = worldYScale(hf, params.demExaggeration)
    const datumM = hf.datumM

    const sDetail = new Simplex2(mulberry32(params.seed))
    const { detail, detailScale } = params

    return (x, z) => {
      const h = (hf.heightAtWorld(x, z) - datumM) * scale
      if (detail === 0) return h // fast path — chunk normals sample 5× per vertex

      // optional fine grain on top of the (smoother) 30m-class data
      const fine =
        detail * fbm(sDetail, x * detailScale, z * detailScale, 3, 2.3, 0.55) +
        detail * 0.35 * fbm(sDetail, x * detailScale * 4.1 + 31, z * detailScale * 4.1 - 17, 2, 2.2, 0.5)
      // no basin carve in real-world mode — the map runs uninterrupted
      return h + fine
    }
  }

  // Height field sampler for the current seed — kept so other objects can query it.
  _makeSampler(params) {
    if (params.source === 'real' && this.heightField) return this._makeDemSampler(params)
    this._h2ft = null // procedural: fictional elevations
    const rng = mulberry32(params.seed)
    const sWarp = new Simplex2(rng)
    const sRidge = new Simplex2(rng)
    const sBase = new Simplex2(rng)
    const sDetail = new Simplex2(rng)

    // A handful of explicit impact craters scattered outside the basin
    const craterRng = mulberry32(params.seed ^ 0x9e3779b9)
    const craters = []
    for (let i = 0; i < 7; i++) {
      const a = craterRng() * Math.PI * 2
      const d = 10.5 + craterRng() * 10
      craters.push({
        x: Math.cos(a) * d,
        z: Math.sin(a) * d,
        r: 1.6 + craterRng() * 2.8,
        depth: (0.45 + craterRng() * 0.9) * params.amplitude * 0.35,
      })
    }

    const { scale, octaves, lacunarity, gain, amplitude, warp, detail, detailScale } = params

    return (x, z) => {
      // domain warp — breaks up the "obviously noise" look
      const wx = x + warp * fbm(sWarp, x * 0.045 + 7.3, z * 0.045 + 2.1, 3, 2.1, 0.5)
      const wz = z + warp * fbm(sWarp, x * 0.045 - 4.7, z * 0.045 + 9.4, 3, 2.1, 0.5)

      // large-scale ridged mountains + mid-scale rolling base
      const m = ridged(sRidge, wx * scale, wz * scale, octaves, lacunarity, gain)
      const base = fbm(sBase, wx * scale * 2.1, wz * scale * 2.1, octaves, lacunarity, gain)
      let h = amplitude * (m * m * 1.2 + base * 0.28)

      // impact craters: bowl + raised rim
      for (const c of craters) {
        const dx = x - c.x
        const dz = z - c.z
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d < c.r * 1.6) {
          const bowl = 1 - smoothstep(0, c.r, d)
          h -= c.depth * bowl * bowl * bowl * 2.2
          const rim = Math.exp(-Math.pow((d - c.r) / (c.r * 0.28), 2))
          h += c.depth * 0.4 * rim
        }
      }

      // fine surface grain (two extra scales)
      const fine =
        detail * fbm(sDetail, x * detailScale, z * detailScale, 3, 2.3, 0.55) +
        detail * 0.35 * fbm(sDetail, x * detailScale * 4.1 + 31, z * detailScale * 4.1 - 17, 2, 2.2, 0.5)

      // flatten the central excavation basin
      const r = Math.sqrt(x * x + z * z)
      const t = smoothstep(BASIN_RADIUS, BASIN_BLEND, r)
      const floorH = FLOOR_Y + fine * 0.12
      return lerp(floorH, h + fine, t)
    }
  }

  rebuild(params) {
    const sample = this._makeSampler(params)
    this.sample = sample
    // real mode never builds the procedural plane — not even before the DEM
    // has loaded (heightField null): the plane was previously built once at
    // construction time (~1M vertices of noise) only to be hidden behind
    // terrain.group.visible=false while tiles fetch. Chunks stream in via
    // the ChunkManager once heightField is set and rebuild() runs again.
    const real = params.source === 'real'
    const chunksReady = real && !!this.heightField
    this.mesh.visible = !real
    this.chunkGroup.visible = chunksReady
    if (chunksReady) {
      // chunk meshes are owned by the ChunkManager — nothing builds here,
      // only the shared shading config the incremental builds will use
      this._prepareChunkShading(params)
    } else if (!real) {
      this._rebuildSinglePlane(params, sample)
    }
  }

  // Shading config shared by every chunk build. The height range is the FIXED
  // island-wide range (heightField.minM/maxM) — chunks built minutes apart
  // must normalize hypsometric tint identically or borders would seam.
  _prepareChunkShading(params) {
    const hf = this.heightField
    // permanent extended domain (sea floor → summit) — baked into every
    // chunk's vertex tint below the instant it's built, independent of the
    // bathymetry toggle (vertex colors can't un-bake on a later toggle flip)
    const minH = metersToWorldY(hf, hf.minM, params.demExaggeration)
    const maxH = metersToWorldY(hf, hf.maxM, params.demExaggeration)
    this.applyBathymetryShading(params) // toggle-aware uHeightRange/uSeaLevelY/uSeaSplit + ramp
    this.mapUniforms.uDetailAmpWorld.value = this._detailAmpWorld(params) // packet C: track demExaggeration
    // P2: one sampler per LOD zoom — a chunk built at zoom z reads z's tile
    // pyramid level (this.sample stays the primary-zoom sampler for labels,
    // peaks and tours)
    const samplers = new Map()
    for (const [z, field] of this.heightFields) {
      samplers.set(z, z === this.primaryZoom ? this.sample : this._makeDemSamplerFor(field, params))
    }
    this._chunkCfg = {
      samplers,
      minH,
      span: Math.max(1e-5, maxH - minH),
      sTint: new Simplex2(mulberry32(params.seed + 101)),
    }
  }

  // Toggle-aware ramp/height-range for the ocean band (index.js's
  // bathymetryVisible switch calls this directly — no chunk rebuild, no
  // re-fetch, just a uniform + canvas-texture swap, per
  // docs/BATHYMETRY_DESIGN.md §2.6). hf.minM/maxM are the PERMANENT extended
  // domain (see _prepareChunkShading above) — this method only decides how
  // much of that domain the ramp texture treats as "ocean" vs "land". With
  // bathymetryVisible false, uHeightRange.x collapses to sea level and
  // uSeaSplit to 0, which makes the fragment shader's two-stage remap exactly
  // reproduce the original pre-bathymetry single-stage formula.
  applyBathymetryShading(params) {
    const hf = this.heightField
    if (!hf) return
    const exagg = params.demExaggeration
    const seaLevelY = metersToWorldY(hf, 0, exagg)
    const maxY = metersToWorldY(hf, hf.maxM, exagg)
    const on = params.source === 'real' && !!params.bathymetryVisible
    const seaMinY = on ? metersToWorldY(hf, hf.minM, exagg) : seaLevelY
    this.mapUniforms.uHeightRange.value.set(seaMinY, maxY)
    this.mapUniforms.uSeaLevelY.value = seaLevelY
    this.mapUniforms.uSeaSplit.value = on ? SEA_RAMP_SPLIT : 0
    this.rebuildRamp(params)
  }

  // Build one chunk mesh for map tile (tx, ty) at `zoom` with a res² grid.
  // Its tile 3×3 neighbourhood at that zoom must already be cached (the
  // ChunkManager ensures it first). Vertex normals come from central
  // differences of the per-zoom sampler, so normals are identical on both
  // sides of a same-zoom border — no lighting seam. A skirt (the edge ring
  // extruded straight down) hides the hairline cracks that DO exist across
  // LOD-ring boundaries, where two zooms resample the relief differently.
  addChunk(zoom, tx, ty, res) {
    const { samplers, minH, span, sTint } = this._chunkCfg
    const sample = samplers.get(zoom)
    const proj = this.heightFields.get(zoom).projection
    const size = proj.tileWorldSize
    const eps = size / res // normal probe = one grid cell
    const skirtDepth = size * 0.03
    const center = proj.tileCenterWorld(tx, ty)

    const n1 = res + 1
    const gridCount = n1 * n1
    const count = gridCount + 4 * n1 // grid + 4 skirt edges
    const posArr = new Float32Array(count * 3)
    const normals = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const uvs = new Float32Array(count * 2)
    const half = size / 2

    for (let iy = 0; iy < n1; iy++) {
      for (let ix = 0; ix < n1; ix++) {
        const i = iy * n1 + ix
        const lx = -half + ix * eps
        const lz = -half + iy * eps
        const wx = center.x + lx
        const wz = center.z + lz
        const h = sample(wx, wz)
        posArr[i * 3] = lx
        posArr[i * 3 + 1] = h
        posArr[i * 3 + 2] = lz
        uvs[i * 2] = ix / res
        uvs[i * 2 + 1] = 1 - iy / res

        // seam-free normal: central differences of the per-zoom sampler
        const nx = sample(wx - eps, wz) - sample(wx + eps, wz)
        const nz = sample(wx, wz - eps) - sample(wx, wz + eps)
        const inv = 1 / Math.hypot(nx, 2 * eps, nz)
        normals[i * 3] = nx * inv
        normals[i * 3 + 1] = 2 * eps * inv
        normals[i * 3 + 2] = nz * inv

        // vertex tint: height-graded value + slope darkening + grain jitter
        // (world-coherent, so it too runs continuously across chunks). minH
        // now extends down to the GEBCO sea floor (geo.js TAIWAN_SEA_MIN_M),
        // so real depths land naturally in [0,1] — no clamp needed (the old
        // Math.max(0,…) papered over coastal DEM data dipping a few meters
        // BELOW the then-fixed 0 m floor; pow(negative, 0.85) is NaN → black
        // fog-proof shards. That floor is now a safely-buffered -7000 m, well
        // below any real sample, so the underflow this guarded against can't happen).
        const hn = (h - minH) / span
        let v = lerp(0.62, 0.95, Math.pow(hn, 0.85))
        v *= lerp(0.78, 1.0, Math.pow(Math.max(0, normals[i * 3 + 1]), 0.6))
        v += fbm(sTint, wx * 1.7, wz * 1.7, 2, 2.2, 0.5) * 0.05
        colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v
      }
    }

    // skirt vertices: copies of the 4 edge rings pushed straight down. Normals
    // and colors reuse the edge vertex values — the wall is near-vertical and
    // in shadow of the rim, so lighting continuity beats geometric correctness.
    const edges = new Array(4 * n1)
    for (let ix = 0; ix < n1; ix++) edges[ix] = ix // north row
    for (let ix = 0; ix < n1; ix++) edges[n1 + ix] = res * n1 + ix // south row
    for (let iy = 0; iy < n1; iy++) edges[2 * n1 + iy] = iy * n1 // west col
    for (let iy = 0; iy < n1; iy++) edges[3 * n1 + iy] = iy * n1 + res // east col
    for (let j = 0; j < edges.length; j++) {
      const s = edges[j]
      const d = gridCount + j
      posArr[d * 3] = posArr[s * 3]
      posArr[d * 3 + 1] = posArr[s * 3 + 1] - skirtDepth
      posArr[d * 3 + 2] = posArr[s * 3 + 2]
      normals[d * 3] = normals[s * 3]
      normals[d * 3 + 1] = normals[s * 3 + 1]
      normals[d * 3 + 2] = normals[s * 3 + 2]
      colors[d * 3] = colors[s * 3]
      colors[d * 3 + 1] = colors[s * 3 + 1]
      colors[d * 3 + 2] = colors[s * 3 + 2]
      uvs[d * 2] = uvs[s * 2]
      uvs[d * 2 + 1] = uvs[s * 2 + 1]
    }

    // indices: grid triangles + skirt quads. Skirt quads are emitted with both
    // windings (they're cheap) so every wall faces outward regardless of edge.
    const IndexArray = count > 65535 ? Uint32Array : Uint16Array
    const idx = new IndexArray(res * res * 6 + 4 * res * 12)
    let o = 0
    for (let iy = 0; iy < res; iy++) {
      for (let ix = 0; ix < res; ix++) {
        const a = iy * n1 + ix
        const b = a + 1
        const c = a + n1
        const d = c + 1
        idx[o++] = a
        idx[o++] = c
        idx[o++] = b
        idx[o++] = b
        idx[o++] = c
        idx[o++] = d
      }
    }
    for (let e = 0; e < 4; e++) {
      for (let i = 0; i < res; i++) {
        const t0 = edges[e * n1 + i]
        const t1 = edges[e * n1 + i + 1]
        const s0 = gridCount + e * n1 + i
        const s1 = s0 + 1
        idx[o++] = t0
        idx[o++] = t1
        idx[o++] = s0
        idx[o++] = t1
        idx[o++] = s1
        idx[o++] = s0
        idx[o++] = t0
        idx[o++] = s0
        idx[o++] = t1
        idx[o++] = t1
        idx[o++] = s0
        idx[o++] = s1
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geo.setIndex(new THREE.BufferAttribute(idx, 1))

    const chunk = new THREE.Mesh(geo, this.material)
    chunk.position.set(center.x, 0, center.z)
    chunk.receiveShadow = true
    chunk.castShadow = true
    chunk.userData = { zoom, tx, ty, res }
    this.chunkGroup.add(chunk)
    this.chunkMap.set(`${zoom}/${tx}/${ty}`, chunk)
    return chunk
  }

  removeChunk(key) {
    const chunk = this.chunkMap.get(key)
    if (!chunk) return
    this.chunkGroup.remove(chunk)
    chunk.geometry.dispose() // material is shared — never disposed here
    this.chunkMap.delete(key)
  }

  // Procedural mode: the original single 56×56 plane, untouched.
  _rebuildSinglePlane(params, sample) {
    const res = params.resolution
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, res, res)
    geo.rotateX(-Math.PI / 2)

    const pos = geo.attributes.position
    const count = pos.count
    const arr = pos.array
    let minH = Infinity
    let maxH = -Infinity
    for (let i = 0; i < count; i++) {
      const x = arr[i * 3]
      const z = arr[i * 3 + 2]
      const h = sample(x, z)
      arr[i * 3 + 1] = h
      if (h < minH) minH = h
      if (h > maxH) maxH = h
    }
    geo.computeVertexNormals()

    // vertex tint: height-graded value + slope darkening + grain jitter
    const colorRng = mulberry32(params.seed + 101)
    const sTint = new Simplex2(colorRng)
    const normals = geo.attributes.normal.array
    const colors = new Float32Array(count * 3)
    const span = Math.max(1e-5, maxH - minH)
    for (let i = 0; i < count; i++) {
      const x = arr[i * 3]
      const h = arr[i * 3 + 1]
      const z = arr[i * 3 + 2]
      const ny = normals[i * 3 + 1]
      const hn = (h - minH) / span
      let v = lerp(0.62, 0.95, Math.pow(hn, 0.85))
      v *= lerp(0.78, 1.0, Math.pow(Math.max(0, ny), 0.6))
      v += fbm(sTint, x * 1.7, z * 1.7, 2, 2.2, 0.5) * 0.05
      const r = Math.sqrt(x * x + z * z)
      if (r < BASIN_BLEND) v = lerp(0.52, v, smoothstep(BASIN_RADIUS, BASIN_BLEND, r))
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    this.mapUniforms.uHeightRange.value.set(minH, maxH)
    // procedural: no bathymetry concept — collapse the fragment shader's
    // two-stage remap to a no-op (uSeaSplit 0 = pure land, single-stage,
    // exactly like before this feature existed) and keep the ramp canvas in
    // sync (no ocean band) in case a bathymetry-ON real session ran earlier
    this.mapUniforms.uSeaLevelY.value = minH
    this.mapUniforms.uSeaSplit.value = 0
    this.rebuildRamp(params)
    this.mapUniforms.uDetailAmpWorld.value = this._detailAmpWorld(params) // packet C: track demExaggeration

    this.mesh.geometry.dispose()
    this.mesh.geometry = geo
  }

  // Bake the elevation gradient into a 1D ramp texture the shader samples.
  // With bathymetry shading on, the canvas gets an extra ocean band in
  // [0, SEA_RAMP_SPLIT] and the same 4 land stops are rescaled into
  // [SEA_RAMP_SPLIT, 1] — same land colors at the same RELATIVE positions, so
  // sampling them (via the fragment shader's rescaled landT, see above) gives
  // the identical color the classic layout gave at that land-relative
  // position. Off (or procedural — see applyBathymetryShading/
  // _rebuildSinglePlane), it's the original 4-stop gradient spanning the
  // whole canvas, unchanged.
  rebuildRamp(params) {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 1
    const ctx = c.getContext('2d')
    const grad = ctx.createLinearGradient(0, 0, 256, 0)
    const bathyOn = params.source === 'real' && !!params.bathymetryVisible
    if (bathyOn) {
      const toRamp = (t) => SEA_RAMP_SPLIT + t * (1 - SEA_RAMP_SPLIT)
      grad.addColorStop(0, params.bathyDeepColor)
      grad.addColorStop(SEA_RAMP_SPLIT * 0.55, params.bathyShallowColor)
      // coastal band: the fragment shader's depthT = (-depth/7000)^0.4 remap
      // means rampT 0.9×SEA_RAMP_SPLIT is only ~-22 m (solve depthT=0.1) — a
      // deliberately narrow sliver right next to the 0 m pin below, so this
      // pale-green stop reads as a coastline ring, not a wash over the whole
      // bathyShallowColor band further out to sea.
      grad.addColorStop(SEA_RAMP_SPLIT * 0.9, params.bathyCoastColor)
      grad.addColorStop(SEA_RAMP_SPLIT, params.gradLow) // 0 m pin — shoreline hands off to the land ramp's own start color, so the seam is seamless
      grad.addColorStop(toRamp(THREE.MathUtils.clamp(params.gradMid1Pos, 0.01, 0.98)), params.gradMid1)
      grad.addColorStop(toRamp(THREE.MathUtils.clamp(params.gradMid2Pos, 0.02, 0.99)), params.gradMid2)
      grad.addColorStop(1, params.gradHigh)
    } else {
      grad.addColorStop(0, params.gradLow)
      grad.addColorStop(THREE.MathUtils.clamp(params.gradMid1Pos, 0.01, 0.98), params.gradMid1)
      grad.addColorStop(THREE.MathUtils.clamp(params.gradMid2Pos, 0.02, 0.99), params.gradMid2)
      grad.addColorStop(1, params.gradHigh)
    }
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 256, 1)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true
    this.mapUniforms.uRampTex.value?.dispose()
    this.mapUniforms.uRampTex.value = tex
  }

  // Noise-driven roughness map (green channel is what three.js reads) + bump map
  // reused for micro relief that's finer than the vertex grid.
  rebuildRoughness(params) {
    const size = 512
    const rng = mulberry32(params.seed + 777)
    const s = new Simplex2(rng)
    const data = new Uint8Array(size * size * 4)
    const sc = params.roughnessScale
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size
        const v = y / size
        const n = fbm(s, u * sc, v * sc, 4, 2.2, 0.55)
        const n2 = fbm(s, u * sc * 7 + 13, v * sc * 7 - 5, 2, 2.2, 0.5)
        const rough = THREE.MathUtils.clamp(params.roughness + params.roughnessVariation * n, 0.04, 1)
        const bump = 0.5 + 0.5 * (n * 0.6 + n2 * 0.4)
        const i = (y * size + x) * 4
        data[i] = Math.round(bump * 255) // bump reads red-ish luminance
        data[i + 1] = Math.round(rough * 255) // roughness reads green
        data[i + 2] = Math.round(bump * 255)
        data[i + 3] = 255
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.needsUpdate = true

    const bumpTex = tex.clone()
    bumpTex.repeat.set(4, 4)
    bumpTex.needsUpdate = true

    if (this.material.roughnessMap) this.material.roughnessMap.dispose()
    if (this.material.bumpMap && this.material.bumpMap !== this.material.roughnessMap) {
      this.material.bumpMap.dispose()
    }
    this.material.roughnessMap = tex
    this.material.bumpMap = bumpTex
    this.material.bumpScale = params.bumpScale
    this.material.needsUpdate = true
  }

  updateMaterial(params) {
    this.material.color.set(params.color)
    this.material.envMapIntensity = params.envMapIntensity
    this.material.bumpScale = params.bumpScale
  }
}
