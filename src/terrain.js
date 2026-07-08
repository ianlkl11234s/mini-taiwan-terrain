import * as THREE from 'three'
import { Simplex2, mulberry32, fbm, ridged, smoothstep, lerp } from './noise.js'

export const TERRAIN_SIZE = 56
export const BASIN_RADIUS = 6.6 // flat excavation floor
export const BASIN_BLEND = 9.0 // where flat floor blends back into mountains
export const FLOOR_Y = -0.35

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
      uRampTex: { value: null },
      uHeightContrast: { value: params.heightContrast },
      uHeightPivot: { value: params.heightPivot },
      uSlopeTint: { value: params.slopeTint },
      uContourColor: { value: new THREE.Color(params.contourColor) },
      uScanT: { value: -1 }, // scan progress 0..1, negative = inactive
      uScanColor: { value: new THREE.Color(params.scanColor) },
      uScanWidth: { value: params.scanWidth },
      uScanBlur: { value: params.scanBlur },
      uScanDispH: { value: params.scanDispHeight },
      uScanDispW: { value: params.scanDispFalloff },
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
  float dV = length(wPre.xz);
  float RV = uScanT * 42.0;
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
uniform sampler2D uRampTex;
uniform float uHeightContrast;
uniform float uHeightPivot;
uniform float uSlopeTint;
uniform vec3 uContourColor;
uniform float uScanT;
uniform vec3 uScanColor;
uniform float uScanWidth;
uniform float uScanBlur;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  // --- hypsometric tint: user gradient sampled by height, contrast expanded around a pivot
  float hNorm = clamp((vWorldPos.y - uHeightRange.x) / max(uHeightRange.y - uHeightRange.x, 1e-4), 0.0, 1.0);
  float rampT = clamp(0.5 + (hNorm - uHeightPivot) * uHeightContrast, 0.0, 1.0);
  vec3 ramp = texture2D(uRampTex, vec2(rampT, 0.5)).rgb;
  // smooth interpolated normal (world space) — screen-space derivatives look blotchy
  vec3 wN = inverseTransformDirection(normalize(vNormal), viewMatrix);
  float slope = 1.0 - clamp(wN.y, 0.0, 1.0);
  ramp = mix(ramp, vec3(0.42, 0.31, 0.21), smoothstep(0.3, 0.8, slope) * uSlopeTint);
  // keep the lighting/AO shading from the base surface but let the gradient own the color
  float luma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, ramp * clamp(luma * 2.4, 0.2, 1.4), uTint);

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
    float dScan = length(vWorldPos.xz);
    float Rs = uScanT * 42.0;
    float aaS = fwidth(dScan);
    float edgeS = abs(dScan - Rs) - uScanWidth * 0.5;
    float bandS = 1.0 - smoothstep(0.0, max(uScanBlur, aaS), edgeS);
    float fadeS = 1.0 - smoothstep(0.6, 1.0, uScanT);
    diffuseColor.rgb = mix(diffuseColor.rgb, uScanColor, clamp(bandS * fadeS, 0.0, 0.95));
  }
}`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
// radar scan ripple: an emissive wavefront expanding from the center across the relief
if (uScanT >= 0.0) {
  float d = length(vWorldPos.xz);
  float R = uScanT * 42.0;
  float edgeE = abs(d - R) - uScanWidth * 0.5;
  float band = 1.0 - smoothstep(0.0, max(uScanBlur, fwidth(d)), edgeE);
  float fade = 1.0 - smoothstep(0.6, 1.0, uScanT);
  totalEmissiveRadiance += uScanColor * band * fade * 0.5;
}`
        )
    }
    // group holds both terrain forms; main.js adds terrain.group to the scene.
    // - procedural mode: the legacy single 56×56 plane (this.mesh)
    // - real mode: a grid of chunk meshes, one per map tile (this.chunkGroup)
    // All chunks share this.material — one shader, world-space overlays, so
    // contours / grid / hypsometric tint run continuously across chunk borders.
    this.group = new THREE.Group()
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.mesh.receiveShadow = true
    this.mesh.castShadow = true
    this.group.add(this.mesh)
    this.chunkGroup = new THREE.Group()
    this.group.add(this.chunkGroup)
    this.chunks = []
    this.heightField = null // real-world height source (geo.js), set via setHeightField()
    this.rebuild(params)
    this.rebuildRoughness(params)
  }

  setHeightField(heightField) {
    this.heightField = heightField
  }

  // scene height → display elevation in feet (real when a DEM drives the terrain)
  heightToFeet(h) {
    return this._h2ft ? this._h2ft(h) : Math.round(4800 + h * 420)
  }

  // Sampler over the real-world height field: world xz → meters → scene units.
  // Heights are datum-shifted (mosaic mean → y 0) so framing, fog and camera
  // keep working; XY and Y share the projection's K so proportions are true.
  _makeDemSampler(params) {
    const hf = this.heightField
    const scale = hf.projection.K * params.demExaggeration
    const datumM = hf.dem.meanM
    this._h2ft = (h) => Math.round((h / scale + datumM) * 3.28084)

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
    if (params.source === 'real' && this.heightField) {
      this.mesh.visible = false
      this._rebuildChunks(params, sample)
    } else {
      this._disposeChunks()
      this.mesh.visible = true
      this._rebuildSinglePlane(params, sample)
    }
  }

  _disposeChunks() {
    for (const chunk of this.chunks) {
      this.chunkGroup.remove(chunk)
      chunk.geometry.dispose() // material is shared — never disposed here
    }
    this.chunks = []
  }

  // Real-world mode: one mesh per map tile, all sampling the same height
  // field, all sharing the single material. Vertex normals come from central
  // differences of the height sampler (not computeVertexNormals), so normals
  // are identical on both sides of a chunk border — no lighting seam.
  _rebuildChunks(params, sample) {
    this._disposeChunks()
    const hf = this.heightField
    const proj = hf.projection
    const res = params.chunkRes
    const size = proj.tileWorldSize
    const eps = size / res // normal probe distance = one grid cell
    const scale = proj.K * params.demExaggeration
    const datumM = hf.dem.meanM

    // global height range straight off the mosaic — one range for every chunk
    // keeps the hypsometric ramp and vertex tint continuous across borders
    const minH = (hf.dem.minM - datumM) * scale
    const maxH = (hf.dem.maxM - datumM) * scale
    this.mapUniforms.uHeightRange.value.set(minH, maxH)
    const span = Math.max(1e-5, maxH - minH)
    const sTint = new Simplex2(mulberry32(params.seed + 101))

    for (let ty = hf.tileY0; ty < hf.tileY0 + hf.tilesAcross; ty++) {
      for (let tx = hf.tileX0; tx < hf.tileX0 + hf.tilesAcross; tx++) {
        const center = proj.tileCenterWorld(tx, ty)
        const geo = new THREE.PlaneGeometry(size, size, res, res)
        geo.rotateX(-Math.PI / 2)

        const arr = geo.attributes.position.array
        const count = geo.attributes.position.count
        const normals = new Float32Array(count * 3)
        const colors = new Float32Array(count * 3)
        for (let i = 0; i < count; i++) {
          const wx = center.x + arr[i * 3]
          const wz = center.z + arr[i * 3 + 2]
          const h = sample(wx, wz)
          arr[i * 3 + 1] = h

          // seam-free normal: central differences of the global sampler
          const nx = sample(wx - eps, wz) - sample(wx + eps, wz)
          const nz = sample(wx, wz - eps) - sample(wx, wz + eps)
          const inv = 1 / Math.hypot(nx, 2 * eps, nz)
          normals[i * 3] = nx * inv
          normals[i * 3 + 1] = 2 * eps * inv
          normals[i * 3 + 2] = nz * inv

          // vertex tint: height-graded value + slope darkening + grain jitter
          // (world-coherent, so it too runs continuously across chunks)
          const hn = (h - minH) / span
          let v = lerp(0.62, 0.95, Math.pow(hn, 0.85))
          v *= lerp(0.78, 1.0, Math.pow(Math.max(0, normals[i * 3 + 1]), 0.6))
          v += fbm(sTint, wx * 1.7, wz * 1.7, 2, 2.2, 0.5) * 0.05
          colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v
        }
        geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

        const chunk = new THREE.Mesh(geo, this.material)
        chunk.position.set(center.x, 0, center.z)
        chunk.receiveShadow = true
        chunk.castShadow = true
        this.chunkGroup.add(chunk)
        this.chunks.push(chunk)
      }
    }
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

    this.mesh.geometry.dispose()
    this.mesh.geometry = geo
  }

  // Bake the 4-stop elevation gradient into a 1D ramp texture the shader samples.
  rebuildRamp(params) {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 1
    const ctx = c.getContext('2d')
    const grad = ctx.createLinearGradient(0, 0, 256, 0)
    grad.addColorStop(0, params.gradLow)
    grad.addColorStop(THREE.MathUtils.clamp(params.gradMid1Pos, 0.01, 0.98), params.gradMid1)
    grad.addColorStop(THREE.MathUtils.clamp(params.gradMid2Pos, 0.02, 0.99), params.gradMid2)
    grad.addColorStop(1, params.gradHigh)
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
