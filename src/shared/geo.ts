//
// geo.ts — geodesy helpers, ported from the Swift app's PerimeterTab.swift and
// FederalAirspace.swift.
//
// These are the numbers that end up in client deliverables, so the formulas are
// kept identical to the macOS app rather than "modernised": the Swift versions
// were validated against QGIS's bundled PROJ/pyproj to the millimetre, and the
// test suite asserts the same expectations on both sides.
//

/** Distance in metres between two [lon, lat] points, using the local radii of
 *  curvature at their mean latitude.
 *
 *  Deliberately NOT spherical (~0.5% error, which is 1.4 km on a large fire) and
 *  NOT UTM planar (grid scale factor). Matches pyproj/Karney to the millimetre.
 */
export function segmentMetres(a: [number, number], b: [number, number]): number {
  const eqR = 6378137.0;
  const e2 = 0.006694380022903416;
  const phi = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const s = Math.sin(phi);
  const den = 1 - e2 * s * s;
  const meridional = (eqR * (1 - e2)) / Math.pow(den, 1.5);
  const primeVertical = eqR / Math.sqrt(den);
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  return Math.hypot(primeVertical * Math.cos(phi) * dLon, meridional * dLat);
}

/** Signed decimal degrees → `42°25'30"N`. */
export function dms(v: number, isLat: boolean): string {
  const hemi = isLat ? (v >= 0 ? 'N' : 'S') : v >= 0 ? 'E' : 'W';
  const a = Math.abs(v);
  const deg = Math.floor(a);
  const minF = (a - deg) * 60;
  const min = Math.floor(minF);
  const sec = Math.round((minF - min) * 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${deg}°${pad(min)}'${pad(sec)}"${hemi}`;
}

/** Packed DMS digits from NOTAM prose → signed decimal degrees.
 *  "422530" + "N" → 42.425. Longitude carries three degree digits.
 */
export function dmsPacked(
  digits: string,
  hemi: string,
  lonDigits: boolean,
): number | null {
  const degLen = lonDigits ? 3 : 2;
  if (digits.length !== degLen + 4) return null;
  const deg = Number(digits.slice(0, degLen));
  const min = Number(digits.slice(degLen, degLen + 2));
  const sec = Number(digits.slice(degLen + 2));
  if (!isFinite(deg) || !isFinite(min) || !isFinite(sec)) return null;
  const v = deg + min / 60 + sec / 3600;
  return 'SW'.includes(hemi) ? -v : v;
}

/** FAA detail-XML coordinate: "36.11666667N" → signed decimal degrees. */
export function faaCoordinate(raw: string): number | null {
  const s = raw.trim();
  const hemi = s.slice(-1);
  if (!'NSEW'.includes(hemi)) return null;
  const v = Number(s.slice(0, -1));
  return isFinite(v) ? ('SW'.includes(hemi) ? -v : v) : null;
}
