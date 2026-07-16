import { BlendFunction, Effect } from 'postprocessing'
import { Uniform, Vector2 } from 'three'

// Screen-space rain streak overlay (docs/ENVIRONMENT_DESIGN.md §8): the
// world-space rain layer (rain.js) is a camera-following LineSegments volume
// of near-vertical falling streaks — from this app's default top-down camera
// that geometry foreshortens to almost nothing (a falling line viewed end-on
// projects to a dot), so "it's raining" barely reads at the default angle no
// matter how rain.js's opacity/color/length are tuned. This Effect instead
// paints procedural streaks directly in screen space: legible at ANY camera
// pitch, at the cost of not being lit/fogged/depth-occluded like the
// world-space volume — rain.js is still the right layer for ride view / low
// camera angles where real depth cueing matters (see rain.js's module header).
//
// Effect base class blend function — CORRECTED after an empirical bug (first
// draft used the default and every pixel painted solid pale-blue, verified
// via screenshot + reading node_modules/postprocessing/build/index.js, not
// just from the JSDoc comment): the constructor's default `blendFunction` IS
// BlendFunction.NORMAL, but in this library NORMAL's GLSL is
// `mix(dst, src, opacity)` (~L2332, `normal_default`) where `opacity` is a
// single per-EFFECT scalar uniform (BlendMode constructor default 1 — see
// ~L2404) — NOT per-pixel `outputColor.a`. With opacity=1 that unconditionally
// replaces every pixel with mainImage's output regardless of alpha, which is
// exactly the solid-wash bug observed. `BlendFunction.ALPHA` (~L2269,
// `alpha_default`) is `mix(dst, src, src.a * opacity)` — that's the one that
// actually composites per-pixel like a normal "over" blend, so mainImage only
// needs to produce the streak rgb + coverage alpha and alpha=0 pixels
// correctly fall through to the original frame untouched. (scene.js's
// ExposureEffect and grain/NoiseEffect both sidestep this entirely — Exposure
// writes 100% of the frame back out so NORMAL@opacity=1 is fine for it, and
// grain drives `blendMode.opacity.value` directly as a single global knob,
// never per-pixel alpha — neither is a precedent for "per-pixel alpha with
// NORMAL", which doesn't exist in this library.)
//
// EffectPass calls `update(renderer, inputBuffer, deltaTime)` once per
// rendered frame for any Effect that overrides it (postprocessing internal,
// confirmed at node_modules/postprocessing/build/index.js ~L15436 EffectPass
// render()) — that's where uTime accumulates, no separate tickView wiring
// needed. EffectComposer.render() skips disabled passes entirely
// (`if (pass.enabled) {...}`, confirmed ~L1215), so update() never runs while
// rainOverlayPass.enabled is false: disabling really is zero render cost, not
// just zero visual output.
//
// Second empirical bug, also corrected: rainOverlayPass must sit BEFORE the
// scene.js exposure/tonemap/grade merged pass, not after it. See scene.js's
// placement comment for the full story (EffectComposer's `renderToScreen`
// ownership is static per-pass, assigned to whichever pass was added last —
// disabling THAT pass leaves nothing painting the visible canvas that frame).
// Consequence for THIS file: `inputColor` below is pre-tonemap HDR linear,
// not the final graded frame — see the lum→lumTone compression in mainImage.

const FRAGMENT = /* glsl */ `
  uniform float uIntensity;
  uniform float uTime;
  uniform vec2 uWind;

  // Cheap positional hashes (Dave Hoskins-style, public-domain technique) —
  // streak placement doesn't need typhoon.js's full Ashima simplex grid, just
  // fast, well-distributed per-cell randomness.
  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // One streak layer: uv sliced into cells.x columns x cells.y rows. Each
  // column gets a random vertical phase (colPhase) so columns don't all rain
  // in lockstep; each individual cell is present/absent via a per-cell hash
  // gated on 'density' (more cells lit = heavier rain) and draws a short
  // head-bright/tail-fade segment 'len' tall — NOT a streak spanning the
  // whole column, which would read as a static blur rather than falling drops.
  //
  // NOTE on the two smoothstep() calls below: GLSL requires edge0 < edge1 —
  // smoothstep(a, b, x) with a > b is undefined by spec (caught while writing
  // this, not just a style nit). Fades are always written as
  // 1.0 - smoothstep(0.0, span, x) (bright at 0, fading out to 'span'), never
  // the flipped argument order.
  float rainLayer(vec2 uv, vec2 cells, float speed, float len, float width, float density, float t) {
    vec2 st = uv * cells;
    float col = floor(st.x);
    float colPhase = hash11(col) * 41.0;
    // += (not -=): as t grows, a fixed screen point sees a larger st.y, i.e.
    // the sampled pattern slides toward uv.y = 0 — streaks fall DOWN the
    // screen (uv origin is bottom-left, same convention as gl_FragCoord).
    st.y += t * speed + colPhase;
    float row = floor(st.y);
    float cellRand = hash21(vec2(col, row));
    float present = step(cellRand, density);
    float x = fract(st.x) - 0.5 - (cellRand - 0.5) * 0.6; // per-cell horizontal jitter within the column
    float y = fract(st.y);
    float core = 1.0 - smoothstep(0.0, width, abs(x));
    float band = 1.0 - smoothstep(0.0, len, y);
    return present * core * band;
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    float windLen = length(uWind);
    // Shear uv by wind so streaks slant — a bigger wind vector (typhoon)
    // both steepens the angle here and speeds up the fall below; both driven
    // off the same continuous uniform rather than a hardcoded weather-id
    // switch, so any future weather preset "just works" as long as it sets
    // uWind sensibly (see rain.js's WIND_BY_WEATHER, the single source of
    // truth this uniform is synced from — index.js's applyRainOverlay()).
    vec2 suv = uv;
    suv.x += suv.y * uWind.x * 1.6;
    suv.y += uv.x * uWind.y * 0.3;

    float speedMul = 1.0 + windLen * 2.2;
    float density = mix(0.1, 0.85, clamp(uIntensity, 0.0, 1.0));

    // near -> far: smaller cells.x = fewer/wider columns = thicker streaks up
    // close; larger cells.x = many thin columns = fine distant rain. Speed
    // and length scale down together so the three layers read as separate
    // depths, not just three copies of the same pattern.
    float l1 = rainLayer(suv, vec2(22.0, 10.0), 2.4 * speedMul, 0.40, 0.16, density, uTime);
    float l2 = rainLayer(suv, vec2(38.0, 17.0), 1.5 * speedMul, 0.30, 0.10, density, uTime);
    float l3 = rainLayer(suv, vec2(62.0, 26.0), 0.9 * speedMul, 0.22, 0.06, density, uTime);
    float coverage = clamp(l1 * 0.5 + l2 * 0.35 + l3 * 0.25, 0.0, 1.0);

    // Large-scale slow gust drift — a soft coarse luminance ripple that only
    // becomes visible once windLen climbs into typhoon range (smoothstep
    // gate below), reading as gusting sheets of mist layered over the streak
    // layers rather than a separate weather-specific effect.
    vec2 gp = uv * 2.2 + uWind * 3.0 + vec2(uTime * 0.06, uTime * 0.03);
    float gust = valueNoise(gp) * 0.6 + valueNoise(gp * 2.1 + 5.0) * 0.4;
    coverage += gust * smoothstep(0.12, 0.5, windLen) * 0.12;
    coverage = clamp(coverage, 0.0, 1.0);

    // Contrast-vs-background tint: bright (paper-map) backgrounds get a dark
    // cyan-grey streak color, dark (night) backgrounds get a brighter cool
    // tone — a one-line mix() driven by measured luminance, not a weather or
    // time-of-day lookup, so it stays correct under any lighting.
    //
    // inputColor here is PRE-tonemap HDR linear (see module header — this
    // pass sits before scene.js's ToneMappingEffect), so raw luminance is
    // unbounded (bright sunlit terrain can read well above 1.0) rather than
    // the tidy 0..1 range a graded frame would give. '1.0 - exp(-lum)' is a
    // cheap Reinhard-style compressor — same shape as an ACES-ish rolloff
    // without the full curve — squashing HDR luminance back into ~0..1 so the
    // smoothstep threshold below means roughly the same thing regardless of
    // how blown-out the raw HDR value gets.
    float lum = dot(inputColor.rgb, vec3(0.299, 0.587, 0.114));
    float lumTone = 1.0 - exp(-lum);
    vec3 tintForDark = vec3(0.75, 0.85, 0.92); // brighter cool tone — reads on dark/night backgrounds
    vec3 tintForLight = vec3(0.2745, 0.3451, 0.4157); // ~#46586a dark cyan-grey — reads on light paper-map backgrounds
    vec3 tint = mix(tintForDark, tintForLight, smoothstep(0.2, 0.6, lumTone));

    // uIntensity gates final alpha directly (not just the 'density' fed into
    // rainLayer above) so intensity<=0 is visually a no-op even though the
    // real zero-cost path is rainOverlayPass.enabled=false at the composer
    // level (see module header) — this is shader-side correctness, not the
    // performance guarantee.
    float alpha = coverage * clamp(uIntensity, 0.0, 1.0) * 0.85;
    outputColor = vec4(tint, alpha);
  }
`

export class RainOverlayEffect extends Effect {
  constructor({ intensity = 0, wind = [0, 0] } = {}) {
    super('RainOverlayEffect', FRAGMENT, {
      // ALPHA, not the default NORMAL — see module header for why NORMAL's
      // per-EFFECT opacity scalar (not per-pixel outputColor.a) is the wrong
      // tool here and silently paints the whole screen solid.
      blendFunction: BlendFunction.ALPHA,
      uniforms: new Map([
        ['uIntensity', new Uniform(intensity)],
        ['uWind', new Uniform(new Vector2(wind[0], wind[1]))],
        ['uTime', new Uniform(0)],
      ]),
    })
  }

  // Advances the fall clock — see module header for why this needs no other
  // wiring (EffectPass drives it once per frame, skipped while disabled).
  update(renderer, inputBuffer, deltaTime) {
    this.uniforms.get('uTime').value += deltaTime
  }
}
