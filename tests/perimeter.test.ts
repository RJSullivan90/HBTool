//
// perimeter.test.ts — simplification and arc measurement.
//
// Mirrors the Swift suite's coverage. The assertions that matter most are the
// ones encoding contractual behaviour: tolerance mode bounding deviation by
// construction, percentage mode NOT doing so, arcs summing to the perimeter, and
// A/B surviving a change of geometry.
//

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assemble,
  documentFromPolygons,
  douglasPeuckerKeep,
  partCount,
  ringIsClockwise,
  vertexCount,
  visvalingamOrder,
  type LonLat,
} from '../src/shared/geometry.ts';
import {
  ACCURACY_LIMIT_M,
  areaDeltaHectares,
  keptIndices,
  maxDeviation,
  removedPercent,
  simplifiedKML,
  simplifiedRings,
  simplifyPlan,
  simplifyStats,
} from '../src/shared/simplify.ts';
import { measuredRings, longestRing, sectionLineKML, MeasuredRing } from '../src/shared/measure.ts';
import { segmentMetres } from '../src/shared/geo.ts';

const C_LAT = 50.0;
const C_LON = -120.0;

/** A closed ring with optional wiggle, the same shape the Swift suite uses. */
function makeRing(n: number, wiggle: boolean): LonLat[] {
  const pts: LonLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const r = wiggle ? 0.05 + 0.004 * Math.sin(11 * a) + 0.0015 * Math.cos(23 * a) : 0.05;
    pts.push([
      C_LON + (r * Math.cos(a)) / Math.cos((C_LAT * Math.PI) / 180),
      C_LAT + r * Math.sin(a),
    ]);
  }
  pts.push(pts[0]); // closed, like a KML ring
  return pts;
}

const doc = () => assemble([{ name: 'ring', isPolygon: true, parts: [[makeRing(600, true)]] }]);

test('assemble builds one document on one zone', () => {
  const d = doc();
  assert.equal(d.zone, 10);
  assert.equal(d.features.length, 1);
  assert.equal(partCount(d), 1);
  assert.equal(vertexCount(d), 601);
  assert.equal(d.features[0].parts[0].rings[0].isClosed, true);
});

test('a distant second feature moves the whole document to one zone', () => {
  // Correct behaviour: everything must land on a single grid, even if that grid
  // suits neither feature perfectly.
  const d = assemble([
    { name: 'west', isPolygon: false, parts: [[[[-130, 50], [-129, 50]]]] },
    { name: 'east', isPolygon: false, parts: [[[[-114, 50], [-113, 50]]]] },
  ]);
  // Centre is -121.5, which lies in zone 10 (zone 11 begins at -120) — so both
  // features land on zone 10 even though the eastern one would prefer 11.
  assert.equal(d.zone, 10);
});

test('tolerance mode bounds deviation BY CONSTRUCTION', () => {
  // This is the contractual guarantee: ask for N metres, get at most N metres.
  const d = doc();
  const ring = d.features[0].parts[0].rings[0];
  for (const tol of [1, 5, 10, 25, 100]) {
    const kept = keptIndices(ring, 'tolerance', 0, tol);
    const dev = maxDeviation(ring, kept);
    assert.ok(dev <= tol + 1e-6, `tolerance ${tol} m produced ${dev.toFixed(3)} m`);
  }
});

test('percentage mode does NOT bound deviation — hence the readout', () => {
  // Visvalingam ranks by triangle area, so a thin spike scores low and can move
  // the boundary far at a modest removal percentage. The tool must therefore
  // show measured deviation rather than implying the percentage is safe.
  const spiky: LonLat[] = [];
  const n = 200;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    // Every 20th vertex spikes outward.
    const r = 0.05 + (i % 20 === 0 ? 0.02 : 0);
    spiky.push([
      C_LON + (r * Math.cos(a)) / Math.cos((C_LAT * Math.PI) / 180),
      C_LAT + r * Math.sin(a),
    ]);
  }
  spiky.push(spiky[0]);
  const d = assemble([{ name: 's', isPolygon: true, parts: [[spiky]] }]);
  const ring = d.features[0].parts[0].rings[0];
  const kept = keptIndices(ring, 'percent', 50, 0);
  const dev = maxDeviation(ring, kept);
  assert.ok(dev > ACCURACY_LIMIT_M, `expected >10 m at 50% removal, got ${dev.toFixed(1)} m`);
});

test('simplification never drops a ring below being a ring', () => {
  const d = doc();
  const ring = d.features[0].parts[0].rings[0];
  for (const pct of [99, 100, 150]) {
    const kept = keptIndices(ring, 'percent', pct, 0);
    assert.ok(kept.length >= 4, `percent ${pct} left ${kept.length} vertices`);
  }
  const huge = keptIndices(ring, 'tolerance', 0, 1e9);
  assert.ok(huge.length >= 4);
});

test('percent 0 keeps everything', () => {
  const d = doc();
  const ring = d.features[0].parts[0].rings[0];
  assert.equal(keptIndices(ring, 'percent', 0, 0).length, ring.lonlat.length);
});

test('stats report the removal, the deviation and the area change', () => {
  const d = doc();
  const kept = simplifyPlan(d, 'tolerance', 0, 10);
  const s = simplifyStats(d, kept);
  assert.equal(s.before, 601);
  assert.ok(s.after < s.before);
  assert.ok(s.deviation <= 10 + 1e-6);
  assert.ok(removedPercent(s) > 0 && removedPercent(s) < 100);
  assert.equal(s.parts, 1);
  // A simplified perimeter encloses slightly less; a few hectares on a big fire.
  assert.ok(Math.abs(areaDeltaHectares(s)) < 50);
});

test('holes subtract from the measured area', () => {
  const outer = makeRing(200, false);
  const holePts: LonLat[] = [];
  for (let i = 0; i < 60; i++) {
    const a = (2 * Math.PI * i) / 60;
    holePts.push([
      C_LON + (0.01 * Math.cos(a)) / Math.cos((C_LAT * Math.PI) / 180),
      C_LAT + 0.01 * Math.sin(a),
    ]);
  }
  holePts.push(holePts[0]);
  const withHole = assemble([{ name: 'h', isPolygon: true, parts: [[outer, holePts]] }]);
  const solid = assemble([{ name: 's', isPolygon: true, parts: [[outer]] }]);
  const a1 = simplifyStats(withHole, simplifyPlan(withHole, 'percent', 0, 0)).areaBefore;
  const a2 = simplifyStats(solid, simplifyPlan(solid, 'percent', 0, 0)).areaBefore;
  assert.ok(a1 < a2, 'a ring with a hole must enclose less than the same ring solid');
});

test('multi-part geometry stays multi-part through simplification and KML', () => {
  const d = documentFromPolygons('fire', [[makeRing(120, true)], [makeRing(80, false)]]);
  assert.equal(partCount(d), 2);
  const kept = simplifyPlan(d, 'tolerance', 0, 20);
  const kml = simplifiedKML('fire', d, kept, 'note');
  assert.match(kml, /<MultiGeometry>/);
  assert.equal((kml.match(/<Polygon>/g) ?? []).length, 2);
  assert.equal(simplifyStats(d, kept).parts, 2);
});

test('simplifiedRings materialises exactly the retained vertices', () => {
  const d = doc();
  const kept = simplifyPlan(d, 'tolerance', 0, 25);
  const out = simplifiedRings(d, kept);
  assert.equal(out[0].parts[0].rings[0].lonlat.length, kept[0][0][0].length);
  // and it is the same geometry the export would write
  assert.deepEqual(
    out[0].parts[0].rings[0].lonlat[0],
    d.features[0].parts[0].rings[0].lonlat[kept[0][0][0][0]],
  );
});

test('Douglas-Peucker keeps the endpoints and degenerates gracefully', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 0.5 },
    { x: 20, y: 0 },
  ];
  assert.deepEqual(douglasPeuckerKeep(pts, 1), [0, 2]); // 0.5 m spike dropped
  assert.deepEqual(douglasPeuckerKeep(pts, 0.1), [0, 1, 2]); // kept
  assert.deepEqual(douglasPeuckerKeep([{ x: 0, y: 0 }], 1), [0]);
  assert.deepEqual(douglasPeuckerKeep([], 1), []);
});

test('Visvalingam never offers the endpoints for removal', () => {
  const d = doc();
  const ring = d.features[0].parts[0].rings[0];
  const n = ring.metres.length;
  assert.ok(!ring.order.includes(0));
  assert.ok(!ring.order.includes(n - 1));
  assert.equal(ring.order.length, n - 2);
  // Least important first: dropping in order should be monotonically worse.
  assert.equal(new Set(ring.order).size, ring.order.length, 'no index ranked twice');
});

test('visvalingamOrder handles tiny inputs', () => {
  assert.deepEqual(visvalingamOrder([]), []);
  assert.deepEqual(visvalingamOrder([{ x: 0, y: 0 }, { x: 1, y: 1 }]), []);
});

test('ring orientation is detected', () => {
  const ccw: LonLat[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  assert.equal(ringIsClockwise(ccw), false);
  assert.equal(ringIsClockwise([...ccw].reverse()), true);
});

// MARK: measurement

test('a closed ring measures as a cycle and arcs sum to the whole', () => {
  const d = doc();
  const rings = measuredRings(d.features);
  const r = longestRing(rings)!;
  assert.ok(r.isClosed);
  // The duplicate closing vertex is dropped.
  assert.equal(r.count, 600);

  const a: MeasuredRing['nearestEdgePoint'] extends never ? never : import('../src/shared/measure.ts').EdgePoint =
    { part: 0, ring: 0, segment: 10, t: 0.25 };
  const b = { part: 0, ring: 0, segment: 400, t: 0.75 };
  const fwd = r.forwardDistance(a, b);
  const rev = r.forwardDistance(b, a);
  assert.ok(Math.abs(fwd + rev - r.total) < 1e-6, 'the two arcs must sum to the perimeter');
  assert.ok(fwd > 0 && rev > 0);
});

test('the exported arc path matches the measured distance', () => {
  const d = doc();
  const r = longestRing(measuredRings(d.features))!;
  const a = { part: 0, ring: 0, segment: 5, t: 0 };
  const b = { part: 0, ring: 0, segment: 200, t: 0.5 };
  const path = r.forwardPathLonLat(a, b);
  let walked = 0;
  for (let i = 0; i + 1 < path.length; i++) walked += segmentMetres(path[i], path[i + 1]);
  const measured = r.forwardDistance(a, b);
  // Same vertices, same ellipsoidal formula — they must agree closely.
  assert.ok(
    Math.abs(walked - measured) < 0.5,
    `walked ${walked.toFixed(2)} vs measured ${measured.toFixed(2)}`,
  );
});

test('the arc path starts and ends exactly on the anchors', () => {
  const d = doc();
  const r = longestRing(measuredRings(d.features))!;
  const a = { part: 0, ring: 0, segment: 3, t: 0.4 };
  const b = { part: 0, ring: 0, segment: 90, t: 0.6 };
  const path = r.forwardPathLonLat(a, b);
  assert.deepEqual(path[0], r.lonlatPosition(a));
  assert.deepEqual(path[path.length - 1], r.lonlatPosition(b));
});

test('forward and reverse trace the same vertices in opposite order', () => {
  const d = doc();
  const r = longestRing(measuredRings(d.features))!;
  const a = { part: 0, ring: 0, segment: 10, t: 0 };
  const b = { part: 0, ring: 0, segment: 30, t: 0 };
  const f = r.forwardVertexIndices(a, b);
  const rv = r.forwardVertexIndices(b, a);
  // The arcs are complementary and share no vertex.
  assert.equal(new Set([...f, ...rv]).size, f.length + rv.length);
  // They sum to count - 2, NOT count: forwardVertexIndices excludes the
  // interpolated endpoints, and with t=0 the anchors sit exactly on vertices 10
  // and 30, so those two belong to neither arc. Both arcs still render through
  // them, because forwardPath adds position(a) and position(b) back at the ends.
  assert.equal(f.length + rv.length, r.count - 2);
  assert.ok(!f.includes(10) && !rv.includes(10));
  assert.equal(f[0], 11);
  assert.equal(f[f.length - 1], 29);
  assert.equal(rv[0], 31);
  assert.equal(rv[rv.length - 1], 9); // wraps through 0
});

test('nearest edge point snaps to the ring and round-trips', () => {
  const d = doc();
  const r = longestRing(measuredRings(d.features))!;
  const target = r.lonlat[123];
  const snapped = r.nearestEdgePointLonLat(target)!;
  const back = r.lonlatPosition(snapped);
  assert.ok(Math.abs(back[0] - target[0]) < 1e-9);
  assert.ok(Math.abs(back[1] - target[1]) < 1e-9);
});

test('A and B survive a change of geometry by re-anchoring geographically', () => {
  // The reason A/B are not (segment, t) indices: simplifying rebuilds the vertex
  // list, so segment 400 of the original is somewhere else entirely afterwards.
  const d = doc();
  const full = longestRing(measuredRings(d.features))!;
  const anchor = full.lonlatPosition({ part: 0, ring: 0, segment: 400, t: 0.5 });

  const kept = simplifyPlan(d, 'tolerance', 0, 30);
  const simplified = longestRing(measuredRings(simplifiedRings(d, kept)))!;
  assert.ok(simplified.count < full.count, 'simplification must actually remove vertices');

  const resnapped = simplified.nearestEdgePointLonLat(anchor)!;
  const where = simplified.lonlatPosition(resnapped);
  // The anchor lands back on the boundary, within the simplification tolerance.
  assert.ok(segmentMetres(where, anchor) <= 30 + 1, 'anchor drifted beyond the tolerance');
});

test('an open line measures end to end, not as a cycle', () => {
  const line: LonLat[] = [
    [-120.0, 50.0],
    [-120.0, 50.01],
    [-120.0, 50.02],
  ];
  const d = assemble([{ name: 'l', isPolygon: false, parts: [[line]] }]);
  const r = measuredRings(d.features)[0];
  assert.equal(r.isClosed, false);
  assert.equal(r.count, 3);
  const expected = segmentMetres(line[0], line[1]) + segmentMetres(line[1], line[2]);
  assert.ok(Math.abs(r.total - expected) < 1e-6);
  // Not cyclic: the two directions are the same length, not complementary.
  const a = { part: 0, ring: 0, segment: 0, t: 0 };
  const b = { part: 0, ring: 0, segment: 1, t: 1 };
  assert.ok(Math.abs(r.forwardDistance(a, b) - r.forwardDistance(b, a)) < 1e-9);
});

test('section KML is a single magenta LineString with 7 decimals', () => {
  const kml = sectionLineKML('Section', [
    [-120.1234567, 50.7654321],
    [-120.2, 50.8],
  ], 'A → B, 1.23 km');
  assert.equal((kml.match(/<LineString>/g) ?? []).length, 1);
  assert.ok(!kml.includes('<Polygon>'));
  assert.match(kml, /ffff00ff/); // magenta, reads over imagery
  assert.match(kml, /-120\.1234567,50\.7654321,0/);
  assert.match(kml, /A → B, 1\.23 km/);
});

test('a very large ring simplifies without pathological slowness', () => {
  // A real perimeter has run to 54,333 vertices, which pinned a core for 30-50s
  // in the Swift app before the work was memoised. The algorithms themselves must
  // stay O(n log n).
  const big = makeRing(20_000, true);
  const t0 = Date.now();
  const d = assemble([{ name: 'big', isPolygon: true, parts: [[big]] }]);
  const kept = simplifyPlan(d, 'tolerance', 0, 10);
  const s = simplifyStats(d, kept);
  const ms = Date.now() - t0;
  assert.ok(s.after < s.before);
  assert.ok(ms < 10_000, `20k vertices took ${ms} ms`);
});

test('the exported section is the arc the direction names, both ways', () => {
  // The invariant behind "Selected section" and the KML export: whichever
  // direction is chosen, the exported path must be the arc whose length is
  // reported. Getting this inverted would hand a pilot the wrong side of a fire.
  const d = doc();
  const r = longestRing(measuredRings(d.features))!;
  const a = r.nearestEdgePointLonLat(r.lonlat[0])!;
  const b = r.nearestEdgePointLonLat(r.lonlat[Math.floor(r.count / 3)])!;

  for (const direction of ['forward', 'reverse'] as const) {
    const from = direction === 'forward' ? a : b;
    const to = direction === 'forward' ? b : a;
    const reported = r.forwardDistance(from, to);
    const path = r.forwardPathLonLat(from, to);
    let walked = 0;
    for (let i = 0; i + 1 < path.length; i++) walked += segmentMetres(path[i], path[i + 1]);
    assert.ok(
      Math.abs(walked - reported) < 1,
      `${direction}: exported ${walked.toFixed(1)} m vs reported ${reported.toFixed(1)} m`,
    );
  }

  // And the two directions really are different arcs summing to the perimeter.
  const fwd = r.forwardDistance(a, b);
  const rev = r.forwardDistance(b, a);
  assert.notEqual(fwd.toFixed(3), rev.toFixed(3));
  assert.ok(Math.abs(fwd + rev - r.total) < 1e-6);
});

test('snapping is geometric, not ordinal', () => {
  // The property A/B rely on: the nearest edge point is decided purely by
  // position, with no regard for vertex order. That is what lets an anchor
  // survive the vertex list being rebuilt by the simplify slider — and it also
  // means an anchor can legitimately land on a segment far away in index terms
  // where a perimeter doubles back on itself.
  const line: LonLat[] = [
    [-120.0, 50.0],
    [-120.0, 50.02],
    [-119.99, 50.02],
    [-119.99, 50.0],
    [-119.98, 50.0],
    [-119.98, 50.02],
  ];
  const d2 = assemble([{ name: 'z', isPolygon: false, parts: [[line]] }]);
  const r2 = measuredRings(d2.features)[0];

  // A point on the midpoint of segment 4 snaps to segment 4, not to segment 0,
  // even though segment 0 comes first and is the same shape.
  const onSeg4: LonLat = [-119.98, 50.01];
  const snapped = r2.nearestEdgePointLonLat(onSeg4)!;
  assert.equal(snapped.segment, 4);
  const back = r2.lonlatPosition(snapped);
  assert.ok(Math.abs(back[0] - onSeg4[0]) < 1e-9);
  assert.ok(Math.abs(back[1] - onSeg4[1]) < 1e-9);
});
