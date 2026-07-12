#!/usr/bin/env python3
"""Bake Taiwan restricted/danger airspace zones into a lean polygon JSON for
the 3D "airspace fence" overlay (src/engine/airspace.js).

Source (WGS84 lon/lat, from ../taipei-gis-analytics/data/processed):
  aviation/airspace/taiwan_airspace_3d.geojson (81 Polygon features — the
  merged Taiwan-only slice of the airspace dataset; the sibling per-country
  files in that folder, e.g. us_airspace_3d.geojson, are NOT used).

Category filter — the design brief asks for exactly three classes,
禁航(P, Prohibited) / 限航(R, Restricted) / 危險(D, Danger), and explicitly
excludes FIR/TMA/CTR (nationwide/terminal control structures whose footprint
would blanket the whole island and bury every other layer). Checking the
actual `layer` property distribution on the 81 features:

    RCR 29  ULZ 20  CTR 12  TMA 6  SURFACE 6  FIR 3  CONTROL 2  DANGER 2  CIRCUIT 1

RCR ("R" restricted areas — this file's own restricted_zones.geojson source,
see _manifest.json) maps directly to 限航/R, and DANGER maps directly to
危險/D. There is NO 禁航/Prohibited ("P") class anywhere in this dataset —
Taiwan's civil aviation authority designates security-sensitive no-fly areas
(e.g. RCR48 = Presidential Guard Office airspace, RCR45-47 = the three nuclear
plants) as numbered R-series restricted areas, not as a separate ICAO "P"
class. So the kept set below is R + D only (31 features); LAYER_CLASS_MAP is
still keyed generically so a future data revision that adds an explicit
Prohibited-labeled layer (e.g. "PROHIBITED") would fall into 'P' automatically
without a code change. ULZ (Ultra-Light [aircraft] Zone — sport-aviation
advisory areas, not a restriction on other traffic) and the CTR/TMA/FIR/
CONTROL/SURFACE/CIRCUIT control-zone family are all dropped.

floor_m/ceiling_m are ABSOLUTE elevations (meters AMSL) already computed
upstream from the raw floor_raw/ceiling_raw (SFC/GND/FT AMSL/FL...) strings —
NOT terrain-relative AGL heights, so no DEM sampling is needed here at all
(unlike the point-layer bakes in bake_poi_layers.py): the fence's floor/
ceiling plug directly into the engine's metersToWorldY(heightField, meters,
exaggeration) helper at render time.

Data-quality handling (both affect a small number of the 31 kept features —
flagged in the printed report and in meta.warnings):
  - CEILING_CLAMP_M: one feature (RCR18B, floor 5,516m/FL181 - ceiling
    12,192m/FL400) exceeds a sane fence height; ceilings above the clamp are
    capped so the extrusion never towers absurdly high. No other kept
    feature approaches the clamp.
  - Missing floor_m/ceiling_m: RCR7 (石礁) has null floor_m/ceiling_m in the
    source (a two-segment restricted area where the upstream bake kept only
    a partial parse — see its `warnings` property). Falls back to
    FALLBACK_FLOOR_M/FALLBACK_CEILING_M (SFC-FL050, a conservative generic
    restricted-area slab) rather than dropping the zone.

Output (always overwritten — safe to rerun):
  public/layers/airspace.json
"""
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "layers" / "airspace.json"

GIS_ROOT = Path("/Users/migu/Desktop/資料庫/gen_ai_try/ichef_工作用/GIS")
SRC = GIS_ROOT / "taipei-gis-analytics/data/processed/aviation/airspace/taiwan_airspace_3d.geojson"

# layer property -> our 3-class scheme. Only classes present get emitted; see
# module docstring for why 'P' currently has no matching source layer.
LAYER_CLASS_MAP = {
    "RCR": "R",  # 限航 Restricted
    "DANGER": "D",  # 危險 Danger
    # forward-compat: a future prohibited-area layer label would go here, e.g.
    # "PROHIBITED": "P",
}

CEILING_CLAMP_M = 10000  # sane max fence height (~FL330) — see docstring
FALLBACK_FLOOR_M = 0  # SFC
FALLBACK_CEILING_M = 1524  # FL050 / 5,000 ft — generic restricted-area slab

CLASS_LABELS = {"P": "禁航 Prohibited", "R": "限航 Restricted", "D": "危險 Danger"}


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(SRC.read_text())
    feats = data["features"]
    source_count = len(feats)

    zones = []
    clamped = []
    fallback_used = []
    excluded_layers = {}
    for f in feats:
        pr = f["properties"]
        layer = pr.get("layer")
        cls = LAYER_CLASS_MAP.get(layer)
        if cls is None:
            excluded_layers[layer] = excluded_layers.get(layer, 0) + 1
            continue
        geom = f["geometry"]
        if geom["type"] != "Polygon":
            continue  # none in the current dataset — guard for future revisions
        ring = geom["coordinates"][0]  # exterior only; no kept feature has holes

        code = pr.get("code") or ""
        floor_m = pr.get("floor_m")
        ceiling_m = pr.get("ceiling_m")
        if floor_m is None or ceiling_m is None:
            floor_m, ceiling_m = FALLBACK_FLOOR_M, FALLBACK_CEILING_M
            fallback_used.append(code)
        if ceiling_m > CEILING_CLAMP_M:
            clamped.append((code, ceiling_m))
            ceiling_m = CEILING_CLAMP_M
        if ceiling_m <= floor_m:
            ceiling_m = floor_m + 1  # degenerate guard, never hit by current data

        zones.append(
            {
                "code": code,
                "nameZh": pr.get("name_zh") or "",
                "nameEn": pr.get("name_en") or "",
                "cls": cls,
                "floorM": round(floor_m),
                "ceilingM": round(ceiling_m),
                "ring": [[round(lon, 5), round(lat, 5)] for lon, lat in ring],
            }
        )

    out = {
        "meta": {
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sourceFeatureCount": source_count,
            "featureCount": len(zones),
            "excludedLayers": excluded_layers,
            "classLabels": CLASS_LABELS,
            "ceilingClampM": CEILING_CLAMP_M,
            "clampedFeatures": clamped,
            "fallbackFeatures": fallback_used,
        },
        "zones": zones,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))

    print(f"source features: {source_count}")
    print(f"excluded (not P/R/D): {excluded_layers}")
    print(f"kept zones: {len(zones)} (by class: " f"{ {c: sum(1 for z in zones if z['cls']==c) for c in set(z['cls'] for z in zones)} })")
    print(f"ceiling-clamped: {clamped}")
    print(f"floor/ceiling fallback applied: {fallback_used}")
    print(f"-> {OUT} ({OUT.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
