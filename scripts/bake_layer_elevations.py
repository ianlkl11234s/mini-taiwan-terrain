#!/usr/bin/env python3
"""Bake elevation onto rail-line vertices and station points from the local
DEM tile set, producing lean JSON the engine can fetch lazily at runtime.

Sources (all WGS84 lon/lat):
  - rail lines GeoJSON (taipei-gis-analytics, MultiLineString features)
  - station points GeoJSON (mini-taiwan-pulse, Point features — no THSR)
  - THSR station pillars JSON (mini-taiwan-pulse, id/lng/lat, no names)
  - THSR station names GeoJSON (taipei-gis-analytics, id "THSR-XXXX" -> name)

DEM: local terrarium-encoded PNG tiles under public/tiles/{z}/{x}/{y}.png
  meters = R*256 + G + B/256 - 32768 (see src/engine/dem.js)
Looks up z13 first (nearest pixel), falls back to z12, then 0 m (open sea /
tile not generated — the tile set omits pure-sea tiles by design).

Outputs (always overwritten — safe to rerun):
  public/layers/rail_lines.json
  public/layers/stations.json
"""
import json
import math
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
# bathy/ nesting (see src/engine/dem.js TILE_URL + docs/.claude/skills/verify):
# the local tile symlink is public/tiles/bathy/{z}/{x}/{y}.png since the
# GEBCO-bathymetry tile set landed alongside the old flat layout — this
# constant went stale when that migration happened (every TileCache lookup
# silently fell through to the sea/0m fallback, never erroring), fixed here.
TILES_DIR = ROOT / "public" / "tiles" / "bathy"
OUT_DIR = ROOT / "public" / "layers"

GIS_ROOT = Path("/Users/migu/Desktop/資料庫/gen_ai_try/ichef_工作用/GIS")
RAIL_SRC = GIS_ROOT / "taipei-gis-analytics/data/processed/transportation/rail_lines/rail_lines_20260527.geojson"
STATIONS_SRC = GIS_ROOT / "mini-taiwan-pulse/public/geo/station_points.geojson"
THSR_PILLARS_SRC = GIS_ROOT / "mini-taiwan-pulse/public/station_pillars.json"
THSR_NAMES_SRC = GIS_ROOT / "taipei-gis-analytics/output/report/0123_ichef_used/04_transit/rail_stations_tra_thsr.geojson"

# --- hydrology sources (mini-taiwan-pulse, all WGS84) --------------------------
RIVERS_SRC = GIS_ROOT / "mini-taiwan-pulse/public/geo/water_rivers.geojson"
# WRA river-channel polygons — the ONLY source of river_name / river_type; used
# purely as a spatial-join lookup to tag the (attribute-less) centerline chains.
RIVER_NAMES_SRC = GIS_ROOT / "taipei-gis-analytics/data/processed/water_resources/river_infrastructure_wra/river_polygons_wra.geojson"
RIVER_SURFACES_SRC = GIS_ROOT / "mini-taiwan-pulse/public/geo/water_river_polygons.geojson"
RESERVOIRS_SRC = GIS_ROOT / "mini-taiwan-pulse/public/geo/water_reservoirs.geojson"
DAMS_SRC = GIS_ROOT / "mini-taiwan-pulse/public/geo/water_dams.geojson"

# Rivers: the centerline source (water_rivers.geojson) has NO usable attributes
# and every one of its 2015 "features" is a whole stream network already
# dissolved into thousands of short, disconnected parts (68,696 parts / 513k
# vertices total, median part = 4 points) — rendering them directly draws a
# dashed scribble instead of a river. Pipeline:
#   1. endpoint snap  — round every part endpoint to RIVER_SNAP_PREC_DEG
#      (~11 m) and merge parts end-to-end through degree-2 nodes into maximal
#      chains; degree>=3 nodes are real confluences and stay as chain breaks
#      (fine — sibling chains still share that vertex, so the network reads as
#      continuous even though it's many polyline objects).
#   2. T-junction snap — many tributary mouths don't land on a mainstem
#      *vertex* (so step 1 can't see them); for each chain endpoint still
#      dangling after step 1, snap it onto the nearest vertex of any OTHER
#      chain within RIVER_TJUNCTION_TOL_M and record the connection.
#   3. SPATIAL JOIN — the centerlines carry no names, so tag every chain by a
#      point-in-polygon majority vote against the WRA river-channel polygons
#      (river_polygons_wra.geojson: 13,262 MultiPolygons carrying river_name +
#      river_type "1"=trunk … "5"=finest; river_type "" is a fishing harbour and
#      is EXCLUDED). Each chain samples every RIVER_JOIN_SAMPLE_EVERY-th vertex,
#      queries an STRtree with a small dwithin tolerance (centerline vs mapped
#      channel are different sources, so allow a near-miss), and takes the most
#      common (name, type). Chains that join nothing are type 6 (no-name creek).
#   4. KEEP RULE + BUCKETS — a chain is kept if it joined a WRA reach (any
#      type 1-5) OR it belongs to a connected river SYSTEM at least
#      RIVER_SYSTEM_MIN_KM long (the coverage rule that keeps unnamed
#      tributaries of the big basins; isolated stubs are dropped). Kept chains
#      are DP-simplified (the thin minor bucket at a coarser tolerance) and
#      split into three buckets by grade (major 1-2 / mid 3-4 / minor 5+6) for
#      per-width rendering.
#   5. LABELS — for every named river, pool its kept chains and drop 1-2 name
#      anchors at percentile positions along the pooled cloud's principal axis
#      (2 at 40%/70% when the river's total kept length exceeds
#      RIVER_LONG_RIVER_KM, else 1 at the midpoint), gated by a
#      RIVER_LABEL_MIN_KM floor so only rivers worth naming get a tag.
RIVER_SNAP_PREC_DEG = 1e-4  # ~11 m endpoint-snap grid (step 1)
RIVER_TJUNCTION_TOL_M = 20.0  # tributary-mouth-to-mainstem snap radius (step 2)
RIVER_TOL_DEG = 0.0006  # ~60 m simplification tolerance
RIVER_JOIN_SAMPLE_EVERY = 8  # sample every Nth chain vertex for the point-in-polygon join
RIVER_JOIN_MAX_SAMPLES = 40  # ...capped per chain so long trunks don't dominate the query
RIVER_JOIN_TOL_DEG = 0.00025  # ~28 m dwithin radius (centerline vs mapped channel offset)
# The WRA channel polygons cover only officially-managed reaches — most of the
# denser headwater network in the centerline source has no polygon (verified:
# median distance from a >=3 km chain midpoint to the nearest WRA polygon is
# ~1.7 km, so the ~25% join hit rate is a real coverage gap, NOT an offset/tol
# bug — the matched chains sit right on the polygons). So coverage is a UNION of
# two keep rules: (a) any chain that joined a WRA reach (named + graded), and
# (b) any chain in a connected river SYSTEM at least RIVER_SYSTEM_MIN_KM long
# (the old behaviour — keeps unnamed tributaries feeding the big basins). This
# is a superset of the old output plus the newly-graded/named trunks.
RIVER_JOIN_FALLBACK_TOL_DEG = 0.0012  # ~133 m — second, wider look for chains RIVER_JOIN_TOL_DEG missed entirely
# Wide/braided reaches (a tidal estuary's channel meanders across a mapped
# floodplain far broader than a normal single-channel offset) sit farther from
# their WRA polygon than RIVER_JOIN_TOL_DEG allows, so a handful of genuinely
# major rivers (verified: 淡水河, 烏溪) matched too little length to clear
# RIVER_LABEL_MIN_KM and lost their name label entirely. Fixed with a SECOND
# pass at this wider tolerance, run ONLY on chains that scored zero votes in
# the first pass — an already-matched chain is never re-voted, so this can only
# recover names on orphans, never override/corrupt an existing match.
RIVER_SYSTEM_MIN_KM = 10.0  # keep chains whose connected system reaches this length
RIVER_MINOR_TOL_DEG = 0.0009  # ~90 m: coarser simplification for the minor bucket (thin creeks)
RIVER_LABEL_MIN_KM = 10.0  # only name rivers whose total kept length reaches this (~200 labels)
RIVER_LONG_RIVER_KM = 30.0  # ...and give the long ones two anchors (40% / 70%) instead of one

# Reservoirs: keep polygons that are either sizeable OR carry an id / dam match
# (so every live-data reservoir survives regardless of area). Douglas-Peucker
# the shoreline with a tighter tolerance to preserve the basin shape.
RES_TOL_DEG = 0.00025  # ~25 m
RES_AREA_MIN_M2 = 150_000  # 0.15 km²
RES_INTERIOR_GRID = 32  # interior DEM sample grid for the captured-floor level

# River water-surface polygons (water_river_polygons.geojson, 13k Polygons of the
# mapped wetted channel). Only the wider downstream/midstream reaches are worth a
# translucent water SHEET — narrow upstream creeks are already carried by the
# river LINE layer, so filter hard by WIDTH (2·area/perimeter) + area. The engine
# triangulates each kept polygon (THREE.ShapeUtils, boundary vertices only) into
# ONE merged mesh, so two shapes are baked to keep those triangles honest:
#   - the outer bank ring is Douglas-Peucker simplified;
#   - hole-free polygons longer than a threshold are SLICED across their main
#     axis into ~1 km cross-sections (earcut has only boundary vertices, so a
#     long sloped reach would otherwise span it with a few huge triangles that
#     cut through the hillsides). Polygons that carry sandbar holes (braided
#     rivers / estuaries) are left un-sliced — they are low-gradient valley floor
#     where big flat triangles are harmless, and slicing can't keep their holes.
# Per-vertex water elevation is sampled slightly INTO the water (bank ring →
# toward centroid, hole ring → away from it) then rolling-min smoothed along the
# ring, so bank-height spikes don't spike the sheet.
RSURF_WIDTH_MIN_M = 20.0  # drop channels narrower than this (river LINE covers them)
RSURF_AREA_MIN_M2 = 15_000.0  # ...and smaller than this
RSURF_OUTER_TOL_DEG = 0.00024  # ~24 m DP on the outer bank ring
RSURF_HOLE_TOL_DEG = 0.00020
RSURF_HOLE_MIN_M2 = 8_000.0  # keep only sandbar holes above this (braided rivers)
RSURF_SLICE_DIAG_M = 2000.0  # slice hole-free polygons with a bbox diagonal over this
RSURF_SLICE_LEN_M = 900.0  # ...into cross-sections about this long along the main axis
RSURF_INSET_CAP_DEG = 0.00022  # ~24 m max offset when sampling water elevation
RSURF_ROLL_WIN = 2  # rolling-min window (vertices) that kills bank-height spikes
RSURF_ELEV_FLOOR_M = -3  # clamp DTM noise at tidal river mouths

# Official system colors (mini-taiwan-pulse/src/data/railLoader.ts SYSTEM_COLOR_MAP,
# plus the greyscale TRA tone already used in station_points.geojson) — used as the
# fallback whenever a rail_lines feature has no `color` property, and as the
# per-system station marker color.
SYSTEM_COLORS = {
    "trtc": "#d90023",
    "thsr": "#ee6c00",
    "krtc": "#f8961e",
    "klrt": "#43aa8b",
    "tmrt": "#577590",
    "tra": "#7B7B7B",
    "aklrt": "#8cc540",
    "dlrt": "#a4ce4e",
    "tymc": "#8246af",
}
FALLBACK_COLOR = "#888888"

TILE_PX = 256


class TileCache:
    """Opens each terrarium PNG at most once; nearest-pixel lookup with a
    z13 -> z12 -> sea(0m) fallback chain, mirroring dem.js's NODATA guard."""

    def __init__(self):
        self._cache = {}
        self.hits = {"z13": 0, "z12": 0, "sea": 0}

    def _tile(self, z, tx, ty):
        key = (z, tx, ty)
        if key in self._cache:
            return self._cache[key]
        path = TILES_DIR / str(z) / str(tx) / f"{ty}.png"
        px = None
        if path.exists():
            px = Image.open(path).convert("RGB").load()
        self._cache[key] = px
        return px

    def elevation(self, lon, lat):
        for z, label in ((13, "z13"), (12, "z12")):
            n = 2**z
            fx = (lon + 180.0) / 360.0 * n
            lat_rad = math.radians(lat)
            fy = (1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n
            gx, gy = fx * TILE_PX, fy * TILE_PX
            tx, ty = int(gx // TILE_PX), int(gy // TILE_PX)
            px = self._tile(z, tx, ty)
            if px is None:
                continue
            lx = min(int(gx % TILE_PX), TILE_PX - 1)
            ly = min(int(gy % TILE_PX), TILE_PX - 1)
            r, g, b = px[lx, ly]
            v = r * 256 + g + b / 256 - 32768
            if v < -100:  # encoded NODATA hole (see dem.js) — treat as sea
                v = 0
            self.hits[label] += 1
            return round(v)
        self.hits["sea"] += 1
        return 0


def bake_rail(cache):
    data = json.loads(RAIL_SRC.read_text())
    lines_out = []
    for feat in data["features"]:
        pr = feat["properties"]
        system = pr.get("system_id") or "unknown"
        color = pr.get("color") or SYSTEM_COLORS.get(system, FALLBACK_COLOR)
        name = pr.get("name_zh") or pr.get("name_en") or system
        geom = feat["geometry"]
        parts = geom["coordinates"] if geom["type"] == "MultiLineString" else [geom["coordinates"]]
        for part in parts:
            points = [[round(lon, 5), round(lat, 5), cache.elevation(lon, lat)] for lon, lat in part]
            lines_out.append({"name": name, "system": system, "color": color, "points": points})
    return lines_out, len(data["features"])


def load_thsr_names():
    if not THSR_NAMES_SRC.exists():
        return {}
    data = json.loads(THSR_NAMES_SRC.read_text())
    names = {}
    for f in data["features"]:
        pr = f["properties"]
        if pr.get("transit_type") == "thsr":
            names[pr["id"].replace("THSR-", "")] = pr.get("name", pr["id"])
    return names


def bake_stations(cache):
    data = json.loads(STATIONS_SRC.read_text())
    systems = {}
    for feat in data["features"]:
        pr = feat["properties"]
        system = pr["system_id"]
        lon, lat = feat["geometry"]["coordinates"]
        entry = systems.setdefault(system, {"color": SYSTEM_COLORS.get(system, pr.get("color") or FALLBACK_COLOR), "points": []})
        entry["points"].append(
            {"name": pr.get("name", ""), "lat": round(lat, 5), "lon": round(lon, 5), "elev": cache.elevation(lon, lat)}
        )

    # THSR has no entry in station_points.geojson — supplement from the pillar
    # coordinates (id/lng/lat) + the separate id -> name lookup.
    thsr_names = load_thsr_names()
    pillars = json.loads(THSR_PILLARS_SRC.read_text()) if THSR_PILLARS_SRC.exists() else {}
    thsr_points = []
    for p in pillars.get("thsr", []):
        thsr_points.append(
            {
                "name": thsr_names.get(p["id"], p["id"]),
                "lat": round(p["lat"], 5),
                "lon": round(p["lng"], 5),
                "elev": cache.elevation(p["lng"], p["lat"]),
            }
        )
    if thsr_points:
        systems["thsr"] = {"color": SYSTEM_COLORS["thsr"], "points": thsr_points}

    return systems


# ---------------------------------------------------------------- geometry utils
def _haversine_m(a, b):
    R = 6371000.0
    lon1, lat1 = a[0], a[1]
    lon2, lat2 = b[0], b[1]
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def _line_len_km(pts):
    return sum(_haversine_m(pts[i], pts[i + 1]) for i in range(len(pts) - 1)) / 1000.0


def dp_simplify(pts, tol):
    """Iterative Douglas-Peucker in lon/lat space (perpendicular distance in
    degrees — good enough for display simplification). Endpoints always kept."""
    n = len(pts)
    if n < 3:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        s, e = stack.pop()
        ax, ay = pts[s][0], pts[s][1]
        dx, dy = pts[e][0] - ax, pts[e][1] - ay
        seg2 = dx * dx + dy * dy
        dmax, idx = 0.0, -1
        for i in range(s + 1, e):
            px, py = pts[i][0], pts[i][1]
            if seg2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / seg2
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > dmax:
                dmax, idx = d, i
        if dmax > tol and idx != -1:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    return [pts[i] for i in range(n) if keep[i]]


def _ring_area_m2(ring):
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = math.cos(math.radians(lat0))
    R = 6371000.0
    a = 0.0
    for i in range(len(ring) - 1):
        x1 = math.radians(ring[i][0]) * k * R
        y1 = math.radians(ring[i][1]) * R
        x2 = math.radians(ring[i + 1][0]) * k * R
        y2 = math.radians(ring[i + 1][1]) * R
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def _point_in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-18) + xi):
            inside = not inside
        j = i
    return inside


def _percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    idx = min(len(sorted_vals) - 1, int(len(sorted_vals) * p))
    return sorted_vals[idx]


# ---------------------------------------------------------------- rivers stitching
class _UnionFind:
    """Disjoint-set over arbitrary hashable keys (node coordinates)."""

    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def _snap_key(pt, prec):
    return (round(pt[0] / prec), round(pt[1] / prec))


def _stitch_river_chains(parts, prec):
    """Merge line-string parts end-to-end through degree-2 endpoint nodes
    into maximal chains. Returns (chains, node_degree) where each chain is
    {"points": [...], "start": node_key, "end": node_key} and node_degree
    maps every endpoint-node key to how many part-ends touch it (>=3 marks a
    real confluence/branch point; chains only ever break there or at a
    degree-1 dangling end — degree-2 nodes are always absorbed into a chain)."""
    n = len(parts)
    node_a = [None] * n
    node_b = [None] * n
    valid = [False] * n
    for i, part in enumerate(parts):
        if len(part) >= 2:
            node_a[i] = _snap_key(part[0], prec)
            node_b[i] = _snap_key(part[-1], prec)
            valid[i] = True

    adj = defaultdict(list)  # node -> [(part_idx, 'A'|'B')]
    for i in range(n):
        if not valid[i]:
            continue
        adj[node_a[i]].append((i, "A"))
        adj[node_b[i]].append((i, "B"))

    used = [False] * n

    def extend_from(i, end):
        node = node_a[i] if end == "A" else node_b[i]
        candidates = adj[node]
        if len(candidates) != 2:
            return None
        other = next(((j, e) for (j, e) in candidates if j != i), None)
        if other is None or used[other[0]]:
            return None
        return other

    chains = []
    for i in range(n):
        if not valid[i] or used[i]:
            continue
        used[i] = True
        chain_parts = [(i, False)]
        cur_i, cur_end = i, "B"
        while True:
            nxt = extend_from(cur_i, cur_end)
            if nxt is None:
                break
            j, e = nxt
            used[j] = True
            reversed_j = e == "B"
            chain_parts.append((j, reversed_j))
            cur_i, cur_end = j, ("A" if reversed_j else "B")

        prefix = []
        cur_i, cur_end = i, "A"
        while True:
            nxt = extend_from(cur_i, cur_end)
            if nxt is None:
                break
            j, e = nxt
            used[j] = True
            reversed_j = e == "A"
            prefix.append((j, reversed_j))
            cur_i, cur_end = j, ("B" if reversed_j else "A")

        chain_order = list(reversed(prefix)) + chain_parts
        pts = []
        for idx, (pi, rev) in enumerate(chain_order):
            seg = list(reversed(parts[pi])) if rev else list(parts[pi])
            if idx > 0 and seg:
                seg = seg[1:]  # drop duplicate junction point
            pts.extend(seg)

        first_pi, first_rev = chain_order[0]
        last_pi, last_rev = chain_order[-1]
        start_node = node_b[first_pi] if first_rev else node_a[first_pi]
        end_node = node_a[last_pi] if last_rev else node_b[last_pi]
        chains.append({"points": pts, "start": start_node, "end": end_node})

    node_degree = {node: len(v) for node, v in adj.items()}
    return chains, node_degree


def _tjunction_snap(chains, node_degree, tol_m, grid_deg=0.0003):
    """For every chain endpoint still dangling (node_degree == 1, i.e. no
    other part shared that node in step 1), look for the nearest vertex
    belonging to a DIFFERENT chain within tol_m — this is the common case of
    a tributary mouth landing on the middle of a mainstem's line instead of
    exactly on one of its vertices. On a match: snap the dangling point's own
    coordinate onto it (closes the sub-tolerance visual gap) and union the
    two chains' components so the pair is treated as connected/attached.
    Returns (union_find, attached, stats) where attached[i] = [start_ok, end_ok]."""
    grid = defaultdict(list)  # (cx, cy) -> [(chain_idx, point_idx)]
    for ci, c in enumerate(chains):
        for pi, p in enumerate(c["points"]):
            grid[(int(p[0] / grid_deg), int(p[1] / grid_deg))].append((ci, pi))

    uf = _UnionFind()
    for c in chains:
        uf.union(c["start"], c["end"])

    attached = [[False, False] for _ in chains]
    checked = snapped = 0
    for ci, c in enumerate(chains):
        ends = ((0, c["start"], 0), (1, c["end"], len(c["points"]) - 1))
        for which, node, pt_idx in ends:
            if node_degree.get(node, 0) >= 2:
                attached[ci][which] = True
                continue
            checked += 1
            p = c["points"][pt_idx]
            cx, cy = int(p[0] / grid_deg), int(p[1] / grid_deg)
            best_d, best = tol_m, None
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for (oj, opi) in grid.get((cx + dx, cy + dy), ()):
                        if oj == ci:
                            continue
                        q = chains[oj]["points"][opi]
                        d = _haversine_m(p, q)
                        if d < best_d:
                            best_d, best = d, (oj, q)
            if best is not None:
                oj, q = best
                snapped += 1
                attached[ci][which] = True
                c["points"][pt_idx] = [q[0], q[1]]
                uf.union(node, chains[oj]["start"])

    return uf, attached, {"checked": checked, "snapped": snapped}


def _river_anchor_points(segs, fracs):
    """Label anchors for one named river. Its centerline is fragmented into many
    disconnected chains (broken at every confluence), so "the longest chain" is
    just a small piece — placing on it drops labels on random upstream stubs.
    Instead pool EVERY vertex of all the river's chains, project onto the pooled
    cloud's principal (down-valley) axis, and pick the actual on-river vertex at
    each requested percentile — so anchors spread along the river's real extent
    and always land on the line."""
    pts = [p for s in segs for p in s]
    if len(pts) < 2:
        p = pts[0]
        return [[p[0], p[1]] for _ in fracs]
    to_m, (ux, uy), (cx, cy) = _main_axis(pts)
    proj = sorted((((x := to_m(p))[0] - cx) * ux + (x[1] - cy) * uy, p) for p in pts)
    n = len(proj)
    return [[proj[min(n - 1, max(0, int(n * f)))][1][0], proj[min(n - 1, max(0, int(n * f)))][1][1]] for f in fracs]


def _tag_chains_with_names(chains):
    """Spatial-join every chain to the WRA river-channel polygons: sample a few
    vertices per chain, point-in(near)-polygon them through an STRtree with a
    small dwithin tolerance, and majority-vote the (name, type). Writes
    c["name"] (str|None) and c["type"] (1..6; 6 = joined nothing) in place.
    Returns join stats."""
    import numpy as np
    import shapely
    from shapely import STRtree
    from shapely.geometry import shape

    data = json.loads(RIVER_NAMES_SRC.read_text())
    geoms = []
    metas = []  # parallel to geoms: (name|None, type_int)
    skipped_empty = 0
    for ft in data["features"]:
        pr = ft["properties"]
        rt = pr.get("river_type", "")
        if rt == "":  # fishing harbour — never a river name
            skipped_empty += 1
            continue
        try:
            t = int(rt)
        except (TypeError, ValueError):
            continue
        geoms.append(shape(ft["geometry"]))
        metas.append((pr.get("river_name") or None, t))
    data = None  # free the 168 MB payload before the query pass
    tree = STRtree(geoms)

    xs, ys, owners = [], [], []
    for ci, c in enumerate(chains):
        pts = c["points"]
        n = len(pts)
        idxs = list(range(0, n, RIVER_JOIN_SAMPLE_EVERY))
        if idxs[-1] != n - 1:
            idxs.append(n - 1)
        if len(idxs) > RIVER_JOIN_MAX_SAMPLES:
            sel = np.linspace(0, len(idxs) - 1, RIVER_JOIN_MAX_SAMPLES).round().astype(int)
            idxs = [idxs[k] for k in sorted(set(int(s) for s in sel))]
        for i in idxs:
            xs.append(pts[i][0])
            ys.append(pts[i][1])
            owners.append(ci)

    pts_geom = shapely.points(np.asarray(xs), np.asarray(ys))
    owners = np.asarray(owners)

    def _vote(sample_mask, tol):
        q = tree.query(pts_geom[sample_mask], predicate="dwithin", distance=tol)
        v = [defaultdict(int) for _ in chains]
        owners_sub = owners[sample_mask]
        for k in range(q.shape[1]):
            v[int(owners_sub[q[0, k]])][metas[q[1, k]]] += 1
        return v

    votes = _vote(np.ones(len(xs), dtype=bool), RIVER_JOIN_TOL_DEG)

    # fallback pass (see RIVER_JOIN_FALLBACK_TOL_DEG) — only chains still
    # voteless after the tight pass get a second, wider look
    orphan_chain = np.array([not v for v in votes])
    fallback_matched = 0
    if orphan_chain.any():
        votes_fb = _vote(orphan_chain[owners], RIVER_JOIN_FALLBACK_TOL_DEG)
        for ci in range(len(chains)):
            if orphan_chain[ci] and votes_fb[ci]:
                votes[ci] = votes_fb[ci]
                fallback_matched += 1

    matched = named = 0
    for ci, c in enumerate(chains):
        if votes[ci]:
            name, t = max(votes[ci].items(), key=lambda kv: kv[1])[0]
            c["name"] = name
            c["type"] = t
            matched += 1
            if name is not None:
                named += 1
        else:
            c["name"] = None
            c["type"] = 6
    return {
        "polysUsed": len(geoms),
        "polysSkippedEmpty": skipped_empty,
        "samplePoints": len(xs),
        "chainsMatched": matched,
        "chainsNamed": named,
        "fallbackMatched": fallback_matched,
    }


def bake_rivers(cache):
    data = json.loads(RIVERS_SRC.read_text())
    feats = data["features"]

    # Collect every part GLOBALLY across all 2015 features — some rivers are
    # split across feature boundaries in this source, so per-feature stitching
    # would miss real connections.
    parts_raw = []
    raw_vertex_total = 0
    for feat in feats:
        geom = feat["geometry"]
        ps = geom["coordinates"] if geom["type"] == "MultiLineString" else [geom["coordinates"]]
        for part in ps:
            raw_vertex_total += len(part)
            if len(part) >= 2:
                parts_raw.append(part)

    # step 1: endpoint-snap stitch into maximal chains
    chains, node_degree = _stitch_river_chains(parts_raw, RIVER_SNAP_PREC_DEG)

    # step 2: T-junction snap (closes tributary-mouth-onto-mainstem gaps)
    uf, _attached, tj_stats = _tjunction_snap(chains, node_degree, RIVER_TJUNCTION_TOL_M)
    for c in chains:
        c["len_km"] = _line_len_km(c["points"])  # endpoints may have moved

    # connected-system totals (union of stitch + T-junction links) — the
    # coverage keep rule below drops isolated stubs but keeps tributaries that
    # feed a real river system.
    comp_len = defaultdict(float)
    for c in chains:
        comp_len[uf.find(c["start"])] += c["len_km"]

    # step 3: spatial join — tag every chain with a river name + grade
    join_stats = _tag_chains_with_names(chains)

    # step 4: keep rule = matched-to-WRA OR in a large system. The vector river
    # LINES are retired (the river body is now the physics flow-accumulation
    # tint, scripts/bake_flow_accum.py → public/layers/river_sim.png), so this
    # step no longer emits buckets or bakes per-vertex elevation — it only
    # DP-simplifies the survivors to pool each named river's geometry for the
    # label anchors (step 5). Elevation is sampled solely at the ~200 anchors.
    kept_by_type = defaultdict(int)
    kept_chains_named = defaultdict(list)  # name -> [simplified pts,...] for labels
    kept_matched = kept_system = 0
    kept_total = kept_vertices = 0
    for c in chains:
        is_matched = c["type"] != 6
        in_system = comp_len[uf.find(c["start"])] >= RIVER_SYSTEM_MIN_KM
        if not (is_matched or in_system):
            continue
        # thin unnamed creeks get a coarser tolerance; named trunks stay crisp
        tol = RIVER_MINOR_TOL_DEG if c["type"] >= 5 else RIVER_TOL_DEG
        simp = dp_simplify(c["points"], tol)
        if len(simp) < 2:
            continue
        kept_total += 1
        kept_vertices += len(simp)
        kept_by_type[c["type"]] += 1
        if is_matched:
            kept_matched += 1
        else:
            kept_system += 1
        if c["name"]:
            kept_chains_named[c["name"]].append(simp)

    # step 5: name labels — one anchor per named river (two for the long ones),
    # placed by pooling ALL of that river's kept chains and picking on-line
    # points along the pooled cloud's principal axis (see _river_anchor_points
    # — the centerline is fragmented at every confluence, so any single chain
    # is too short to anchor on).
    labels = []
    chain_type = {}
    for c in chains:
        if c["name"]:
            chain_type.setdefault(c["name"], c["type"])
    for name, segs in kept_chains_named.items():
        total_km = sum(_line_len_km(s) for s in segs)
        if total_km < RIVER_LABEL_MIN_KM:
            continue
        fracs = [0.4, 0.7] if total_km >= RIVER_LONG_RIVER_KM else [0.5]
        for lon, lat in _river_anchor_points(segs, fracs):
            labels.append(
                {
                    "name": name,
                    "type": chain_type.get(name, 5),
                    "lon": round(lon, 5),
                    "lat": round(lat, 5),
                    "elev": cache.elevation(lon, lat),
                }
            )

    total_chains = len(chains)
    meta = {
        "featuresTotal": len(feats),
        "partsRaw": len(parts_raw),
        "chainsStitched": len(chains),
        "tjunctionChecked": tj_stats["checked"],
        "tjunctionSnapped": tj_stats["snapped"],
        "joinPolysUsed": join_stats["polysUsed"],
        "joinPolysSkippedEmpty": join_stats["polysSkippedEmpty"],
        "joinSamplePoints": join_stats["samplePoints"],
        "chainsMatched": join_stats["chainsMatched"],
        "chainsNamed": join_stats["chainsNamed"],
        "joinFallbackMatched": join_stats["fallbackMatched"],
        "joinHitRatePct": round(100.0 * join_stats["chainsMatched"] / total_chains, 1) if total_chains else 0,
        "keptByType": {str(k): kept_by_type[k] for k in sorted(kept_by_type)},
        "keptMatched": kept_matched,
        "keptSystemOnly": kept_system,
        "chainsKept": kept_total,
        "vertexRaw": raw_vertex_total,
        "vertexSimplified": kept_vertices,
        "labelCount": len(labels),
        "snapPrecDeg": RIVER_SNAP_PREC_DEG,
        "tjunctionTolM": RIVER_TJUNCTION_TOL_M,
        "joinTolDeg": RIVER_JOIN_TOL_DEG,
        "joinFallbackTolDeg": RIVER_JOIN_FALLBACK_TOL_DEG,
        "systemMinKm": RIVER_SYSTEM_MIN_KM,
        "labelMinKm": RIVER_LABEL_MIN_KM,
        "tolDeg": RIVER_TOL_DEG,
    }
    return labels, meta


# ---------------------------------------------------------------- reservoirs
def load_dam_heights():
    """name -> dam_height_m from water_dams (kind='dam' rows carry heights)."""
    data = json.loads(DAMS_SRC.read_text())
    heights = {}
    for feat in data["features"]:
        pr = feat["properties"]
        h = pr.get("dam_height_m")
        nm = pr.get("name")
        if nm and h:
            heights.setdefault(nm, float(h))
    return heights


def bake_dam_markers(cache):
    """is_reservoir=true points, deduped by name (prefer the kind='dam' row so
    the marker sits on the dam, and to keep one dot per reservoir)."""
    data = json.loads(DAMS_SRC.read_text())
    by_name = {}
    for feat in data["features"]:
        pr = feat["properties"]
        if not pr.get("is_reservoir"):
            continue
        nm = pr.get("name")
        if not nm:
            continue
        lon, lat = feat["geometry"]["coordinates"]
        prev = by_name.get(nm)
        # prefer a 'dam' kind row (has a real dam location/height) over 'reservoir'
        if prev is None or (prev["kind"] != "dam" and pr.get("kind") == "dam"):
            by_name[nm] = {"name": nm, "lon": lon, "lat": lat, "kind": pr.get("kind"), "compareId": pr.get("compare_id")}
    dams = []
    for d in by_name.values():
        dams.append(
            {
                "name": d["name"],
                "lon": round(d["lon"], 5),
                "lat": round(d["lat"], 5),
                "elev": cache.elevation(d["lon"], d["lat"]),
                "compareId": d["compareId"],
            }
        )
    return dams


def _floor_full_elev(ring, cache):
    """fullElev = shoreline (ring) median elevation ≈ real full-pool level.
    floorElev = 10th-percentile of the interior DEM (the flat 'captured water'
    surface the DTM recorded — the deepest level a lowered water plane can be
    shown at, since we have no bathymetry below it)."""
    ring_el = [cache.elevation(lon, lat) for lon, lat in ring]
    full = statistics.median(ring_el) if ring_el else 0
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    interior = []
    N = RES_INTERIOR_GRID
    for i in range(N):
        for j in range(N):
            lon = minx + (maxx - minx) * (i + 0.5) / N
            lat = miny + (maxy - miny) * (j + 0.5) / N
            if _point_in_ring(lon, lat, ring):
                interior.append(cache.elevation(lon, lat))
    if len(interior) >= 5:
        interior.sort()
        floor = _percentile(interior, 0.10)
    else:
        floor = min(ring_el) if ring_el else full
    floor = min(floor, full)  # floor must sit at/below full pool
    if full - floor < 3:  # guarantee a visible drop band even on shallow basins
        floor = full - 3
    return int(round(full)), int(round(floor))


def bake_reservoirs(cache):
    data = json.loads(RESERVOIRS_SRC.read_text())
    dam_heights = load_dam_heights()
    reservoirs = []
    matched_dam = 0
    full_range = []
    for feat in data["features"]:
        pr = feat["properties"]
        name = pr.get("name") or ""
        if not name:
            continue
        compare_id = pr.get("compare_id")
        # largest outer ring across the MultiPolygon = the main water body
        best_ring, best_area = None, -1.0
        for poly in feat["geometry"]["coordinates"]:
            outer = poly[0]
            area = _ring_area_m2(outer)
            if area > best_area:
                best_area, best_ring = area, outer
        if best_ring is None:
            continue
        dam_h = dam_heights.get(name)
        # keep only meaningful basins, but never drop one that has an id or a dam
        if best_area < RES_AREA_MIN_M2 and compare_id is None and dam_h is None:
            continue
        simp = dp_simplify(best_ring, RES_TOL_DEG)
        if len(simp) < 4:
            simp = best_ring
        full_el, floor_el = _floor_full_elev(simp, cache)
        if full_el <= 0:
            continue  # offshore islands (澎湖/金門) outside the tile coverage → no DEM
        full_range.append(full_el)
        if dam_h is not None:
            matched_dam += 1
        reservoirs.append(
            {
                "name": name,
                "compareId": compare_id,
                "fullElev": full_el,
                "floorElev": floor_el,
                "damHeight": round(dam_h, 1) if dam_h is not None else None,
                "ring": [[round(lon, 5), round(lat, 5)] for lon, lat in simp],
            }
        )

    dams = bake_dam_markers(cache)
    meta = {
        "featuresTotal": len(data["features"]),
        "reservoirsKept": len(reservoirs),
        "matchedDamHeight": matched_dam,
        "damMarkers": len(dams),
        "fullElevRange": [min(full_range), max(full_range)] if full_range else [0, 0],
        "ringVertexTotal": sum(len(r["ring"]) for r in reservoirs),
        "areaMinM2": RES_AREA_MIN_M2,
        "tolDeg": RES_TOL_DEG,
    }
    return reservoirs, dams, meta


# ---------------------------------------------------------------- river surfaces
def _ring_open(ring):
    """GeoJSON rings are closed (first == last). Return the ring WITHOUT the
    trailing duplicate — the engine's ShapeUtils contour must be open."""
    r = list(ring)
    if len(r) >= 2 and r[0][0] == r[-1][0] and r[0][1] == r[-1][1]:
        r = r[:-1]
    return r


def _ring_perimeter_m(ring):
    n = len(ring)
    return sum(_haversine_m(ring[i], ring[(i + 1) % n]) for i in range(n))


def _closed(ring):
    return ring + [ring[0]]


def _main_axis(ring):
    """PCA largest-eigenvector (unit) of the ring vertices in a local meters
    frame + the local->meters projector + the meters centroid. Used to slice a
    long reach across its dominant (down-stream) direction."""
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = math.cos(math.radians(lat0))
    R = 6371000.0

    def to_m(p):
        return (math.radians(p[0]) * k * R, math.radians(p[1]) * R)

    pts = [to_m(p) for p in ring]
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    sxx = syy = sxy = 0.0
    for x, y in pts:
        dx, dy = x - cx, y - cy
        sxx += dx * dx
        syy += dy * dy
        sxy += dx * dy
    tr, det = sxx + syy, sxx * syy - sxy * sxy
    lam = tr / 2 + math.sqrt(max(0.0, (tr / 2) ** 2 - det))
    if abs(sxy) > 1e-9:
        vx, vy = lam - syy, sxy
    else:
        vx, vy = (1.0, 0.0) if sxx >= syy else (0.0, 1.0)
    norm = math.hypot(vx, vy) or 1.0
    return to_m, (vx / norm, vy / norm), (cx, cy)


def _slab_clip(ring, tval, t_lo, t_hi):
    """Sutherland-Hodgman clip of the CYCLIC ring to the convex slab
    {t_lo <= t(p) <= t_hi}. ring is open; returns an open ring (or [])."""

    def clip_half(poly, keep, boundary):
        if not poly:
            return poly
        out = []
        n = len(poly)
        tv = [tval(p) for p in poly]
        for i in range(n):
            cur, nxt = poly[i], poly[(i + 1) % n]
            tc, tn = tv[i], tv[(i + 1) % n]
            ci, ni = keep(tc), keep(tn)
            if ci:
                out.append(cur)
            if ci != ni and (tn - tc) != 0:
                a = (boundary - tc) / (tn - tc)
                out.append([cur[0] + a * (nxt[0] - cur[0]), cur[1] + a * (nxt[1] - cur[1])])
        return out

    r = clip_half(ring, lambda t: t >= t_lo, t_lo)
    r = clip_half(r, lambda t: t <= t_hi, t_hi)
    return r


def _slice_reach(outer):
    """Cut a long outer ring into ~RSURF_SLICE_LEN_M cross-sections along its
    main axis (adds interior boundary vertices so earcut can't span the slope
    with a few huge triangles). Adjacent slices share identical cut vertices, so
    they meet seamlessly. Falls back to [outer] when a single slice."""
    to_m, (ux, uy), (cx, cy) = _main_axis(outer)

    def proj(p):
        x, y = to_m(p)
        return (x - cx) * ux + (y - cy) * uy

    ts = [proj(p) for p in outer]
    t_min, t_max = min(ts), max(ts)
    length = t_max - t_min
    n = max(1, round(length / RSURF_SLICE_LEN_M))
    if n <= 1:
        return [outer]
    step = length / n
    out = []
    for i in range(n):
        lo = t_min + step * i - 1e-6
        hi = t_min + step * (i + 1) + (1e-6 if i == n - 1 else 0.0)
        sl = _slab_clip(outer, proj, lo, hi)
        if len(sl) >= 3 and _ring_area_m2(_closed(sl)) > 500:
            out.append(sl)
    return out or [outer]


def _bake_surface_elev(ring, cache, inward=True):
    """Per-vertex water elevation: sample the DTM slightly INTO the water
    (bank ring → toward centroid; hole ring → away from it, since water sits
    outside the sandbar) then rolling-min along the ring to drop residual
    bank-height spikes. Clamped at a small floor to swallow tidal-mouth noise."""
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    sign = 1.0 if inward else -1.0
    raw = []
    for p in ring:
        dx, dy = cx - p[0], cy - p[1]
        d = math.hypot(dx, dy)
        if d > 0:
            off = sign * min(RSURF_INSET_CAP_DEG, 0.35 * d) / d
            raw.append(cache.elevation(p[0] + dx * off, p[1] + dy * off))
        else:
            raw.append(cache.elevation(p[0], p[1]))
    n = len(raw)
    out = []
    for i in range(n):
        v = min(raw[(i + j) % n] for j in range(-RSURF_ROLL_WIN, RSURF_ROLL_WIN + 1))
        out.append(max(RSURF_ELEV_FLOOR_M, v))
    return out


def bake_river_surfaces(cache):
    data = json.loads(RIVER_SURFACES_SRC.read_text())
    feats = data["features"]
    polygons = []
    kept = sliced = holed = 0
    vertex_total = 0
    raw_polys = 0

    def emit(ring_pts, holes):
        nonlocal vertex_total
        oe = _bake_surface_elev(ring_pts, cache, inward=True)
        o = [[round(p[0], 5), round(p[1], 5), oe[i]] for i, p in enumerate(ring_pts)]
        rec = {"o": o}
        vertex_total += len(o)
        if holes:
            hh = []
            for hl in holes:
                he = _bake_surface_elev(hl, cache, inward=False)
                hh.append([[round(p[0], 5), round(p[1], 5), he[i]] for i, p in enumerate(hl)])
                vertex_total += len(hl)
            rec["h"] = hh
        polygons.append(rec)

    for feat in feats:
        geom = feat["geometry"]
        subs = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in subs:
            raw_polys += 1
            outer = _ring_open(poly[0])
            if len(outer) < 3:
                continue
            area = _ring_area_m2(_closed(outer))
            per = _ring_perimeter_m(outer)
            width = 2 * area / per if per > 0 else 0.0
            if width < RSURF_WIDTH_MIN_M or area < RSURF_AREA_MIN_M2:
                continue

            holes = []
            for h in poly[1:]:
                ho = _ring_open(h)
                if len(ho) < 3 or _ring_area_m2(_closed(ho)) < RSURF_HOLE_MIN_M2:
                    continue
                hs = dp_simplify(ho, RSURF_HOLE_TOL_DEG)
                if len(hs) >= 3:
                    holes.append(hs)

            outer_s = dp_simplify(outer, RSURF_OUTER_TOL_DEG)
            if len(outer_s) < 3:
                continue
            kept += 1

            xs = [p[0] for p in outer_s]
            ys = [p[1] for p in outer_s]
            diag = _haversine_m((min(xs), min(ys)), (max(xs), max(ys)))
            if holes:
                holed += 1
                emit(outer_s, holes)
            elif diag > RSURF_SLICE_DIAG_M:
                sliced += 1
                for sl in _slice_reach(outer_s):
                    emit(sl, [])
            else:
                emit(outer_s, [])

    meta = {
        "featuresTotal": len(feats),
        "rawPolygons": raw_polys,
        "polygonsKept": kept,
        "polygonsSliced": sliced,
        "polygonsHoled": holed,
        "polygonsOut": len(polygons),
        "vertexTotal": vertex_total,
        "widthMinM": RSURF_WIDTH_MIN_M,
        "areaMinM2": RSURF_AREA_MIN_M2,
        "outerTolDeg": RSURF_OUTER_TOL_DEG,
        "sliceDiagM": RSURF_SLICE_DIAG_M,
        "sliceLenM": RSURF_SLICE_LEN_M,
    }
    return polygons, meta


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cache = TileCache()
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")

    rail_lines, route_count = bake_rail(cache)
    rail_fallback = dict(cache.hits)

    rail_out = {
        "meta": {
            "generated": generated,
            "routeCount": route_count,
            "partCount": len(rail_lines),
            "vertexCount": sum(len(l["points"]) for l in rail_lines),
            "tileFallback": rail_fallback,
        },
        "lines": rail_lines,
    }
    (OUT_DIR / "rail_lines.json").write_text(json.dumps(rail_out, ensure_ascii=False, separators=(",", ":")))

    station_cache = TileCache()  # separate hit counters for the summary
    systems = bake_stations(station_cache)
    station_count = sum(len(s["points"]) for s in systems.values())

    stations_out = {
        "meta": {
            "generated": generated,
            "stationCount": station_count,
            "systems": sorted(systems.keys()),
            "tileFallback": station_cache.hits,
        },
        "systems": systems,
    }
    (OUT_DIR / "stations.json").write_text(json.dumps(stations_out, ensure_ascii=False, separators=(",", ":")))

    print(f"rail_lines.json  : {route_count} routes / {len(rail_lines)} parts / {rail_out['meta']['vertexCount']} vertices"
          f"  (tile z13={rail_fallback['z13']} z12={rail_fallback['z12']} sea/missing={rail_fallback['sea']})")
    print(f"stations.json    : {station_count} stations across {len(systems)} systems {sorted(systems.keys())}"
          f"  (tile z13={station_cache.hits['z13']} z12={station_cache.hits['z12']} sea/missing={station_cache.hits['sea']})")

    # ---- rivers ----
    river_cache = TileCache()
    river_labels, river_meta = bake_rivers(river_cache)
    rivers_out = {
        "meta": {"generated": generated, **river_meta, "tileFallback": river_cache.hits},
        "labels": river_labels,
    }
    (OUT_DIR / "rivers.json").write_text(json.dumps(rivers_out, ensure_ascii=False, separators=(",", ":")))

    # ---- reservoirs ----
    res_cache = TileCache()
    reservoirs, dams, res_meta = bake_reservoirs(res_cache)
    res_out = {
        "meta": {"generated": generated, **res_meta, "tileFallback": res_cache.hits},
        "reservoirs": reservoirs,
        "dams": dams,
    }
    (OUT_DIR / "reservoirs.json").write_text(json.dumps(res_out, ensure_ascii=False, separators=(",", ":")))

    # ---- river surfaces ----
    rsurf_cache = TileCache()
    river_surfaces, rsurf_meta = bake_river_surfaces(rsurf_cache)
    rsurf_out = {
        "meta": {"generated": generated, **rsurf_meta, "tileFallback": rsurf_cache.hits},
        "polygons": river_surfaces,
    }
    (OUT_DIR / "river_surfaces.json").write_text(json.dumps(rsurf_out, ensure_ascii=False, separators=(",", ":")))

    print(f"rivers.json      : {river_meta['partsRaw']} raw parts -> {river_meta['chainsStitched']} chains "
          f"(T-junction snap {river_meta['tjunctionSnapped']}/{river_meta['tjunctionChecked']} closed)")
    print(f"                   join: {river_meta['chainsMatched']}/{river_meta['chainsStitched']} chains matched "
          f"({river_meta['joinHitRatePct']}% hit, {river_meta['joinFallbackMatched']} via fallback tol, "
          f"{river_meta['chainsNamed']} named) "
          f"against {river_meta['joinPolysUsed']} WRA polys ({river_meta['joinPolysSkippedEmpty']} harbours skipped)")
    print(f"                   keptByType {river_meta['keptByType']} (labels-only output — vector lines retired)")
    print(f"                   chainsKept {river_meta['chainsKept']} ({river_meta['keptMatched']} matched + "
          f"{river_meta['keptSystemOnly']} system), vertices {river_meta['vertexRaw']} -> "
          f"{river_meta['vertexSimplified']}, labels {river_meta['labelCount']} "
          f"(system floor {RIVER_SYSTEM_MIN_KM} km, label floor {RIVER_LABEL_MIN_KM} km)")
    print(f"reservoirs.json  : kept {res_meta['reservoirsKept']}/{res_meta['featuresTotal']} basins, "
          f"{res_meta['matchedDamHeight']} matched dam heights, {res_meta['damMarkers']} dam markers, "
          f"fullElev {res_meta['fullElevRange'][0]}–{res_meta['fullElevRange'][1]} m, "
          f"ring verts {res_meta['ringVertexTotal']}")
    print(f"river_surfaces.json: kept {rsurf_meta['polygonsKept']}/{rsurf_meta['rawPolygons']} polygons "
          f"(width>= {RSURF_WIDTH_MIN_M} m, area>= {RSURF_AREA_MIN_M2/1000:.0f}k m²), "
          f"{rsurf_meta['polygonsSliced']} sliced + {rsurf_meta['polygonsHoled']} holed "
          f"-> {rsurf_meta['polygonsOut']} out, {rsurf_meta['vertexTotal']} vertices")

    def _kb(p):
        return f"{p.stat().st_size / 1024:.0f} KB"

    print(f"wrote -> {OUT_DIR / 'rail_lines.json'}")
    print(f"wrote -> {OUT_DIR / 'stations.json'}")
    print(f"wrote -> {OUT_DIR / 'rivers.json'} ({_kb(OUT_DIR / 'rivers.json')})")
    print(f"wrote -> {OUT_DIR / 'reservoirs.json'} ({_kb(OUT_DIR / 'reservoirs.json')})")
    print(f"wrote -> {OUT_DIR / 'river_surfaces.json'} ({_kb(OUT_DIR / 'river_surfaces.json')})")


if __name__ == "__main__":
    main()
