//
// geometry.ts — the feature → part → ring model everything else works on.
//
// THE HIERARCHY IS NOT DECORATION. 34 of BC's 226 current perimeters are
// multi-part with up to 6 polygons. Flattening every outer ring into one
// polygon's hole list produces "hole lies outside shell" geometry that Google
// Earth draws as fragments, so feature → part → ring is preserved end to end.
//
// ONE UTM ZONE PER DOCUMENT, taken from the centre of its full extent. A zone
// per point puts vertices on different grids; in the Swift app that inflated a
// test measurement 24x. `assemble` is the single place the zone is decided, and
// it hands the zone back so every consumer uses the same one.
//

import { lonLatBounds, utmForward, zoneForBounds, type Metres } from './proj.ts';

/** [lon, lat], WGS84. */
export type LonLat = [number, number];

export type Ring = {
  /** Original vertices, WGS84. */
  lonlat: LonLat[];
  /** The same vertices in UTM metres, for area and deviation maths. */
  metres: Metres[];
  /** Visvalingam removal order, least important first (indices into lonlat). */
  order: number[];
  /** True when the ring repeats vertex 0 at the end, as KML polygon rings do. */
  isClosed: boolean;
};

/** One polygon (rings[0] outer, the rest holes) or one line (a single ring). */
export type Part = { rings: Ring[] };

export type Feature = { name: string; isPolygon: boolean; parts: Part[] };

/** Retained vertex indices, mirroring feature → part → ring. */
export type KeptPlan = number[][][];

export type GeoDocument = {
  features: Feature[];
  /** The one zone every metre coordinate in this document is on. */
  zone: number;
};

export type RawFeature = {
  name: string;
  isPolygon: boolean;
  /** parts → rings → vertices */
  parts: LonLat[][][];
};

/** Rings must keep 4 points (3 distinct plus the closing repeat); lines keep 2. */
export function floorCount(ring: Ring): number {
  return ring.isClosed ? 4 : 2;
}

export function ringIsClockwise(pts: readonly LonLat[]): boolean {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += (b[0] - a[0]) * (b[1] + a[1]);
  }
  return sum > 0;
}

/** Perpendicular distance from p to segment a→b, in whatever units come in. */
export function segmentDistance(p: Metres, a: Metres, b: Metres): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function triangleArea(a: Metres, b: Metres, c: Metres): number {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
}

/**
 * Visvalingam–Whyatt ranking: repeatedly drop the vertex whose triangle with its
 * CURRENT neighbours is smallest, recomputing those neighbours as the ring
 * collapses. Min-heap with lazy invalidation by version counter, so this stays
 * O(n log n) — necessary, since a single perimeter has run to 54,333 vertices.
 *
 * The first and last vertices are never candidates, which is what keeps a ring's
 * closure and a line's endpoints intact.
 */
export function visvalingamOrder(pts: readonly Metres[]): number[] {
  const n = pts.length;
  if (n <= 3) return [];

  const prev = Array.from({ length: n }, (_, i) => i - 1);
  const next = Array.from({ length: n }, (_, i) => i + 1);
  const alive = new Array<boolean>(n).fill(true);
  const version = new Array<number>(n).fill(0);

  type Entry = { area: number; i: number; v: number };
  const heap: Entry[] = [];

  const push = (e: Entry): void => {
    heap.push(e);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p].area <= heap[c].area) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };

  const pop = (): Entry | undefined => {
    if (heap.length === 0) return undefined;
    [heap[0], heap[heap.length - 1]] = [heap[heap.length - 1], heap[0]];
    const out = heap.pop()!;
    let p = 0;
    for (;;) {
      const l = 2 * p + 1;
      const r = l + 1;
      let s = p;
      if (l < heap.length && heap[l].area < heap[s].area) s = l;
      if (r < heap.length && heap[r].area < heap[s].area) s = r;
      if (s === p) break;
      [heap[s], heap[p]] = [heap[p], heap[s]];
      p = s;
    }
    return out;
  };

  for (let i = 1; i < n - 1; i++) {
    push({ area: triangleArea(pts[i - 1], pts[i], pts[i + 1]), i, v: 0 });
  }

  const order: number[] = [];
  for (;;) {
    const e = pop();
    if (!e) break;
    if (!alive[e.i] || e.v !== version[e.i]) continue;
    alive[e.i] = false;
    order.push(e.i);
    const p = prev[e.i];
    const nx = next[e.i];
    next[p] = nx;
    prev[nx] = p;
    if (p > 0 && alive[p]) {
      version[p] += 1;
      push({ area: triangleArea(pts[prev[p]], pts[p], pts[next[p]]), i: p, v: version[p] });
    }
    if (nx < n - 1 && alive[nx]) {
      version[nx] += 1;
      push({ area: triangleArea(pts[prev[nx]], pts[nx], pts[next[nx]]), i: nx, v: version[nx] });
    }
  }
  return order;
}

/**
 * Douglas–Peucker with an explicit stack. Every dropped vertex is within
 * `tolerance` metres of the retained line BY CONSTRUCTION — which is the whole
 * reason tolerance mode is the safe one for contractual accuracy, and percentage
 * mode is not.
 */
export function douglasPeuckerKeep(pts: readonly Metres[], tolerance: number): number[] {
  const n = pts.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Set<number>([0, n - 1]);
  const stack: Array<[number, number]> = [[0, n - 1]];
  for (;;) {
    const top = stack.pop();
    if (!top) break;
    const [first, last] = top;
    if (last <= first + 1) continue;
    let worst = 0;
    let wi = first;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(pts[i], pts[first], pts[last]);
      if (d > worst) {
        worst = d;
        wi = i;
      }
    }
    if (worst > tolerance) {
      keep.add(wi);
      stack.push([first, wi], [wi, last]);
    }
  }
  return [...keep].sort((a, b) => a - b);
}

/**
 * Build a document from raw lon/lat geometry.
 *
 * The zone is chosen ONCE here, from the centre of the whole extent. A distant
 * second feature can therefore move the document's zone — that is correct, and
 * it is why callers must take the zone from the returned document rather than
 * recomputing one per feature.
 */
export function assemble(input: RawFeature[]): GeoDocument {
  const allRings: LonLat[][] = [];
  for (const f of input) for (const part of f.parts) for (const ring of part) allRings.push(ring);
  const bounds = lonLatBounds(allRings);
  const zone = bounds ? zoneForBounds(bounds) : 10;

  const features: Feature[] = input.map((f) => ({
    name: f.name,
    isPolygon: f.isPolygon,
    parts: f.parts.map((part) => ({
      rings: part.map((lonlat) => {
        const metres = lonlat.map((c) => utmForward(c[1], c[0], zone));
        const isClosed =
          lonlat.length > 2 &&
          lonlat[0][0] === lonlat[lonlat.length - 1][0] &&
          lonlat[0][1] === lonlat[lonlat.length - 1][1];
        return { lonlat, metres, order: visvalingamOrder(metres), isClosed };
      }),
    })),
  }));
  return { features, zone };
}

/** A wildfire perimeter's MultiPolygon as a one-feature document. */
export function documentFromPolygons(
  name: string,
  polygons: number[][][][],
): GeoDocument {
  return assemble([
    {
      name,
      isPolygon: true,
      parts: polygons.map((poly) => poly.map((ring) => ring.map((c) => [c[0], c[1]] as LonLat))),
    },
  ]);
}

/** Every ring in the document, flattened, for drawing and bounds. */
export function allRings(doc: GeoDocument): LonLat[][] {
  const out: LonLat[][] = [];
  for (const f of doc.features) for (const p of f.parts) for (const r of p.rings) out.push(r.lonlat);
  return out;
}

export function vertexCount(doc: GeoDocument): number {
  let n = 0;
  for (const f of doc.features) for (const p of f.parts) for (const r of p.rings) n += r.lonlat.length;
  return n;
}

export function partCount(doc: GeoDocument): number {
  let n = 0;
  for (const f of doc.features) n += f.parts.length;
  return n;
}
