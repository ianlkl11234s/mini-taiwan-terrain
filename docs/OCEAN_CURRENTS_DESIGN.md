# Ocean Currents — design notes

Layer module: `src/engine/currents.js`. Registered as `currents` in `src/engine/index.js` (GROUP_MOVE, alongside `ships` — see rationale below). Source algorithm ported from `mini-taiwan-pulse/src/map/climateParticleLineLayer.ts`.

## Data path / decode contract

- CDN: `${VITE_TILE_BASE}/climate/currents_latest.{png,json}` (R2 `terrain-tiles/climate/`, uploaded verbatim from pulse's `public/climate/`, unchanged). Fetched once on first `currentsVisible=true` (`loadCurrentsData()` in index.js), same `{loading,loaded}` fetch-once guard as `loadRailData`.
- JSON meta: `{ width:1081, height:841, u_min, u_max, v_min, v_max, bbox:[90,-15,180,55], valid_at }`.
- PNG decoded via `<canvas>` `getImageData` (same approach as pulse's `loadClimateRaster`): R→u, G→v via linear decode against `u_min/u_max/v_min/v_max`; alpha≥128 = ocean.
- Ocean mask eroded by 1px (3×3 all-valid test) **once at decode time** into a `Uint8Array` (`CurrentsField.validMask`), not per-sample at runtime like pulse's `maskErodePx` — cheaper for a 2000-particle/frame hot loop.
- `valid_at: 2026-07-02` — snapshot is over a week stale by now. Daily-refresh cron for this asset is **not** part of this task; it is the same backlog item as pulse's own stale-snapshot problem (HANDOFF backlog, cron not yet wired). Tracked separately — this layer will pick up whatever the CDN serves whenever it's refreshed, no code change needed here.

## Advection & respawn

- N=2000 particles (fixed constant, not a style param), each a 16-point lon/lat ring buffer (15 segments).
- Per particle per frame: bilinear-sample u/v (m/s) at the current position, advect via the equirectangular approximation (`dLon = u·dtFlow/(111320·cos(lat))`, `dLat = v·dtFlow/110540`), shift the ring, prepend the new position.
- `dtFlow = dt · FLOW_SCALE · styleSchema.speed`. Respawn (fresh random ocean point inside `TAIWAN_BBOX`, lifespan 6–10s) whenever: age exceeds lifespan, the particle exits `TAIWAN_BBOX`, or a sample lands on the eroded-invalid (land) mask — covers both "climbed onto land" and "drifted out of coverage."
- Verified in-browser: sampling live particle positions against `terrain.sample()` (8,572 vertices checked) found **0** above 5m elevation — the mask/bbox gating holds up against the real DEM, not just the coarse CMEMS mask.

## flowScale tuning

Pulse's `timeScaleSeconds=86_400` (one flow-day per real second) is tuned for its continental/global mapbox view. This engine's camera sits much closer to Taiwan (K ≈ 26.9km per 56 world units), so the same multiplier would sweep a particle across the whole visible coast in a fraction of a second. Tuned by eye in-browser to `FLOW_SCALE = 9000`, giving a 1.5 m/s current roughly 100+ km of travel over its 6–10s lifespan (a meaningful chunk of the east coast) without the streak rocketing across the screen.

Caveat: the trail is a **fixed frame count** (16 points), not a fixed time window, so its on-screen length is inversely proportional to fps — at the test machine's uncapped ~120fps the streak is roughly half as long as it would be at a 60fps reference; a future 30fps ambient throttle (see below) would roughly double it. This is inherent to the ring-buffer-per-render-call design (pulse has the same property) and is noted in-code rather than "fixed," since a time-windowed trail would need a bigger rewrite (interpolating buffer contents against wall-clock time instead of frame count).

## AdditiveBlending + HDR boost (the actual visibility finding)

The brief's plan was: color = ramp(speed) faded toward black per tail segment, `AdditiveBlending`, so black contributes nothing and there's no alpha-sort fight with terrain/ships/sea. That part works as designed. What the brief did **not** anticipate: `scene.js`'s post-processing chain runs `ToneMappingEffect({ mode: ACES_FILMIC })` on a `HalfFloatType` HDR framebuffer. Verified directly in-browser: even a **full-bright, non-additive, depthTest-off, opacity-1** debug override (`rgb(1,0,1)`, no fade, no blend) came out as a barely-visible gray speck after that tonemap pass. Plain 0..1 additive color values are simply too dim to survive ACES_FILMIC's highlight compression.

Fix: `HDR_BOOST = 10` multiplies the final fade×ramp color before it's written to the vertex-color buffer, pushing values well over 1 into the HDR buffer so they still read as a bright streak after tonemapping. Tuned empirically: boost 4 was still too dim to reliably spot; boost 16 oversaturated to near-white (lost the speed-color hue); 10 is the chosen middle ground. This is a **rendering-pipeline interaction specific to this app's post-processing stack**, not a data or advection bug — logged here since it's exactly the kind of "additive blending + fog/tonemap anomaly" the brief asked to report rather than silently paper over.

Residual honesty note: streaks are still visually **subtle** — thin (1px, WebGL line width cap — see TODO below), and only ~1 particle's worth of trail is within any typical close-in camera framing at a time (2000 particles scattered across the full ~580×610km Taiwan bbox ⇒ a normal ~15–25 world-unit view framing statistically contains well under 10 segments). A wide, deliberately-aimed shot over a dense cluster (verified via a density-bucket search restricted to the east-coast lon/lat band, ~24.9°N 122.2°E) does show multiple short bright cyan/white streaks against the seafloor. Whether this reads as clearly "Kuroshio flowing north" to a casual viewer, versus a careful one who pauses and looks, is a judgment call — see the parent report's screenshots.

## Relation to the (not yet shipped) 30fps/DPR-1.0 performance package

The task brief assumed backlog #3 ("顯示效能提升包" — ambient RAF throttle to 30fps + DPR 1.0 during continuous animation) was already live and told this layer not to bypass it. **It is not implemented** — `docs/HANDOFF.md` lists it as backlog #3, explicitly "實作前先 profile 真 GPU" (profile before implementing), and grepping `index.js`'s `isAnimating()`/tick loop confirms no fps cap or `ambientThrottled` flag exists anywhere in the codebase. This layer was built and verified against the actual (uncapped) engine: it hooks into `isAnimating()` unconditionally while visible (same pattern as `typhoonVisible` and the sea-ripple `seaAnimated` toggle — continuous wall-clock ambient motion, not gated on the timeline's play/pause), and does zero per-frame work while hidden. When/if backlog #3 ships, this layer needs no changes — `ctx.dt` already comes from the shared clock and the trail-length/fps coupling noted above will just shift in the direction the perf package intends (longer, not shorter, trails at 30fps).

## Panel grouping

Registered in `GROUP_MOVE` (交通 Move), immediately after `ships` in the registration/draw order. The brief's "面板分組跟 ships/海面同組" doesn't map onto a literal single existing group: the sea-ripple ("海面") is a toggle inside the `周邊 Region` layer (`GROUP_BASE`), not a standalone panel row — there's no dedicated "Ocean/Marine" group today. `GROUP_MOVE` (where `ships` lives) was the closest literal match; flagged here as a judgment call, not a silent assumption.
