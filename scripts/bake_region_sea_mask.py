#!/usr/bin/env python3
"""Land/sea mask for the region sea plane.

The region sea plane must NOT be an elevation threshold — genuinely low-lying
land (the western plain) sits below any sensible sea height and would flood /
z-fight. Instead we bake a proper land/sea MASK from the exact Taiwan main-island
coastline ring (src/engine/data/coastline_taiwan.json): the sea plane samples it
and DISCARDS wherever the mask says land, independent of elevation.

    public/layers/region_sea_mask.png   L, sea=255 / land=0
    public/layers/region_sea_mask.json  { bbox (lon/lat), size, png }

Baked in a Web-Mercator pixel grid (row 0 = north, col 0 = west) so it maps
linearly to world space — the sea plane's UVs are set from the bbox projected
through the same projection the engine uses (see region.js), exactly like the
river-sim texture.
"""

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RING = ROOT / "src" / "engine" / "data" / "coastline_taiwan.json"
OUT_PNG = ROOT / "public" / "layers" / "region_sea_mask.png"
OUT_JSON = ROOT / "public" / "layers" / "region_sea_mask.json"

MARGIN = 0.12   # degrees of sea kept around the island so the plane fills to the coast
WIDTH = 1024    # px; height derived to keep world-square pixels (Mercator)


def merc_y(lat):
    r = math.radians(lat)
    return math.log(math.tan(r) + 1.0 / math.cos(r))


def main():
    ring = json.loads(RING.read_text())
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    min_lon, max_lon = min(lons) - MARGIN, max(lons) + MARGIN
    min_lat, max_lat = min(lats) - MARGIN, max(lats) + MARGIN

    my_max, my_min = merc_y(max_lat), merc_y(min_lat)  # north, south
    d_lon = (max_lon - min_lon) * math.pi / 180.0       # world-x span (radians)
    d_my = my_max - my_min                              # world-z span (Mercator)
    height = max(1, round(WIDTH * d_my / d_lon))

    def to_px(lon, lat):
        col = (lon - min_lon) / (max_lon - min_lon) * (WIDTH - 1)
        row = (my_max - merc_y(lat)) / d_my * (height - 1)
        return (col, row)

    img = Image.new("L", (WIDTH, height), 255)  # sea
    ImageDraw.Draw(img).polygon([to_px(lon, lat) for lon, lat in ring], fill=0)  # land
    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT_PNG)

    meta = {
        "bbox": {"minLon": round(min_lon, 5), "maxLon": round(max_lon, 5),
                 "minLat": round(min_lat, 5), "maxLat": round(max_lat, 5)},
        "size": {"w": WIDTH, "h": height},
        "png": "/layers/region_sea_mask.png",
        "note": "row 0 = north, col 0 = west; L: sea=255 land=0 (main island only)",
    }
    OUT_JSON.write_text(json.dumps(meta, indent=2))

    land_px = sum(1 for p in img.getdata() if p < 128)
    print(f"[mask] {WIDTH}x{height}, land {100*land_px/(WIDTH*height):.1f}% "
          f"→ {OUT_PNG.name} {OUT_PNG.stat().st_size/1024:.0f} KB  bbox={meta['bbox']}")


if __name__ == "__main__":
    main()
