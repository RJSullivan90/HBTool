//
// measure.ts — perimeter arc measurement and section clipping.
//
// A/B ARE GEOGRAPHIC ANCHORS, NEVER (segment, t) INDICES. Moving the simplify
// slider rebuilds the vertex list, so an index would silently point somewhere
// else. They are re-snapped through nearestEdgePointLonLat after any change.
//
// DISTANCES ARE ELLIPSOIDAL PER SEGMENT (see geo.ts) — matching pyproj/Karney to
// the millimetre. Not UTM planar (grid scale factor) and not spherical (~0.5%,
// which is 1.4 km on a large fire).
//

import { segmentMetres } from './geo.ts';
import { xmlEscape } from './fires.ts';
import type { Feature, LonLat, Ring } from './geometry.ts';
import type { Metres } from './proj.ts';

/** A point lying exactly on a ring's edge: fraction `t` along `segment`. */
export type EdgePoint = {
  part: number;
  ring: number;
  segment: number;
  t: number;
};

export function sameEdgePoint(a: EdgePoint | null, b: EdgePoint | null): boolean {
  if (!a || !b) return a === b;
  return a.part === b.part && a.ring === b.ring && a.segment === b.segment && a.t === b.t;
}

/** A ring prepared for arc measurement: cyclic vertices with cumulative lengths. */
export class MeasuredRing {
  readonly part: number;
  readonly ring: number;
  readonly lonlat: LonLat[];
  readonly metres: Metres[];
  readonly isClosed: boolean;
  /** segLen[i] is the length of the segment STARTING at vertex i. */
  readonly segLen: number[];
  /** cum[i] is the distance from vertex 0 to vertex i. */
  readonly cum: number[];
  readonly total: number;

  constructor(part: number, ring: number, source: Ring) {
    this.part = part;
    this.ring = ring;
    const closed = source.isClosed;
    this.isClosed = closed;
    // A closed ring repeats vertex 0 at the end; drop it and treat it as cyclic,
    // otherwise a zero-length segment lands in the middle of the maths.
    this.lonlat =
      closed && source.lonlat.length > 1 ? source.lonlat.slice(0, -1) : source.lonlat.slice();
    this.metres =
      closed && source.metres.length > 1 ? source.metres.slice(0, -1) : source.metres.slice();

    const n = this.lonlat.length;
    const lens: number[] = [];
    // Closed rings have n segments (the last wraps to vertex 0); open lines n-1.
    const segments = closed ? n : Math.max(0, n - 1);
    for (let i = 0; i < segments; i++) {
      lens.push(segmentMetres(this.lonlat[i], this.lonlat[(i + 1) % n]));
    }
    if (!closed) lens.push(0); // keeps indices aligned for open lines
    this.segLen = lens;

    const c: number[] = [0];
    for (let i = 0; i < Math.max(0, n - 1); i++) c.push(c[i] + lens[i]);
    this.cum = c;
    this.total = closed ? lens.reduce((a, b) => a + b, 0) : (c[c.length - 1] ?? 0);
  }

  get count(): number {
    return this.lonlat.length;
  }

  position(p: EdgePoint): Metres {
    const a = this.metres[p.segment];
    const b = this.metres[(p.segment + 1) % this.count];
    return { x: a.x + (b.x - a.x) * p.t, y: a.y + (b.y - a.y) * p.t };
  }

  lonlatPosition(p: EdgePoint): LonLat {
    const a = this.lonlat[p.segment];
    const b = this.lonlat[(p.segment + 1) % this.count];
    return [a[0] + (b[0] - a[0]) * p.t, a[1] + (b[1] - a[1]) * p.t];
  }

  /** Distance from vertex 0 forward along the ring to an edge point. */
  offset(p: EdgePoint): number {
    return this.cum[p.segment] + this.segLen[p.segment] * p.t;
  }

  /** Distance walking forward, in vertex order, from a to b. */
  forwardDistance(a: EdgePoint, b: EdgePoint): number {
    const d = this.offset(b) - this.offset(a);
    if (!this.isClosed) return Math.abs(d);
    return d < 0 ? d + this.total : d;
  }

  /**
   * The ring vertices passed through walking forward from a to b, excluding the
   * interpolated endpoints. Single source of truth, so the metre path and the
   * lon/lat path can never disagree about which vertices are in the arc.
   */
  forwardVertexIndices(a: EdgePoint, b: EdgePoint): number[] {
    if (this.count === 0) return [];
    const out: number[] = [];
    if (this.isClosed) {
      const span = this.forwardDistance(a, b);
      const start = this.offset(a);
      for (let k = 1; k <= this.count; k++) {
        const j = (a.segment + k) % this.count;
        let dj = this.cum[j] - start;
        if (dj < 0) dj += this.total;
        if (dj < span - 1e-7) out.push(j);
        else break;
      }
    } else {
      const lo = Math.min(a.segment, b.segment);
      const hi = Math.max(a.segment, b.segment);
      if (hi > lo) for (let i = lo + 1; i <= hi; i++) out.push(i);
      // Walking "backwards" along an open line still traces the same vertices.
      if (this.offset(b) < this.offset(a)) out.reverse();
    }
    return out;
  }

  forwardPath(a: EdgePoint, b: EdgePoint): Metres[] {
    return [
      this.position(a),
      ...this.forwardVertexIndices(a, b).map((i) => this.metres[i]),
      this.position(b),
    ];
  }

  /** The same path in WGS84 — this is what gets exported. */
  forwardPathLonLat(a: EdgePoint, b: EdgePoint): LonLat[] {
    return [
      this.lonlatPosition(a),
      ...this.forwardVertexIndices(a, b).map((i) => this.lonlat[i]),
      this.lonlatPosition(b),
    ];
  }

  /** Nearest edge point to a position in UTM metres, with its distance. */
  nearestEdgePoint(p: Metres): { point: EdgePoint; distance: number } {
    let best: EdgePoint = { part: this.part, ring: this.ring, segment: 0, t: 0 };
    let bestD = Infinity;
    const segments = this.isClosed ? this.count : Math.max(0, this.count - 1);
    for (let i = 0; i < segments; i++) {
      const a = this.metres[i];
      const b = this.metres[(i + 1) % this.count];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      if (d < bestD) {
        bestD = d;
        best = { part: this.part, ring: this.ring, segment: i, t };
      }
    }
    return { point: best, distance: bestD };
  }

  /**
   * Nearest edge point to a GEOGRAPHIC position. This is what re-anchors A and B
   * after the geometry changes, since segment indices mean nothing across a
   * different vertex list. Longitude is scaled by cos(lat) so the search is not
   * skewed by longitude compression at high latitude.
   */
  nearestEdgePointLonLat(p: LonLat): EdgePoint | null {
    if (this.count <= 1) return null;
    const kx = Math.cos((p[1] * Math.PI) / 180);
    let best: EdgePoint | null = null;
    let bestD = Infinity;
    const segments = this.isClosed ? this.count : Math.max(0, this.count - 1);
    for (let i = 0; i < segments; i++) {
      const a = this.lonlat[i];
      const b = this.lonlat[(i + 1) % this.count];
      const ax = a[0] * kx;
      const ay = a[1];
      const bx = b[0] * kx;
      const by = b[1];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((p[0] * kx - ax) * dx + (p[1] - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p[0] * kx - (ax + t * dx), p[1] - (ay + t * dy));
      if (d < bestD) {
        bestD = d;
        best = { part: this.part, ring: this.ring, segment: i, t };
      }
    }
    return best;
  }
}

/** Every ring worth measuring, in feature → part → ring order. */
export function measuredRings(features: Feature[]): MeasuredRing[] {
  const out: MeasuredRing[] = [];
  for (const f of features) {
    f.parts.forEach((part, pi) => {
      part.rings.forEach((ring, ri) => {
        if (ring.lonlat.length > 1) out.push(new MeasuredRing(pi, ri, ring));
      });
    });
  }
  return out;
}

/** The largest ring, which is the one a perimeter measurement means. */
export function longestRing(rings: MeasuredRing[]): MeasuredRing | null {
  let best: MeasuredRing | null = null;
  for (const r of rings) if (!best || r.total > best.total) best = r;
  return best;
}

export type SectionDirection = 'forward' | 'reverse';

/**
 * A single LineString of the clipped section, for loading into a controller as a
 * pilot reference. Magenta and thick so it reads over satellite imagery.
 */
export function sectionLineKML(name: string, points: LonLat[], note: string): string {
  const coords = points.map((p) => `${p[0].toFixed(7)},${p[1].toFixed(7)},0`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEscape(name)}</name>
    <Style id="section">
      <LineStyle><color>ffff00ff</color><width>4</width></LineStyle>
    </Style>
    <Placemark>
      <name>${xmlEscape(name)}</name>
      <description>${xmlEscape(note)}</description>
      <styleUrl>#section</styleUrl>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
`;
}

export function formatMetres(m: number, unit: 'km' | 'mi' = 'km'): string {
  const per = unit === 'km' ? 1000 : 1609.344;
  return `${(m / per).toFixed(2)} ${unit}`;
}
