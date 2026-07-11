#!/usr/bin/env python3
"""Bake CDN snapshots of past-day ship AIS trails for the marine layer
(backlog #12, design doc docs/MARINE_DESIGN.md SS1.1).

Why this script exists
-----------------------
mini-taiwan-terrain and mini-taiwan-pulse share ONE Supabase project. Past
days are immutable (realtime.ship_positions for a closed day never
changes), so re-querying `get_ship_trails(target_date)` from every visitor's
browser on every load is pure waste and adds to a shared-DB abuse surface
that backlog #9 (rate limiting) hasn't closed yet. This script does that
query ONCE per day, server-side, trims the result, and ships a static JSON
snapshot to Cloudflare R2. The frontend (src/engine/ships.js, a later
phase) reads `{VITE_TILE_BASE}/ships/trails/{date}.json` first and only
falls back to a live RPC call for TODAY (whose snapshot cannot exist yet).

Source (gis-platform migrations/018_ship_flight_trail_rpc.sql)
-----------------------------------------------------------------
- `get_ship_dates()` -> TABLE(date TEXT, records BIGINT, ships BIGINT), one
  row per day that has >=1 ship position (backed by a materialized view
  refreshed every 30 min, so "today" may appear with a partial count).
- `get_ship_trails(target_date DATE)` -> TABLE(mmsi TEXT, ship_type TEXT,
  trail TEXT), one row per ship, `trail` = "lat,lng,ts;lat,lng,ts;..."
  (ts = integer epoch seconds), ordered by collected_at ASC server-side.
  There is no ship "name" field anywhere upstream (AIS name field isn't
  collected) -- the frontend contract's `name?` is intentionally optional
  and this script never emits it.
- Both are anon-grantable `public.*` wrappers -- no realtime.* schema is
  ever touched from this script, per repo rule.

anon key / URL: copied verbatim from src/engine/index.js's
fetchReservoirRatios() inline constants (same Supabase project, same
already-public anon key -- repo convention is one inline pair per bake/
runtime call site, not a shared client module).

Output contract (docs/MARINE_DESIGN.md SS1.2, consumed by ships.js later)
-----------------------------------------------------------------------
    {
      "meta": {"date", "ships", "points", "source", "decimation"},
      "trails": [{"mmsi", "ship_type", "points": [[lat, lng, ts], ...]}]
    }
Deliberately NOT the RPC's raw "lat,lng,ts;..." semicolon string -- the CDN
snapshot is pre-parsed into nested arrays so the frontend skips a parse
pass entirely (that's the whole point of a *baked* snapshot).

Trim pipeline (per ship, per day)
----------------------------------
1. Parse the semicolon trail into (lat, lng, ts) tuples (already time-
   sorted by the RPC's own ORDER BY).
2. GPS anomaly filter: drop any point implying >40 knots from the last
   *kept* point -- ported 1:1 from mini-taiwan-pulse's
   src/data/shipLoader.ts filterGpsAnomalies() (same KM_PER_DEG_LAT=111.0 /
   KM_PER_DEG_LNG=101.0 25 degN flat-earth approximation, same threshold).
3. Iterative Douglas-Peucker simplification in raw lat/lng degree space
   (adapted from scripts/bake_layer_elevations.py's dp_simplify -- same
   algorithm, lon/lat swapped to lat/lng, 3-tuples instead of 2-tuples so
   ts rides along by index). RDP naturally preserves heading-turn vertices
   and drops near-collinear redundant points, which is exactly "抽稀但保
   航向轉折" from the design doc. Endpoints are always kept.
4. The whole day shares ONE tolerance, searched by geometric growth
   (0.0001 deg ~11m start, x1.8 per step, capped at 0.02 deg ~2.2km) until
   the final JSON's `gzip -9` size is <=2MB (Cloudflare gzips responses;
   -9 is used here purely as a same-order-of-magnitude size estimate, not
   a claim about Cloudflare's actual compression ratio).
5. Ships left with <2 points after steps 2-3 are dropped (a single-point
   "trail" cannot animate -- tickView needs a [first, last] time range).

Idempotency
------------
- **Fetch**: a local cache file at `scripts/.cache/ship_trails/{date}.json`
  existing already means "already baked" (past days are immutable) --
  reruns skip the RPC call entirely unless --force. This is also the
  rate-limit courtesy measure described above.
- **Upload**: `rclone copy` is idempotent on its own (size+modtime compare
  against the remote object) -- this script always re-runs it for every
  target date's cache file and lets rclone decide whether a transfer is
  actually needed, rather than hand-rolling a second comparison layer.

Usage
-----
    python3 scripts/bake_ship_trails.py                # last 7 past days
    python3 scripts/bake_ship_trails.py --days 3
    python3 scripts/bake_ship_trails.py --force         # re-fetch + re-bake even if cached
    python3 scripts/bake_ship_trails.py --skip-upload   # bake + measure only, no rclone/curl

Dependencies: requests (only non-stdlib import) + a system `rclone` with
its `r2` remote already configured (`~/.config/rclone/rclone.conf` --
NOT this repo's gitignored .env; that file holds R2 credentials for other
tooling but this script shells out to rclone directly, same as the
`data-pipeline` skill's documented SOP).
"""
import argparse
import gzip
import json
import math
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

SUPABASE_URL = "https://utcmcikhvxnohbxchbrs.supabase.co"
SUPABASE_ANON = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0"
    "Y21jaWtodnhub2hieGNoYnJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1NjgyMDMsImV4"
    "cCI6MjA5MDE0NDIwM30.rQSjJ6WD53p9tRZ6M7xleDelktVHfKeZFGPC2ItULVQ"
)
RPC_HEADERS = {
    "apikey": SUPABASE_ANON,
    "Authorization": f"Bearer {SUPABASE_ANON}",
    "Content-Type": "application/json",
}
RPC_TIMEOUT_S = 90  # server statement_timeout is 60s; leave headroom

# GPS anomaly filter -- ported from mini-taiwan-pulse shipLoader.ts
MAX_SPEED_KNOTS = 40
KM_PER_DEG_LAT = 111.0
KM_PER_DEG_LNG = 101.0  # ~25 degN flat-earth approx, same as pulse

# RDP adaptive tolerance search (degrees)
RDP_TOL_START = 0.0001
RDP_TOL_MAX = 0.02
RDP_TOL_GROWTH = 1.8
TARGET_GZIP_BYTES = 2 * 1024 * 1024

CACHE_DIR = Path(__file__).resolve().parent / ".cache" / "ship_trails"
R2_REMOTE_DIR = "r2:terrain-tiles/ships/trails/"
CDN_URL_TMPL = "https://tiles.itsmigu.com/ships/trails/{date}.json"


# ---------------------------------------------------------------- RPC ----

def rpc(name, payload=None):
    """POST a public.* RPC. Returns (raw_response_bytes, parsed_json).
    Raises RuntimeError with the HTTP status + body snippet on failure --
    callers must NOT swallow this (repo rule: RPC failure stops the run,
    it does not silently fall back to something else)."""
    url = f"{SUPABASE_URL}/rest/v1/rpc/{name}"
    resp = requests.post(url, headers=RPC_HEADERS, json=payload or {}, timeout=RPC_TIMEOUT_S)
    if not resp.ok:
        raise RuntimeError(f"RPC {name} failed: HTTP {resp.status_code} {resp.text[:300]!r}")
    return resp.content, resp.json()


def fetch_ship_dates():
    _, rows = rpc("get_ship_dates")
    return rows


def pick_target_dates(dates_rows, n_days):
    """Most recent N dates strictly before today (Asia/Taipei), from the
    get_ship_dates() rows. Ascending order (oldest first) for stable
    progress printing."""
    today_tw = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    past = sorted(d["date"] for d in dates_rows if d["date"] < today_tw)
    return past[-n_days:]


# ------------------------------------------------------------- parsing ----

def parse_trail(trail):
    """'lat,lng,ts;lat,lng,ts;...' -> [(lat, lng, ts), ...], ts as int."""
    if not trail:
        return []
    pts = []
    for chunk in trail.split(";"):
        if not chunk:
            continue
        lat_s, lng_s, ts_s = chunk.split(",")
        pts.append((float(lat_s), float(lng_s), int(ts_s)))
    return pts


def filter_gps_anomalies(path):
    """Drop points implying >40 knots from the last KEPT point. 1:1 port of
    pulse shipLoader.ts filterGpsAnomalies. Returns (clean_path, dropped_count)."""
    if len(path) < 2:
        return list(path), 0
    kept = [path[0]]
    dropped = 0
    for cur in path[1:]:
        prev = kept[-1]
        dt_hours = (cur[2] - prev[2]) / 3600.0
        if dt_hours > 0:
            d_lat_km = (cur[0] - prev[0]) * KM_PER_DEG_LAT
            d_lng_km = (cur[1] - prev[1]) * KM_PER_DEG_LNG
            dist_km = math.hypot(d_lat_km, d_lng_km)
            speed_knots = dist_km / dt_hours / 1.852
            if speed_knots > MAX_SPEED_KNOTS:
                dropped += 1
                continue
        kept.append(cur)
    return kept, dropped


def rdp_simplify(path, tol_deg):
    """Iterative Douglas-Peucker on (lat, lng); ts rides along by index.
    Adapted from bake_layer_elevations.dp_simplify. Endpoints always kept."""
    n = len(path)
    if n < 3:
        return list(path)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        s, e = stack.pop()
        ax, ay = path[s][0], path[s][1]
        dx, dy = path[e][0] - ax, path[e][1] - ay
        seg2 = dx * dx + dy * dy
        dmax, idx = 0.0, -1
        for i in range(s + 1, e):
            px, py = path[i][0], path[i][1]
            if seg2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / seg2
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > dmax:
                dmax, idx = d, i
        if dmax > tol_deg and idx != -1:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    return [path[i] for i in range(n) if keep[i]]


def gzip_size(data_bytes):
    return len(gzip.compress(data_bytes, compresslevel=9))


# ------------------------------------------------------------- baking ----

def build_day_payload(date_str, rows):
    """rows: RPC result [{mmsi, ship_type, trail}, ...].
    Returns (payload_dict, body_bytes, gzip_bytes, stats_dict)."""
    raw_points = 0
    cleaned = []  # [{mmsi, ship_type, path: [(lat,lng,ts),...]}]
    dropped_anomalies = 0

    for row in rows:
        raw_path = parse_trail(row.get("trail"))
        raw_points += len(raw_path)
        clean_path, dropped = filter_gps_anomalies(raw_path)
        dropped_anomalies += dropped
        if len(clean_path) < 2:
            continue  # can't animate a single point -- drop the ship
        cleaned.append({"mmsi": row["mmsi"], "ship_type": row.get("ship_type"), "path": clean_path})

    tol = RDP_TOL_START
    attempts = []
    while True:
        out = []
        pts_count = 0
        for ship in cleaned:
            simplified = rdp_simplify(ship["path"], tol)
            pts_count += len(simplified)
            out.append({
                "mmsi": ship["mmsi"],
                "ship_type": ship["ship_type"],
                "points": [[round(p[0], 6), round(p[1], 6), p[2]] for p in simplified],
            })
        payload = {
            "meta": {
                "date": date_str,
                "ships": len(out),
                "points": pts_count,
                "source": "get_ship_trails",
                "decimation": f"gps_anomaly_filter+rdp_tol_deg={tol:.5f}",
            },
            "trails": out,
        }
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        gz = gzip_size(body)
        attempts.append({"tol_deg": round(tol, 5), "points": pts_count, "bytes": len(body), "gzip_bytes": gz})
        if gz <= TARGET_GZIP_BYTES or tol >= RDP_TOL_MAX:
            break
        tol *= RDP_TOL_GROWTH

    stats = {
        "raw_ships": len(rows),
        "raw_points": raw_points,
        "dropped_anomalies": dropped_anomalies,
        "final_ships": len(out),
        "final_points": pts_count,
        "final_bytes": len(body),
        "final_gzip_bytes": gz,
        "final_tol_deg": round(tol, 5),
        "attempts": attempts,
    }
    return payload, body, gz, stats


def process_date(date_str, force):
    """Returns (cache_path, stats_or_None). stats is None on a cache hit
    (nothing was re-measured -- past days are immutable so the numbers
    from the original bake still hold; use --force to re-measure)."""
    cache_path = CACHE_DIR / f"{date_str}.json"
    if cache_path.exists() and not force:
        print(f"[{date_str}] cache hit ({cache_path.stat().st_size/1e6:.2f} MB) -- skip RPC fetch")
        return cache_path, None

    print(f"[{date_str}] fetching get_ship_trails ...")
    raw_bytes, rows = rpc("get_ship_trails", {"target_date": date_str})
    raw_mb = len(raw_bytes) / 1e6
    print(f"[{date_str}] raw RPC payload: {raw_mb:.2f} MB, {len(rows)} ships")

    payload, body, gz, stats = build_day_payload(date_str, rows)
    stats["raw_rpc_bytes"] = len(raw_bytes)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(body)

    print(
        f"[{date_str}] baked: {stats['final_ships']}/{stats['raw_ships']} ships kept, "
        f"{stats['final_points']}/{stats['raw_points']} points kept "
        f"({stats['dropped_anomalies']} anomalies dropped), "
        f"tol={stats['final_tol_deg']}deg -> "
        # NOTE: MiB (1024-based), matching TARGET_GZIP_BYTES's own unit --
        # printing decimal MB here reads as "over 2MB" for values that are
        # actually under the 2*1024*1024 target (e.g. 2075449 B = 1.98 MiB
        # but 2.08 decimal MB), which is misleading in a measurement report.
        f"{stats['final_bytes']/1048576:.2f} MiB raw json / {gz/1048576:.2f} MiB gzip -9 ({gz} B)"
    )
    if len(stats["attempts"]) > 1:
        print(f"[{date_str}]   tolerance search: {len(stats['attempts'])} steps -> {stats['attempts']}")
    if gz > TARGET_GZIP_BYTES:
        print(f"[{date_str}]   WARNING: gzip size {gz/1048576:.2f} MiB still exceeds 2 MiB target at tol cap {RDP_TOL_MAX}deg")

    return cache_path, stats


# ------------------------------------------------------------- upload ----

def upload_to_r2(cache_path):
    print(f"[{cache_path.stem}] rclone copy -> {R2_REMOTE_DIR}")
    result = subprocess.run(
        # --s3-no-check-bucket: this repo's R2 API token is scoped to the
        # `terrain-tiles` bucket only (no s3:CreateBucket / ListAllMyBuckets
        # grant). Without this flag rclone's default preflight HeadBucket
        # check gets an ambiguous 403 from the scoped token, concludes the
        # bucket is missing, and tries (and fails) to auto-create it --
        # discovered empirically while wiring this script; the bucket
        # already exists and is readable (`rclone lsf r2:terrain-tiles/`
        # works fine), so skipping the check is correct, not a workaround.
        ["rclone", "copy", str(cache_path), R2_REMOTE_DIR, "-v", "--s3-no-check-bucket"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"rclone copy failed for {cache_path.name}: "
            f"exit {result.returncode}\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
    # rclone prints "Copied (...)" only when a transfer actually happened;
    # silent (empty -v output) means it decided the remote copy already matches.
    if "Copied" in result.stderr or "Copied" in result.stdout:
        print(f"[{cache_path.stem}] uploaded (new or changed)")
    else:
        print(f"[{cache_path.stem}] rclone: remote already up to date, skipped transfer")


def verify_cdn(date_str):
    url = CDN_URL_TMPL.format(date=date_str)
    try:
        resp = requests.head(url, timeout=15)
    except requests.RequestException as e:
        print(f"[{date_str}] curl verify FAILED: {e}")
        return False
    ok = resp.status_code == 200
    ctype = resp.headers.get("content-type", "?")
    clen = resp.headers.get("content-length", "?")
    tag = "OK" if ok else "FAIL"
    print(f"[{date_str}] verify {tag}: GET {url} -> {resp.status_code}, content-type={ctype}, content-length={clen}")
    return ok


# --------------------------------------------------------------- main ----

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7, help="how many past days to bake (default 7)")
    ap.add_argument("--force", action="store_true", help="re-fetch + re-bake even if a cache file already exists")
    ap.add_argument("--skip-upload", action="store_true", help="bake + measure only, skip rclone/curl")
    args = ap.parse_args()

    print("=== 1/3 get_ship_dates ===")
    dates_rows = fetch_ship_dates()
    targets = pick_target_dates(dates_rows, args.days)
    if not targets:
        print("No past dates with data found in get_ship_dates() -- nothing to bake.", file=sys.stderr)
        sys.exit(1)
    print(f"{len(dates_rows)} total dated rows from get_ship_dates(); baking {len(targets)} target date(s): {targets}")

    print("\n=== 2/3 fetch + trim per day ===")
    results = []  # [(date, cache_path, stats_or_None)]
    for i, date_str in enumerate(targets):
        cache_path, stats = process_date(date_str, args.force)
        results.append((date_str, cache_path, stats))
        if stats is not None and i < len(targets) - 1:
            time.sleep(0.5)  # polite spacing between live RPC calls (backlog #9 not closed yet)

    if args.skip_upload:
        print("\n--skip-upload set: not touching R2. Done.")
    else:
        print("\n=== 3/3 upload to R2 + verify CDN ===")
        upload_failures = []
        verify_failures = []
        for date_str, cache_path, _stats in results:
            try:
                upload_to_r2(cache_path)
            except RuntimeError as e:
                print(f"[{date_str}] UPLOAD ERROR: {e}", file=sys.stderr)
                upload_failures.append(date_str)
                continue
            if not verify_cdn(date_str):
                verify_failures.append(date_str)

        if upload_failures or verify_failures:
            print(
                f"\nFAILED: upload_failures={upload_failures} verify_failures={verify_failures}",
                file=sys.stderr,
            )
            sys.exit(1)

    print("\n=== measurement table ===")
    # gzip column is MiB (1024-based) to match TARGET_GZIP_BYTES's own unit
    # -- see the note in process_date(). raw/final json columns are plain
    # decimal MB (not gated by any threshold, decimal is the conventional
    # reading for "how big is this file on disk").
    header = f"{'date':<12} {'raw MB':>8} {'raw ships':>10} {'raw pts':>9} {'final MB':>9} {'gzip MiB':>9} {'final ships':>12} {'final pts':>10}"
    print(header)
    for date_str, cache_path, stats in results:
        if stats is None:
            size_mb = cache_path.stat().st_size / 1e6
            print(f"{date_str:<12} {'(cached)':>8} {'':>10} {'':>9} {size_mb:>9.2f} {'?':>9} {'':>12} {'':>10}")
            continue
        print(
            f"{date_str:<12} "
            f"{stats['raw_rpc_bytes']/1e6:>8.2f} "
            f"{stats['raw_ships']:>10} "
            f"{stats['raw_points']:>9} "
            f"{stats['final_bytes']/1e6:>9.2f} "
            f"{stats['final_gzip_bytes']/1048576:>9.2f} "
            f"{stats['final_ships']:>12} "
            f"{stats['final_points']:>10}"
        )


if __name__ == "__main__":
    main()
