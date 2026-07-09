#!/usr/bin/env python3
"""Regional context coastlines for the typhoon view.

Fetches Natural Earth 1:10m coastline (public domain), crops it to a window
around Taiwan wide enough to show the neighbours the user asked for — Taiwan's
outlying islands, N Philippines (Luzon), the Ryukyus / Okinawa, S Japan, S Korea
and the SE China coast — simplifies each line with Douglas-Peucker, and writes a
small polyline JSON the region layer draws as flat sea-level strokes.

    public/layers/region_coast.json   { bbox, lines: [ [[lon,lat],...], ... ] }

No shapely/geopandas dependency: bbox clipping and DP simplification are done in
plain Python so it runs against the project's existing numpy/PIL toolchain.
"""

import json
import math
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "layers" / "region_coast.json"
CACHE = Path("/private/tmp/claude-501/ne_10m_coastline.geojson")
URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson"

# window around Taiwan: Luzon(S) → Korea/Japan(N), China coast(W) → Honshu(E)
BBOX = {"minLon": 116.0, "maxLon": 142.0, "minLat": 12.0, "maxLat": 41.0}
MARGIN = 0.5              # keep points a touch outside so strokes reach the edge
DP_TOL = 0.012           # Douglas-Peucker tolerance (degrees, ~1.3 km)
MIN_PTS = 2              # drop degenerate sub-lines shorter than this


def fetch():
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    print(f"[region] downloading {URL}")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(URL, timeout=120) as r:
        data = r.read()
    CACHE.write_bytes(data)
    print(f"[region] cached {len(data)/1e6:.1f} MB")
    return json.loads(data)


def inside(pt):
    lon, lat = pt
    return (BBOX["minLon"] - MARGIN <= lon <= BBOX["maxLon"] + MARGIN
            and BBOX["minLat"] - MARGIN <= lat <= BBOX["maxLat"] + MARGIN)


def clip(line):
    """Split a LineString into runs of consecutive in-window points."""
    runs, cur = [], []
    for pt in line:
        if inside(pt):
            cur.append(pt)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return runs


def _dp(pts, tol, lo, hi, keep):
    if hi <= lo + 1:
        return
    ax, ay = pts[lo]
    bx, by = pts[hi]
    dx, dy = bx - ax, by - ay
    d2 = dx * dx + dy * dy
    imax, dmax = -1, 0.0
    for i in range(lo + 1, hi):
        px, py = pts[i]
        if d2 == 0:
            dist = math.hypot(px - ax, py - ay)
        else:
            t = ((px - ax) * dx + (py - ay) * dy) / d2
            t = max(0.0, min(1.0, t))
            dist = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
        if dist > dmax:
            imax, dmax = i, dist
    if dmax > tol:
        keep[imax] = True
        _dp(pts, tol, lo, imax, keep)
        _dp(pts, tol, imax, hi, keep)


def simplify(pts, tol):
    if len(pts) <= 2:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    _dp(pts, tol, 0, len(pts) - 1, keep)
    return [p for p, k in zip(pts, keep) if k]


def main():
    gj = fetch()
    lines = []
    pts_in = pts_out = 0
    for feat in gj.get("features", []):
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        parts = []
        if gtype == "LineString":
            parts = [geom["coordinates"]]
        elif gtype == "MultiLineString":
            parts = geom["coordinates"]
        for part in parts:
            pts_in += len(part)
            for run in clip(part):
                if len(run) < MIN_PTS:
                    continue
                simp = simplify([[round(x, 4), round(y, 4)] for x, y in run], DP_TOL)
                if len(simp) >= MIN_PTS:
                    lines.append(simp)
                    pts_out += len(simp)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {"bbox": BBOX, "lines": lines,
               "note": "Natural Earth 10m coastline, cropped + DP-simplified; [lon,lat] pairs"}
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    size = OUT.stat().st_size
    print(f"[region] {len(lines):,} polylines, {pts_out:,} pts "
          f"(from {pts_in:,}) → {OUT.name} {size/1024:.0f} KB")


if __name__ == "__main__":
    main()
