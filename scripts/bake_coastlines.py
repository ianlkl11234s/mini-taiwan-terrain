#!/usr/bin/env python3
"""Coastline rings for the islands *not* covered by coastline_taiwan.json.

coastline_taiwan.json only has one ring — the main island (county boundaries
unioned, simplified to 100m, 1,289 points), imported directly by
src/engine/polyline.js's `createCoastlineLayer` (flat mode, single polyline).
It has never had Penghu, Kinmen (+ its outlying islets), Matsu, or the Fujian
coastal strip that came in with the 金馬 terrain expansion.

This script fills that gap with a *separate* file — public/layers/
coastlines_extended.json — containing every OTHER ring, tagged with the
precision of the source that produced it:

    source=nlsc   Penghu / Kinmen archipelagos: warped from the real 20m DTM
                  mosaics (dtm_20m_penghu / dtm_20m_kinmen) at a ~28m grid,
                  simplified with a 50-100m Douglas-Peucker tolerance.
    source=gebco  Matsu / Fujian (China) coast / anything else: GEBCO_2025's
                  native ~450m grid thresholded directly (elevation > 0),
                  simplified with a ~500m tolerance — GEBCO has no better
                  resolution to offer there (Matsu has no NLSC-family DTM at
                  all, see bake_region_sea_mask.py), so a finer tolerance
                  would just be polishing noise.

Land/sea determination for the NLSC pass (Penghu/Kinmen) is an ELEVATION
threshold on the real 20m DTM (`elevation > LAND_MIN_M`, see the constants
by KINMEN_WINDOW) — NOT mere non-nodata validity, and NOT OR'd with GEBCO.
Both had to go (2026-07-11), found by checking ring area_km2 against each
county's official land area:

  - Non-nodata validity is too permissive: both DTMs carry valid (non
    -32767) readings well past the shoreline into the intertidal zone
    (shallow reef / exposed mudflat) — `!=NODATA` overshoots Penghu ~5x
    (640km² vs official ~127km²) and merges Kinmen's main island with
    Lieyu across a tidal-flat land bridge (~220km² vs official
    151.656km², barely moved by dropping GEBCO alone — see LAND_MIN_M).
  - The GEBCO OR-clause (bake_region_sea_mask.py's combined rule, kept for
    that script's coarse whole-island sea-plane mask) is dropped entirely
    here: Kinmen's real islands sit only ~2-10km from mainland China's
    Xiamen coast, and GEBCO's ~450m grid resolves that mainland strip as
    land too — ORing it in pulled genuine Xiamen coastline into the ring
    on top of the intertidal-bridge problem above. The mainland side is
    still covered, just by the separate GEBCO pass's own china_coast ring
    below, so nothing is lost.

The GEBCO pass itself (Matsu / Fujian coast / anything else) is unaffected
by any of this — it keeps thresholding GEBCO_2025's native ~450m grid
directly (elevation > 0), simplified with a ~500m tolerance — GEBCO has no
better resolution to offer there (Matsu has no NLSC-family DTM at all, see
bake_region_sea_mask.py), so a finer tolerance would just be polishing
noise. Unlike bake_region_sea_mask.py (which bakes one coarse ~241m/px
Mercator raster sized for a sea-plane alphaMap, where this level of
imprecision is invisible), ring *shape* fidelity needs the source data's
own native resolution, so this script runs two separate passes at two
different grids instead of reusing its baked PNG:

  1. NLSC pass — one gdalwarp window per archipelago (Penghu, Kinmen),
     each cropped tight to that DTM's own native footprint (plus a couple of
     pixels of margin so `gdal_polygonize` doesn't clip a ring against the
     window edge). Kinmen's real islands sit only ~2-10km from Xiamen —
     close enough that a *generous* buffer around the Kinmen window pulls in
     genuine mainland Chinese coast (verified visually, see scratchpad debug
     PNG from the session that wrote this script); keeping the window tight
     to the DTM's own bounds avoids that without clipping Kinmen's own
     islands (the survey product's own bounding box already hugs just its
     islands, confirmed by inspection).
  2. GEBCO pass — the whole GEBCO subset thresholded once, then everything
     already covered by the NLSC pass (Penghu/Kinmen windows) or the main
     island (bbox + area heuristic — nothing else in-domain gets close to
     Taiwan's ~36,000km²) is dropped, keeping Matsu / China coast / any
     stray islet GEBCO happens to resolve.

Vectorization is `gdal_polygonize.py` (GDAL CLI, 8-connected) reading a
Byte land/sea GeoTIFF built with `gdal_calc.py` — no shapely/geopandas, no
rasterio; this repo's bake scripts stay on numpy/PIL/scipy + GDAL CLI
subprocess calls, same pattern as bake_region_sea_mask.py. `gdal_calc.py`
needs `--hideNoData` — without it, it silently propagates each input's own
declared NoData straight to the output for any pixel that IS that NoData
value, ignoring what the --calc expression would have evaluated there (a
sharp edge found the hard way while prototyping this script: `(A!=-32767)`
came back *entirely 1s*, because gdal_calc short-circuited every nodata
pixel instead of letting the formula say "false").

Ring simplification is Douglas-Peucker (same recursive implementation as
bake_region_coast.py) run in EPSG:3826 (TWD97 TM2) meters via pyproj — not
degrees — so the tolerance numbers above mean what they say. Small islands
get a tolerance *floor* scaled to their own bbox diagonal (same fix
bake_region_coast.py needed): a flat tolerance at the coarse end would grind
a small islet down to a handful of points whose straight chords cut across
open water.

Area filtering (drop rings under ~0.5km², keeping known small-but-real
islets like Kinmen's 大膽/二膽 which sit right at that threshold) is also
computed in EPSG:3826 meters (shoelace), not degrees.

Output: public/layers/coastlines_extended.json
    { bbox, rings: [ { points: [[lon,lat],...] (closed, first==last),
                       source: "nlsc"|"gebco", region, area_km2 }, ... ],
      note }

Usage:
    python3 scripts/bake_coastlines.py
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import pyproj
from osgeo import gdal

gdal.UseExceptions()

ROOT = Path(__file__).resolve().parent.parent
ANALYTICS_ROOT = ROOT.parent / "taipei-gis-analytics"
PENGHU_DTM = ANALYTICS_ROOT / "data/raw/base_map/dtm_20m_penghu/penghu_1116ok.tif"
KINMEN_DTM = ANALYTICS_ROOT / "data/raw/base_map/dtm_20m_kinmen/kinmen_tm2z121.tif"
GEBCO_TIF = ANALYTICS_ROOT / "data/raw/base_map/gebco_2025/gebco_2025_taiwan_subset.tif"
OUT_JSON = ROOT / "public" / "layers" / "coastlines_extended.json"

NODATA = -32767  # NLSC-family DTM nodata sentinel (shared with bake_region_sea_mask.py)
FINE_RES = 0.00025  # deg, ~27-28m at these latitudes — matches DTM's own ~20m native detail

# gdalwarp windows for the NLSC pass (W,S,E,N). Penghu: DTM's own bounds +
# generous buffer (no contamination risk, nearest other land is Taiwan
# itself, ~50km away). Kinmen: DTM's own bounds + only ~2px margin — a
# generous buffer here would additionally pull in genuine Xiamen coastline
# (Kinmen's islands sit only ~2-10km from the mainland).
PENGHU_WINDOW = (119.24, 23.10, 119.80, 23.86)
KINMEN_WINDOW = (118.203, 24.377, 118.487, 24.540)

# Land elevation threshold (meters) for the NLSC fine pass: land is
# `elevation > LAND_MIN_M`, NOT mere non-nodata validity, and NOT OR'd with
# GEBCO. FIXED 2026-07-11: an earlier version used validity (`!=NODATA`)
# OR'd with GEBCO>0 (bake_region_sea_mask.py's combined rule), measured
# (via ring area_km2) to badly overshoot both archipelagos' official land
# area:
#   - Both DTMs carry valid (non-nodata) elevation readings well past the
#     shoreline into the intertidal zone (shallow reef / exposed mudflat at
#     low tide) — `!=NODATA` overshoots Penghu ~5x (640km² vs official
#     ~127km² total) and, worse, merges Kinmen's main island with Lieyu
#     across a mudflat land bridge filling the strait between them
#     (~220km² vs Kinmen County's official 151.656km² — main island 134.25
#     + Lieyu ~14.85-16 + small islets; per zh.wikipedia.org/Kinmen County
#     government site, verified 2026-07-11). Dropping the GEBCO OR-clause
#     alone barely moved this (~223km² → ~220km²) — GEBCO was a minor
#     contributor, not the main one; the intertidal bridge is upstream of
#     GEBCO entirely, in the DTM itself.
#   - Penghu's DTM has no such bridging: `elevation > 0` alone already
#     lands at 127.7km² across 13 rings ≥0.5km² with per-island sizes that
#     match real geography (main island 66.7 / Xiyu 19.0 / Baisha 14.8 /
#     …), so PENGHU_LAND_MIN_M stays at 0.
#   - Kinmen's mudflat bridge to Lieyu only breaks above ~2.5m elevation
#     (swept 2.0-4.0m against connected-component count — see the session's
#     scratchpad kinmen_mask_valid.png / threshold sweep); 3.0m sits well
#     into the stable plateau past that transition (main 129.1km² + Lieyu
#     13.9km² = 142.9km², inside the 140-160km² band around the official
#     151.656km²), so KINMEN_LAND_MIN_M is 3.0, not 0.
PENGHU_LAND_MIN_M = 0.0
KINMEN_LAND_MIN_M = 3.0

# Native DTM footprints (no buffer) — used to drop the GEBCO pass's own
# (coarser) detections of these same islands so each only appears once.
PENGHU_NATIVE_BBOX = (119.299, 23.169, 119.741, 23.804)
KINMEN_NATIVE_BBOX = (118.204, 24.378, 118.486, 24.539)

# Main island exclusion: bbox (MAIN_DTM's own WGS84 bounds + buffer) + area
# floor. Nothing else in-domain gets within an order of magnitude of
# Taiwan's ~36,000km², so the pair is a safe, simple test.
TAIWAN_MAIN_BBOX = (119.85, 21.75, 122.15, 25.45)
TAIWAN_MAIN_MIN_AREA_KM2 = 1000.0
TAIWAN_REF_POINT = (120.9, 23.85)  # Sun Moon Lake — belt-and-suspenders point-in-ring check

MATSU_BBOX = (119.85, 26.05, 120.55, 26.45)

# The GEBCO subset's own bbox (117.3-124.0E/20.7-27.0N, sized for the
# terrain_rgb bathymetry bake) reaches past Taiwan's own territory at its
# extreme edges — Japan's Yaeyama islands (Yonaguni/Iriomote/Hateruma,
# >=~122.9E) east, the Philippines' Batanes group (Y'Ami/Itbayat, <=~21.0N)
# south. Neither is in scope here (only 澎湖/金門/馬祖/中國沿岸 + Taiwan's own
# outlying islands are), so the coarse pass is post-filtered to a tighter
# inclusion window rather than re-cropping the GEBCO source itself. This
# still comfortably keeps genuine Taiwan outlying islands the GEBCO pass
# happens to resolve (Guishan ~121.95,24.84; Green Island ~121.49,22.66;
# Lanyu ~121.55,22.05 — all found while writing this script) — a bonus
# beyond the ask, tagged region=taiwan_outlying, not silently dropped.
GEBCO_INCLUDE_BBOX = (117.3, 21.3, 122.3, 27.0)

MIN_AREA_KM2 = 0.5

# Douglas-Peucker tolerance in meters: (cap, floor, fraction-of-ring-bbox-diagonal)
# — same shape as bake_region_coast.py's ring_tolerance, tuned per source precision.
NLSC_TOL = (90.0, 20.0, 0.025)
GEBCO_TOL = (500.0, 80.0, 0.03)

_to3826 = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3826", always_xy=True)


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def project(ring: list[list[float]]) -> list[tuple[float, float]]:
    return [_to3826.transform(lon, lat) for lon, lat in ring]


def ring_area_km2(ring: list[list[float]]) -> float:
    pts = project(ring)
    s = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0 / 1e6


def ring_bbox(ring: list[list[float]]) -> tuple[float, float, float, float]:
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    return min(lons), min(lats), max(lons), max(lats)


def bbox_center(bbox: tuple[float, float, float, float]) -> tuple[float, float]:
    w, s, e, n = bbox
    return (w + e) / 2.0, (s + n) / 2.0


def point_in_bbox(pt: tuple[float, float], bbox: tuple[float, float, float, float]) -> bool:
    x, y = pt
    w, s, e, n = bbox
    return w <= x <= e and s <= y <= n


def point_in_ring(pt: tuple[float, float], ring: list[list[float]]) -> bool:
    """Ray casting; ring assumed closed (first == last)."""
    x, y = pt
    inside = False
    n = len(ring)
    for i in range(n - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-15) + x1):
            inside = not inside
    return inside


def _dp(pts_m, tol, lo, hi, keep):
    if hi <= lo + 1:
        return
    ax, ay = pts_m[lo]
    bx, by = pts_m[hi]
    dx, dy = bx - ax, by - ay
    d2 = dx * dx + dy * dy
    imax, dmax = -1, 0.0
    for i in range(lo + 1, hi):
        px, py = pts_m[i]
        if d2 == 0:
            dist = math.hypot(px - ax, py - ay)
        else:
            t = ((px - ax) * dx + (py - ay) * dy) / d2
            t = max(0.0, min(1.0, t))
            dist = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
        if dist > dmax:
            imax, dmax = i, dist
    if dmax > tol:
        keep[imax] = True
        _dp(pts_m, tol, lo, imax, keep)
        _dp(pts_m, tol, imax, hi, keep)


def simplify_ring(ring: list[list[float]], tol_params: tuple[float, float, float]) -> list[list[float]]:
    """Douglas-Peucker in EPSG:3826 meters; tolerance floored to a fraction of
    the ring's own bbox diagonal so small islands don't get ground down to a
    handful of points (the bake_region_coast.py lesson)."""
    cap, floor, frac = tol_params
    pts_m = project(ring)
    xs = [p[0] for p in pts_m]
    ys = [p[1] for p in pts_m]
    diag = math.hypot(max(xs) - min(xs), max(ys) - min(ys))
    tol = max(floor, min(cap, diag * frac))
    if len(ring) <= 4:
        return ring
    keep = [False] * len(ring)
    keep[0] = keep[-1] = True
    _dp(pts_m, tol, 0, len(ring) - 1, keep)
    return [p for p, k in zip(ring, keep) if k]


def warp(src: Path, bbox: tuple[float, float, float, float], out: Path,
         resample: str, dtype: str | None = None, nodata: float | None = None) -> None:
    w, s, e, n = bbox
    cmd = ["gdalwarp", "-t_srs", "EPSG:4326", "-te", str(w), str(s), str(e), str(n),
           "-tr", str(FINE_RES), str(FINE_RES), "-r", resample, "-of", "GTiff", "-overwrite"]
    if dtype:
        cmd += ["-ot", dtype]
    if nodata is not None:
        cmd += ["-srcnodata", str(nodata), "-dstnodata", str(nodata)]
    cmd += [str(src), str(out)]
    run(cmd)


def build_land_mask(dtm_warped: Path, out_mask: Path, land_min_m: float) -> None:
    """NLSC pass only: land = DTM elevation > land_min_m — NOT mere validity,
    no GEBCO OR (see the LAND_MIN_M note above KINMEN_WINDOW) — the mainland
    side is covered separately by the GEBCO pass's china_coast ring."""
    run(["gdal_calc.py", "-A", str(dtm_warped),
         "--calc", f"(A>{land_min_m})", "--type", "Byte",
         "--outfile", str(out_mask), "--overwrite", "--quiet",
         "--hideNoData", "--NoDataValue", "0"])


def polygonize(mask_tif: Path, out_geojson: Path) -> list[dict]:
    out_geojson.unlink(missing_ok=True)
    run(["gdal_polygonize.py", "-8", str(mask_tif), "-f", "GeoJSON", str(out_geojson)])
    gj = json.loads(out_geojson.read_text())
    return [f for f in gj["features"] if f["properties"].get("DN") == 1]


def fine_pass(name: str, dtm_src: Path, window: tuple[float, float, float, float], land_min_m: float, td: Path) -> list[dict]:
    print(f"[coastlines] NLSC pass: {name} window={window} land>{land_min_m}m")
    dtm_w = td / f"{name}_dtm.tif"
    mask = td / f"{name}_mask.tif"
    warp(dtm_src, window, dtm_w, "near", nodata=NODATA)
    build_land_mask(dtm_w, mask, land_min_m)
    feats = polygonize(mask, td / f"{name}_polys.geojson")
    print(f"  {len(feats)} raw land features")
    return feats


def coarse_pass(td: Path) -> list[dict]:
    print("[coastlines] GEBCO pass (whole domain, native ~450m grid)")
    mask = td / "gebco_mask_full.tif"
    run(["gdal_calc.py", "-A", str(GEBCO_TIF), "--calc", "A>0", "--type", "Byte",
         "--outfile", str(mask), "--overwrite", "--quiet", "--hideNoData", "--NoDataValue", "0"])
    feats = polygonize(mask, td / "gebco_polys.geojson")
    print(f"  {len(feats)} raw land features")
    return feats


def classify_gebco_region(center: tuple[float, float]) -> str:
    if point_in_bbox(center, MATSU_BBOX):
        return "matsu"
    # Nothing on the Fujian coast reaches this far east — Taiwan's own strait
    # coast starts around 120.0-120.1E, so >121.3E in the (already
    # GEBCO_INCLUDE_BBOX-filtered) remainder is Taiwan's own outlying islands.
    if center[0] > 121.3:
        return "taiwan_outlying"
    return "china_coast"


def main() -> int:
    for p in (PENGHU_DTM, KINMEN_DTM, GEBCO_TIF):
        if not p.exists():
            print(f"缺失來源：{p}", file=sys.stderr)
            return 1

    rings: list[dict] = []

    with tempfile.TemporaryDirectory() as td_str:
        td = Path(td_str)

        for name, dtm_src, window, native_bbox, region, land_min_m in (
            ("penghu", PENGHU_DTM, PENGHU_WINDOW, PENGHU_NATIVE_BBOX, "penghu", PENGHU_LAND_MIN_M),
            ("kinmen", KINMEN_DTM, KINMEN_WINDOW, KINMEN_NATIVE_BBOX, "kinmen", KINMEN_LAND_MIN_M),
        ):
            for feat in fine_pass(name, dtm_src, window, land_min_m, td):
                ring = feat["geometry"]["coordinates"][0]
                area = ring_area_km2(ring)
                if area < MIN_AREA_KM2:
                    continue
                rings.append({"ring": ring, "source": "nlsc", "region": region, "area_km2": area})

        gebco_feats = coarse_pass(td)
        dropped_taiwan = dropped_dup = dropped_small = dropped_foreign = 0
        for feat in gebco_feats:
            ring = feat["geometry"]["coordinates"][0]
            area = ring_area_km2(ring)
            if area < MIN_AREA_KM2:
                dropped_small += 1
                continue
            bbox = ring_bbox(ring)
            center = bbox_center(bbox)
            if not point_in_bbox(center, GEBCO_INCLUDE_BBOX):
                dropped_foreign += 1
                continue
            if point_in_bbox(center, PENGHU_WINDOW) or point_in_bbox(center, KINMEN_WINDOW):
                dropped_dup += 1
                continue
            if (point_in_bbox(center, TAIWAN_MAIN_BBOX) and area > TAIWAN_MAIN_MIN_AREA_KM2) \
                    or point_in_ring(TAIWAN_REF_POINT, ring):
                dropped_taiwan += 1
                continue
            region = classify_gebco_region(center)
            rings.append({"ring": ring, "source": "gebco", "region": region, "area_km2": area})

        print(f"[coastlines] GEBCO pass filtered: -{dropped_taiwan} 本島 / "
              f"-{dropped_dup} 澎金重複 / -{dropped_small} <{MIN_AREA_KM2}km² / "
              f"-{dropped_foreign} 域外（日本八重山/菲律賓巴丹）")

    for r in rings:
        tol = NLSC_TOL if r["source"] == "nlsc" else GEBCO_TOL
        r["points"] = simplify_ring(r["ring"], tol)
        del r["ring"]

    by_region: dict[str, int] = {}
    for r in rings:
        by_region[r["region"]] = by_region.get(r["region"], 0) + 1

    w, s, e, n = GEBCO_INCLUDE_BBOX
    payload = {
        "bbox": {"minLon": w, "maxLon": e, "minLat": s, "maxLat": n},
        "rings": [
            {"points": [[round(x, 5), round(y, 5)] for x, y in r["points"]],
             "source": r["source"], "region": r["region"],
             "area_km2": round(r["area_km2"], 3)}
            for r in rings
        ],
        "note": (
            "本島以外的海岸線 ring（澎湖/金門+烈嶼/馬祖/中國沿岸/台灣自身離島），供"
            "coastline_taiwan.json（本島單一 ring，未變動）的姊妹圖層。region: penghu/kinmen="
            "source=nlsc（20m DTM 實測，50-100m 級 DP 簡化）；matsu/china_coast/taiwan_outlying="
            "source=gebco（GEBCO_2025 450m 網格，500m 級 DP 簡化，無更高解析度可用）。"
            "taiwan_outlying 為 GEBCO 順帶解出的台灣自身離島（龜山島/綠島/蘭嶼等），非任務原始"
            "範圍但屬於「新增的島」，一併保留。陸海判定：penghu/kinmen（source=nlsc）用"
            "DTM elevation>LAND_MIN_M（不是單純有效像素——兩軌 DTM 在潮間帶/淺灘都有非"
            "nodata 的實測值，純用有效像素會把金門本島與烈嶼之間的潮間帶當陸地黏成一塊，"
            "也讓澎湖膨脹數倍；金門 LAND_MIN_M=3.0m 才能斷開烈嶼海峽，澎湖 LAND_MIN_M=0m"
            "即可貼合各島實際面積，見 bake_coastlines.py 內文）；也不再 OR GEBCO（金門實際"
            "島嶼距廈門僅數公里，OR 會把大陸沿岸黏進 ring；大陸沿岸改由 china_coast ring"
            "涵蓋，不缺）；matsu/china_coast/taiwan_outlying（source=gebco）用 GEBCO"
            "elevation>0。面積 < 0.5km² 的碎屑島已濾除。"
            "china_coast ring 為 GEBCO 子集 bbox 邊界裁切形狀（非完整封閉海岸線，如實反映資料"
            "範圍）；日本八重山群島（與那國/西表島等）與菲律賓巴丹群島（GEBCO 子集東緣/南緣"
            "帶到的域外島嶼）已排除，不在此圖層範圍內。"
        ),
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))

    size_kb = OUT_JSON.stat().st_size / 1024
    print(f"\n[coastlines] {len(rings)} rings → {OUT_JSON.name} ({size_kb:.1f} KB)")
    for region, n in sorted(by_region.items()):
        print(f"  {region}: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
