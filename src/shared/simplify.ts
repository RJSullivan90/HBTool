//
// simplify.ts — perimeter simplification, ported from the Swift app.
//
// TWO MODES, AND THE DIFFERENCE IS CONTRACTUAL:
//
//  * Tolerance (Douglas–Peucker) bounds deviation BY CONSTRUCTION. Ask for 8 m
//    and no vertex moves more than 8 m.
//  * Percentage (Visvalingam) does NOT. It ranks by triangle area, so a thin
//    spike scores low and can be dropped even though removing it moves the
//    boundary 100 m+ — at only 50% removal. The readout is therefore the thing
//    to trust, not the percentage.
//
// BCWS specifies GPS within 10 m, so any deviation past 10 m is flagged. That
// number is a contract term, not a preference.
//

import {
  douglasPeuckerKeep,
  floorCount,
  segmentDistance,
  type Feature,
  type GeoDocument,
  type KeptPlan,
  type Ring,
} from './geometry.ts';
import { xmlEscape } from './fires.ts';

export type SimplifyMode = 'percent' | 'tolerance';

/** BCWS's contractual GPS accuracy, in metres. Deviation past this is flagged. */
export const ACCURACY_LIMIT_M = 10;

export function keptIndices(
  ring: Ring,
  mode: SimplifyMode,
  percent: number,
  tolerance: number,
): number[] {
  const count = ring.lonlat.length;
  const all = (): number[] => Array.from({ length: count }, (_, i) => i);

  if (mode === 'percent') {
    const removable = Math.max(0, count - floorCount(ring));
    const cut = Math.min(removable, Math.round((ring.order.length * percent) / 100));
    if (cut <= 0) return all();
    const drop = new Set<number>();
    for (let k = 0; k < cut; k++) drop.add(ring.order[k]);
    return all().filter((i) => !drop.has(i));
  }

  const kept = douglasPeuckerKeep(ring.metres, tolerance);
  // Never simplify a ring below the point where it stops being a ring.
  if (kept.length < floorCount(ring)) {
    return Array.from({ length: Math.min(count, floorCount(ring)) }, (_, i) => i);
  }
  return kept;
}

/**
 * Greatest distance from any ORIGINAL vertex to the simplified line, in metres.
 *
 * This is the number that decides whether a simplification is deliverable, so it
 * is measured against the retained geometry rather than inferred from the mode.
 */
export function maxDeviation(ring: Ring, kept: number[]): number {
  if (kept.length < 2) return 0;
  let worst = 0;
  let s = 0;
  for (let i = 0; i < ring.metres.length; i++) {
    while (s + 1 < kept.length && kept[s + 1] <= i) s++;
    const a = ring.metres[kept[s]];
    const b = ring.metres[kept[Math.min(s + 1, kept.length - 1)]];
    const d = segmentDistance(ring.metres[i], a, b);
    if (d > worst) worst = d;
  }
  return worst;
}

/** Shoelace area of the given vertices, m². */
export function ringArea(ring: Ring, indices: number[]): number {
  if (indices.length <= 2) return 0;
  let sum = 0;
  for (let k = 0; k < indices.length; k++) {
    const p = ring.metres[indices[k]];
    const q = ring.metres[indices[(k + 1) % indices.length]];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) / 2;
}

export function simplifyPlan(
  doc: GeoDocument,
  mode: SimplifyMode,
  percent: number,
  tolerance: number,
): KeptPlan[] {
  return doc.features.map((f) =>
    f.parts.map((part) => part.rings.map((r) => keptIndices(r, mode, percent, tolerance))),
  );
}

export type SimplifyStats = {
  before: number;
  after: number;
  /** Metres. Compare against ACCURACY_LIMIT_M. */
  deviation: number;
  areaBefore: number; // m²
  areaAfter: number;
  parts: number;
};

export function simplifyStats(doc: GeoDocument, kept: KeptPlan[]): SimplifyStats {
  const s: SimplifyStats = {
    before: 0,
    after: 0,
    deviation: 0,
    areaBefore: 0,
    areaAfter: 0,
    parts: 0,
  };
  doc.features.forEach((f, fi) => {
    s.parts += f.parts.length;
    f.parts.forEach((part, pi) => {
      part.rings.forEach((ring, ri) => {
        const k = kept[fi][pi][ri];
        s.before += ring.lonlat.length;
        s.after += k.length;
        s.deviation = Math.max(s.deviation, maxDeviation(ring, k));
        if (f.isPolygon) {
          // Holes subtract, so the area delta reflects the real enclosed area.
          const sign = ri === 0 ? 1 : -1;
          s.areaBefore +=
            sign * ringArea(ring, Array.from({ length: ring.lonlat.length }, (_, i) => i));
          s.areaAfter += sign * ringArea(ring, k);
        }
      });
    });
  });
  return s;
}

export function removedPercent(s: SimplifyStats): number {
  return s.before > 0 ? (1 - s.after / s.before) * 100 : 0;
}
export function areaDeltaPercent(s: SimplifyStats): number {
  return s.areaBefore > 0 ? ((s.areaAfter - s.areaBefore) / s.areaBefore) * 100 : 0;
}
export function areaDeltaHectares(s: SimplifyStats): number {
  return (s.areaAfter - s.areaBefore) / 10_000;
}
export function areaHectares(m2: number): number {
  return m2 / 10_000;
}

/** Materialise the current simplification as plain lon/lat rings, so measuring,
 *  clipping and exporting all describe exactly what is on screen. */
export function simplifiedRings(doc: GeoDocument, kept: KeptPlan[]): Feature[] {
  return doc.features.map((f, fi) => ({
    name: f.name,
    isPolygon: f.isPolygon,
    parts: f.parts.map((part, pi) => ({
      rings: part.rings.map((ring, ri) => ({
        ...ring,
        lonlat: kept[fi][pi][ri].map((i) => ring.lonlat[i]),
        metres: kept[fi][pi][ri].map((i) => ring.metres[i]),
        // The removal order indexes the ORIGINAL vertex list, so it cannot carry
        // over to a reduced one.
        order: [],
      })),
    })),
  }));
}

export function simplifiedKML(
  name: string,
  doc: GeoDocument,
  kept: KeptPlan[],
  note: string,
): string {
  const coordText = (ring: Ring, idx: number[]): string =>
    idx.map((i) => `${ring.lonlat[i][0].toFixed(7)},${ring.lonlat[i][1].toFixed(7)},0`).join(' ');

  let body = '';
  doc.features.forEach((f, fi) => {
    const geoms: string[] = [];
    f.parts.forEach((part, pi) => {
      if (f.isPolygon) {
        let g = '<Polygon><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>';
        part.rings.forEach((ring, ri) => {
          const coords = coordText(ring, kept[fi][pi][ri]);
          const tag = ri === 0 ? 'outerBoundaryIs' : 'innerBoundaryIs';
          g += `<${tag}><LinearRing><coordinates>${coords}</coordinates></LinearRing></${tag}>`;
        });
        geoms.push(g + '</Polygon>');
      } else {
        part.rings.forEach((ring, ri) => {
          geoms.push(
            '<LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>' +
              `<coordinates>${coordText(ring, kept[fi][pi][ri])}</coordinates></LineString>`,
          );
        });
      }
    });
    const geometry =
      geoms.length === 1 ? geoms[0] : `<MultiGeometry>${geoms.join('')}</MultiGeometry>`;
    body += `
    <Placemark>
      <name>${xmlEscape(f.name || name)}</name>
      <description>${xmlEscape(note)}</description>
      <styleUrl>#simplified</styleUrl>
      ${geometry}
    </Placemark>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEscape(name)}</name>
    <Style id="simplified">
      <LineStyle><color>ff0000ff</color><width>2.5</width></LineStyle>
      <PolyStyle><color>4d0000ff</color></PolyStyle>
    </Style>${body}
  </Document>
</kml>
`;
}
