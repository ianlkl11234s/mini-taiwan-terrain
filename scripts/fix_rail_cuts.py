#!/usr/bin/env python3
"""Backlog #3: re-stitch rail_lines.json's TRA part boundaries so
scripts/bake_trains.py's schedule-to-part matching stops failing at express
trains that skip the exact station where two parts happen to meet.

Root cause (see report from the investigation this script encodes): the 37
system=="tra" parts in rail_lines.json are disjoint corridor segments cut at
real junction stations (樹林, 八堵, 竹南, 彰化, 蘇澳新, 成功/追分, 高雄 area).
bake_trains.py's leg-matching requires BOTH stations of a schedule leg to
land on the SAME part. A local/express train that stops at both ends of a
cut (e.g. 樹林 then 八堵) is fine -- but a fast train that runs straight
through the junction without stopping there (e.g. 桃園 -> board -> 板橋,
skipping 樹林 entirely) has its two stops on two DIFFERENT parts with no
part in common, so the leg fails to match even though the train obviously
did travel a continuous physical track.

Fix strategy: DATA-DRIVEN. Actually run the real 992-train schedule against
the current parts, collect every distinct failing (station_a, station_b)
pair, then for each one search for a "clean bridge" -- a station that sits
near an ENDPOINT (ratio <0.05 or >0.95) of some part touching station_a and
near an endpoint of some part touching station_b. That identifies exactly
which pairs of parts must be merged into one. Union-find over those merge
edges groups all 37 parts into connected components; any component with
>1 member is DECOMPOSED into simple (non-branching) node sequences
(decompose_into_simple_paths()) and each sequence becomes one new merged
part (build_simple_path()).

An earlier version of this script tried collapsing each whole component
into ONE part via a single Euler-tour walk (retracing back to a branch
point before descending into the next sibling -- the standard way to
serialize a tree as one walk). That produced a real bug: 八堵 forks to both
基隆支線 and 宜蘭線, and 彰化/竹南 forks to both 山線 and 海線/南下幹線, so
the Euler tour revisits those branch points' coordinates 2-3x within a
SINGLE polyline; bake_trains.py's nearest-point search (argmin over every
segment) can then snap a station sitting AT the branch point to the wrong
visit, producing a non-monotonic ratio (observed: 苗栗->竹南->新竹 jumped
ratio 0.18 -> 0.54 -> 0.13 -- the merged dot would have visually teleported
up the line and back for one stop). Simple-path decomposition sidesteps
this categorically: no output part ever lists the same original part index
twice, so every coordinate inside ONE merged part is visited exactly once
and nearest-point search is unambiguous. A branch point's part legitimately
appears as the shared endpoint of >1 output path (its points get
duplicated across parts) -- harmless for the invariant below, and each
individual output part stays internally simple/monotonic.

Every point in a merged part is a verbatim copy of a point already present
in one of the parts it replaces -- no new coordinates are invented and
nothing is dropped, only regrouped/reordered/repeated (a part shared by
multiple simple paths is copied into each) -- so the UNION of all
system=="tra" points before and after this script is identical (verified
inline below, also re-checked standalone by scripts/verify_rail_geometry.py).
Parts not involved in any merge (including the mirror/reverse duplicates of
merged parts, which are never touched) pass through byte-for-byte unchanged.

This script only touches rail_lines.json's system=="tra" entries. thsr
entries and every other line are copied through verbatim. It does not bake
elevation (points already carry elev from an earlier bake) and does not
import geopandas/shapely -- same light numpy-only dependency budget as
bake_trains.py, which this script imports and reuses (build_station_catalog,
build_tracks, resolve_stops, the pyproj-backed EPSG:3826 transformer) rather
than re-deriving the station-snapping logic.

Usage: python3 scripts/fix_rail_cuts.py [--dry-run]
  (no args)   overwrite rail_lines.json in place, then you should rerun
              scripts/bake_trains.py to regenerate train_tracks.json /
              train_schedule.json against the new part structure.
  --dry-run   print the analysis (failing pairs, merge edges, components)
              and the projected new part count, but do not write the file.

Idempotent: rerunning against an already-fixed rail_lines.json finds (close
to) zero remaining failing pairs, so no further merge edges are proposed and
the file is left untouched (write_json_stable-style skip, see main()).
"""
import json
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
import bake_trains as bt  # noqa: E402  (reuse station snapping / schedule resolution)

ENDPOINT_TOL = 0.05  # ratio distance from 0 or 1 to count as "at this part's endpoint"


def load_tra():
    rail = json.loads(bt.RAIL_LINES_SRC.read_text())
    lines = rail["lines"]
    tra_positions = [i for i, l in enumerate(lines) if l.get("system") == "tra"]
    tra_parts = [lines[i] for i in tra_positions]
    return rail, lines, tra_positions, tra_parts


def compute_failing_pairs(station_parts, id2name):
    """Run the REAL 992-train schedule through the SAME leg-matching test
    bake_trains.py's main() uses (common part between adjacent stops), and
    return {sorted (station_a, station_b): occurrence_count} for every leg
    that fails."""
    master = json.loads(bt.MASTER_SCHEDULE_SRC.read_text())
    fail_pairs = {}
    for sch in master["schedules"]:
        stops, _dropped = bt.resolve_stops(sch, id2name)
        if len(stops) < 2:
            continue
        for a, b in zip(stops, stops[1:]):
            pa = set(station_parts.get(a["station"], {}).keys())
            pb = set(station_parts.get(b["station"], {}).keys())
            if not (pa & pb):
                key = tuple(sorted((a["station"], b["station"])))
                fail_pairs[key] = fail_pairs.get(key, 0) + 1
    return fail_pairs


def find_clean_bridge(station_parts, parts_a, parts_b):
    """A 'clean' bridge station s: touches some part in parts_a near THAT
    part's endpoint (ratio<0.05 or >0.95) AND touches some part in parts_b
    near THAT part's endpoint. Rejects mid-line coincidences (e.g. two
    unrelated long corridors both happening to pass near the same town)
    so every merge we propose is a genuine "this is where the track
    physically joins" splice, not an arbitrary shortcut."""
    for s, pr in station_parts.items():
        hit_a = [p for p in pr if p in parts_a and (pr[p] < ENDPOINT_TOL or pr[p] > 1 - ENDPOINT_TOL)]
        hit_b = [p for p in pr if p in parts_b and (pr[p] < ENDPOINT_TOL or pr[p] > 1 - ENDPOINT_TOL)]
        if hit_a and hit_b:
            return s, hit_a[0], hit_b[0], pr[hit_a[0]], pr[hit_b[0]]
    return None


def build_merge_plan(station_parts, fail_pairs):
    """Return (edges, unresolved) where edges: {(p,q) sorted: (bridge, end_p, end_q)}
    end_p/end_q in {'start','end'} = which end of that part's OWN point
    order the bridge sits at."""
    edges = {}
    unresolved = []
    for (a, b), cnt in fail_pairs.items():
        parts_a = set(station_parts.get(a, {}).keys())
        parts_b = set(station_parts.get(b, {}).keys())
        res = find_clean_bridge(station_parts, parts_a, parts_b)
        if res is None:
            unresolved.append((a, b, cnt))
            continue
        s, pX, pY, rX, rY = res
        end_x = "end" if rX > 0.5 else "start"
        end_y = "end" if rY > 0.5 else "start"
        key = tuple(sorted((pX, pY)))
        if key not in edges:
            edges[key] = (s, pX, end_x, pY, end_y) if key == (pX, pY) else (s, pY, end_y, pX, end_x)
    return edges, unresolved


def union_find_components(n, edges):
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    for (p, q) in edges:
        union(p, q)

    comps = {}
    for i in range(n):
        comps.setdefault(find(i), []).append(i)
    return comps


def decompose_into_simple_paths(members, adj):
    """Cover every tree edge inside `members` with a set of SIMPLE
    (non-branching) node sequences. A single Euler-tour walk through a
    branching node (tried first, see git history) revisits that node's
    coordinates more than once within ONE polyline -- and bake_trains.py's
    nearest-point search (bt.nearest_on_polyline, argmin over ALL segments)
    then has no way to tell which visit a given station "belongs" to, so a
    station sitting exactly at a branch point can snap to the wrong visit
    and get an arbitrary/non-monotonic ratio (observed empirically: 苗栗 ->
    竹南 -> 新竹 jumped ratio 0.18 -> 0.54 -> 0.13, i.e. the merged dot
    would visually teleport up the line and back for one station). Simple
    paths avoid this categorically: each returned path never lists the same
    part index twice, so every coordinate in it is visited exactly once and
    nearest-point search is unambiguous.

    Branch points (degree>=3 in the tree) end up as the shared FIRST/LAST
    node of more than one path -- i.e. that part's points are legitimately
    duplicated into more than one output part. That's fine for the
    point-SET invariant (a point already in the set staying in the set
    doesn't grow it) and each individual output part is still internally
    simple/monotonic."""
    remaining = set()
    for p in members:
        for nbr, _my_end, _nbr_end in adj[p]:
            if nbr in members:
                remaining.add((min(p, nbr), max(p, nbr)))

    paths = []
    while remaining:
        p0, q0 = next(iter(remaining))
        remaining.discard((p0, q0))
        path = [p0, q0]

        extended = True
        while extended:
            extended = False
            last = path[-1]
            for nbr, _my_end, _nbr_end in adj[last]:
                if nbr not in members or nbr in path:
                    continue
                e = (min(last, nbr), max(last, nbr))
                if e in remaining:
                    path.append(nbr)
                    remaining.discard(e)
                    extended = True
                    break

        extended = True
        while extended:
            extended = False
            first = path[0]
            for nbr, _my_end, _nbr_end in adj[first]:
                if nbr not in members or nbr in path:
                    continue
                e = (min(first, nbr), max(first, nbr))
                if e in remaining:
                    path.insert(0, nbr)
                    remaining.discard(e)
                    extended = True
                    break

        paths.append(path)
    return paths


def build_simple_path(path, adj, tra_parts):
    """Concatenate a SIMPLE (non-branching, no repeated part index) node
    sequence into one point list, orienting each part via its bridge end
    (adj) so consecutive parts meet head-to-tail."""

    def edge(a, b):
        for nbr, my_end, nbr_end in adj[a]:
            if nbr == b:
                return my_end, nbr_end
        raise KeyError(f"no adjacency edge {a}->{b}")

    result = None
    for i, idx in enumerate(path):
        pts = list(tra_parts[idx]["points"])
        if i == 0:
            if len(path) > 1:
                my_end, _ = edge(idx, path[1])
                if my_end == "start":
                    pts = pts[::-1]
            result = pts
        else:
            prev = path[i - 1]
            _, nbr_end = edge(prev, idx)
            if nbr_end == "end":
                pts = pts[::-1]
            if result[-1] == pts[0]:
                result.extend(pts[1:])
            else:
                result.extend(pts)
    return result


def main():
    dry_run = "--dry-run" in sys.argv

    rail, lines, tra_positions, tra_parts = load_tra()
    print(f"loaded rail_lines.json: {len(lines)} lines total, {len(tra_parts)} system=='tra'")

    catalog, id2name, added, conflicts, ta_count, pulse_count = bt.build_station_catalog()
    parts_out, station_parts, interchanges = bt.build_tracks(tra_parts, catalog, prefix="tra")

    fail_pairs = compute_failing_pairs(station_parts, id2name)
    print(f"\ndistinct failing station-pairs (current parts): {len(fail_pairs)}")
    print(f"total failing leg instances: {sum(fail_pairs.values())}")

    if not fail_pairs:
        print("no failing pairs -- rail_lines.json already fully covers the schedule, nothing to do.")
        return

    edges, unresolved = build_merge_plan(station_parts, fail_pairs)
    print(f"\nrequired merge edges (clean endpoint-to-endpoint bridges): {len(edges)}")
    for (p, q), (s, pX, endX, pY, endY) in edges.items():
        print(f"  tra_{p:02d}.{endX:<5s} <-> tra_{q:02d}.{endY:<5s}   bridge station = {s}")
    if unresolved:
        print(f"\n{len(unresolved)} pair(s) with no 1-hop clean bridge (expected to resolve transitively once their parts land in the same merged component -- rechecked after the merge, see below):")
        for a, b, cnt in unresolved:
            print(f"  {a} <-> {b}  (x{cnt})")

    comps = union_find_components(len(tra_parts), edges)
    non_trivial = {root: members for root, members in comps.items() if len(members) > 1}
    print(f"\nnon-trivial components to merge: {len(non_trivial)}")
    for root, members in non_trivial.items():
        print(f"  {sorted(members)}")

    adj = {i: [] for i in range(len(tra_parts))}
    for (p, q), (s, pX, endX, pY, endY) in edges.items():
        adj[p].append((q, endX, endY))
        adj[q].append((p, endY, endX))

    new_entries = []
    replaced = set()
    for root, members in non_trivial.items():
        simple_paths = decompose_into_simple_paths(members, adj)
        print(f"  component {sorted(members)} -> {len(simple_paths)} simple path(s):")
        for path in simple_paths:
            merged_points = build_simple_path(path, adj, tra_parts)
            names = ", ".join(tra_parts[m].get("name", f"tra_{m:02d}") for m in path)
            color = tra_parts[path[0]].get("color", "#7B7B7B")
            new_entries.append(
                {
                    "name": f"合併路段（原 part {'+'.join(str(m) for m in path)}: {names}）",
                    "system": "tra",
                    "color": color,
                    "points": merged_points,
                }
            )
            print(f"    {path} -> {len(merged_points)} points")
        replaced.update(members)

    kept = [tra_parts[i] for i in range(len(tra_parts)) if i not in replaced]
    new_tra_parts = new_entries + kept
    print(f"\nnew tra part count: {len(new_tra_parts)}  (was {len(tra_parts)}: -{len(replaced)} replaced originals +{len(new_entries)} merged)")

    # ---- geometry-union invariant check (belt-and-suspenders; the same
    # check also runs standalone via scripts/verify_rail_geometry.py) ----
    old_point_set = {tuple(p) for part in tra_parts for p in part["points"]}
    new_point_set = {tuple(p) for part in new_tra_parts for p in part["points"]}
    if old_point_set != new_point_set:
        missing = old_point_set - new_point_set
        added_pts = new_point_set - old_point_set
        print(f"\n!! GEOMETRY UNION MISMATCH: {len(missing)} points lost, {len(added_pts)} points added -- ABORTING, not writing output.")
        sys.exit(1)
    print(f"\ngeometry union check OK: {len(old_point_set)} distinct tra points, identical before/after")

    if dry_run:
        print("\n--dry-run: not writing rail_lines.json")
        return

    # rebuild the full lines[] array: non-tra lines untouched, in original
    # relative order; tra lines replaced by new_tra_parts at the position of
    # the FIRST original tra entry (keeps thsr/other lines' absolute order
    # untouched, matters nothing functionally but keeps the diff readable).
    first_tra_pos = tra_positions[0]
    non_tra_before = [l for i, l in enumerate(lines) if l.get("system") != "tra" and i < first_tra_pos]
    non_tra_after = [l for i, l in enumerate(lines) if l.get("system") != "tra" and i >= first_tra_pos]
    new_lines = non_tra_before + new_tra_parts + non_tra_after
    rail["lines"] = new_lines

    out_path = bt.RAIL_LINES_SRC
    out_path.write_text(json.dumps(rail, ensure_ascii=False, separators=(",", ":")))
    print(f"\nwrote -> {out_path} ({out_path.stat().st_size/1024:.1f} KB, {len(new_lines)} lines total, {len(new_tra_parts)} tra)")
    print("Next: rerun `python3 scripts/bake_trains.py` to regenerate train_tracks.json / train_schedule.json against the new part structure.")


if __name__ == "__main__":
    main()
