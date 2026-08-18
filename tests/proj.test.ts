//
// proj.test.ts — UTM projection, cross-validated against proj4.
//
// proj4 is a DEV dependency used purely as an independent oracle here. The app
// ships the hand-ported formulas (see src/shared/proj.ts for why), and this file
// is what proves the transcription is right. A mistyped coefficient produces
// coordinates that look entirely plausible while being tens of metres out, which
// no round-trip test would catch — both directions would be wrong consistently.
//

import { test } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';

import {
  lonLatBounds,
  projectedBounds,
  utmForward,
  utmInverse,
  utmZone,
  zoneForBounds,
} from '../src/shared/proj.ts';

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
const utmDef = (zone: number) => `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`;

// Spread across the country HBTool actually works in, plus the US fires, plus a
// zone edge and the far north where convergence is worst.
const SITES: Array<{ name: string; lat: number; lon: number }> = [
  { name: 'Prince George BC', lat: 53.9171, lon: -122.7497 },
  { name: 'Kamloops BC', lat: 50.6745, lon: -120.3273 },
  { name: 'Grants Pass OR', lat: 42.4393, lon: -123.3284 },
  { name: 'Ely MN', lat: 47.9032, lon: -91.867 },
  { name: 'Whitehorse YT', lat: 60.7212, lon: -135.0568 },
  { name: 'Inuvik NT (far north)', lat: 68.3607, lon: -133.723 },
  { name: 'zone 10/11 edge', lat: 50.0, lon: -120.0 },
  { name: 'just west of the edge', lat: 50.0, lon: -120.0001 },
];

test('utmForward matches proj4 to the millimetre', () => {
  for (const s of SITES) {
    const zone = utmZone(s.lon);
    const mine = utmForward(s.lat, s.lon, zone);
    const [px, py] = proj4(WGS84, utmDef(zone), [s.lon, s.lat]) as [number, number];
    const dx = Math.abs(mine.x - px);
    const dy = Math.abs(mine.y - py);
    assert.ok(dx < 0.001, `${s.name} easting off by ${dx.toFixed(6)} m`);
    assert.ok(dy < 0.001, `${s.name} northing off by ${dy.toFixed(6)} m`);
  }
});

test('utmInverse matches proj4 to sub-millimetre on the ground', () => {
  for (const s of SITES) {
    const zone = utmZone(s.lon);
    const m = utmForward(s.lat, s.lon, zone);
    const mine = utmInverse(m.x, m.y, zone);
    const [plon, plat] = proj4(utmDef(zone), WGS84, [m.x, m.y]) as [number, number];
    // 1e-8 degrees is about 1 mm of latitude.
    assert.ok(Math.abs(mine.lat - plat) < 1e-8, `${s.name} lat`);
    assert.ok(Math.abs(mine.lon - plon) < 1e-8, `${s.name} lon`);
  }
});

test('forward then inverse returns the original position', () => {
  for (const s of SITES) {
    const zone = utmZone(s.lon);
    const m = utmForward(s.lat, s.lon, zone);
    const back = utmInverse(m.x, m.y, zone);
    // 1e-7 degrees is about 1 cm. The series bottoms out around 7e-9 (~0.8 mm)
    // at high latitude, so a 1e-9 bar would fail on correct maths.
    assert.ok(Math.abs(back.lat - s.lat) < 1e-7, `${s.name} lat round-trip`);
    assert.ok(Math.abs(back.lon - s.lon) < 1e-7, `${s.name} lon round-trip`);
  }
});

test('zone numbering is right at the boundaries', () => {
  assert.equal(utmZone(-123.0), 10);
  assert.equal(utmZone(-120.0), 11); // exactly on the 10/11 boundary
  assert.equal(utmZone(-120.0001), 10);
  assert.equal(utmZone(-179.9), 1);
  assert.equal(utmZone(179.9), 60);
  // Clamped rather than allowed to produce zone 61.
  assert.equal(utmZone(180), 60);
  assert.equal(utmZone(-180), 1);
});

test('a zone is chosen for the whole document, from its centre', () => {
  const b = lonLatBounds([
    [
      [-123.0, 50.0],
      [-119.0, 51.0],
    ],
  ]);
  assert.ok(b);
  assert.deepEqual(b, { west: -123.0, south: 50.0, east: -119.0, north: 51.0 });
  // Centre is -121, which is zone 10 — NOT one zone per vertex.
  assert.equal(zoneForBounds(b!), 10);
});

test('lonLatBounds returns null for no geometry', () => {
  assert.equal(lonLatBounds([]), null);
  assert.equal(lonLatBounds([[]]), null);
});

test('projected bounds use all four corners, not two', () => {
  // The graticule is curved on the plane, so the extreme easting need not come
  // from the same corner as the extreme northing.
  const b = { west: -123.0, south: 49.0, east: -121.0, north: 51.0 };
  const zone = zoneForBounds(b);
  const pb = projectedBounds(b, zone);
  const corners = [
    utmForward(b.south, b.west, zone),
    utmForward(b.north, b.west, zone),
    utmForward(b.south, b.east, zone),
    utmForward(b.north, b.east, zone),
  ];
  assert.equal(pb.minX, Math.min(...corners.map((c) => c.x)));
  assert.equal(pb.maxY, Math.max(...corners.map((c) => c.y)));
  // The two EAST corners differ in easting by ~5.9 km at this extent, purely
  // from the curvature of the graticule on the plane. That is the whole reason
  // two corners is not enough — a two-corner box would lose kilometres of span.
  // (The WEST corners are identical here because west = -123 IS zone 10's
  // central meridian, where easting is exactly 500000 at every latitude, so
  // asserting on those would prove nothing.)
  const eastSpread = Math.abs(corners[2].x - corners[3].x);
  assert.ok(eastSpread > 5000, `east corners differ by only ${eastSpread.toFixed(0)} m`);
  assert.equal(corners[0].x, 500_000);
});

test('degenerate extents are padded, not left at zero span', () => {
  // A single point or a dead-straight line would otherwise divide by zero when
  // fitting a view, blanking the map.
  const point = { west: -120, south: 50, east: -120, north: 50 };
  const pb = projectedBounds(point, 10, 100);
  assert.ok(pb.maxX - pb.minX >= 200);
  assert.ok(pb.maxY - pb.minY >= 200);

  const horizontal = { west: -120.1, south: 50, east: -120, north: 50 };
  const hb = projectedBounds(horizontal, 10, 100);
  assert.ok(hb.maxX - hb.minX > 1000); // real span, untouched
  assert.ok(hb.maxY - hb.minY >= 200); // padded
});

test('accuracy envelope off the central meridian is documented and held', () => {
  // The truncated Snyder series loses accuracy with distance from the central
  // meridian. Measured against proj4 in zone 10 (central meridian -123):
  //
  //     0-4° off   < 0.001 m
  //       6° off   ~ 0.003 m
  //       8° off   ~ 0.021 m
  //       9° off   ~ 0.048 m
  //      11° off   ~ 0.194 m
  //
  // Inside a proper UTM zone (±3°) that is sub-millimetre. The larger figures
  // only arise because the map viewer draws province-scale extents on a single
  // zone, and even there 19 cm is three orders of magnitude inside the 10 m
  // accuracy BCWS specifies. The Swift app carries the identical limitation.
  const zone = 10;
  for (const lon of [-126, -123, -120]) {
    for (const lat of [48, 54, 60]) {
      const mine = utmForward(lat, lon, zone);
      const [px, py] = proj4(WGS84, utmDef(zone), [lon, lat]) as [number, number];
      const off = Math.hypot(mine.x - px, mine.y - py);
      assert.ok(off < 0.001, `in-zone: lon ${lon} lat ${lat} off by ${off.toFixed(4)} m`);
    }
  }
  // Province scale, where the tool genuinely does draw.
  for (const lon of [-134, -132, -114]) {
    for (const lat of [48, 54, 60]) {
      const mine = utmForward(lat, lon, zone);
      const [px, py] = proj4(WGS84, utmDef(zone), [lon, lat]) as [number, number];
      const off = Math.hypot(mine.x - px, mine.y - py);
      assert.ok(off < 0.5, `province scale: lon ${lon} lat ${lat} off by ${off.toFixed(4)} m`);
    }
  }
});
