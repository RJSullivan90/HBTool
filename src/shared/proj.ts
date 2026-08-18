//
// proj.ts — UTM projection, ported line-for-line from the Swift app.
//
// WHY PORTED RATHER THAN DELEGATED TO proj4: these formulas produce the numbers
// that go into client deliverables, and the Swift versions were validated
// against QGIS's bundled PROJ/pyproj to the millimetre. Porting them keeps the
// two apps bit-comparable, and keeps zero runtime dependencies in the geometry
// path. proj4 IS used — as an independent oracle in tests/proj.test.ts, which is
// where a subtle transcription error would surface. A wrong coefficient here
// yields plausible-looking coordinates that are quietly tens of metres out.
//
// ACCURACY ENVELOPE, measured against proj4 in zone 10 (see tests/proj.test.ts):
//
//     0-4° off the central meridian   < 0.001 m
//       6° off                        ~ 0.003 m
//       9° off                        ~ 0.048 m
//      11° off                        ~ 0.194 m
//
// Inside a proper UTM zone (±3°) that is sub-millimetre. The larger figures only
// arise because the viewer draws province-scale extents on a single zone; even
// 19 cm is three orders of magnitude inside the 10 m BCWS specifies. The Swift
// app carries the identical limitation — this is the truncated series, not a
// transcription error.
//
// THE RULE: ONE UTM ZONE PER DOCUMENT, taken from the centroid. Choosing a zone
// per point puts vertices on different grids; in the Swift app that inflated a
// test measurement 24x.
//

/** GRS80 / WGS84 — identical for these purposes. */
const A = 6378137.0;
const E2 = 0.006694380022903416;
const K0 = 0.9996;
const FALSE_EASTING = 500_000;

export function utmZone(lon: number): number {
  return Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1));
}

export type Metres = { x: number; y: number };
export type LonLat = { lon: number; lat: number };

export function utmForward(lat: number, lon: number, zone: number): Metres {
  const ep2 = E2 / (1 - E2);
  const lon0 = ((zone * 6 - 183) * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const bigN = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  const bigT = tanPhi * tanPhi;
  const bigC = ep2 * cosPhi * cosPhi;
  const bigA = (lam - lon0) * cosPhi;

  const e4 = E2 * E2;
  const e6 = e4 * E2;
  const m =
    A *
    ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi));

  const a2 = bigA * bigA;
  const a3 = a2 * bigA;
  const a4 = a3 * bigA;
  const a5 = a4 * bigA;
  const a6 = a5 * bigA;

  const x =
    K0 *
      bigN *
      (bigA +
        ((1 - bigT + bigC) * a3) / 6 +
        ((5 - 18 * bigT + bigT * bigT + 72 * bigC - 58 * ep2) * a5) / 120) +
    FALSE_EASTING;
  const y =
    K0 *
    (m +
      bigN *
        tanPhi *
        (a2 / 2 +
          ((5 - bigT + 9 * bigC + 4 * bigC * bigC) * a4) / 24 +
          ((61 - 58 * bigT + bigT * bigT + 600 * bigC - 330 * ep2) * a6) / 720));
  return { x, y };
}

export function utmInverse(x: number, y: number, zone: number): LonLat {
  const ep2 = E2 / (1 - E2);
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  const lon0 = zone * 6 - 183;

  const m = (y - 0) / K0; // lat0 = 0, so the meridian arc at the origin is 0
  const mu = m / (A * (1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * Math.pow(e1, 3)) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * Math.pow(e1, 4)) / 32) * Math.sin(4 * mu) +
    ((151 * Math.pow(e1, 3)) / 96) * Math.sin(6 * mu) +
    ((1097 * Math.pow(e1, 4)) / 512) * Math.sin(8 * mu);

  const s1 = Math.sin(phi1);
  const c1 = Math.cos(phi1);
  const t1 = Math.tan(phi1);
  const cc1 = ep2 * c1 * c1;
  const tt1 = t1 * t1;
  const n1 = A / Math.sqrt(1 - E2 * s1 * s1);
  const r1 = (A * (1 - E2)) / Math.pow(1 - E2 * s1 * s1, 1.5);
  const d = (x - FALSE_EASTING) / (n1 * K0);
  const d2 = d * d;
  const d3 = d2 * d;
  const d4 = d3 * d;
  const d5 = d4 * d;
  const d6 = d5 * d;

  const phi =
    phi1 -
    ((n1 * t1) / r1) *
      (d2 / 2 -
        ((5 + 3 * tt1 + 10 * cc1 - 4 * cc1 * cc1 - 9 * ep2) * d4) / 24 +
        ((61 + 90 * tt1 + 298 * cc1 + 45 * tt1 * tt1 - 252 * ep2 - 3 * cc1 * cc1) * d6) / 720);
  const lam =
    (lon0 * Math.PI) / 180 +
    (d -
      ((1 + 2 * tt1 + cc1) * d3) / 6 +
      ((5 - 2 * cc1 + 28 * tt1 - 3 * cc1 * cc1 + 8 * ep2 + 24 * tt1 * tt1) * d5) / 120) /
      c1;

  return { lat: (phi * 180) / Math.PI, lon: (lam * 180) / Math.PI };
}

// MARK: bounds

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type LonLatBounds = { west: number; south: number; east: number; north: number };

/** Lon/lat extent of a set of rings. */
export function lonLatBounds(rings: Array<Array<[number, number]>>): LonLatBounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  if (!isFinite(west)) return null;
  return { west, south, east, north };
}

/**
 * The zone for a whole document, from the centre of its extent.
 *
 * Deliberately not per-point — see the header. A distant second feature can move
 * a document's zone, and that is correct: everything then lands on one grid.
 */
export function zoneForBounds(b: LonLatBounds): number {
  return utmZone((b.west + b.east) / 2);
}

/**
 * Projected extent, computed from all four corners rather than two.
 *
 * Two corners are not enough: the graticule is curved on the projection plane,
 * so the min/max easting can come from a different corner than the min/max
 * northing. Degenerate extents (a single point, a dead-straight line) are padded
 * rather than rejected, because a zero-span box divides by zero when fitting a
 * view and blanks it.
 */
export function projectedBounds(b: LonLatBounds, zone: number, padIfDegenerate = 100): Bounds {
  const corners = [
    utmForward(b.south, b.west, zone),
    utmForward(b.north, b.west, zone),
    utmForward(b.south, b.east, zone),
    utmForward(b.north, b.east, zone),
  ];
  let minX = Math.min(...corners.map((c) => c.x));
  let maxX = Math.max(...corners.map((c) => c.x));
  let minY = Math.min(...corners.map((c) => c.y));
  let maxY = Math.max(...corners.map((c) => c.y));
  if (maxX - minX < 1e-6) {
    minX -= padIfDegenerate;
    maxX += padIfDegenerate;
  }
  if (maxY - minY < 1e-6) {
    minY -= padIfDegenerate;
    maxY += padIfDegenerate;
  }
  return { minX, minY, maxX, maxY };
}
