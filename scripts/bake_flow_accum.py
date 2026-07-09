#!/usr/bin/env python3
"""Physics-derived river intensity for the WHOLE ISLAND (replaces the 基隆河
regional pilot, scripts/pilot_flow_accum.py).

Assembles the project's z13 terrarium DEM tiles over the full Taiwan bbox into
one array (missing tiles = sea, exactly as the ocean surrounds the island),
runs the standard hydrology pipeline on that FULL-RESOLUTION grid (~260M cells —
trunk catchments cross the whole island, so the accumulation must see it all),
then downsamples the intensity to a single z12-resolution overlay:

    1. Priority-Flood +epsilon depression filling  (Barnes et al. 2014),
       Numba-JIT'd with a manual binary min-heap so 260M cells is tractable
       (pure-Python heapq is not — that's why the pilot stayed regional).
    2. D8 steepest-descent receivers on the filled surface.
    3. Flow accumulation (contributing area), high→low, using the heap's own
       pop order reversed (no separate 260M argsort).
    4. Braided-plain fix: the filled plains (汐止 / 台北 etc.) drain across an
       epsilon gradient whose D8 direction fans into parallel zig-zag threads.
       We damp this with a SLOPE-ADAPTIVE blur — steep terrain (金瓜石) keeps the
       pilot's crisp sigma≈0.8, near-flat terrain gets a wider blur that melts
       the zig-zag into a smooth braid — plus an optional MFD (Holmgren
       multiple-flow) accumulation that spreads flow across all lower neighbours
       (--method mfd). Default is D8 (identical acc semantics to the pilot, so
       the validated A_MIN/A_FULL/sigma carry over) + the adaptive blur.

The 0..1 intensity uses the pilot's validated ramp: sea/below-sea = 0; a log-area
ramp opens at A_MIN_KM2 and saturates at A_FULL_KM2. The result draps onto the
terrain shader (terrain.js uRiverTex) which tints valley floors blue — the river
is GLUED to the thalweg by construction, width set by physics.

Outputs (public/layers/):
    river_sim.png   grayscale intensity, one texel per z12-equivalent DEM cell,
                    cropped to the island land bbox
    river_sim.json  geographic bounds + size + parameters + the sanity stats

Idempotent. Terrarium decode mirrors src/engine/dem.js:
    m = R*256 + G + B/256 - 32768, with v < -100 treated as NODATA/sea (0 m).
"""

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
from PIL import Image
from numba import njit
from scipy.ndimage import distance_transform_edt, find_objects, gaussian_filter, label

ROOT = Path(__file__).resolve().parent.parent
TILES_DIR = ROOT / "public" / "tiles"
OUT_DIR = ROOT / "public" / "layers"

# ---------------------------------------------------------------- parameters
ZOOM = 13
# whole main island (mirrors src/engine/geo.js TAIWAN_BBOX) — tiles outside the
# island footprint simply don't exist and read as sea, so this rectangle is the
# ocean-bounded domain the flood drains to on every side.
TAIWAN_BBOX = {"minLon": 119.9, "maxLon": 122.1, "minLat": 21.8, "maxLat": 25.4}
OUT_STRIDE = 2             # z13 → z12 downsample of the OUTPUT texture (max-pool)
EPSILON = 1e-4            # +epsilon fill gradient (m) — drains flats, no sinks
SEA_LEVEL = 0.0          # <= this elevation → no river (ocean / estuary)

# river-intensity ramp (contributing area, km²) — pilot-validated, kept as-is
A_MIN_KM2 = 0.10          # upstream creeks become visible here
A_FULL_KM2 = 45.0         # trunk channels saturate here (log ramp between)

# slope-adaptive blur: crisp where it's steep, wide where it's flat (the
# braided-plain zig-zag fix). sigmas in FULL-RES z13 texels.
BLUR_SIGMA_STEEP = 0.8    # pilot value — untouched on real hillsides (金瓜石)
BLUR_SIGMA_FLAT = 2.6     # wider melt for the epsilon-filled plains (汐止/台北)
FLAT_SLOPE_LO = 0.010     # <= this local slope (m/m) → fully "flat" (max blur)
FLAT_SLOPE_HI = 0.060     # >= this → fully "steep" (pilot blur)

MFD_EXPONENT = 4.0        # Holmgren p for --method mfd (higher → more D8-like)

MPP0 = 156543.03392       # mercator meters/pixel at zoom 0
TILE_PX = 256


def lon_to_tile_x(lon, n):
    return int(math.floor((lon + 180.0) / 360.0 * n))


def lat_to_tile_y(lat, n):
    r = math.radians(lat)
    return int(math.floor((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n))


def gpx_to_lon(gx, n):
    """global z-level pixel column → longitude (linear in web-mercator X)."""
    return gx / (n * TILE_PX) * 360.0 - 180.0


def gpy_to_lat(gy, n):
    """global z-level pixel row → latitude (mercator Y is nonlinear in lat but
    UNIFORM in pixels, matching the shader's linear world-Z sampling)."""
    ty = gy / TILE_PX
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))


def _decode_terrarium(path):
    arr = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    m = arr[:, :, 0] * 256.0 + arr[:, :, 1] + arr[:, :, 2] / 256.0 - 32768.0
    m[m < -100.0] = 0.0  # NODATA hole → sea
    return m


def load_tile(tx, ty, z12_cache):
    """(256,256) float32 meters for z13 tile (tx,ty).
    Prefers the native z13 tile; falls back to the z12 parent quadrant
    (bilinear-upsampled) so INTERIOR holes in the z13 pyramid — high-mountain
    tiles that were never fetched — are filled with real (coarser) relief
    instead of a spurious sea hole in the river network. Truly-offshore tiles
    (absent at BOTH z13 and z12) return None → sea. Returns (arr, source)."""
    p13 = TILES_DIR / str(ZOOM) / str(tx) / f"{ty}.png"
    if p13.exists():
        return _decode_terrarium(p13), "z13"
    ptx, pty = tx // 2, ty // 2
    qx, qy = tx & 1, ty & 1
    key = (ptx, pty)
    if key not in z12_cache:
        p12 = TILES_DIR / "12" / str(ptx) / f"{pty}.png"
        z12_cache[key] = _decode_terrarium(p12) if p12.exists() else None
    parent = z12_cache[key]
    if parent is None:
        return None, "sea"
    half = TILE_PX // 2
    quad = parent[qy * half:(qy + 1) * half, qx * half:(qx + 1) * half]
    up = Image.fromarray(quad, mode="F").resize((TILE_PX, TILE_PX), Image.BILINEAR)
    return np.asarray(up, dtype=np.float32), "z12"


def assemble_dem(x0, x1, y0, y1):
    """Stitch tile block [x0..x1] × [y0..y1] into one float32 DEM.
    Row 0 = north (y0), col 0 = west (x0). Missing z13 tiles fall back to the
    z12 parent (see load_tile); true ocean reads as sea (0 m)."""
    w = (x1 - x0 + 1) * TILE_PX
    h = (y1 - y0 + 1) * TILE_PX
    dem = np.zeros((h, w), dtype=np.float32)
    z12_cache = {}
    n13 = n12 = 0
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            t, src = load_tile(tx, ty, z12_cache)
            if t is None:
                continue
            if src == "z13":
                n13 += 1
            else:
                n12 += 1
            ry = (ty - y0) * TILE_PX
            rx = (tx - x0) * TILE_PX
            dem[ry:ry + TILE_PX, rx:rx + TILE_PX] = t
    return dem, n13, n12


def _void_fill(sub, pit_sub, rng):
    """Fill one void component with a SMOOTH surface interpolated from its rim, so
    the invented interior drains as one coherent through-valley (natural) instead
    of the nearest-fill's rectangular Voronoi drainage. Done as a cheap coarse-
    grid Laplace solve (downsample → Jacobi relax with the valid rim fixed →
    bilinear upsample), plus a little coherent noise to seed minor tributaries.
    Coarse-grid keeps it O(crop) fast even on the big 雪山 void."""
    h, w = sub.shape
    inv = sub <= SEA_LEVEL
    inds = distance_transform_edt(inv, return_distances=False, return_indices=True)
    nearest = sub[tuple(inds)].astype(np.float32)      # nearest valid rim value
    # multi-octave coherent noise → a fractal micro-relief that makes the invented
    # interior drain as a dendritic network (a smooth fill alone drains in a
    # tell-tale parallel comb). Amplitude dominates the gentle Laplace gradient.
    r = rng.standard_normal(sub.shape).astype(np.float32)
    noise = gaussian_filter(r, 6.0) * 22.0 + gaussian_filter(r, 2.0) * 9.0
    if pit_sub.sum() < 400 or min(h, w) < 16:
        sub[pit_sub] = (gaussian_filter(nearest, 2.0) + noise)[pit_sub]  # tiny void — blur is enough
        return
    f = max(2, min(h, w) // 48)                        # coarse factor → ≤ ~48-wide grid
    work = nearest[::f, ::f].copy()
    free = inv[::f, ::f]                                # relax these; rim stays fixed
    for _ in range(200):
        nb = work.copy()
        nb[1:-1, 1:-1] = 0.25 * (work[:-2, 1:-1] + work[2:, 1:-1] + work[1:-1, :-2] + work[1:-1, 2:])
        work[free] = nb[free]
    smooth = np.asarray(Image.fromarray(work, mode="F").resize((w, h), Image.BILINEAR), dtype=np.float32)
    sub[pit_sub] = (smooth + noise)[pit_sub]


def repair_interior_pits(dem):
    """The terrarium source has NoData voids over the high central peaks that
    decode to elevation 0 — a 0 m 'sea' pit walled by 2000-3000 m ridges (e.g.
    z13 tile 6850/3521 is 97% zeros amid the 雪山 massif). Priority-Flood fills
    such a pit into one giant flat lake, leaving a river-less VOID in the map.
    Repair: any <=0 cell NOT connected to the border ocean is an interior void;
    harmonic-inpaint each void component from its rim so a natural valley threads
    through it. True coastal sea stays 0 (it reaches the array border)."""
    invalid = dem <= SEA_LEVEL
    lbl, _ = label(invalid)  # 4-connectivity
    border = np.unique(np.concatenate([lbl[0], lbl[-1], lbl[:, 0], lbl[:, -1]]))
    pits = invalid & ~np.isin(lbl, border[border != 0])
    del lbl, invalid
    npix = int(pits.sum())
    if npix == 0:
        return 0
    plbl, npc = label(pits)
    del pits
    rng = np.random.RandomState(0)  # idempotent noise
    m = 6  # margin so a valid rim is always inside each component's crop
    # find_objects returns every component's bbox in ONE pass — iterating labels
    # with `plbl == i` would rescan the 300M array per component (thousands of
    # NoData specks → a hang).
    for i, sl in enumerate(find_objects(plbl), start=1):
        if sl is None:
            continue
        ys, xs = sl
        y0, y1 = max(0, ys.start - m), min(dem.shape[0], ys.stop + m)
        x0, x1 = max(0, xs.start - m), min(dem.shape[1], xs.stop + m)
        sub = dem[y0:y1, x0:x1]
        pit_sub = plbl[y0:y1, x0:x1] == i
        _void_fill(sub, pit_sub, rng)
        dem[y0:y1, x0:x1] = sub
    return npix


# ------------------------------------------------------- Numba hydrology core
@njit(cache=True, nogil=True)
def priority_flood_epsilon(dem, eps):
    """Priority-Flood +epsilon (Barnes 2014) with a manual binary min-heap.
    Returns (filled, pop_order): a strict-monotone drainage surface (no
    depressions, no flats) and the order cells were settled (ascending filled
    elevation) — reversed, that's a valid high→low accumulation order."""
    h, w = dem.shape
    n = h * w
    df = dem.reshape(n)
    filled = np.empty(n, np.float32)
    closed = np.zeros(n, np.uint8)
    pop_order = np.empty(n, np.int32)

    hp = np.empty(n, np.float32)   # heap priorities
    hi = np.empty(n, np.int32)     # heap payload (cell index)
    hs = 0                         # heap size

    # seed every border cell (the ocean-facing domain outlets)
    for c in range(w):
        for idx in (c, (h - 1) * w + c):
            if closed[idx] == 0:
                closed[idx] = 1
                v = df[idx]
                filled[idx] = v
                hp[hs] = v; hi[hs] = idx; k = hs; hs += 1
                while k > 0:
                    p = (k - 1) >> 1
                    if hp[k] < hp[p]:
                        hp[k], hp[p] = hp[p], hp[k]; hi[k], hi[p] = hi[p], hi[k]; k = p
                    else:
                        break
    for r in range(h):
        for idx in (r * w, r * w + w - 1):
            if closed[idx] == 0:
                closed[idx] = 1
                v = df[idx]
                filled[idx] = v
                hp[hs] = v; hi[hs] = idx; k = hs; hs += 1
                while k > 0:
                    p = (k - 1) >> 1
                    if hp[k] < hp[p]:
                        hp[k], hp[p] = hp[p], hp[k]; hi[k], hi[p] = hi[p], hi[k]; k = p
                    else:
                        break

    npop = 0
    while hs > 0:
        e = hp[0]
        idx = hi[0]
        # pop root
        hs -= 1
        hp[0] = hp[hs]; hi[0] = hi[hs]
        k = 0
        while True:
            l = 2 * k + 1
            rr = l + 1
            s = k
            if l < hs and hp[l] < hp[s]:
                s = l
            if rr < hs and hp[rr] < hp[s]:
                s = rr
            if s == k:
                break
            hp[k], hp[s] = hp[s], hp[k]; hi[k], hi[s] = hi[s], hi[k]; k = s

        pop_order[npop] = idx
        npop += 1

        r = idx // w
        c = idx - r * w
        elo = e + eps
        for dr in (-1, 0, 1):
            nr = r + dr
            if nr < 0 or nr >= h:
                continue
            base = nr * w
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nc = c + dc
                if nc < 0 or nc >= w:
                    continue
                nidx = base + nc
                if closed[nidx]:
                    continue
                closed[nidx] = 1
                dn = df[nidx]
                fn = dn if dn > elo else elo
                filled[nidx] = fn
                hp[hs] = fn; hi[hs] = nidx; k = hs; hs += 1
                while k > 0:
                    p = (k - 1) >> 1
                    if hp[k] < hp[p]:
                        hp[k], hp[p] = hp[p], hp[k]; hi[k], hi[p] = hi[p], hi[k]; k = p
                    else:
                        break
    return filled, pop_order


_D = np.array([[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]], np.int64)


@njit(cache=True, nogil=True)
def d8_accumulate(filled, pop_order, h, w, cell_m):
    """D8 steepest-descent receivers + contributing-area count. Processes cells
    high→low (pop_order reversed) so each cell's full accumulation is known
    before it drains into its receiver."""
    n = h * w
    diag = cell_m * math.sqrt(2.0)
    acc = np.ones(n, np.float64)
    recv = np.empty(n, np.int64)
    # steepest-descent receiver per cell
    for idx in range(n):
        r = idx // w
        c = idx - r * w
        best = 0.0
        rec = idx
        fe = filled[idx]
        for d in range(8):
            nr = r + _D[d, 0]
            nc = c + _D[d, 1]
            if nr < 0 or nr >= h or nc < 0 or nc >= w:
                continue
            nidx = nr * w + nc
            dist = diag if (_D[d, 0] != 0 and _D[d, 1] != 0) else cell_m
            slope = (fe - filled[nidx]) / dist
            if slope > best:
                best = slope
                rec = nidx
        recv[idx] = rec
    # accumulate high→low
    for k in range(n - 1, -1, -1):
        i = pop_order[k]
        rr = recv[i]
        if rr != i:
            acc[rr] += acc[i]
    return acc


@njit(cache=True, nogil=True)
def mfd_accumulate(filled, pop_order, h, w, cell_m, p):
    """Holmgren multiple-flow-direction accumulation: each cell distributes its
    load to ALL lower neighbours, weighted by slope^p. Spreads flow across the
    epsilon-filled plains (kills the D8 zig-zag) while a high p keeps steep
    terrain near-D8. Same high→low pass (pop_order reversed)."""
    n = h * w
    diag = cell_m * math.sqrt(2.0)
    acc = np.ones(n, np.float64)
    wbuf = np.empty(8, np.float64)
    nbuf = np.empty(8, np.int64)
    for k in range(n - 1, -1, -1):
        i = pop_order[k]
        r = i // w
        c = i - r * w
        fe = filled[i]
        wsum = 0.0
        m = 0
        for d in range(8):
            nr = r + _D[d, 0]
            nc = c + _D[d, 1]
            if nr < 0 or nr >= h or nc < 0 or nc >= w:
                continue
            nidx = nr * w + nc
            drop = fe - filled[nidx]
            if drop > 0.0:
                dist = diag if (_D[d, 0] != 0 and _D[d, 1] != 0) else cell_m
                wgt = (drop / dist) ** p
                wbuf[m] = wgt
                nbuf[m] = nidx
                wsum += wgt
                m += 1
        if wsum > 0.0:
            a = acc[i]
            for j in range(m):
                acc[nbuf[j]] += a * wbuf[j] / wsum
    return acc


# ------------------------------------------------------------------ pipeline
def block_max(a, k):
    if k == 1:
        return a
    h, w = a.shape
    a = a[: h // k * k, : w // k * k]
    return a.reshape(h // k, k, w // k, k).max(axis=(1, 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--method", choices=["d8", "mfd"], default="d8")
    ap.add_argument("--mfd-exp", type=float, default=MFD_EXPONENT)
    ap.add_argument("--out", default="river_sim")
    ap.add_argument("--minlon", type=float, default=TAIWAN_BBOX["minLon"])
    ap.add_argument("--maxlon", type=float, default=TAIWAN_BBOX["maxLon"])
    ap.add_argument("--minlat", type=float, default=TAIWAN_BBOX["minLat"])
    ap.add_argument("--maxlat", type=float, default=TAIWAN_BBOX["maxLat"])
    ap.add_argument("--a-min", type=float, default=A_MIN_KM2)
    ap.add_argument("--a-full", type=float, default=A_FULL_KM2)
    args = ap.parse_args()

    t_all = time.time()
    n = 2 ** ZOOM

    x0 = lon_to_tile_x(args.minlon, n)
    x1 = lon_to_tile_x(args.maxlon, n)
    y0 = lat_to_tile_y(args.maxlat, n)   # north
    y1 = lat_to_tile_y(args.minlat, n)   # south
    n_tiles = (x1 - x0 + 1) * (y1 - y0 + 1)
    print(f"[flow] z{ZOOM} island tiles x{x0}..{x1} y{y0}..{y1} "
          f"= {x1 - x0 + 1}×{y1 - y0 + 1} = {n_tiles} tiles")

    t = time.time()
    dem, n13, n12 = assemble_dem(x0, x1, y0, y1)
    h, w = dem.shape
    land = int(np.count_nonzero(dem > SEA_LEVEL))
    print(f"[flow] DEM {w}×{h} = {w * h:,} cells, {n13} z13 tiles + {n12} z12-filled holes "
          f"({n13 + n12}/{n_tiles}), {land:,} land cells ({100 * land / (w * h):.1f}%) "
          f"in {time.time() - t:.1f}s")

    t = time.time()
    pit_px = repair_interior_pits(dem)
    print(f"[flow] repaired {pit_px:,} interior NoData-void cells (high-peak 0 m pits) "
          f"in {time.time() - t:.1f}s")

    lat_c = (args.minlat + args.maxlat) / 2
    cell_m = (MPP0 / n) * math.cos(math.radians(lat_c))
    cell_km2 = (cell_m * cell_m) / 1e6
    print(f"[flow] cell ≈ {cell_m:.2f} m ({cell_km2 * 1e6:.0f} m²/cell)")

    t = time.time()
    filled, pop_order = priority_flood_epsilon(dem, np.float32(EPSILON))
    raised = int(np.count_nonzero(filled > dem.reshape(-1) + 1e-3))
    print(f"[flow] priority-flood+ε fill in {time.time() - t:.1f}s (raised {raised:,} cells)")

    t = time.time()
    if args.method == "mfd":
        acc = mfd_accumulate(filled, pop_order, h, w, cell_m, args.mfd_exp)
        print(f"[flow] MFD accumulation (p={args.mfd_exp}) in {time.time() - t:.1f}s")
    else:
        acc = d8_accumulate(filled, pop_order, h, w, cell_m)
        print(f"[flow] D8 accumulation in {time.time() - t:.1f}s")
    del filled, pop_order
    area_km2 = (acc.reshape(h, w) * cell_km2)
    del acc
    max_km2 = float(area_km2.max())
    # sanity: the single largest catchment (濁水溪 / 高屏溪 ≈ 3000 km²)
    print(f"[flow] max catchment {max_km2:,.0f} km²  (sanity: 濁水溪/高屏溪 ≈ 3000 km²)")

    # intensity: log-area ramp (pilot-validated), gated by sea level
    la_min, la_full = math.log10(args.a_min), math.log10(args.a_full)
    ll = np.log10(np.maximum(area_km2, 1e-6))
    tnorm = np.clip((ll - la_min) / (la_full - la_min), 0.0, 1.0)
    intensity = (tnorm * tnorm * (3.0 - 2.0 * tnorm)).astype(np.float32)   # smoothstep
    del area_km2, ll, tnorm

    # slope-adaptive blur — crisp on hillsides, wide on the epsilon-filled plains.
    # local slope from the ORIGINAL dem (central differences, m/m).
    gy, gx = np.gradient(dem)
    slope = np.hypot(gx, gy) / cell_m
    flatw = np.clip((FLAT_SLOPE_HI - slope) / (FLAT_SLOPE_HI - FLAT_SLOPE_LO), 0.0, 1.0).astype(np.float32)
    del gy, gx, slope
    blur_crisp = gaussian_filter(intensity, BLUR_SIGMA_STEEP)
    blur_flat = gaussian_filter(intensity, BLUR_SIGMA_FLAT)
    intensity = blur_crisp * (1.0 - flatw) + blur_flat * flatw
    del blur_crisp, blur_flat, flatw
    intensity[dem <= SEA_LEVEL] = 0.0        # no river over the sea (post-blur)

    # downsample intensity to the z12-equivalent output texture (max-pool keeps
    # thin channels), then crop to the island land bbox so the texture is tight.
    out = block_max(intensity, OUT_STRIDE)
    landmask = (block_max((dem > SEA_LEVEL).astype(np.float32), OUT_STRIDE) > 0.5)
    del intensity, dem
    rows = np.where(landmask.any(axis=1))[0]
    cols = np.where(landmask.any(axis=0))[0]
    r0, r1 = int(rows[0]), int(rows[-1]) + 1
    c0, c1 = int(cols[0]), int(cols[-1]) + 1
    crop = out[r0:r1, c0:c1]
    ch, cw = crop.shape

    # geographic bbox of the crop — map downsampled-pixel EDGES back through the
    # full-res global-pixel grid (col edge is linear in lon; row edge uniform in
    # mercator-Y, matching the shader's linear world-Z sampling).
    gx0 = x0 * TILE_PX
    gy0 = y0 * TILE_PX
    bbox = {
        "minLon": gpx_to_lon(gx0 + c0 * OUT_STRIDE, n),
        "maxLon": gpx_to_lon(gx0 + c1 * OUT_STRIDE, n),
        "maxLat": gpy_to_lat(gy0 + r0 * OUT_STRIDE, n),
        "minLat": gpy_to_lat(gy0 + r1 * OUT_STRIDE, n),
    }

    river_cells = int(np.count_nonzero(crop > 0.02))
    print(f"[flow] output {cw}×{ch} = {cw * ch:,} texels, "
          f"river texels (>0.02) = {river_cells:,} ({100 * river_cells / (cw * ch):.2f}%)")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img = (np.clip(crop, 0, 1) * 255.0 + 0.5).astype(np.uint8)
    png_path = OUT_DIR / f"{args.out}.png"
    Image.fromarray(img, mode="L").save(png_path, optimize=True)
    png_mb = png_path.stat().st_size / 1e6

    meta = {
        "bbox": bbox,
        "size": {"w": cw, "h": ch},
        "zoom": ZOOM,
        "png": f"/layers/{args.out}.png",
        "params": {
            "method": args.method,
            "mfd_exp": args.mfd_exp if args.method == "mfd" else None,
            "out_stride": OUT_STRIDE,
            "cell_m": round(cell_m, 2),
            "a_min_km2": args.a_min,
            "a_full_km2": args.a_full,
            "epsilon": EPSILON,
            "blur_sigma_steep": BLUR_SIGMA_STEEP,
            "blur_sigma_flat": BLUR_SIGMA_FLAT,
        },
        "stats": {
            "demCells": w * h,
            "landCellsPct": round(100 * land / (w * h), 1),
            "maxCatchmentKm2": round(max_km2, 1),
            "riverTexelsPct": round(100 * river_cells / (cw * ch), 2),
        },
        "note": "row 0 = north, col 0 = west; grayscale = river intensity 0..1",
    }
    (OUT_DIR / f"{args.out}.json").write_text(json.dumps(meta, indent=2))
    print(f"[flow] wrote {png_path.name} ({png_mb:.2f} MB) + {args.out}.json  bbox={bbox}")
    print(f"[flow] TOTAL {time.time() - t_all:.1f}s")


if __name__ == "__main__":
    main()
