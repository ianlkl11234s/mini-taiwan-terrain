#!/usr/bin/env python3
"""Bake the nationwide 醫療設施 POI (hospitals/clinics/pharmacies) point set —
the "F 醫療設施 POI" overnight-chain layer. Complements (does NOT replace) the
existing hospitals.json layer ("急救醫院 Hospitals" — 232 emergency-responsible
hospitals only, bake_poi_layers.py:bake_hospitals) with the FULL national roll
of 健保特約醫事機構 (NHI-contracted medical institutions).

---- Source correction (read before touching the "42MB" brief) -------------
The task brief pointed at
  ../taipei-gis-analytics/data/processed/poi/medical/medical/*.geojson
describing it as "42MB, NLSC 六角網格抓取, 含醫院/診所/藥局". Investigated and
that description does NOT match the file actually at that path:
  - poi/medical/medical/six_cities_medical_20260122.geojson (2,178 features)
    + .../基隆_..._連江_medical_20260604.geojson (1,080 features) ARE the NLSC
    MarkBufferAnlys hex-grid fetch (docs/data-catalog/poi/medical.md), but
    together they're only ~1.6 MB and their `marktype` codes are 9930101
    (醫院/衛生所) / 9930301-04 (托嬰中心/長照中心/婦女中心/身障福利機構) — i.e.
    社會福利設施, NOT 醫院/診所/藥局, and NO 藥局 category exists at all in
    that source.
  - The file that actually IS ~42 MiB (44,157,815 bytes = 42.11 MiB) sits one
    directory up: poi/medical/nhi_institutions_geocoded.geojson — the
    衛福部/健保署 NHI-contracted institution registry, geocoded via TGOS
    (+ Google fallback). ITS `category` field is exactly {hospital_*, clinic,
    pharmacy, ...} — the medical/診所/藥局 split the brief actually describes.
    It also covers all 22 counties, not just 六都 (see county breakdown in the
    printed report below).
This script therefore bakes nhi_institutions_geocoded.geojson, not the NLSC
hex-grid files. Flagged as a deviation in the delivery report; the NLSC files
remain untouched (still exactly what docs/data-catalog/poi/medical.md
describes) in case a future task wants the 社福設施 content specifically.

---- Category mapping (source `category` -> this layer's int enum) ---------
  hospital_medical_center / hospital_regional / hospital_district -> 0 醫院
  clinic                                                          -> 1 診所
  pharmacy                                                        -> 2 藥局
  everything else (home_nursing/health_center/rehab_home/lab/
    speech_therapy/physical_therapy/midwifery/medical_radiology/
    occupational_therapy/other_nhi -- 1,707 rows, ~5.4% of the 31,603 total)
  -> DROPPED. The task spec is an explicit 3-value int enum (醫院/診所/藥局);
     these don't fit any of the three and aren't "medical facilities" in the
     common-usage sense the layer name implies (a home-nursing agency isn't a
     place you'd point at on the map looking for a clinic). Counts printed by
     this script so the drop is auditable, not silent.

---- Fields kept per point (thinning for the JSON payload) ------------------
  name, cat (int 0/1/2), county (short string, for the pick-card 1-line
  extra the brief asked for), lon/lat (rounded 5dp -> ~1.1m precision, plenty
  for a point icon), elev (DEM-baked, TileCache below). Dropped: facility_id,
  address, phone, specialties (huge free-text list per hospital), services,
  open_hours, contract_type/dates, source_did, geocode_source, form_type,
  district_code, facility_kind, address_matched — none of that earns its
  weight across ~30k rows; name+county is enough for the pick popup.

---- Size measurement (printed at bake time; ALSO recorded here so the
     decision has a paper trail) ----------------------------------------
  Baked output: 2.83 MB for 29,896 points, 451 醫院 / 21,765 診所 / 7,680 藥局
  (measured 2026-07-12; dropped 1,707 non-3-category rows, 22 counties + 8
  points with a blank county string covered). That lands in the 2-8 MB
  bracket of the repo's 3-way data rule -> uploaded to R2 (rclone copy ...
  r2:terrain-tiles/layers/ --s3-no-check-bucket, mirroring bake_ship_trails.py's
  upload_to_r2) rather than committed to git. The bake output therefore lives
  in scripts/.cache/medical/ (gitignored, like ship_trails' own cache dir),
  NOT public/layers/ — a >2MB file sitting in public/layers/ would just be an
  untracked-but-easy-to-`git add -A`-by-accident footgun for the next person.
  public/layers/manifest.json's "medical" entry points straight at the
  absolute CDN URL `https://tiles.itsmigu.com/layers/medical.json` (there's no
  way to bake a build-time VITE_TILE_BASE substitution into a static JSON
  manifest file, so this hardcodes the same resolved value vectortiles.js's
  VECTOR_BASE fallback already hardcodes) — fetched lazily on first layer
  activation (same onActivate-fetch, fail-quiet pattern as every other POI
  layer here), with NO local git copy at all (unlike the <2MB packs in this
  repo, which keep a git copy AND could add an R2 mirror). Known caveat: the
  existing Cloudflare Cache Rule only covers `*.pmtiles` + `/ships/trails/`
  (see docs/HANDOFF.md) — `/layers/*.json` on R2 is NOT covered yet, so every
  fetch round-trips to R2 origin instead of hitting Cloudflare's edge cache.
  Not a correctness issue (R2 serves it fine either way) but a perf follow-up
  worth a backlog line, same shape as HANDOFF's existing backlog #5.

DEM: reuses bake_layer_elevations.TileCache verbatim (bathy-corrected), same
as bake_poi_layers.py.

Output (always overwritten — safe to rerun):
  scripts/.cache/medical/medical.json (local bake cache, gitignored)
  -> rclone copy -> r2:terrain-tiles/layers/medical.json (unless --skip-upload)

Usage:
  python3 scripts/bake_medical_poi.py                # bake + upload + verify
  python3 scripts/bake_medical_poi.py --skip-upload  # bake + measure only
"""
import argparse
import json
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import requests

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
from bake_layer_elevations import TileCache  # noqa: E402 (reuse DEM sampler, don't reinvent)

ROOT = SCRIPTS_DIR.parent
OUT_DIR = SCRIPTS_DIR / ".cache" / "medical"
OUT_PATH = OUT_DIR / "medical.json"
R2_REMOTE_DIR = "r2:terrain-tiles/layers/"
CDN_URL = "https://tiles.itsmigu.com/layers/medical.json"

GIS_ROOT = Path("/Users/migu/Desktop/資料庫/gen_ai_try/ichef_工作用/GIS")
SRC = GIS_ROOT / "taipei-gis-analytics/data/processed/poi/medical/nhi_institutions_geocoded.geojson"

CATEGORY_MAP = {
    "hospital_medical_center": 0,
    "hospital_regional": 0,
    "hospital_district": 0,
    "clinic": 1,
    "pharmacy": 2,
}
CAT_NAMES = ["醫院", "診所", "藥局"]  # index == enum value, mirrored in src/engine/medical.js


def upload_to_r2(path):
    print(f"[medical] rclone copy -> {R2_REMOTE_DIR}")
    result = subprocess.run(
        # --s3-no-check-bucket: same scoped-token workaround as
        # bake_ship_trails.py's upload_to_r2 (this repo's R2 token can't
        # HeadBucket/ListAllMyBuckets; the bucket already exists and works).
        ["rclone", "copy", str(path), R2_REMOTE_DIR, "-v", "--s3-no-check-bucket"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"rclone copy failed: exit {result.returncode}\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
    if "Copied" in result.stderr or "Copied" in result.stdout:
        print("[medical] uploaded (new or changed)")
    else:
        print("[medical] rclone: remote already up to date, skipped transfer")


def verify_cdn():
    try:
        resp = requests.head(CDN_URL, timeout=15)
    except requests.RequestException as e:
        print(f"[medical] verify FAILED: {e}")
        return False
    ok = resp.status_code == 200
    ctype = resp.headers.get("content-type", "?")
    clen = resp.headers.get("content-length", "?")
    print(f"[medical] verify {'OK' if ok else 'FAIL'}: GET {CDN_URL} -> {resp.status_code}, content-type={ctype}, content-length={clen}")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-upload", action="store_true", help="bake + measure only, skip rclone/verify")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"reading {SRC} ...")
    data = json.loads(SRC.read_text())
    feats = data["features"]
    print(f"  {len(feats)} source features")

    cache = TileCache()
    points = []
    dropped = Counter()
    kept_by_cat = Counter()
    counties = Counter()
    for f in feats:
        pr = f["properties"]
        src_cat = pr.get("category")
        cat = CATEGORY_MAP.get(src_cat)
        if cat is None:
            dropped[src_cat] += 1
            continue
        geom = f.get("geometry")
        if not geom or geom.get("type") != "Point":
            dropped["_no_geometry"] += 1
            continue
        lon, lat = geom["coordinates"]
        county = pr.get("county") or ""
        points.append(
            {
                "name": pr.get("name") or "",
                "cat": cat,
                "county": county,
                "lon": round(lon, 5),
                "lat": round(lat, 5),
                "elev": cache.elevation(lon, lat),
            }
        )
        kept_by_cat[cat] += 1
        counties[county] += 1

    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = {
        "meta": {
            "generated": generated,
            "source": "taipei-gis-analytics/data/processed/poi/medical/nhi_institutions_geocoded.geojson",
            "featureCount": len(feats),
            "pointCount": len(points),
            "categories": CAT_NAMES,
            "countsByCategory": {CAT_NAMES[k]: v for k, v in sorted(kept_by_cat.items())},
            "droppedCategories": dict(dropped),
            "countyCoverage": dict(sorted(counties.items(), key=lambda kv: -kv[1])),
            "tileFallback": cache.hits,
        },
        "points": points,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    size_mb = OUT_PATH.stat().st_size / (1024 * 1024)
    print(f"kept {len(points)}/{len(feats)} points (dropped {sum(dropped.values())} non-醫院/診所/藥局 rows)")
    print(f"by category: {dict(kept_by_cat)}")
    print(f"dropped categories: {dict(dropped)}")
    print(f"counties covered: {len(counties)}")
    print(f"tile fallback: {cache.hits}")
    print(f"-> {OUT_PATH} ({size_mb:.2f} MB)")

    if not args.skip_upload:
        upload_to_r2(OUT_PATH)
        verify_cdn()


if __name__ == "__main__":
    main()
