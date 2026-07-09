#!/usr/bin/env python3
"""Physics-derived river intensity for a REGIONAL PILOT (基隆河流域 + 金瓜石).

Reads the project's own z13 terrarium DEM tiles over the pilot bbox (plus a
one-tile buffer so border flow directions are sane), then runs the standard
hydrology pipeline entirely on that DEM:

    1. Priority-Flood +epsilon depression filling  (Barnes et al. 2014)
    2. D8 steepest-descent flow direction
    3. Flow accumulation (contributing area) in one descending-elevation pass

The contributing area is turned into a 0-255 "river intensity" bake:
sea/below-sea = 0; a log-area ramp opens at a catchment threshold and saturates
at a trunk-river area; the bbox edge fades out so the test region has no hard
border. The result draps onto the terrain shader (terrain.js uRiverTex) which
tints valley floors blue — so the river is GLUED to the thalweg by construction
and its width is set by physics, not by an official survey line.

Outputs (public/layers/):
    river_sim_pilot.png   grayscale intensity, one texel per (strided) DEM cell
    river_sim_pilot.json  geographic bounds + size + the parameters used

Terrarium decode mirrors src/engine/dem.js:  m = R*256 + G + B/256 - 32768,
with v < -100 treated as a NODATA / sea hole (0 m).
"""

import heapq
import json
import math
import time
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parent.parent
TILES_DIR = ROOT / "public" / "tiles"
OUT_DIR = ROOT / "public" / "layers"

# ---------------------------------------------------------------- parameters
ZOOM = 13
BBOX = {"minLon": 121.50, "maxLon": 121.95, "minLat": 24.95, "maxLat": 25.20}
BUFFER_TILES = 1            # ring of tiles kept OUTSIDE the bbox for border flow
STRIDE = 1                  # block-mean DEM downsample (1 = full z13 ~17 m/px)
EPSILON = 1e-4              # +epsilon fill gradient (m) — drains flats, no sinks
SEA_LEVEL = 0.0            # <= this elevation → no river (ocean / estuary)

# river-intensity ramp (contributing area, km²): opens at A_MIN, full at A_FULL
A_MIN_KM2 = 0.10            # upstream creeks become visible here
A_FULL_KM2 = 45.0          # trunk channels saturate here (log ramp between)
EDGE_FADE_PX = 40           # bbox-edge fade-out width (texels) → no hard border

MPP0 = 156543.03392         # mercator meters/pixel at zoom 0
TILE_PX = 256


def lon_to_tile_x(lon, n):
    return int(math.floor((lon + 180.0) / 360.0 * n))


def lat_to_tile_y(lat, n):
    r = math.radians(lat)
    return int(math.floor((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n))


def tile_x_to_lon(tx, n):
    return tx / n * 360.0 - 180.0


def tile_y_to_lat(ty, n):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))


def load_tile(tx, ty):
    """z13 terrarium PNG → (256,256) float32 meters, or None if missing/sea."""
    path = TILES_DIR / str(ZOOM) / str(tx) / f"{ty}.png"
    if not path.exists():
        return None
    arr = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    m = arr[:, :, 0] * 256.0 + arr[:, :, 1] + arr[:, :, 2] / 256.0 - 32768.0
    m[m < -100.0] = 0.0  # NODATA hole → sea
    return m


def assemble_dem(n, x0, x1, y0, y1):
    """Stitch the tile block [x0..x1] × [y0..y1] into one float32 DEM array.
    Row 0 = north (y0), col 0 = west (x0). Missing tiles read as sea (0 m)."""
    w = (x1 - x0 + 1) * TILE_PX
    h = (y1 - y0 + 1) * TILE_PX
    dem = np.zeros((h, w), dtype=np.float32)
    missing = 0
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            t = load_tile(tx, ty)
            if t is None:
                missing += 1
                continue
            ry = (ty - y0) * TILE_PX
            rx = (tx - x0) * TILE_PX
            dem[ry:ry + TILE_PX, rx:rx + TILE_PX] = t
    return dem, missing


def block_mean(a, k):
    if k == 1:
        return a
    h, w = a.shape
    a = a[: h // k * k, : w // k * k]
    return a.reshape(h // k, k, w // k, k).mean(axis=(1, 3)).astype(np.float32)


def priority_flood_fill(dem):
    """Priority-Flood +epsilon (Barnes 2014). Returns a filled DEM with a strict
    monotone drainage gradient everywhere inland (no depressions, no flats)."""
    h, w = dem.shape
    demf = dem.ravel()
    filled = np.full(demf.shape, np.inf, dtype=np.float32)
    closed = np.zeros(demf.shape, dtype=bool)

    heap = []
    push = heapq.heappush
    pop = heapq.heappop

    # seed every border cell at its own elevation (the domain outlets)
    for c in range(w):
        for idx in (c, (h - 1) * w + c):
            if not closed[idx]:
                closed[idx] = True
                filled[idx] = demf[idx]
                push(heap, (float(demf[idx]), idx))
    for r in range(h):
        for idx in (r * w, r * w + w - 1):
            if not closed[idx]:
                closed[idx] = True
                filled[idx] = demf[idx]
                push(heap, (float(demf[idx]), idx))

    eps = EPSILON
    while heap:
        e, idx = pop(heap)
        r = idx // w
        c = idx - r * w
        # 8-neighbourhood
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
                closed[nidx] = True
                dn = demf[nidx]
                fn = dn if dn > e + eps else e + eps
                filled[nidx] = fn
                push(heap, (fn, nidx))
    return filled.reshape(h, w)


def d8_receivers(filled, cell_m):
    """For every cell, the flat index of its D8 steepest-descent neighbour
    (slope = drop / distance). Cells with no downhill neighbour (domain outlets)
    receive themselves (sinks)."""
    h, w = filled.shape
    inf = np.float32(np.inf)
    pad = np.full((h + 2, w + 2), inf, dtype=np.float32)
    pad[1:-1, 1:-1] = filled

    idx = np.arange(h * w, dtype=np.int64).reshape(h, w)
    best_slope = np.zeros((h, w), dtype=np.float32)
    recv = idx.copy()
    diag = cell_m * math.sqrt(2.0)
    for dr, dc in ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)):
        neigh = pad[1 + dr:1 + dr + h, 1 + dc:1 + dc + w]
        dist = diag if (dr != 0 and dc != 0) else cell_m
        slope = (filled - neigh) / dist  # +inf neighbours → -inf slope, never win
        take = slope > best_slope
        best_slope = np.where(take, slope, best_slope)
        recv = np.where(take, idx + dr * w + dc, recv)
    return recv.ravel()


def flow_accumulate(filled, recv):
    """Contributing-area count per cell. Process high→low so each cell's full
    accumulation is known before it drains into its receiver."""
    n = filled.size
    order = np.argsort(filled.ravel(), kind="stable")[::-1]
    acc = np.ones(n, dtype=np.float64)
    recv_l = recv.tolist()
    acc_l = acc.tolist()
    for i in order.tolist():
        r = recv_l[i]
        if r != i:
            acc_l[r] += acc_l[i]
    return np.asarray(acc_l, dtype=np.float64)


def edge_fade_mask(h, w, px):
    """1.0 in the interior, linear ramp to 0.0 over `px` texels at each edge."""
    yr = np.minimum(np.arange(h), np.arange(h)[::-1]).astype(np.float32)
    xr = np.minimum(np.arange(w), np.arange(w)[::-1]).astype(np.float32)
    fy = np.clip(yr / px, 0, 1)
    fx = np.clip(xr / px, 0, 1)
    return np.minimum(fy[:, None], fx[None, :])


def main():
    t_all = time.time()
    n = 2 ** ZOOM

    # bbox tiles + buffer ring
    bx0 = lon_to_tile_x(BBOX["minLon"], n)
    bx1 = lon_to_tile_x(BBOX["maxLon"], n)
    by0 = lat_to_tile_y(BBOX["maxLat"], n)  # north
    by1 = lat_to_tile_y(BBOX["minLat"], n)  # south
    x0, x1 = bx0 - BUFFER_TILES, bx1 + BUFFER_TILES
    y0, y1 = by0 - BUFFER_TILES, by1 + BUFFER_TILES
    n_tiles = (x1 - x0 + 1) * (y1 - y0 + 1)

    print(f"[pilot] z{ZOOM} bbox tiles x{bx0}..{bx1} y{by0}..{by1} "
          f"(+{BUFFER_TILES} buffer → {x1 - x0 + 1}×{y1 - y0 + 1} = {n_tiles} tiles)")

    t = time.time()
    dem_full, missing = assemble_dem(n, x0, x1, y0, y1)
    dem = block_mean(dem_full, STRIDE)
    h, w = dem.shape
    print(f"[pilot] DEM assembled {dem_full.shape} → stride {STRIDE} → {w}×{h} "
          f"= {w * h:,} cells ({missing} tiles missing→sea) in {time.time() - t:.1f}s")

    lat_c = (BBOX["minLat"] + BBOX["maxLat"]) / 2
    cell_m = (MPP0 / n) * math.cos(math.radians(lat_c)) * STRIDE
    cell_km2 = (cell_m * cell_m) / 1e6
    print(f"[pilot] cell ≈ {cell_m:.1f} m ({cell_km2 * 1e6:.0f} m²/cell)")

    t = time.time()
    filled = priority_flood_fill(dem)
    print(f"[pilot] priority-flood fill in {time.time() - t:.1f}s "
          f"(raised {np.count_nonzero(filled > dem + 1e-3):,} cells)")

    t = time.time()
    recv = d8_receivers(filled, cell_m)
    acc = flow_accumulate(filled, recv)
    area_km2 = (acc * cell_km2).reshape(h, w)
    print(f"[pilot] D8 + flow-accumulation in {time.time() - t:.1f}s "
          f"(max catchment {area_km2.max():.1f} km²)")

    # intensity: log-area ramp, gated by sea level, faded at the bbox edge
    la_min, la_full = math.log10(A_MIN_KM2), math.log10(A_FULL_KM2)
    ll = np.log10(np.maximum(area_km2, 1e-6))
    tnorm = np.clip((ll - la_min) / (la_full - la_min), 0.0, 1.0)
    intensity = tnorm * tnorm * (3.0 - 2.0 * tnorm)          # smoothstep
    # gentle smoothing knits D8's single-cell channels into continuous threads
    # (D8 zig-zags across flats — visible as dotting at a near-top-down zoom) and
    # slightly fattens creeks so thin tributaries read; the sea mask is applied
    # AFTER so the blur never bleeds a river out over the ocean.
    intensity = gaussian_filter(intensity, sigma=0.8)
    intensity[dem <= SEA_LEVEL] = 0.0                        # no river over the sea

    # crop buffer ring away → output = bbox tiles only, then fade the edges
    m = TILE_PX // STRIDE
    crop = intensity[BUFFER_TILES * m: h - BUFFER_TILES * m,
                     BUFFER_TILES * m: w - BUFFER_TILES * m]
    ch, cw = crop.shape
    crop = crop * edge_fade_mask(ch, cw, EDGE_FADE_PX)

    river_cells = int(np.count_nonzero(crop > 0.02))
    print(f"[pilot] output {cw}×{ch} = {cw * ch:,} texels, "
          f"river texels (>0.02) = {river_cells:,} ({100 * river_cells / (cw * ch):.2f}%)")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img = (np.clip(crop, 0, 1) * 255.0 + 0.5).astype(np.uint8)
    Image.fromarray(img, mode="L").save(OUT_DIR / "river_sim_pilot.png")

    # geographic bounds of the OUTPUT region = the bbox tile block's outer edges
    meta = {
        "bbox": {
            "minLon": tile_x_to_lon(bx0, n),
            "maxLon": tile_x_to_lon(bx1 + 1, n),
            "maxLat": tile_y_to_lat(by0, n),      # north edge
            "minLat": tile_y_to_lat(by1 + 1, n),  # south edge
        },
        "size": {"w": cw, "h": ch},
        "zoom": ZOOM,
        "params": {
            "stride": STRIDE,
            "cell_m": round(cell_m, 2),
            "buffer_tiles": BUFFER_TILES,
            "a_min_km2": A_MIN_KM2,
            "a_full_km2": A_FULL_KM2,
            "edge_fade_px": EDGE_FADE_PX,
            "epsilon": EPSILON,
        },
        "note": "row 0 = north, col 0 = west; grayscale = river intensity 0..1",
    }
    (OUT_DIR / "river_sim_pilot.json").write_text(json.dumps(meta, indent=2))
    print(f"[pilot] wrote river_sim_pilot.png + .json  bbox={meta['bbox']}")
    print(f"[pilot] TOTAL {time.time() - t_all:.1f}s")


if __name__ == "__main__":
    main()
