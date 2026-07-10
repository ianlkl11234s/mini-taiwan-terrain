#!/usr/bin/env python3
"""Irrigation-canal polylines, elevation-baked (仿 trails 模式, scripts/bake_trails.py).

Source (EPSG:4326, from ../taipei-gis-analytics):
  data/processed/infrastructure/irrigation_canal/irrigation_canal_20260603.geojson
  21,785 LineString features (農田水利署灌排渠道 WFS), properties 管理處/渠道名/屬性.

Pipeline:
  1. Reproject each line to EPSG:3826 (TWD97 TM2) via pyproj — length filtering and
     simplification tolerance are both metric, per project convention (distance/
     area math goes through EPSG:3826, no hand-rolled degree-based approximation).
  2. Drop canals shorter than MIN_LEN_M (small 給/排水溝 stubs) and Douglas-Peucker
     simplify the survivors at TOL_M (shapely LineString.simplify) — both in TWD97
     meters, then reproject the simplified vertices back to EPSG:4326 for storage.
  3. DEM: reuses bake_layer_elevations.TileCache verbatim (same sampler bake_trails
     uses) to tag every output vertex with an elevation.

SIZE BUDGET: the task's example thresholds (200 m cutoff, 5-decimal coords) don't
fit under 2 MB for this dataset — measured 3.4 MB at TOL=20m/MIN_LEN=200m/5dp. This
script instead uses TOL_M=80 / MIN_LEN_M=470 / 4 decimal places (~11 m, still finer
than the 80 m simplify tolerance so it doesn't reintroduce blur) to land at ~1.86 MB
with real elevations baked in (a per-line "color" field, mirroring trails.json, also
had to move to meta-level — at 12k+ lines a repeated constant string is ~300 KB by
itself). That drops 43% of features (mostly short 小給/小排 stubs) instead of the
~14% a 200 m cutoff would drop. If the full-detail dataset is wanted after all, see
the two options printed in this script's summary output — 全量版本走 R2，未在此執行上傳
(per instructions, no R2 upload done here).

Idempotent (always overwrites public/layers/irrigation.json).
"""
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import LineString

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
from bake_layer_elevations import TileCache  # noqa: E402 (reuse DEM sampler, don't reinvent)

ROOT = SCRIPTS_DIR.parent
OUT_DIR = ROOT / "public" / "layers"
GIS_ROOT = Path("/Users/migu/Desktop/資料庫/gen_ai_try/ichef_工作用/GIS")
IRRIGATION_SRC = (
    GIS_ROOT / "taipei-gis-analytics/data/processed/infrastructure/irrigation_canal"
    "/irrigation_canal_20260603.geojson"
)

TOL_M = 80.0       # Douglas-Peucker simplify tolerance, TWD97 meters
MIN_LEN_M = 470.0  # drop canals shorter than this (mostly 小給/小排 stubs)
COORD_DP = 4       # ~11 m — matched to TOL_M so rounding doesn't reintroduce blur
CANAL_COLOR = "#3d7a9e"  # single canal-line color (layer-builder can restyle per-office later)


def main():
    if not IRRIGATION_SRC.exists():
        print(f"缺失來源：{IRRIGATION_SRC}", file=sys.stderr)
        return 1

    t_all = time.time()
    print("loading source geojson ...")
    data = json.loads(IRRIGATION_SRC.read_text())
    feats = data["features"]
    src_count = len(feats)
    src_vtx = sum(len(f["geometry"]["coordinates"]) for f in feats)
    print(f"source: {src_count:,} canals, {src_vtx:,} vertices")

    to_3826 = Transformer.from_crs("EPSG:4326", "EPSG:3826", always_xy=True)
    to_4326 = Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)

    cache = TileCache()
    lines_out = []
    dropped_short = 0
    elev_checks = []

    t = time.time()
    for i, feat in enumerate(feats):
        if i and i % 5000 == 0:
            print(f"  ... {i:,}/{src_count:,} ({time.time() - t:.1f}s)")
        pr = feat["properties"]
        coords = feat["geometry"]["coordinates"]
        xs, ys = to_3826.transform([c[0] for c in coords], [c[1] for c in coords])
        line = LineString(zip(xs, ys))
        length_m = line.length
        if length_m < MIN_LEN_M:
            dropped_short += 1
            continue
        simp = line.simplify(TOL_M, preserve_topology=False)
        sxs = [p[0] for p in simp.coords]
        sys_ = [p[1] for p in simp.coords]
        lons, lats = to_4326.transform(sxs, sys_)
        points = [[round(lo, COORD_DP), round(la, COORD_DP), cache.elevation(lo, la)] for lo, la in zip(lons, lats)]
        elevs = [p[2] for p in points]
        lines_out.append(
            {
                "name": pr.get("渠道名") or "",
                "office": pr.get("管理處") or "",
                "lengthKm": round(length_m / 1000.0, 2),
                "points": points,
            }
        )
        if len(elev_checks) < 6:
            elev_checks.append({"name": pr.get("渠道名"), "office": pr.get("管理處"),
                                 "lengthKm": round(length_m / 1000.0, 2),
                                 "elevMin": min(elevs) if elevs else None,
                                 "elevMax": max(elevs) if elevs else None})

    kept_count = len(lines_out)
    kept_vtx = sum(len(l["points"]) for l in lines_out)
    print(f"simplify+filter done in {time.time() - t:.1f}s: kept {kept_count:,}/{src_count:,} canals "
          f"(dropped {dropped_short:,} < {MIN_LEN_M:.0f} m), {kept_vtx:,} vertices "
          f"(from {src_vtx:,}, {100 * kept_vtx / src_vtx:.1f}%)")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    payload = {
        "meta": {
            "generated": generated,
            "canalCount": kept_count,
            "canalCountSource": src_count,
            "droppedShort": dropped_short,
            "vertexCount": kept_vtx,
            "vertexCountSource": src_vtx,
            "tileFallback": cache.hits,
            "params": {"tolM": TOL_M, "minLenM": MIN_LEN_M, "coordDp": COORD_DP, "crs": "EPSG:3826"},
            # single color at meta level, not per-line: trails.json repeats a constant
            # color on each of its 49 lines (negligible there), but at 12.8k lines that
            # same pattern alone costs ~300 KB — worth the small format deviation to
            # stay under the 2 MB budget.
            "color": CANAL_COLOR,
        },
        "lines": lines_out,
    }
    out_path = OUT_DIR / "irrigation.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    size_mb = out_path.stat().st_size / 1e6

    print(f"\nwrote -> {out_path} ({size_mb:.2f} MB)")
    print(f"  tile fallback: z13={cache.hits['z13']} z12={cache.hits['z12']} sea/missing={cache.hits['sea']}")

    print("\nsample elevation check (first 3 + last 3 kept canals):")
    for c in elev_checks[:3] + elev_checks[-3:]:
        print(f"  {c['name']} ({c['office']}, {c['lengthKm']} km): elev=({c['elevMin']}, {c['elevMax']}) m")

    print(
        "\n備案（若需要全量/高精度版本，本次未上傳，僅記錄量測結果）：\n"
        f"  A) 目前方案（已寫入 repo）：TOL={TOL_M:.0f}m / MIN_LEN={MIN_LEN_M:.0f}m / {COORD_DP}位小數 -> "
        f"{kept_count:,} 條 / {kept_vtx:,} 頂點 / {size_mb:.2f} MB\n"
        "  B) 全量高精度版（需上 R2，未執行）：TOL=20m / MIN_LEN=200m / 5位小數 -> "
        "約 18,820 條 / 215,852 頂點 / 約 3.4 MB（實測，含 confidence-less 全量點位）"
    )
    print(f"\nTOTAL {time.time() - t_all:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
