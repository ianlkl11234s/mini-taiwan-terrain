#!/usr/bin/env python3
"""Bake elevation onto 5 basic POI point sets from taipei-gis-analytics
processed GeoJSON/CSV, producing lean JSON in the same {meta, systems:
{id: {color, points}}} shape as stations.json / trail_signs.json (see
bake_layer_elevations.bake_stations / bake_trails.bake_trail_signs) so the
frontend can reuse createPointLayer's onActivate -> setSet(id, {...}) path
verbatim, per-type sets included where the source data supports it
(port_class_group / hospital level).

Sources (all WGS84 lon/lat, from ../taipei-gis-analytics/data/processed):
  - transportation/airport/airports_merged_latest.geojson (125 features —
    filtered to small/medium/large_airport, dropping heliport/balloonport/
    closed, which is what "機場" means in common usage; 57 kept)
  - transportation/ports/ports_20260527.geojson (277 Point features, split
    into 4 sets by port_class_group: 漁港/國際商港/國內商港/渡輪觀光碼頭)
  - fire/fire_stations/fire_stations_20260710.geojson (717 Point features,
    single set)
  - emergency_response/hospitals/{emergency_hospitals,emergency_hospitals_mohw}.csv
    (Phase 1 datagov 11-county + Phase 2 衛福部 PDF supplementary-county CSVs
    — see docs/data-catalog/emergency_response/hospitals.md: Phase 1 covers
    11 counties/169 rows, Phase 2 covers the OTHER 11/22 counties; concat
    Phase 1 + Phase 2 rows whose county isn't already in Phase 1, avoiding
    the double-count a naive full concat would produce), split into 4 sets
    by level (重度級/中度級/一般級/未分級)
  - police_justice/police_stations/police_stations_20260626.geojson (2065
    Point features, single set — facility_subtype kept per-point for pick(),
    not split into per-type sets: 派出所 dominates so a subtype split would
    be one giant set + several tiny ones, not a useful visual grouping)

DEM: reuses bake_layer_elevations.TileCache verbatim (now bathy/-corrected).

Outputs (always overwritten — safe to rerun):
  public/layers/airports.json
  public/layers/ports.json
  public/layers/fire_stations.json
  public/layers/hospitals.json
  public/layers/police_stations.json
"""
import csv
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
ANALYTICS = GIS_ROOT / "taipei-gis-analytics/data/processed"

AIRPORT_SRC = ANALYTICS / "transportation/airport/airports_merged_latest.geojson"
PORTS_SRC = ANALYTICS / "transportation/ports/ports_20260527.geojson"
FIRE_SRC = ANALYTICS / "fire/fire_stations/fire_stations_20260710.geojson"
HOSPITALS_P1_SRC = ANALYTICS / "emergency_response/hospitals/emergency_hospitals.csv"
HOSPITALS_P2_SRC = ANALYTICS / "emergency_response/hospitals/emergency_hospitals_mohw.csv"
POLICE_SRC = ANALYTICS / "police_justice/police_stations/police_stations_20260626.geojson"

AIRPORT_KEEP_TYPES = {"small_airport", "medium_airport", "large_airport"}
AIRPORT_COLOR = "#2f6fd0"  # 機場藍

PORT_COLORS = {
    "漁港": "#17a2b8",
    "國際商港": "#0b5f73",
    "國內商港": "#3ddad7",
    "渡輪觀光碼頭": "#7fd8d3",
}
PORT_FALLBACK_COLOR = "#1fb6b6"  # 港口青

FIRE_COLOR = "#d9342b"  # 消防紅

HOSPITAL_COLORS = {
    "重度級": "#1b5e20",
    "中度級": "#43a047",
    "一般級": "#8bc34a",
    "未分級": "#9aa0a6",
}

POLICE_COLOR = "#16325c"  # 警察深藍


def load_geojson(path):
    return json.loads(path.read_text())["features"]


def load_csv(path):
    with path.open(encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def bake_airports(cache):
    feats = [f for f in load_geojson(AIRPORT_SRC) if f["properties"].get("airport_type") in AIRPORT_KEEP_TYPES]
    points = []
    for f in feats:
        pr = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        points.append(
            {
                "name": pr.get("name_zh") or pr.get("name") or "",
                "icao": pr.get("icao") or "",
                "iata": pr.get("iata") or "",
                "type": pr.get("airport_type_zh") or pr.get("airport_type") or "",
                "elevFt": pr.get("elevation_ft"),
                "lon": round(lon, 5),
                "lat": round(lat, 5),
                "elev": cache.elevation(lon, lat),
            }
        )
    return {"default": {"color": AIRPORT_COLOR, "points": points}}, len(feats)


def bake_ports(cache):
    feats = load_geojson(PORTS_SRC)
    systems = {}
    for f in feats:
        pr = f["properties"]
        group = pr.get("port_class_group") or "其他"
        lon, lat = f["geometry"]["coordinates"]
        entry = systems.setdefault(group, {"color": PORT_COLORS.get(group, PORT_FALLBACK_COLOR), "points": []})
        entry["points"].append(
            {
                "name": pr.get("name") or "",
                "class": pr.get("port_class") or "",
                "county": pr.get("county") or "",
                "lon": round(lon, 5),
                "lat": round(lat, 5),
                "elev": cache.elevation(lon, lat),
            }
        )
    return systems, len(feats)


def bake_fire_stations(cache):
    feats = load_geojson(FIRE_SRC)
    points = []
    for f in feats:
        pr = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        points.append(
            {
                "name": pr.get("name") or "",
                "type": pr.get("type") or "",
                "address": pr.get("address") or "",
                "lon": round(lon, 5),
                "lat": round(lat, 5),
                "elev": cache.elevation(lon, lat),
            }
        )
    return {"default": {"color": FIRE_COLOR, "points": points}}, len(feats)


def bake_hospitals(cache):
    p1 = load_csv(HOSPITALS_P1_SRC)
    p2 = load_csv(HOSPITALS_P2_SRC)
    p1_counties = set(r["county_id"] for r in p1)
    # Phase 2 (衛福部 PDF) only supplements the counties Phase 1's datagov
    # fetch missed — see docs/data-catalog/emergency_response/hospitals.md
    # ("Phase 1 僅 11 縣 169 家；Phase 2 補 10 漏網縣 +83 家，合併 22 縣全覆蓋
    # 252 家"). A naive full concat of both CSVs double-counts the counties
    # both phases cover (Phase 2 is itself a national list, not a delta).
    rows = list(p1) + [r for r in p2 if r["county_id"] not in p1_counties]
    systems = {}
    for r in rows:
        try:
            lat = float(r["lat"])
            lng = float(r["lng"])
        except (KeyError, ValueError):
            continue
        level = r.get("level") or "未分級"
        entry = systems.setdefault(level, {"color": HOSPITAL_COLORS.get(level, HOSPITAL_COLORS["未分級"]), "points": []})
        entry["points"].append(
            {
                "name": r.get("name") or "",
                "level": level,
                "trauma": r.get("has_trauma_center") == "True",
                "stroke": r.get("has_stroke_center") == "True",
                "address": r.get("address") or "",
                "lon": round(lng, 5),
                "lat": round(lat, 5),
                "elev": cache.elevation(lng, lat),
            }
        )
    return systems, len(rows)


def bake_police(cache):
    feats = load_geojson(POLICE_SRC)
    points = []
    for f in feats:
        pr = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        points.append(
            {
                "name": pr.get("name") or "",
                "subtype": pr.get("facility_subtype") or "",
                "address": pr.get("address") or "",
                "lon": round(lon, 5),
                "lat": round(lat, 5),
                "elev": cache.elevation(lon, lat),
            }
        )
    return {"default": {"color": POLICE_COLOR, "points": points}}, len(feats)


def _kb(p):
    return f"{p.stat().st_size / 1024:.1f} KB"


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")

    jobs = [
        ("airports.json", "airports", bake_airports),
        ("ports.json", "ports", bake_ports),
        ("fire_stations.json", "fire stations", bake_fire_stations),
        ("hospitals.json", "hospitals", bake_hospitals),
        ("police_stations.json", "police stations", bake_police),
    ]

    for filename, label, fn in jobs:
        print(f"baking {label} ...")
        cache = TileCache()
        systems, feature_count = fn(cache)
        point_count = sum(len(s["points"]) for s in systems.values())
        out = {
            "meta": {
                "generated": generated,
                "featureCount": feature_count,
                "pointCount": point_count,
                "systems": sorted(systems.keys()),
                "tileFallback": cache.hits,
            },
            "systems": systems,
        }
        out_path = OUT_DIR / filename
        out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
        print(
            f"  {filename}: {point_count}/{feature_count} points, sets={sorted(systems.keys())}"
            f"  (tile z13={cache.hits['z13']} z12={cache.hits['z12']} sea/missing={cache.hits['sea']})"
            f"  -> {_kb(out_path)}"
        )


if __name__ == "__main__":
    main()
