#!/usr/bin/env python3
"""Farm-field intensity drape texture (仿 river_sim 模式, scripts/bake_flow_accum.py).

Source: ../taipei-gis-analytics/data/processed/agriculture/ftw_fields_2025/
ftw_fields_2025.fgb (386,829 field polygons, EPSG:4326, confidence_mean already
thresholded >= 0.5 upstream — see that dataset's _manifest.json).

Burn value: BINARY (0/255), not confidence-weighted. Checked the source stats
first (`geopandas` in the analytics venv): confidence_mean is clustered in
0.50-0.58 (std 0.02) — the >=0.5 upstream filter already ate all the dynamic
range, so scaling it to 0-255 would just paint a near-uniform flat gray with
no visible gradient. A binary "is there a field here" mask is simpler AND
more honest about what the data actually says. `-at` (ALL_TOUCHED) is used so
the smallest fields (min 0.009 ha, ~9x9 m — sub single z13 cell) still leave a
mark instead of vanishing to a bare majority-of-cell-center test.

GEOREF CONVENTION — must match src/engine/terrain.js's uRiverTex sampling
exactly (same bbox corners run through the SAME lonLatToWorld projection as
river_sim, see src/engine/index.js applyRiverSimBounds): row 0 = north,
col 0 = west, one output texel = one z13 DEM-tile pixel downsampled x
OUT_STRIDE (z12-equivalent) — imported verbatim from bake_flow_accum.py so the
pixel grid is bit-identical, not just "close": same ZOOM/TILE_PX/OUT_STRIDE,
same lon_to_tile_x/lat_to_tile_y/gpx_to_lon/gpy_to_lat, same block_max
downsample. The burn itself happens on a Web Mercator (EPSG:3857) raster grid
whose -te is derived from those same tile-pixel integers via the closed-form
MPP0-based formula (x3857/y3857 below) — NOT through gdalwarp's own lon/lat
reprojection — so the output pixel grid is exactly the tile-pixel grid, no
resampling-introduced drift.

BBOX: src/engine/geo.js TAIWAN_BBOX (119.2 west edge, widened 2026-07 to reach
Penghu — N23E119 tile). Keep this constant in sync with geo.js by hand; there
is no cross-language import.

Heavy geometry work (reprojection + rasterization) is delegated to the GDAL
CLI (ogr2ogr / gdal_rasterize, both present via Homebrew) — same choice
bake_region_sea_mask.py made for the same reason: keep this repo's bake
scripts on numpy/PIL/scipy, no geopandas/rasterio import here. (The task brief
mentioned "run this in the analytics venv"; the GDAL-CLI route already
satisfies "heavy geo work happens outside this repo's python deps" without
needing to activate that venv at all, and it mirrors the sibling script
written the same day.)

Output (public/layers/):
    farm_sim.png    grayscale 0/255, same sidecar shape as river_sim.json
    farm_sim.json   bbox + size + params + stats

Idempotent: every run redoes the reproject/rasterize/downsample from scratch
in a TemporaryDirectory (auto-cleaned) and overwrites the two output files.
"""
import json
import math
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # ~395M px full-res intermediate; not a decompression bomb, just Taiwan

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
from bake_flow_accum import (  # noqa: E402 (reuse the exact river_sim pixel grid, don't reinvent)
    MPP0,
    OUT_STRIDE,
    TILE_PX,
    ZOOM,
    block_max,
    gpx_to_lon,
    gpy_to_lat,
    lat_to_tile_y,
    lon_to_tile_x,
)

ROOT = SCRIPTS_DIR.parent
OUT_DIR = ROOT / "public" / "layers"
GIS_ROOT = Path("/Users/migu/Desktop/資料庫/gen_ai_try/ichef_工作用/GIS")
FGB_SRC = GIS_ROOT / "taipei-gis-analytics/data/processed/agriculture/ftw_fields_2025/ftw_fields_2025.fgb"

# mirrors src/engine/geo.js TAIWAN_BBOX (2026-07 widened west edge for Penghu) — keep in sync by hand
FARM_BBOX = {"minLon": 119.2, "maxLon": 122.1, "minLat": 21.8, "maxLat": 25.4}
BURN_VALUE = 255


def x3857(gx, n):
    """global z13 pixel column -> EPSG:3857 easting (meters). Exact closed form
    (not a reprojection round-trip): at zoom z, n=2**z tiles span the full
    Web Mercator square [-piR, +piR]; MPP0 is m/px at zoom 0, so m/px at zoom
    z is MPP0/n, and 128*MPP0 == piR (128 px = half the zoom-0 world)."""
    return gx * (MPP0 / n) - 128 * MPP0


def y3857(gy, n):
    """global z13 pixel row -> EPSG:3857 northing (meters); row 0 = north (+piR)."""
    return 128 * MPP0 - gy * (MPP0 / n)


def feature_count(fgb_path):
    r = subprocess.run(["ogrinfo", "-so", "-al", str(fgb_path)], check=True, capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if line.strip().startswith("Feature Count:"):
            return int(line.split(":")[1].strip())
    return None


def main():
    if not FGB_SRC.exists():
        print(f"缺失來源：{FGB_SRC}", file=sys.stderr)
        return 1

    t_all = time.time()
    n = 2**ZOOM

    x0 = lon_to_tile_x(FARM_BBOX["minLon"], n)
    x1 = lon_to_tile_x(FARM_BBOX["maxLon"], n)
    y0 = lat_to_tile_y(FARM_BBOX["maxLat"], n)  # north
    y1 = lat_to_tile_y(FARM_BBOX["minLat"], n)  # south
    gx0, gy0 = x0 * TILE_PX, y0 * TILE_PX
    full_w = (x1 - x0 + 1) * TILE_PX
    full_h = (y1 - y0 + 1) * TILE_PX
    print(f"[farm] z{ZOOM} tile grid x{x0}..{x1} y{y0}..{y1} -> full-res {full_w}x{full_h} px "
          f"({full_w * full_h:,} cells)")

    xmin, xmax = x3857(gx0, n), x3857(gx0 + full_w, n)
    ymax, ymin = y3857(gy0, n), y3857(gy0 + full_h, n)

    src_count = feature_count(FGB_SRC)
    print(f"[farm] source: {src_count:,} field polygons ({FGB_SRC.name})")

    with tempfile.TemporaryDirectory(prefix="farm_sim_") as td:
        td = Path(td)
        reproj = td / "fields_3857.fgb"
        full_tif = td / "farm_full.tif"

        t = time.time()
        subprocess.run(
            ["ogr2ogr", "-f", "FlatGeobuf", str(reproj), "-t_srs", "EPSG:3857", str(FGB_SRC)],
            check=True, capture_output=True, text=True,
        )
        print(f"[farm] ogr2ogr reproject -> EPSG:3857 in {time.time() - t:.1f}s")

        t = time.time()
        subprocess.run(
            [
                "gdal_rasterize", "-burn", str(BURN_VALUE), "-at",
                "-a_srs", "EPSG:3857",
                "-te", str(xmin), str(ymin), str(xmax), str(ymax),
                "-ts", str(full_w), str(full_h),
                "-ot", "Byte", "-init", "0", "-q",
                str(reproj), str(full_tif),
            ],
            check=True, capture_output=True, text=True,
        )
        print(f"[farm] gdal_rasterize (ALL_TOUCHED, binary burn={BURN_VALUE}) in {time.time() - t:.1f}s")

        t = time.time()
        arr = np.array(Image.open(full_tif))
        print(f"[farm] loaded full-res raster {arr.shape} in {time.time() - t:.1f}s "
              f"(unique values: {np.unique(arr).tolist()})")

    t = time.time()
    out = block_max(arr, OUT_STRIDE)
    del arr
    rows = np.where(out.any(axis=1))[0]
    cols = np.where(out.any(axis=0))[0]
    if rows.size == 0 or cols.size == 0:
        print("[farm] ERROR: no nonzero pixels in the whole bbox — aborting", file=sys.stderr)
        return 1
    r0, r1 = int(rows[0]), int(rows[-1]) + 1
    c0, c1 = int(cols[0]), int(cols[-1]) + 1
    crop = out[r0:r1, c0:c1]
    ch, cw = crop.shape
    print(f"[farm] downsample x{OUT_STRIDE} -> {out.shape[1]}x{out.shape[0]}, "
          f"tight-crop to data bbox -> {cw}x{ch} in {time.time() - t:.1f}s")

    bbox = {
        "minLon": gpx_to_lon(gx0 + c0 * OUT_STRIDE, n),
        "maxLon": gpx_to_lon(gx0 + c1 * OUT_STRIDE, n),
        "maxLat": gpy_to_lat(gy0 + r0 * OUT_STRIDE, n),
        "minLat": gpy_to_lat(gy0 + r1 * OUT_STRIDE, n),
    }
    nonzero_pct = 100 * np.count_nonzero(crop) / crop.size

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    png_path = OUT_DIR / "farm_sim.png"
    Image.fromarray(crop, mode="L").save(png_path, optimize=True)
    png_mb = png_path.stat().st_size / 1e6

    meta = {
        "bbox": bbox,
        "size": {"w": cw, "h": ch},
        "zoom": ZOOM,
        "png": "/layers/farm_sim.png",
        "params": {
            "burn": "binary 0/255 (ALL_TOUCHED) — confidence_mean clustered 0.50-0.58, "
                    "no usable dynamic range after the upstream >=0.5 filter",
            "out_stride": OUT_STRIDE,
            "source_features": src_count,
        },
        "stats": {"nonzeroPct": round(nonzero_pct, 2)},
        "note": "row 0 = north, col 0 = west; grayscale 0/255 = farm field presence; "
                "same tile-pixel grid as river_sim.png (bake_flow_accum ZOOM/OUT_STRIDE)",
    }
    (OUT_DIR / "farm_sim.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))

    print(f"[farm] wrote {png_path.name} ({png_mb:.2f} MB) + farm_sim.json  "
          f"nonzero={nonzero_pct:.2f}%  bbox={bbox}")
    print(f"[farm] TOTAL {time.time() - t_all:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
