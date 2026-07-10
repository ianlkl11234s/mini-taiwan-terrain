#!/usr/bin/env python3
"""Bake elevation onto Forestry Bureau hiking-trail lines and trail-sign
points from the local DEM tile set, mirroring bake_layer_elevations.py's
rail/stations output convention (same DEM sampler, same lean-JSON shape).

Sources (all WGS84 lon/lat, from ../taipei-gis-analytics):
  - trail lines GeoJSON (data/intermediate/forestry/trail_profiles/trails.geojson,
    49 LineString features carrying 路線名/分署/length_km/ascent_m/descent_m/
    elev_min_m/elev_max_m/county — only name/length/ascent/county are kept,
    the rest is source-side QA metadata we don't need on the client)
  - trail-sign points GeoJSON (data/processed/forestry/mountain_trail_signs/
    mountain_trail_signs.geojson, 3407 Point features — only 路線名/分署 are
    kept; 序號/設置地/TWD97_X/TWD97_Y/年度/團體 are dropped)

DEM: reuses bake_layer_elevations.TileCache verbatim (terrarium-encoded PNG
tiles under public/tiles/{z}/{x}/{y}.png, z13 -> z12 -> sea(0m) fallback) —
no new sampling logic here.

Outputs (always overwritten — safe to rerun):
  public/layers/trails.json       (lines, shape aligned with rail_lines.json)
  public/layers/trail_signs.json  (points, shape aligned with stations.json)
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
from bake_layer_elevations import TileCache  # noqa: E402 (reuse DEM sampler, don't reinvent)

ROOT = SCRIPTS_DIR.parent
OUT_DIR = ROOT / "public" / "layers"

GIS_ROOT = Path("/Users/migu/Desktop/資料庫/gen_ai_try/ichef_工作用/GIS")
TRAILS_SRC = GIS_ROOT / "taipei-gis-analytics/data/intermediate/forestry/trail_profiles/trails.geojson"
SIGNS_SRC = GIS_ROOT / "taipei-gis-analytics/data/processed/forestry/mountain_trail_signs/mountain_trail_signs.geojson"

TRAIL_COLOR = "#5a8f3d"  # single trail-line color (layer-builder can restyle per-line later)
SIGN_COLOR = "#8d6e42"  # trail-sign marker color


def bake_trail_lines(cache):
    data = json.loads(TRAILS_SRC.read_text())
    lines_out = []
    elev_checks = []
    for feat in data["features"]:
        pr = feat["properties"]
        geom = feat["geometry"]
        coords = geom["coordinates"] if geom["type"] == "LineString" else geom["coordinates"][0]
        points = [[round(lon, 5), round(lat, 5), cache.elevation(lon, lat)] for lon, lat in coords]
        elevs = [p[2] for p in points]
        lines_out.append(
            {
                "name": pr.get("路線名") or "",
                "county": pr.get("county") or "",
                "lengthKm": round(pr.get("length_km") or 0, 2),
                "ascentM": round(pr.get("ascent_m") or 0),
                "color": TRAIL_COLOR,
                "points": points,
            }
        )
        elev_checks.append(
            {
                "name": pr.get("路線名"),
                "srcMin": pr.get("elev_min_m"),
                "srcMax": pr.get("elev_max_m"),
                "bakedMin": min(elevs) if elevs else None,
                "bakedMax": max(elevs) if elevs else None,
            }
        )
    return lines_out, len(data["features"]), elev_checks


def bake_trail_signs(cache):
    data = json.loads(SIGNS_SRC.read_text())
    points = []
    for feat in data["features"]:
        pr = feat["properties"]
        lon, lat = feat["geometry"]["coordinates"]
        points.append(
            {
                "name": pr.get("路線名") or "",
                "dept": pr.get("分署") or "",
                "lon": round(lon, 5),
                "lat": round(lat, 5),
                "elev": cache.elevation(lon, lat),
            }
        )
    return points, len(data["features"])


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")

    print("baking trail lines ...")
    trail_cache = TileCache()
    lines, trail_feature_count, elev_checks = bake_trail_lines(trail_cache)
    vertex_count = sum(len(l["points"]) for l in lines)
    trails_out = {
        "meta": {
            "generated": generated,
            "trailCount": trail_feature_count,
            "vertexCount": vertex_count,
            "tileFallback": trail_cache.hits,
        },
        "lines": lines,
    }
    (OUT_DIR / "trails.json").write_text(json.dumps(trails_out, ensure_ascii=False, separators=(",", ":")))

    print("baking trail signs ...")
    sign_cache = TileCache()
    sign_points, sign_feature_count = bake_trail_signs(sign_cache)
    signs_out = {
        "meta": {
            "generated": generated,
            "signCount": len(sign_points),
            "tileFallback": sign_cache.hits,
        },
        "systems": {
            "signs": {"color": SIGN_COLOR, "points": sign_points},
        },
    }
    (OUT_DIR / "trail_signs.json").write_text(json.dumps(signs_out, ensure_ascii=False, separators=(",", ":")))

    def _kb(p):
        return f"{p.stat().st_size / 1024:.1f} KB"

    print(
        f"trails.json      : {trail_feature_count} trails / {vertex_count} vertices"
        f"  (tile z13={trail_cache.hits['z13']} z12={trail_cache.hits['z12']} sea/missing={trail_cache.hits['sea']})"
    )
    print(
        f"trail_signs.json : {len(sign_points)}/{sign_feature_count} signs"
        f"  (tile z13={sign_cache.hits['z13']} z12={sign_cache.hits['z12']} sea/missing={sign_cache.hits['sea']})"
    )
    print(f"wrote -> {OUT_DIR / 'trails.json'} ({_kb(OUT_DIR / 'trails.json')})")
    print(f"wrote -> {OUT_DIR / 'trail_signs.json'} ({_kb(OUT_DIR / 'trail_signs.json')})")

    print("\nsample elevation check (source elev_min/max_m vs baked min/max, first 2 + last 2 trails):")
    for c in elev_checks[:2] + elev_checks[-2:]:
        print(f"  {c['name']}: src=({c['srcMin']:.0f}, {c['srcMax']:.0f})  baked=({c['bakedMin']}, {c['bakedMax']})")


if __name__ == "__main__":
    main()
