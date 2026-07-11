// Pure-geometry regression test for VECTOR_TILES_DESIGN.md §3's polygon
// winding trap (Phase 3, ftw_fields). Run standalone, no dev server / DEM /
// THREE scene needed:
//
//   node scripts/test_polygon_winding.mjs
//
// What this proves, from reading the two libraries' own source (three's
// ShapeUtils.triangulateShape -> Earcut.triangulate in
// node_modules/three/src/extras/{ShapeUtils,Earcut}.js, and
// @mapbox/vector-tile's exported classifyRings in
// node_modules/@mapbox/vector-tile/index.js):
//
//   1. Earcut normalizes the OUTER contour and EACH hole to fixed absolute
//      windings independently (each ring's own linkedList() call re-derives
//      direction from that ring's OWN signed-area sign — see Earcut.js
//      linkedList()/eliminateHoles()). So triangulateShape(contour, holes)
//      triangulates correctly no matter which absolute winding MVT vs.
//      three.js "prefers" — test 2 below proves feeding a hole with the
//      SAME winding as its contour still subtracts correctly. No manual
//      y-flip or winding-reversal step is needed before calling it.
//   2. The REAL trap is upstream of triangulation: `feature.loadGeometry()`
//      returns a FLAT list of rings for a Polygon/MultiPolygon feature with
//      NO explicit exterior/hole grouping. A naive "ring[0] = contour, every
//      other ring = a hole" assumption (test 4) silently corrupts the mesh
//      the moment a feature has more than one exterior ring (a MultiPolygon
//      — plausible for farmland parcels split across a tile clip, or a
//      genuinely multi-part field). The fix is `@mapbox/vector-tile`'s own
//      exported `classifyRings(rings)` (test 3), which groups rings into
//      polygons by comparing each ring's signed-area SIGN against the first
//      ring's (same sign = new exterior, opposite sign = hole of the
//      current one) — sign-RELATIVE, so it needs no knowledge of MVT's
//      absolute CW/CCW convention either.
//
// Fixtures live in raw MVT tile-pixel space (y increases downward, same as
// loadGeometry() hands back). A ring's point order is reversed to GUARANTEE
// the opposite winding sign from its un-reversed twin — a property of the
// shoelace formula (reversing traversal negates signed area), not a guess at
// which absolute direction MVT calls "clockwise".

import * as THREE from 'three'
import { classifyRings } from '@mapbox/vector-tile'

let failures = 0
function assert(cond, msg) {
  if (!cond) {
    failures++
    console.error('FAIL:', msg)
  } else {
    console.log('ok  :', msg)
  }
}

const v2 = (pts) => pts.map(([x, y]) => new THREE.Vector2(x, y))
const ringPts = (pts) => pts.map(([x, y]) => ({ x, y }))

// unsigned area of a triangulateShape() face list over its flattened
// [contour, ...holes] Vector2 vertex list
function totalArea(flatVerts, faces) {
  let sum = 0
  for (const [a, b, c] of faces) {
    const p0 = flatVerts[a]
    const p1 = flatVerts[b]
    const p2 = flatVerts[c]
    sum += Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)) / 2
  }
  return sum
}

// ---------------------------------------------------------------- fixtures
const EXT_A = [
  [0, 0],
  [0, 2000],
  [2000, 2000],
  [2000, 0],
] // outer 2000x2000 square
const HOLE_A_SAME_WINDING = [
  [500, 500],
  [500, 1500],
  [1500, 1500],
  [1500, 500],
] // inner 1000x1000 square, SAME traversal pattern as EXT_A (same sign)
const HOLE_A = [...HOLE_A_SAME_WINDING].reverse() // guaranteed OPPOSITE sign from EXT_A
const EXT_B = [
  [3000, 0],
  [3000, 500],
  [3500, 500],
  [3500, 0],
] // disjoint 500x500 square elsewhere in the tile — a 2nd polygon part (MultiPolygon), same winding pattern as EXT_A

const AREA_EXT_A = 2000 * 2000
const AREA_HOLE_A = 1000 * 1000
const AREA_EXT_B = 500 * 500

// ---------------------------------------------------------------- test 1: single polygon with a hole, correctly grouped
{
  const polys = classifyRings([ringPts(EXT_A), ringPts(HOLE_A)])
  assert(polys.length === 1, 'test1: classifyRings finds exactly 1 polygon')
  assert(polys[0]?.length === 2, 'test1: polygon group has 1 exterior + 1 hole')

  const contour = v2(EXT_A)
  const holes = [v2(HOLE_A)]
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes)
  const area = totalArea([...contour, ...holes[0]], faces)
  const expected = AREA_EXT_A - AREA_HOLE_A
  assert(Math.abs(area - expected) < 1e-6, `test1: triangulated area ${area} == outer-minus-hole ${expected} (hole subtracted, not 挖反)`)
}

// ---------------------------------------------------------------- test 2: triangulateShape is winding-agnostic (Earcut self-normalizes)
{
  const contour = v2(EXT_A)
  const holes = [v2(HOLE_A_SAME_WINDING)] // deliberately SAME winding as contour, no manual flip
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes)
  const area = totalArea([...contour, ...holes[0]], faces)
  const expected = AREA_EXT_A - AREA_HOLE_A
  assert(
    Math.abs(area - expected) < 1e-6,
    `test2: same-winding hole still subtracts correctly (area ${area} == ${expected}) — confirms no manual y-flip/winding-reversal is needed`
  )
}

// ---------------------------------------------------------------- test 3: MultiPolygon ring grouping via classifyRings (the real trap)
{
  const rings = [ringPts(EXT_A), ringPts(HOLE_A), ringPts(EXT_B)]
  const polys = classifyRings(rings)
  assert(polys.length === 2, 'test3: classifyRings splits the flat ring list into 2 polygons')
  assert(polys[0]?.length === 2 && polys[1]?.length === 1, 'test3: 1st polygon keeps its hole, 2nd is hole-free')

  let total = 0
  for (const group of polys) {
    const contour = v2(group[0].map((p) => [p.x, p.y]))
    const holes = group.slice(1).map((h) => v2(h.map((p) => [p.x, p.y])))
    const faces = THREE.ShapeUtils.triangulateShape(contour, holes)
    total += totalArea([...contour, ...holes.flat()], faces)
  }
  const expected = AREA_EXT_A - AREA_HOLE_A + AREA_EXT_B
  assert(Math.abs(total - expected) < 1e-6, `test3: per-group triangulation area ${total} == ${expected} (both parts present, hole intact)`)
}

// ---------------------------------------------------------------- test 4: regression — skipping classifyRings corrupts a MultiPolygon feature
{
  // naive "ring0 = contour, every other ring = a hole" — WRONG the moment a
  // feature has more than one exterior ring: EXT_B is a disjoint exterior,
  // not a hole of EXT_A.
  const contour = v2(EXT_A)
  const holes = [v2(HOLE_A), v2(EXT_B)]
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes)
  const area = totalArea([...contour, ...holes.flat()], faces)
  const correct = AREA_EXT_A - AREA_HOLE_A + AREA_EXT_B
  assert(
    Math.abs(area - correct) > 1,
    `test4: naive ungrouped-rings area ${area} DIFFERS from the correctly-grouped total ${correct} — proves classifyRings is load-bearing, not optional`
  )
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS (4/4)')
process.exit(failures ? 1 : 0)
