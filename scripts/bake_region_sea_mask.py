#!/usr/bin/env python3
"""Land/sea mask for the region sea plane.

The region sea plane must NOT be an elevation threshold — genuinely low-lying
land (the western plain) sits below any sensible sea height and would flood /
z-fight. Instead we bake a proper land/sea MASK.

DEM-derived (2026-07 澎湖擴圖): the mask now comes from actual DTM validity,
not a hand-drawn coastline polygon — a pixel is LAND if the 本島+澎湖+金門 20m
DTM mosaic has a real (non-nodata) value there, OR the GEBCO_2025 bathymetry
grid reports elevation > 0 there, SEA otherwise. The GEBCO OR-clause is new
(2026-07 金馬擴圖): Matsu and the Fujian coastal strip have no NLSC-family DTM
coverage at all, so without it they'd render as flat sea. GEBCO (public
domain, 15 arc-sec ≈ 450m) is coarse but sufficient to place a plausible
coastline there. Small islands covered by neither high-res DTM nor a positive
GEBCO cell (綠島、龜山島…) still fall back to sea, same as before. Interior
nodata voids fully enclosed by land (e.g. high-mountain cloud-cover gaps in
the source DTM, confirmed at 大雪山 ~121.07,24.50) are closed to land via
`binary_fill_holes` — otherwise they'd render as a floating sea patch in the
middle of a mountain. Mosaic uses the same `gdalbuildvrt` multi-source
technique as
`../taipei-gis-analytics/pipelines/base_map/terrain_rgb/01_encode_terrarium_tiles.py`
(same phase-aligned Kinmen raster it uses, to avoid gdalbuildvrt sub-pixel
grid-phase drift when mosaicking sources with mismatched origins).

    public/layers/region_sea_mask.png   L, sea=255 / land=0
    public/layers/region_sea_mask.json  { bbox (lon/lat), size, png }

Baked in a Web-Mercator pixel grid (row 0 = north, col 0 = west) so it maps
linearly to world space — the sea plane's UVs are set from the bbox projected
through the same projection the engine uses (see region.js), exactly like the
river-sim texture. Reprojection is done with the `gdalwarp`/`gdalbuildvrt` CLI
(not rasterio — this repo keeps bake scripts on numpy/PIL; heavy geo libs stay
in the analytics repo's venv), only the small warped output rasters are read
back with PIL/numpy.
"""

import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
ANALYTICS_ROOT = ROOT.parent / "taipei-gis-analytics"
MAIN_DTM = ANALYTICS_ROOT / "data/raw/base_map/dtm_20m/不分幅_台灣20MDEM(2024).tif"
PENGHU_DTM = ANALYTICS_ROOT / "data/raw/base_map/dtm_20m_penghu/penghu_1116ok.tif"
# Phase-aligned to MAIN_DTM's pixel grid (gdalwarp -te snapped to the same
# 20m-grid phase as MAIN_DTM's origin) — the raw TGOS product is TM2 zone 119
# (central meridian 119, unlike MAIN_DTM/PENGHU_DTM's zone 121) and an
# unaligned reprojection was found to inject sub-pixel gdalbuildvrt drift
# across the *entire* mosaic (not just near Kinmen); see terrain_rgb bake
# notes for the same fix applied on the analytics side.
KINMEN_DTM = ANALYTICS_ROOT / "data/raw/base_map/dtm_20m_kinmen/kinmen_tm2z121.tif"
GEBCO_TIF = ANALYTICS_ROOT / "data/raw/base_map/gebco_2025/gebco_2025_taiwan_subset.tif"
OUT_PNG = ROOT / "public" / "layers" / "region_sea_mask.png"
OUT_JSON = ROOT / "public" / "layers" / "region_sea_mask.json"

NODATA = -32767  # all three NLSC-family DTM sources share this nodata sentinel

# W, S, E, N — expanded 2026-07 to cover Kinmen/Matsu/Fujian coastal strip
# (matches the terrain-art bbox expansion and the terrain_rgb tiles_bathy bbox).
BBOX = (117.8, 21.5, 123.5, 26.5)
HEIGHT = 2526  # scaled up from the previous 1835 to hold the same ~241m/px
# Mercator pixel size over the larger N/S span (was measured ~241m/px, not
# exactly the ~220m/px figure quoted when this expansion was scoped — kept
# unchanged rather than re-tuned). WIDTH below derives from the wider bbox so
# pixels stay Mercator-square, same aspect logic as before.


def merc_y(lat):
    r = math.radians(lat)
    return math.log(math.tan(r) + 1.0 / math.cos(r))


def derive_width(bbox, height):
    w, s, e, n = bbox
    d_lon = (e - w) * math.pi / 180.0
    d_my = merc_y(n) - merc_y(s)
    return max(1, round(height * d_lon / d_my))


def build_mosaic_vrt(dest):
    cmd = [
        "gdalbuildvrt", "-srcnodata", str(NODATA), "-vrtnodata", str(NODATA),
        str(dest), str(MAIN_DTM), str(PENGHU_DTM), str(KINMEN_DTM),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def warp_to_grid(vrt_path, width, height, out_tif):
    w, s, e, n = BBOX
    cmd = [
        "gdalwarp", "-t_srs", "EPSG:3857", "-te_srs", "EPSG:4326",
        "-te", str(w), str(s), str(e), str(n),
        "-ts", str(width), str(height),
        "-r", "near", "-srcnodata", str(NODATA), "-dstnodata", str(NODATA),
        "-of", "GTiff", "-overwrite", str(vrt_path), str(out_tif),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def warp_gebco_to_grid(width, height, out_tif):
    """Warp the GEBCO_2025 subset (EPSG:4326, ~450m) onto the same output
    grid as warp_to_grid (bilinear — continuous elevation, not a nodata
    mask), forced to Float32 so PIL reads it back unambiguously."""
    w, s, e, n = BBOX
    cmd = [
        "gdalwarp", "-t_srs", "EPSG:3857", "-te_srs", "EPSG:4326",
        "-te", str(w), str(s), str(e), str(n),
        "-ts", str(width), str(height),
        "-r", "bilinear", "-ot", "Float32",
        "-of", "GTiff", "-overwrite", str(GEBCO_TIF), str(out_tif),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def main():
    for p in (MAIN_DTM, PENGHU_DTM, KINMEN_DTM, GEBCO_TIF):
        if not p.exists():
            print(f"缺失來源：{p}", file=sys.stderr)
            return 1

    width = derive_width(BBOX, HEIGHT)

    with tempfile.TemporaryDirectory() as td:
        vrt = Path(td) / "mosaic.vrt"
        build_mosaic_vrt(vrt)
        out_tif = Path(td) / "mask.tif"
        warp_to_grid(vrt, width, HEIGHT, out_tif)
        arr = np.array(Image.open(out_tif))

        gebco_tif = Path(td) / "gebco.tif"
        warp_gebco_to_grid(width, HEIGHT, gebco_tif)
        gebco_arr = np.array(Image.open(gebco_tif))

    land_dtm = arr != NODATA
    land_gebco = gebco_arr > 0
    land = land_dtm | land_gebco
    # Close interior nodata voids (cloud-cover / survey gaps inside the DTM,
    # e.g. high mountain cloud cover) that don't connect to the open ocean —
    # a real disconnected "hole" would otherwise render as a floating sea
    # patch in the middle of land. Real bays/straits stay sea (still
    # connected to a border-touching ocean component).
    land = ndimage.binary_fill_holes(land)
    mask = np.where(land, 0, 255).astype(np.uint8)  # sea=255 land=0
    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(mask, mode="L").save(OUT_PNG)

    w, s, e, n = BBOX
    meta = {
        "bbox": {"minLon": w, "maxLon": e, "minLat": s, "maxLat": n},
        "size": {"w": width, "h": HEIGHT},
        "png": "/layers/region_sea_mask.png",
        "note": (
            "row 0 = north, col 0 = west; L: sea=255 land=0; "
            "DEM-derived from 本島+澎湖+金門 20m DTM mosaic 有效像素=陸"
            "（gdalbuildvrt+gdalwarp nearest）OR GEBCO_2025 bathymetry grid "
            "elevation>0（gdalwarp bilinear，450m 粗解析度，補馬祖/福建沿岸無 "
            "NLSC 級 DTM 覆蓋的區域）; "
            "內陸孤立 nodata（雲遮等）用 binary_fill_holes 補為陸; "
            "綠島/龜山島不在任一 DTM 範圍內且 GEBCO 在該點非正值，仍判為海"
        ),
    }
    OUT_JSON.write_text(json.dumps(meta, indent=2, ensure_ascii=False))

    land_pct = 100 * land.sum() / land.size
    print(
        f"[mask] {width}x{HEIGHT}, land {land_pct:.1f}% "
        f"→ {OUT_PNG.name} {OUT_PNG.stat().st_size / 1024:.0f} KB  bbox={meta['bbox']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
