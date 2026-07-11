#!/usr/bin/env python3
"""Bake OSM power towers + wind turbines into lean point JSON for the 3D
"電塔 Power Towers" / "風機 Wind Turbines" overlays (src/engine/energy.js).

Sources (all WGS84 lon/lat, from ../taipei-gis-analytics/data/processed):
  - energy/osm_power_towers/osm_power_towers_20260615.geojson
    (26,589 Point features, `power=tower`). `voltage` (volts, string) is
    present on only 8/26,589 features (Overpass coverage is thin) — see
    VOLTAGE_CLASS below for the height-bucket fallback this forces.
  - energy/osm_wind_turbines/osm_wind_turbines_20260615.geojson
    (812 Point features, `generator:source=wind`). `generator:output:
    electricity` (free-text power rating, ~27% coverage per _manifest.json)
    is parsed into capacity_mw where parseable.

NOT baked here: energy/offshore_wind_zones (36 Polygon potential-site areas).
Per the task brief's own escape hatch ("不好掛就跳過並回報，不要為它重構"):
this dataset is a filled polygon (sea-zone outline), structurally nothing
like the point marker-set ("sets") mechanism the towers/turbines layers
below reuse, and airspace.py already demonstrates the "small baked polygon
extrusion" path this repo would need for a proper treatment — bolting that
onto the point-layer module would mean re-deriving that whole path for 36
features. Skipped; flagged again in the handoff report.

DEM: NOT sampled here — floor/ceiling-style absolute elevation doesn't apply
to these point features. Instead this reuses bake_layer_elevations.TileCache
verbatim (same as bake_poi_layers.py) to bake each point's own ground
elevation for instant placement (see markers.js's pointY / the module
header's "POI 層做法" convention); the frontend re-samples the live
heightField as a fallback if a point's tile wasn't resident at bake time.

Voltage -> height class (towers): most OSM power=tower nodes here carry no
voltage tag at all (8/26,589) — VOLTAGE_CLASS still buckets the few that do,
and everything else (the overwhelming majority) falls into vclass 0 (the
<=69kV / unknown bucket), which is the conservative "ordinary distribution
tower" default height. This is a real limitation of the source data, not a
parsing bug — documented in the printed report's vclass histogram.

Outputs (always overwritten — safe to rerun):
  public/layers/power_towers.json
  public/layers/wind_turbines.json
"""
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
from bake_layer_elevations import TileCache  # noqa: E402 (reuse DEM sampler, don't reinvent)

ROOT = SCRIPTS_DIR.parent
OUT_DIR = ROOT / "public" / "layers"

GIS_ROOT = Path("/Users/migu/Desktop/資料庫/gen_ai_try/ichef_工作用/GIS")
TOWERS_SRC = GIS_ROOT / "taipei-gis-analytics/data/processed/energy/osm_power_towers/osm_power_towers_20260615.geojson"
TURBINES_SRC = GIS_ROOT / "taipei-gis-analytics/data/processed/energy/osm_wind_turbines/osm_wind_turbines_20260615.geojson"

# vclass -> real tower height (meters), per the design brief's 3-tier scheme.
# vclass 0 doubles as "voltage unknown" (see module docstring) — the vast
# majority of the dataset.
TOWER_HEIGHT_BY_CLASS = {0: 25, 1: 40, 2: 55}  # <=69kV(or unknown) / 161kV / >=300kV(345kV)


def voltage_class(voltage_str):
    """OSM `voltage` tag is volts as a string (e.g. "161000"), sometimes a
    ';'-joined multi-circuit list (e.g. "161000;69000") — take the max leg."""
    if not voltage_str:
        return 0
    best_kv = 0
    for part in str(voltage_str).split(";"):
        part = part.strip()
        if not part:
            continue
        try:
            kv = float(part) / 1000
        except ValueError:
            continue
        best_kv = max(best_kv, kv)
    if best_kv >= 300:
        return 2
    if best_kv >= 100:
        return 1
    return 0


CAPACITY_RE = re.compile(r"([\d.]+)\s*(MW|KW)", re.IGNORECASE)


def parse_capacity_mw(raw):
    """generator:output:electricity free text -> capacity_mw float, or None
    (covers 'yes'/blank/unrecognized units like the bare '600' outlier —
    ambiguous without a unit, left unparsed rather than guessed)."""
    if not raw:
        return None
    m = CAPACITY_RE.search(str(raw))
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2).upper()
    return round(val / 1000, 3) if unit == "KW" else round(val, 3)


def bake_towers(cache):
    feats = json.loads(TOWERS_SRC.read_text())["features"]
    points = []
    operators = []
    op_index = {}
    vclass_hist = Counter()
    for f in feats:
        pr = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        vc = voltage_class(pr.get("voltage"))
        vclass_hist[vc] += 1
        op = pr.get("operator")
        op_idx = None
        if op:
            op_idx = op_index.get(op)
            if op_idx is None:
                op_idx = len(operators)
                op_index[op] = op_idx
                operators.append(op)
        points.append(
            {
                "lon": round(lon, 5),
                "lat": round(lat, 5),
                "elev": cache.elevation(lon, lat),
                "v": pr.get("voltage"),  # raw voltage string (kept for pick() display), often null
                "vc": vc,
                "op": op_idx,  # index into `operators`, or None
            }
        )
    return points, operators, vclass_hist, len(feats)


def bake_turbines(cache):
    feats = json.loads(TURBINES_SRC.read_text())["features"]
    points = []
    parsed_count = 0
    for f in feats:
        pr = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        cap = parse_capacity_mw(pr.get("generator:output:electricity"))
        if cap is not None:
            parsed_count += 1
        points.append(
            {
                "lon": round(lon, 5),
                "lat": round(lat, 5),
                "elev": cache.elevation(lon, lat),
                "cap": cap,  # capacity_mw, or None if unparseable
                "op": pr.get("operator") or None,
            }
        )
    return points, parsed_count, len(feats)


def _kb(p):
    return f"{p.stat().st_size / 1024:.1f} KB"


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")

    print("baking power towers ...")
    cache = TileCache()
    points, operators, vclass_hist, feat_count = bake_towers(cache)
    towers_out = {
        "meta": {
            "generated": generated,
            "featureCount": feat_count,
            "pointCount": len(points),
            "operators": operators,
            "vclassHeightM": TOWER_HEIGHT_BY_CLASS,
            "vclassHistogram": dict(vclass_hist),
            "tileFallback": cache.hits,
        },
        "points": points,
    }
    towers_path = OUT_DIR / "power_towers.json"
    towers_path.write_text(json.dumps(towers_out, ensure_ascii=False, separators=(",", ":")))
    print(f"  power_towers.json: {len(points)}/{feat_count} points, vclass={dict(vclass_hist)} -> {_kb(towers_path)}")

    print("baking wind turbines ...")
    cache2 = TileCache()
    tpoints, parsed_count, tfeat_count = bake_turbines(cache2)
    turbines_out = {
        "meta": {
            "generated": generated,
            "featureCount": tfeat_count,
            "pointCount": len(tpoints),
            "capacityParsed": parsed_count,
            "tileFallback": cache2.hits,
        },
        "points": tpoints,
    }
    turbines_path = OUT_DIR / "wind_turbines.json"
    turbines_path.write_text(json.dumps(turbines_out, ensure_ascii=False, separators=(",", ":")))
    print(f"  wind_turbines.json: {len(tpoints)}/{tfeat_count} points, capacity parsed {parsed_count} -> {_kb(turbines_path)}")


if __name__ == "__main__":
    main()
