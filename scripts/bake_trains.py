#!/usr/bin/env python3
"""Bake TRA (台鐵) real timetable + per-line-part station arc-length ratio
tables, so a future engine (layer-builder's job, NOT this script) can move
a light dot along rail_lines.json's TRA polylines using real clock time.

This script does NOT touch src/engine/** and does NOT bake elevation
(rail_lines.json points already carry elev from an earlier bake).

Sources
-------
- rail_lines.json (this repo, public/layers/rail_lines.json): 37
  system=="tra" line parts, EPSG:4326 lon/lat.
  IMPORTANT (discovered while writing this script, contradicts the
  original "name is a unique key" assumption): `name` is NOT unique --
  37 parts collapse to only 13 distinct name strings. Each named corridor
  is duplicated forward+reverse (mirrored geometry), AND 11 of the 37
  parts all share the generic/mislabeled name "海線 (彰化→竹南)" even
  though geometrically they cover several unrelated stretches of the
  west-trunk main line (verified: one such part's ratio==1.0 endpoint
  snaps to 高雄, 189km away from 竹南 -- clearly not really "彰化->竹南").
  2 more parts are literally named "tra" with no real corridor name.
  We therefore always key by ARRAY INDEX (0..36, same order as
  rail_lines.json's system=="tra" filter), never by name. train_tracks.json
  below is index-aligned 1:1 with that filter -- this is the contract the
  engine must rely on.
- stations.json (this repo, public/layers/stations.json, systems.tra):
  212 TRA stations, primary coordinate source per project convention.
- ../mini-taiwan-pulse/public/rail/tra/stations/stations.geojson: 244 TRA
  stations (TDX-sourced). Used to (a) fill in the ~32 stations that are
  genuinely ABSENT from this repo's 212 -- not renamed, just missing,
  including major hubs like 臺北/高雄/臺中/新竹/花蓮/臺東/基隆/宜蘭 -- and
  (b) resolve master_schedule's numeric station_id -> station name
  (master_schedule carries no names, only TDX station_ids).
  Cross-check result: all 212 terrain-art TRA station names have an exact
  string match in this 244-name set (0 alias conflicts needed; the one
  apparent oddity, terrain-art's "臺北-環島" vs plain "臺北", turned out to
  be two genuinely different TDX station_ids -- 1001 vs 1000 -- both
  present verbatim in the pulse set, not a naming mismatch).
- ../mini-taiwan-pulse/public/rail/tra/master_schedule.json: 992 real TRA
  trains, one representative weekday (TDX GeneralTrainTimetable static
  snapshot -- metadata has no date-range field, and pulse's own runtime
  loader (railScheduleLoader.ts) only reaches for date-specific
  Supabase-backed `/rail/tra/schedules_real/daily/{date}.json` at request
  time; this bundled master_schedule.json IS pulse's own baked "typical
  day" static fallback, same role we need here). Per-stop arrival/departure
  are seconds relative to that train's own first-station departure.

Distance / ratio metric
------------------------
ALL arc-length + ratio math below is done in EPSG:3826 (TWD97), projected
via pyproj, per repo convention. This is deliberately NOT the same metric
pulse's own TraTrainEngine.ts/railUtils.ts uses (those do raw lon/lat
Euclidean distance, no projection at all). A future engine must replay the
SAME metric when interpolating along rail_lines.json's raw lon/lat points
at runtime (reproject each vertex to EPSG:3826, accumulate segment length)
or a train's position/speed will not match what these ratio tables encode.

Outputs (both go to public/layers/, committed to git, no R2)
-------------------------------------------------------------
  public/layers/train_tracks.json    -- per-part station ratio tables
  public/layers/train_schedule.json  -- per-train stop times

THSR (高鐵) extension
---------------------
Same script also bakes public/layers/thsr_tracks.json + thsr_schedule.json,
same schema, from:
- rail_lines.json system=="thsr": exactly 2 parts, mirrored geometry of the
  SAME single physical corridor (both literally named "高速鐵路" -- name is
  even less useful than for TRA). Verified by snapping all 12 stations onto
  each part (EPSG:3826): part 0 is 南下 (南港 ratio~0 -> 左營 ratio~1), part 1
  is 北上 (左營 ratio~0 -> 南港 ratio~1). Always join by part_id (thsr_00/
  thsr_01), never by name.
- stations.json systems.thsr: 12 stations, already complete (all 12 pulse
  THSR station_id->name_zh strings match this repo's 12 names verbatim, 0
  aliasing needed -- unlike TRA there was no "missing station" gap to fill).
- ../mini-taiwan-pulse/public/rail/thsr/stations/stations.geojson: THSR
  station_id (TDX 4-digit code, e.g. "0990") -> name_zh, for resolving the
  schedule's numeric station_id.
- ../mini-taiwan-pulse/public/rail/thsr/schedules/daily/2026-02-18.json:
  one concrete calendar day (per its own _metadata), 2 direction tracks
  (THSR-1-0 南下 / THSR-1-1 北上) each with a `departures[]` array of real
  trains -- this is the per-train version (the sibling thsr_schedules.json
  in the same dir has the identical per-train shape but is NOT tied to a
  specific date and has fewer departures per track -- an aggregate/rollup,
  not what we want; the dated daily/ file is the direct analogue of TRA's
  master_schedule.json "one representative weekday" role).
- Unlike TRA (37 disjoint/overlapping corridor parts, ambiguous station<->
  part matching), THSR has only 2 full-length mirrored parts and EVERY
  station sits on BOTH -- so a naive "do these two stops share any part"
  test would trivially always pass regardless of direction. Instead each
  departures[] track is resolved ONCE to its correct part_id by geometry
  (find the part where the track's origin has a lower ratio than its
  destination), then every train under that track reuses that same
  part_id. This is expected to give ~100% leg coverage (no cross-line
  ambiguity like TRA's mislabeled/duplicated part names).
"""
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from pyproj import Transformer

SCRIPTS_DIR = Path(__file__).resolve().parent
ROOT = SCRIPTS_DIR.parent
OUT_DIR = ROOT / "public" / "layers"

GIS_ROOT = Path("/Users/migu/Desktop/資料庫/gen_ai_try/ichef_工作用/GIS")
PULSE_ROOT = GIS_ROOT / "mini-taiwan-pulse"
RAIL_LINES_SRC = ROOT / "public" / "layers" / "rail_lines.json"
STATIONS_SRC = ROOT / "public" / "layers" / "stations.json"
PULSE_STATIONS_SRC = PULSE_ROOT / "public/rail/tra/stations/stations.geojson"
MASTER_SCHEDULE_SRC = PULSE_ROOT / "public/rail/tra/master_schedule.json"

PULSE_THSR_STATIONS_SRC = PULSE_ROOT / "public/rail/thsr/stations/stations.geojson"
THSR_SCHEDULE_SRC = PULSE_ROOT / "public/rail/thsr/schedules/daily/2026-02-18.json"

# Empirically chosen (see report): p99 nearest-station-to-its-own-line
# distance across all 244 TRA stations was ~129m, with a single genuine
# outlier at 629m (南方小站, a small halt whose official point sits a bit
# off the baked centerline). No station in the whole network was within
# 800m of a *wrong* line in the same probe, so 800m has comfortable margin
# on both sides (catches the one legit far outlier, rejects cross-line
# false positives which are always km-scale apart in this network).
MATCH_THRESHOLD_M = 800.0

TRANSFORMER = Transformer.from_crs("EPSG:4326", "EPSG:3826", always_xy=True)


def project_lonlat(lonlat_pairs):
    lons = [p[0] for p in lonlat_pairs]
    lats = [p[1] for p in lonlat_pairs]
    xs, ys = TRANSFORMER.transform(lons, lats)
    return np.column_stack([xs, ys])


def nearest_on_polyline(poly_xy, query_xy):
    """For each query point, find the nearest point on the polyline
    (clamped per-segment projection) -> (dist_m array, ratio_0_1 array,
    total_length_m)."""
    p0 = poly_xy[:-1]
    p1 = poly_xy[1:]
    seg = p1 - p0
    seglen2 = np.sum(seg * seg, axis=1)
    seglen2_safe = np.where(seglen2 == 0, 1e-9, seglen2)
    seglen = np.sqrt(seglen2_safe)
    cumlen = np.concatenate([[0.0], np.cumsum(seglen)])
    total_len = float(cumlen[-1])

    q = query_xy[:, None, :]
    v = q - p0[None, :, :]
    t = np.sum(v * seg[None, :, :], axis=2) / seglen2_safe[None, :]
    t = np.clip(t, 0.0, 1.0)
    proj = p0[None, :, :] + t[:, :, None] * seg[None, :, :]
    d = q - proj
    dist = np.sqrt(np.sum(d * d, axis=2))
    best_seg = np.argmin(dist, axis=1)
    rows = np.arange(len(query_xy))
    best_dist = dist[rows, best_seg]
    best_t = t[rows, best_seg]
    arc = cumlen[best_seg] + best_t * seglen[best_seg]
    ratio = arc / total_len if total_len > 0 else np.zeros_like(arc)
    return best_dist, ratio, total_len


def write_json_stable(path, payload):
    """Write payload (compact JSON) to path, EXCEPT when an existing file
    at path already holds byte-identical content once its own meta.generated
    is patched to payload's meta.generated -- in that case leave the
    existing file (and its original, real "last changed" timestamp)
    untouched. Without this, every rerun would rewrite meta.generated to
    datetime.now() and produce a spurious 1-field diff on every bake, even
    when nothing about the actual data changed (the repo's tra outputs must
    stay git-diff-clean across reruns of an unchanged upstream snapshot)."""
    new_bytes = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if path.exists():
        try:
            old = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            old = None
        if isinstance(old, dict) and "meta" in old and "meta" in payload:
            old_restamped = {**old, "meta": {**old["meta"], "generated": payload["meta"]["generated"]}}
            if json.dumps(old_restamped, ensure_ascii=False, separators=(",", ":")) == new_bytes:
                print(f"  (content unchanged, keeping generated={old['meta'].get('generated')}) -> {path.name}")
                return
    path.write_text(new_bytes)


def build_station_catalog():
    """name -> (lon, lat, source). Prefer terrain-art coords; fill gaps
    from pulse. Also returns pulse station_id -> name for schedule lookup,
    and a list of (name, dist_m) for any name present in both sources
    whose coordinates disagree by more than 100m (sanity check -- expect
    empty)."""
    ta_stations = json.loads(STATIONS_SRC.read_text())["systems"]["tra"]["points"]
    pulse_geo = json.loads(PULSE_STATIONS_SRC.read_text())["features"]

    catalog = {}
    for p in ta_stations:
        catalog[p["name"]] = (p["lon"], p["lat"], "terrain-art")

    id2name = {}
    conflicts = []
    added_from_pulse = 0
    for feat in pulse_geo:
        pr = feat["properties"]
        name = pr["name"]
        lon, lat = feat["geometry"]["coordinates"]
        id2name[pr["station_id"]] = name
        if name in catalog:
            ta_lon, ta_lat, _ = catalog[name]
            dxy = project_lonlat([(ta_lon, ta_lat), (lon, lat)])
            d = float(np.linalg.norm(dxy[0] - dxy[1]))
            if d > 100.0:
                conflicts.append((name, d))
        else:
            catalog[name] = (lon, lat, "pulse")
            added_from_pulse += 1

    return catalog, id2name, added_from_pulse, conflicts, len(ta_stations), len(pulse_geo)


def build_tracks(tra_parts, catalog, prefix="tra"):
    names = sorted(catalog.keys())
    station_xy = project_lonlat([(catalog[n][0], catalog[n][1]) for n in names])

    # station_parts[name] = {part_idx: ratio}  (only entries under threshold)
    station_parts = {n: {} for n in names}
    parts_out = []

    for i, part in enumerate(tra_parts):
        poly_xy = project_lonlat([(p[0], p[1]) for p in part["points"]])
        dist, ratio, total_len = nearest_on_polyline(poly_xy, station_xy)
        matched = np.where(dist < MATCH_THRESHOLD_M)[0]
        entries = []
        for idx in matched:
            n = names[idx]
            r = round(float(ratio[idx]), 4)
            d = round(float(dist[idx]), 1)
            entries.append({"station": n, "ratio": r, "dist_m": d})
            station_parts[n][i] = r
        entries.sort(key=lambda e: e["ratio"])

        # human-readable label from the closest-snapping station nearest
        # each end (helps debug the "11x 海線" mislabeling described above --
        # NOT used as a lookup key anywhere)
        label = part.get("name", "")
        if entries:
            start = min(entries, key=lambda e: (e["ratio"], e["dist_m"]))
            end = max(entries, key=lambda e: (e["ratio"], -e["dist_m"]))
            if start["dist_m"] < 300 and end["dist_m"] < 300 and start["station"] != end["station"]:
                label = f"{start['station']}→{end['station']}"

        parts_out.append(
            {
                "part_id": f"{prefix}_{i:02d}",
                "name": part.get("name", ""),
                "label": label,
                "length_m": round(total_len, 1),
                "stations": entries,
            }
        )
        print(f"  part {i:2d}/{len(tra_parts)-1}  {label:<24s} len={total_len/1000:6.1f}km  stations={len(entries)}")

    interchanges = []
    for n in names:
        parts = sorted(station_parts[n].keys())
        if len(parts) >= 2:
            interchanges.append({"station": n, "parts": [f"{prefix}_{p:02d}" for p in parts]})

    return parts_out, station_parts, interchanges


def build_thsr_station_catalog():
    """THSR name -> (lon, lat) catalog, sourced from this repo's
    stations.json systems.thsr (already complete, all 12 stations present --
    unlike TRA there is no gap to fill from pulse). Also returns pulse THSR
    station_id -> name_zh (for resolving the schedule's numeric station_id),
    plus a list of any pulse station name NOT found in the terrain-art
    catalog (sanity check -- expect empty, verified while writing this
    script: all 12 pulse name_zh strings match this repo's 12 thsr names
    verbatim)."""
    ta_stations = json.loads(STATIONS_SRC.read_text())["systems"]["thsr"]["points"]
    pulse_geo = json.loads(PULSE_THSR_STATIONS_SRC.read_text())["features"]

    catalog = {p["name"]: (p["lon"], p["lat"]) for p in ta_stations}

    id2name = {}
    conflicts = []
    for feat in pulse_geo:
        pr = feat["properties"]
        name = pr["name_zh"]
        id2name[pr["station_id"]] = name
        if name not in catalog:
            conflicts.append(name)

    return catalog, id2name, conflicts, len(ta_stations), len(pulse_geo)


def match_thsr_track_to_part(origin, dest, station_parts):
    """A THSR direction-track (e.g. "南下": origin=南港, dest=左營) is
    resolved to whichever built part has origin's ratio < dest's ratio
    (both parts touch every station, so this direction test -- not mere
    membership -- is what actually distinguishes them). Returns the part
    index, or None if no part qualifies."""
    part_idxs = sorted({p for parts in station_parts.values() for p in parts})
    for i in part_idxs:
        ro = station_parts.get(origin, {}).get(i)
        rd = station_parts.get(dest, {}).get(i)
        if ro is not None and rd is not None and ro < rd:
            return i
    return None


TRAIN_TYPE_HINT = {
    "LC": "區間車",
    "CK": "區間快",
    "TC": "自強",
    "TC-PP": "自強(推拉)",
    "PP": "普悠瑪",
    "CG": "莒光",
    "TZ": "太魯閣",
    "TC-DMU": "自強(柴聯)",
}


def resolve_stops(schedule, id2name):
    """Return (stops, dropped_unresolved_count) -- stops with a resolvable
    station name only, in original order. See report: 4 station_ids
    (3243/3245/3247/3249, all between 栗林 and 臺中 on the mountain line)
    have no name in either source (likely newer in-fill stations added
    after both snapshots) -- those individual stops are skipped, the train
    itself is kept."""
    stops = []
    dropped = 0
    for st in schedule["stations"]:
        name = id2name.get(st["station_id"])
        if name is None:
            dropped += 1
            continue
        stops.append({"station": name, "arr_sec": st["arrival"], "dep_sec": st["departure"]})
    return stops, dropped


def bake_thsr(generated):
    """Bake thsr_tracks.json + thsr_schedule.json (same schema as the TRA
    outputs above, independent files -- see module docstring's "THSR
    extension" section). `generated` is the SAME run timestamp main() used,
    so both file pairs share one bake epoch."""
    print("\n=== THSR 1/4 loading sources ===")
    rail = json.loads(RAIL_LINES_SRC.read_text())
    thsr_parts = [l for l in rail["lines"] if l.get("system") == "thsr"]
    print(f"rail_lines.json: {len(rail['lines'])} lines total, {len(thsr_parts)} system=='thsr'")

    catalog, id2name, conflicts, ta_count, pulse_count = build_thsr_station_catalog()
    print(f"stations.json (thsr): {ta_count} stations")
    print(f"pulse thsr stations.geojson: {pulse_count} stations")
    if conflicts:
        print(f"  ! {len(conflicts)} pulse station name(s) not found in terrain-art catalog: {conflicts}")
    else:
        print("  0 alias conflicts (all pulse THSR station names match terrain-art stations.json)")

    print("\n=== THSR 2/4 snapping stations onto each THSR line part (EPSG:3826 arc length) ===")
    parts_out, station_parts, interchanges = build_tracks(thsr_parts, catalog, prefix="thsr")
    total_membership = sum(len(v) for v in station_parts.values())
    print(f"total station<->part memberships (dist<{MATCH_THRESHOLD_M:.0f}m): {total_membership}")

    tracks_payload = {
        "meta": {
            "generated": generated,
            "distance_metric": "epsg3826_arc_length_m",
            "match_threshold_m": MATCH_THRESHOLD_M,
            "partCount": len(parts_out),
            "note": (
                "parts[] is index-aligned 1:1 with rail_lines.json's "
                "system=='thsr' filter (same order, same count=2). Both "
                "parts are mirrored geometry of the SAME single physical "
                "corridor -- part thsr_00 is 南下 (南港->左營, ratio 0->1), "
                "part thsr_01 is 北上 (左營->南港, ratio 0->1). Always join "
                "by part_id/array index, never by name (both parts are "
                "literally named '高速鐵路')."
            ),
        },
        "parts": parts_out,
        "interchanges": interchanges,
    }
    write_json_stable(OUT_DIR / "thsr_tracks.json", tracks_payload)

    print("\n=== THSR 3/4 mapping departures onto line parts (coverage check) ===")
    daily = json.loads(THSR_SCHEDULE_SRC.read_text())
    source_meta = daily.get("_metadata", {})
    track_keys = sorted(k for k in daily.keys() if k != "_metadata")

    track_part_id = {}
    for tk in track_keys:
        track = daily[tk]
        part_idx = match_thsr_track_to_part(track["origin"], track["destination"], station_parts)
        track_part_id[tk] = f"thsr_{part_idx:02d}" if part_idx is not None else None
        print(
            f"  track {tk}  {track['name']}  {track['origin']}->{track['destination']}"
            f"  departures={track['departure_count']}  -> part {track_part_id[tk]}"
        )

    schedule_out = []
    total_departures = 0
    total_dropped_stops = 0
    trains_with_lt2_stops = 0
    total_legs = 0
    matched_legs = 0
    trains_fully_matched = 0
    trains_mostly_matched = 0

    for tk in track_keys:
        track = daily[tk]
        part_id = track_part_id[tk]
        part_idx = int(part_id.split("_")[1]) if part_id else None
        for dep in track["departures"]:
            total_departures += 1
            stops, dropped = resolve_stops(dep, id2name)
            total_dropped_stops += dropped
            if len(stops) < 2:
                trains_with_lt2_stops += 1

            legs = max(len(stops) - 1, 0)
            leg_matched = 0
            if part_idx is not None:
                for a, b in zip(stops, stops[1:]):
                    ra = station_parts.get(a["station"], {}).get(part_idx)
                    rb = station_parts.get(b["station"], {}).get(part_idx)
                    if ra is not None and rb is not None and ra <= rb:
                        leg_matched += 1
            total_legs += legs
            matched_legs += leg_matched
            if legs > 0 and leg_matched == legs:
                trains_fully_matched += 1
            if legs > 0 and leg_matched / legs >= 0.8:
                trains_mostly_matched += 1

            origin = stops[0]["station"] if stops else track["origin"]
            dest = stops[-1]["station"] if stops else track["destination"]
            dep_h, dep_m, dep_s = (int(x) for x in dep["departure_time"].split(":"))
            dep_sec_of_day = dep_h * 3600 + dep_m * 60 + dep_s
            train_no = dep["train_id"].replace("THSR-", "")
            schedule_out.append(
                {
                    "train_no": train_no,
                    "train_type": "高鐵",
                    "direction": f"{origin}→{dest}",
                    "dep_sec_of_day": dep_sec_of_day,
                    "stops": stops,
                }
            )

    leg_coverage = matched_legs / total_legs if total_legs else 0.0
    train_full_coverage = trains_fully_matched / total_departures if total_departures else 0.0
    train_mostly_coverage = trains_mostly_matched / total_departures if total_departures else 0.0

    print(f"schedules: {total_departures} departures across {len(track_keys)} tracks -> {len(schedule_out)} trains (none dropped)")
    print(f"stops dropped (unresolvable station_id): {total_dropped_stops}")
    print(f"trains with <2 resolvable stops: {trains_with_lt2_stops}")
    print(f"total legs (adjacent resolvable-stop pairs): {total_legs}")
    print(f"leg coverage (legs mapped to their track's direction part): {matched_legs}/{total_legs} = {leg_coverage:.1%}")
    print(f"train coverage (100% of a train's legs mapped): {trains_fully_matched}/{total_departures} = {train_full_coverage:.1%}")
    print(f"train coverage (>=80% of a train's legs mapped): {trains_mostly_matched}/{total_departures} = {train_mostly_coverage:.1%}")

    schedule_payload = {
        "meta": {
            "generated": generated,
            "source": source_meta,
            "trainCount": len(schedule_out),
            "leg_coverage": round(leg_coverage, 4),
            "note": (
                "Same convention as train_schedule.json (TRA): arr_sec/"
                "dep_sec are seconds relative to this train's own "
                "first-station departure; `dep_sec_of_day` is that first "
                "departure's Asia/Taipei wall-clock time as integer "
                "seconds-since-local-midnight (0..86399) -- the anchor an "
                "engine needs to add to arr_sec/dep_sec before comparing "
                "against a live clock. `direction` is literally "
                "f'{first_stop}→{last_stop}' (some THSR trains start/end "
                "mid-corridor, e.g. 台中-左營 shortworkings, so this is not "
                "always 南港/左營). To place this train on the 3D map: for "
                "each adjacent stop pair, look up thsr_tracks.json "
                "parts[].stations for a station name match on both ends "
                "(same part_id/index on both) to get ratio_from/ratio_to, "
                "then lerp by elapsed time. Unlike TRA there is only ONE "
                "physical corridor split into 2 mirrored direction parts "
                "(thsr_00=南下, thsr_01=北上) -- a whole train's route "
                "always lies on a single part."
            ),
        },
        "schedules": schedule_out,
    }
    write_json_stable(OUT_DIR / "thsr_schedule.json", schedule_payload)

    thsr_tracks_path = OUT_DIR / "thsr_tracks.json"
    thsr_schedule_path = OUT_DIR / "thsr_schedule.json"

    def _kb(p):
        return f"{p.stat().st_size / 1024:.1f} KB"

    print("\n=== THSR 4/4 output ===")
    print(f"wrote -> {thsr_tracks_path} ({_kb(thsr_tracks_path)})")
    print(f"wrote -> {thsr_schedule_path} ({_kb(thsr_schedule_path)})")
    print(f"combined: {(thsr_tracks_path.stat().st_size + thsr_schedule_path.stat().st_size) / 1024:.1f} KB")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")

    print("=== 1/4 loading sources ===")
    rail = json.loads(RAIL_LINES_SRC.read_text())
    tra_parts = [l for l in rail["lines"] if l.get("system") == "tra"]
    print(f"rail_lines.json: {len(rail['lines'])} lines total, {len(tra_parts)} system=='tra'")

    catalog, id2name, added_from_pulse, conflicts, ta_count, pulse_count = build_station_catalog()
    print(f"stations.json (tra): {ta_count} stations")
    print(f"pulse stations.geojson: {pulse_count} stations")
    print(f"master station catalog: {len(catalog)} names ({added_from_pulse} filled in from pulse only)")
    if conflicts:
        print(f"  ! {len(conflicts)} name(s) exist in both sources with coords >100m apart:")
        for n, d in conflicts:
            print(f"    {n!r}: {d:.0f}m apart")
    else:
        print("  0 alias conflicts (every shared name's coords agree within 100m)")

    print("\n=== 2/4 snapping stations onto each TRA line part (EPSG:3826 arc length) ===")
    parts_out, station_parts, interchanges = build_tracks(tra_parts, catalog, prefix="tra")
    total_membership = sum(len(v) for v in station_parts.values())
    print(f"total station<->part memberships (dist<{MATCH_THRESHOLD_M:.0f}m): {total_membership}")
    print(f"stations touching >=2 parts (interchanges): {len(interchanges)}")

    tracks_out = {
        "meta": {
            "generated": generated,
            "distance_metric": "epsg3826_arc_length_m",
            "match_threshold_m": MATCH_THRESHOLD_M,
            "partCount": len(parts_out),
            "note": (
                "parts[] is index-aligned 1:1 with rail_lines.json's "
                "system=='tra' filter (same order, same count=37). `name` "
                "is copied straight from rail_lines.json and is NOT unique "
                "(see file header comment) -- always join by array index / "
                "part_id, never by name."
            ),
        },
        "parts": parts_out,
        "interchanges": interchanges,
    }
    write_json_stable(OUT_DIR / "train_tracks.json", tracks_out)

    print("\n=== 3/4 mapping 992 schedules onto line parts (coverage check) ===")
    master = json.loads(MASTER_SCHEDULE_SRC.read_text())
    schedules = master["schedules"]

    schedule_out = []
    total_legs = 0
    matched_legs = 0
    trains_fully_matched = 0
    trains_mostly_matched = 0  # >=80% legs matched
    total_dropped_stops = 0
    trains_with_lt2_stops = 0

    for sch in schedules:
        stops, dropped = resolve_stops(sch, id2name)
        total_dropped_stops += dropped
        if len(stops) < 2:
            trains_with_lt2_stops += 1

        legs = max(len(stops) - 1, 0)
        leg_matched = 0
        for a, b in zip(stops, stops[1:]):
            common = station_parts.get(a["station"], {}).keys() & station_parts.get(b["station"], {}).keys()
            if common:
                leg_matched += 1
        total_legs += legs
        matched_legs += leg_matched
        if legs > 0 and leg_matched == legs:
            trains_fully_matched += 1
        if legs > 0 and leg_matched / legs >= 0.8:
            trains_mostly_matched += 1

        origin = stops[0]["station"] if stops else sch.get("origin_station", "")
        dest = stops[-1]["station"] if stops else sch.get("destination_station", "")
        # NOTE (engine implementer, found while wiring the wall-clock live
        # position): the rest of this record is relative-to-first-departure
        # seconds only -- there is no absolute clock anchor anywhere in it, so
        # an engine cannot place a train against Asia/Taipei wall-clock time
        # without one. master_schedule.json's own `departure_time` (HH:MM:SS,
        # used above only for this script's own verify_samples debug print)
        # is exactly that anchor -- surfacing it here as integer seconds-since-
        # local-midnight is an additive field, nothing existing changes shape.
        dep_h, dep_m, dep_s = (int(x) for x in sch["departure_time"].split(":"))
        dep_sec_of_day = dep_h * 3600 + dep_m * 60 + dep_s
        schedule_out.append(
            {
                "train_no": sch["train_no"],
                "train_type": sch["train_type"],
                "direction": f"{origin}→{dest}",
                "dep_sec_of_day": dep_sec_of_day,
                "stops": stops,
            }
        )

    leg_coverage = matched_legs / total_legs if total_legs else 0.0
    train_full_coverage = trains_fully_matched / len(schedules)
    train_mostly_coverage = trains_mostly_matched / len(schedules)

    print(f"schedules: {len(schedules)} trains (before) -> {len(schedule_out)} trains (after, none dropped)")
    print(f"stops dropped (unresolvable station_id, see header comment): {total_dropped_stops}")
    print(f"trains with <2 resolvable stops: {trains_with_lt2_stops}")
    print(f"total legs (adjacent resolvable-stop pairs): {total_legs}")
    print(f"leg coverage (legs mapped to >=1 common part / total legs): {matched_legs}/{total_legs} = {leg_coverage:.1%}")
    print(f"train coverage (100% of a train's legs mapped): {trains_fully_matched}/{len(schedules)} = {train_full_coverage:.1%}")
    print(f"train coverage (>=80% of a train's legs mapped): {trains_mostly_matched}/{len(schedules)} = {train_mostly_coverage:.1%}")
    print(f"train_type_code distribution: {Counter(s['train_type_code'] for s in schedules)}")

    schedule_payload = {
        "meta": {
            "generated": generated,
            "source": master["metadata"],
            "trainCount": len(schedule_out),
            "leg_coverage": round(leg_coverage, 4),
            "note": (
                "arr_sec/dep_sec are seconds relative to this train's own "
                "first-station departure (same convention as pulse's "
                "master_schedule.json). `dep_sec_of_day` is that first "
                "departure's Asia/Taipei wall-clock time as integer "
                "seconds-since-local-midnight (0..86399) -- the anchor an "
                "engine needs to add to arr_sec/dep_sec before comparing "
                "against a live clock; a train can run past local "
                "midnight (dep_sec_of_day + last stop's arr_sec > 86400), "
                "so check both today's and yesterday's start instance. "
                "`direction` is literally f'{first_stop}→{last_stop}'. To "
                "place this train on the 3D map: for each adjacent stop "
                "pair, look up train_tracks.json parts[].stations for a "
                "station name match on both ends (same part_id/index on "
                "both) to get ratio_from/ratio_to, then lerp by elapsed "
                "time."
            ),
        },
        "schedules": schedule_out,
    }
    write_json_stable(OUT_DIR / "train_schedule.json", schedule_payload)

    tracks_path = OUT_DIR / "train_tracks.json"
    schedule_path = OUT_DIR / "train_schedule.json"

    def _kb(p):
        return f"{p.stat().st_size / 1024:.1f} KB"

    print("\n=== 4/4 output ===")
    print(f"wrote -> {tracks_path} ({_kb(tracks_path)})")
    print(f"wrote -> {schedule_path} ({_kb(schedule_path)})")
    print(f"combined: {(tracks_path.stat().st_size + schedule_path.stat().st_size) / 1024 / 1024:.2f} MB")

    verify_samples(schedules, id2name, station_parts, parts_out)

    print("\n\n" + "=" * 70)
    bake_thsr(generated)


def leg_progress_at(stops, station_parts, t_query_sec):
    """Given a resolved stops list and a query time (seconds, same
    relative-to-first-departure clock as the schedule), find which leg
    t_query_sec falls in, resolve it to a common part, and interpolate the
    ratio. Returns a human-readable dict or None if unresolvable."""
    for a, b in zip(stops, stops[1:]):
        lo = a["dep_sec"]
        hi = b["arr_sec"]
        if hi < lo:
            hi = lo
        if lo <= t_query_sec <= hi:
            common = station_parts.get(a["station"], {}).keys() & station_parts.get(b["station"], {}).keys()
            if not common:
                return {"leg": (a["station"], b["station"]), "matched": False}
            part_idx = sorted(common)[0]
            ra = station_parts[a["station"]][part_idx]
            rb = station_parts[b["station"]][part_idx]
            frac = (t_query_sec - lo) / (hi - lo) if hi > lo else 0.0
            ratio = ra + frac * (rb - ra)
            return {
                "leg": (a["station"], b["station"]),
                "matched": True,
                "part_id": f"tra_{part_idx:02d}",
                "ratio_from": ra,
                "ratio_to": rb,
                "frac": round(frac, 3),
                "ratio_at_t": round(ratio, 4),
            }
    return None


def verify_samples(schedules, id2name, station_parts, parts_out):
    print("\n=== sample verification: 3 trains, manual mid-leg check ===")

    def find_train(pred):
        for s in schedules:
            if pred(s):
                return s
        return None

    west_express = find_train(lambda s: s["train_type_code"] == "TC" and s["origin_station"] in ("臺北", "高雄", "新左營"))
    local = find_train(lambda s: s["train_type_code"] == "LC")
    east_line = find_train(
        lambda s: any(
            st["station_id"] in id2name and id2name[st["station_id"]] in ("花蓮", "臺東")
            for st in s["stations"]
        )
        and any(id2name.get(st["station_id"]) == "花蓮" for st in s["stations"])
        and any(id2name.get(st["station_id"]) == "臺東" for st in s["stations"])
    )

    for label, sch in [("西幹線自強/對號快車", west_express), ("區間車", local), ("東幹線（花蓮-臺東)", east_line)]:
        if sch is None:
            print(f"  [{label}] no matching sample train found")
            continue
        stops, _dropped = resolve_stops(sch, id2name)
        print(f"\n  [{label}] {sch['train_id']} {sch['train_type']}  {sch['origin_station']}->{sch['destination_station']}")
        print(f"    departure_time(absolute)={sch['departure_time']}  stops={len(stops)}")
        if len(stops) < 2:
            print("    (not enough resolvable stops to verify)")
            continue
        # pick the midpoint of the 2nd leg (or 1st if only one leg) as the query time
        leg_i = 1 if len(stops) > 2 else 0
        a, b = stops[leg_i], stops[leg_i + 1]
        t_query = (a["dep_sec"] + b["arr_sec"]) // 2
        result = leg_progress_at(stops, station_parts, t_query)
        # cross-check: convert relative t_query back to an absolute clock time
        h, m, s = (int(x) for x in sch["departure_time"].split(":"))
        base_sec = h * 3600 + m * 60 + s
        abs_sec = (base_sec + t_query) % 86400
        abs_hms = f"{abs_sec//3600:02d}:{(abs_sec%3600)//60:02d}:{abs_sec%60:02d}"
        print(f"    querying t={t_query}s after departure (absolute clock ~{abs_hms}), between stop {a['station']}(dep {a['dep_sec']}s) and {b['station']}(arr {b['arr_sec']}s)")
        if result and result.get("matched"):
            print(f"    -> part {result['part_id']}  ratio_from={result['ratio_from']:.4f} ratio_to={result['ratio_to']:.4f}  frac={result['frac']}  ratio_at_t={result['ratio_at_t']:.4f}")
        else:
            print(f"    -> UNMATCHED leg {result['leg'] if result else '(no leg contains t_query)'}")


if __name__ == "__main__":
    main()
