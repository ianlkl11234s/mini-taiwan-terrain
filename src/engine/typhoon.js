import * as THREE from 'three'
import { metersToWorldY } from './geo.js'

// Procedural typhoon — a purely visual (no data) storm system centred on an eye
// coordinate over the ocean. Unlike a flat sprite, the cloud is a DISPLACED mesh:
// a low-frequency version of the storm field pushes the vertices up (eyewall
// towers highest, eye carved into a pit, rainbands ridged), and per-vertex
// normals from that height field are lit by the scene sun — so it reads as a 3D
// mass, not a decal. The fragment shader rebuilds the field at pixel resolution
// for crisp structure modelled on a real cyclone:
//
//   tight log-spiral rainbands with transparent gaps (ocean shows through)
//   + central dense overcast (CDO) core          + bright eyewall ring / dark eye
//   + noise sampled in (spiral-phase, radius) space → sheared filament streaks
//   + density-driven alpha (thin cloud translucent, dense cloud opaque white)
//
// Standard Layer interface (see layers.js) → registers into the LayerManager and
// appears in the Layers panel automatically. tickView() advances the swirl; the
// engine keeps the loop non-idle while the layer is visible (isAnimating()).

const ALT_M = 11000 // cloud-sheet base altitude above sea level (metres)
const VISIBLE_FRAC = 0.72 // radial fade midpoint → visible disk ≈ this × half-plane
const SEGMENTS = 256 // plane subdivisions (relief detail); E = finite-diff step
const E = (1.5 / SEGMENTS).toFixed(6)

// Shared storm field + Ashima 2D simplex noise (webgl-noise, MIT). stormField()
// returns density 0..1 and writes a relief height; both shader stages call the
// SAME function (detail flag = cheap 1-octave for the vertex displacement, full
// warped filaments for the fragment) so the lit geometry and textured surface
// always agree. Modelled on a real cyclone: tight log-spiral rainbands with
// transparent gaps, a solid central dense overcast, a small dark eye ringed by a
// bright gaussian eyewall, wavenumber-1 asymmetry + a comma tail, and
// anisotropic ridged noise for wind-sheared filaments.
const COMMON = /* glsl */ `
  uniform float uTime, uSpin, uEyeSize, uArms, uWind, uBandSharp, uHeight;

  vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec2 mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec3 permute(vec3 x){ return mod289(((x*34.0)+1.0)*x); }
  float snoise(vec2 v){
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0,0.0) : vec2(0.0,1.0);
    vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
  float fbm(vec2 x){
    float v = 0.0, a = 0.5;
    mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
    for (int i = 0; i < 5; i++) { v += a * snoise(x); x = rot * x * 2.0; a *= 0.5; }
    return v;
  }
  float angDiff(float a, float b){ float d = a - b; return atan(sin(d), cos(d)); }

  // density 0..1 at plane-uv; writes relief height (0..~1.6) via out param.
  // detail>0.5 → warped ridged filaments (fragment); else 1 cheap octave (vertex).
  // Every smoothstep keeps edge0 < edge1 (reversed edges are undefined in GLSL
  // and read as 0 on some drivers, which silently blanks the layer).
  float stormField(vec2 uv, out float height, float detail){
    vec2 p = (uv - 0.5) * 2.0;
    float r = length(p);
    height = 0.0;
    if (r > 1.0) return 0.0;
    float ang0 = atan(p.y, p.x);                            // fixed-frame angle
    float omega = uSpin * (0.12 + 1.0 / (r * 3.0 + 0.35));  // differential rotation
    float ang = ang0 - uTime * omega;                       // cyclonic swirl
    float logr = log(r + 0.05);
    float phase = ang * uArms - uWind * logr;               // log-spiral arm phase

    // sheared filaments: strongly anisotropic (phase,radius) domain, warped, ridged
    vec2 q = vec2(phase * 0.15, r * 3.0);
    float fil;
    if (detail > 0.5) {
      vec2 warp = vec2(fbm(q + 13.7), fbm(q + 51.3));
      float nn = fbm(q + warp + vec2(uTime * 0.02, 0.0));
      fil = pow(clamp(1.0 - abs(nn), 0.0, 1.0), 2.2);       // ridged streaks
    } else {
      fil = fbm(q) * 0.5 + 0.5;                             // cheap, smooth
    }

    // spiral rainbands: narrow bright arms, deep transparent gaps
    float band = smoothstep(0.30, 0.75, pow(0.5 + 0.5 * sin(phase), uBandSharp));

    float re = uEyeSize;
    float eye  = smoothstep(re * 0.6, re, r);                          // hard clear eye
    float ring = exp(-pow((r - re) / (0.28 * re), 2.0));               // gaussian eyewall
    float cdo  = 1.0 - smoothstep(re * 1.5, 0.32, r);                  // dense core 1→0
    float bandZone = smoothstep(0.16, 0.42, r);                       // core solid → outer banded

    // wavenumber-1 asymmetry + a comma tail on one (slowly precessing) flank
    float tailDir = uTime * 0.04;
    float asym = 0.70 + 0.30 * sin(ang0 - 0.5 * r - tailDir);
    float tail = 0.32 * exp(-pow(angDiff(ang0, tailDir) / 0.7, 2.0));
    float outer = 1.0 - smoothstep(${VISIBLE_FRAC.toFixed(2)} * (1.0 + tail), 1.0, r);

    float cloud = mix(fil, fil * band, bandZone);            // solid core, banded rim
    cloud = mix(cloud, max(cloud, 0.9), cdo * 0.85);         // fill the CDO shield
    cloud *= asym;                                           // one flank heavier
    cloud += ring * 0.9 * fil;                               // pile onto the eyewall
    cloud *= eye;                                            // punch the eye clear
    cloud *= outer;                                          // disk fade + tail

    height = (cloud * 0.6 + ring * 1.0) * eye;               // eyewall tallest, eye a pit
    height = clamp(height, 0.0, 1.6);
    return clamp(cloud, 0.0, 1.0);
  }
`

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  ${COMMON}
  // local displaced position for a uv (plane spans -1..1 in x; rotateX put the
  // original +y on world -z; group.scale.y is 1 so uHeight is world units)
  vec3 stormLocal(vec2 uv){
    float h; stormField(uv, h, 0.0); // cheap 1-octave field for the displacement
    return vec3(uv.x * 2.0 - 1.0, h * uHeight, -(uv.y * 2.0 - 1.0));
  }
  void main(){
    vUv = uv;
    vec3 P0 = stormLocal(uv);
    vec3 Pu = stormLocal(uv + vec2(${E}, 0.0));
    vec3 Pv = stormLocal(uv + vec2(0.0, ${E}));
    vec4 w0 = modelMatrix * vec4(P0, 1.0);
    vec3 wu = (modelMatrix * vec4(Pu, 1.0)).xyz;
    vec3 wv = (modelMatrix * vec4(Pv, 1.0)).xyz;
    vec3 nrm = normalize(cross(wu - w0.xyz, wv - w0.xyz));
    if (nrm.y < 0.0) nrm = -nrm; // face up
    vNormal = nrm;
    gl_Position = projectionMatrix * viewMatrix * w0;
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vNormal;
  uniform float uOpacity;
  uniform float uDensity;  // fill/density boost: 1 = raw, higher fills band gaps
  uniform vec3  uColor;    // cloud tint (near-white for realism)
  uniform vec3  uLightDir; // world-space sun direction (matches the scene sun)
  ${COMMON}
  void main(){
    float h;
    float density = stormField(vUv, h, 1.0); // full warped-filament field

    // faint outer cirrus veil — a slow, independent thin layer so the storm has
    // the wispy translucent fringe real satellite imagery shows in the gaps
    vec2 pp = (vUv - 0.5) * 2.0;
    float rr = length(pp);
    float a2 = atan(pp.y, pp.x) - uTime * 0.02;
    float vn = fbm(vec2((a2 * 2.0 - 4.0 * log(rr + 0.05)) * 0.2, rr * 1.7)) * 0.5 + 0.5;
    float veil = vn * smoothstep(0.22, 0.7, rr) * (1.0 - smoothstep(0.85, 1.0, rr));

    // thicken / densify the rainbands + CDO (not the veil): layering the cloud
    // onto itself uDensity times fills the thin band gaps toward opaque while the
    // punched-clear eye stays 0 and the faint outer veil stays faint
    density = 1.0 - pow(1.0 - clamp(density, 0.0, 1.0), uDensity);
    float dens = max(density, veil * 0.32);
    float alpha = dens * uOpacity;
    if (alpha < 0.004) discard; // eye + deep band gaps stay transparent

    vec3 N = normalize(vNormal);
    float ndl = dot(N, normalize(uLightDir)) * 0.5 + 0.5; // half-Lambert (soft)
    float lit = mix(0.42, 1.28, ndl);
    float hs  = mix(0.72, 1.12, clamp(h, 0.0, 1.0));       // towers bright, hollows dark

    // bright eyewall ring (recomputed for the colour boost)
    float ring = exp(-pow((rr - uEyeSize) / (0.28 * uEyeSize), 2.0));

    vec3 base = mix(uColor * 0.66, uColor, smoothstep(0.10, 0.85, dens));
    vec3 col = base * lit * hs;
    col += uColor * pow(ndl, 4.0) * 0.12;                  // silver lining on lit rims
    col += uColor * ring * 0.35;                           // luminous eyewall

    gl_FragColor = vec4(col, alpha);
  }
`

export function createTyphoonLayer(params) {
  const group = new THREE.Group()
  group.visible = false

  const uniforms = {
    uTime: { value: 0 },
    uOpacity: { value: params.typhoonOpacity },
    uDensity: { value: params.typhoonDensity },
    uSpin: { value: params.typhoonSpin },
    uEyeSize: { value: params.typhoonEyeSize },
    uHeight: { value: params.typhoonHeight },
    uColor: { value: new THREE.Color(params.typhoonColor) },
    uLightDir: { value: new THREE.Vector3(-0.4, 0.85, -0.3).normalize() },
    // structural constants (tuned; not exposed in the panel)
    uArms: { value: 2.0 },
    uWind: { value: 4.5 }, // log-spiral pitch (lower = looser, more "winding in" arms)
    uBandSharp: { value: 3.0 }, // rainband sharpness (higher = narrower arms, wider gaps)
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false, // the storm is its own atmosphere — don't let scene fog eat it
  })

  // subdivided unit plane (2×2 → vUv 0..1); world size comes from group.scale,
  // vertical relief from the shader displacement (group.scale.y stays 1)
  const geo = new THREE.PlaneGeometry(2, 2, SEGMENTS, SEGMENTS)
  geo.rotateX(-Math.PI / 2) // lie flat, normal +Y
  const mesh = new THREE.Mesh(geo, material)
  mesh.renderOrder = 6
  mesh.frustumCulled = false
  group.add(mesh)

  let hf = null

  function gate() {
    return params.source === 'real' && !!hf && params.typhoonVisible
  }

  // place + scale the sheet: centre on the eye lon/lat, base altitude ALT_M,
  // radius from typhoonRadiusKm (world units via the projection's K), enlarged so
  // the visible disk (after the radial fade) matches the requested radius.
  function place() {
    if (!hf) return
    const proj = hf.projection
    const w = proj.lonLatToWorld(params.typhoonLon, params.typhoonLat)
    const y = metersToWorldY(hf, ALT_M, params.demExaggeration)
    group.position.set(w.x, y, w.z)
    const halfUnits = (params.typhoonRadiusKm * 1000 * proj.K) / VISIBLE_FRAC
    group.scale.set(halfUnits, 1, halfUnits) // plane is 2 wide → half = scale
  }

  // light the clouds with the same sun the terrain uses, so they sit in the scene
  function applyLight() {
    const az = (params.sunAzimuth * Math.PI) / 180
    const el = (params.sunElevation * Math.PI) / 180
    uniforms.uLightDir.value.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize()
  }

  function applyStyle() {
    uniforms.uOpacity.value = params.typhoonOpacity
    uniforms.uDensity.value = params.typhoonDensity
    uniforms.uSpin.value = params.typhoonSpin
    uniforms.uEyeSize.value = params.typhoonEyeSize
    uniforms.uHeight.value = params.typhoonHeight
    uniforms.uColor.value.set(params.typhoonColor)
    applyLight()
  }

  return {
    id: 'typhoon',
    kind: 'area',
    label: 'Typhoon',
    rowLabel: '颱風 Typhoon',
    object3d: group,
    visibleParam: 'typhoonVisible',
    paramMap: {
      visible: 'typhoonVisible',
      opacity: 'typhoonOpacity',
      density: 'typhoonDensity',
      radiusKm: 'typhoonRadiusKm',
      spin: 'typhoonSpin',
      eye: 'typhoonEyeSize',
      relief: 'typhoonHeight',
      lon: 'typhoonLon',
      lat: 'typhoonLat',
      color: 'typhoonColor',
    },

    build() {},

    update(ctx) {
      hf = ctx.heightField
      const show = gate()
      if (show) {
        applyStyle()
        place()
      }
      group.visible = show
    },

    // advance the swirl every non-idle frame (engine keeps the loop alive while
    // the layer is visible — see isAnimating())
    tickView(ctx) {
      if (group.visible) uniforms.uTime.value += ctx.dt
    },

    describe() {
      return {
        id: 'typhoon',
        kind: 'area',
        label: 'Typhoon',
        rowLabel: '颱風 Typhoon',
        count: 1,
        visible: params.typhoonVisible,
        styleSchema: {
          radiusKm: { type: 'slider', label: '暴風半徑 Radius km', min: 80, max: 600, step: 10, format: (v) => `${Math.round(v)}km` },
          density: { type: 'slider', label: '密度 Density', min: 1, max: 4, step: 0.1, format: (v) => v.toFixed(1) },
          relief: { type: 'slider', label: '立體 Relief', min: 0, max: 80, step: 1, format: (v) => `${Math.round(v)}` },
          spin: { type: 'slider', label: '旋轉 Spin', min: 0, max: 0.4, step: 0.005, format: (v) => v.toFixed(3) },
          eye: { type: 'slider', label: '風眼 Eye', min: 0.02, max: 0.25, step: 0.005, format: (v) => v.toFixed(3) },
          opacity: { type: 'slider', label: '不透明度 Opacity', min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2) },
          lon: { type: 'slider', label: '眼 經度 Lon', min: 119, max: 125, step: 0.05, format: (v) => v.toFixed(2) },
          lat: { type: 'slider', label: '眼 緯度 Lat', min: 20, max: 26, step: 0.05, format: (v) => v.toFixed(2) },
          color: { type: 'color', label: '雲色 Color' },
        },
        style: {
          radiusKm: params.typhoonRadiusKm,
          density: params.typhoonDensity,
          relief: params.typhoonHeight,
          spin: params.typhoonSpin,
          eye: params.typhoonEyeSize,
          opacity: params.typhoonOpacity,
          lon: params.typhoonLon,
          lat: params.typhoonLat,
          color: params.typhoonColor,
        },
      }
    },

    dispose() {
      geo.dispose()
      material.dispose()
    },
  }
}
