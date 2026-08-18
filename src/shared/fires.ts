//
// fires.ts — live wildfire perimeter sources, ported from the Swift app's
// FireTab.swift. Pure logic: URL construction, GeoJSON parsing, KML output.
//
// Sources and the reasons behind each choice (verified live in the Swift app):
//  BC      — BC Wildfire Service current fire perimeters (openmaps.gov.bc.ca WFS)
//  Ontario — LIO "In-year Fire Perimeters" ArcGIS service
//  Yukon   — the national CWFIS layer filtered to Province='Yukon'. Yukon's own
//            AGOL services publish POINTS ONLY, no perimeter polygons.
//  Canada  — CWFIS active wildfire perimeters, hotspot-derived
//  Oregon  — NIFC/WFIGS, the US interagency system of record
//
// Two WFIGS traps that cost real time and must not be "simplified" away:
//  * Use the YearToDate layer filtered to `attr_FireOutDateTime IS NULL`, NOT
//    the "Current" layer. Current was missing an active fire whose polygon had
//    been updated that same day (Bologna, 2026-08-12), so it cannot be trusted
//    to mean current. Active is expressed as "not declared out".
//  * ONE STATE PER SOURCE. Nationally the layer holds ~2,500 active perimeters,
//    hundreds of MB, past the server's transfer cap.
//
// WFIGS publishes ACRES; everything else here speaks hectares.
//

export const ACRES_TO_HECTARES = 0.40468564224;

/** Polygons → rings → [lon, lat]. First ring is the exterior, the rest holes.
 *  Multi-part geometry MUST stay multi-part: 25 of BC's ~175 perimeters are
 *  MultiPolygon with up to 6 parts, and flattening every outer ring into one
 *  polygon's hole list produces "hole lies outside shell" geometry that Google
 *  Earth draws as fragments. */
export type MultiPolygon = number[][][][];

export type FirePerimeter = {
  id: number;
  fireNumber: string;
  status: string;
  sizeHa: number;
  trackDate: string; // "2026-05-09"
  detail: string;
  url: string;
  attribution: string;
  polygons: MultiPolygon;
};

export type FireSourceId = 'BC' | 'Ontario' | 'Yukon' | 'Canada' | 'Oregon';

export const FIRE_SOURCES: Array<{ id: FireSourceId; note: string }> = [
  { id: 'BC', note: 'BC Wildfire Service — current fire perimeters' },
  { id: 'Ontario', note: 'Ontario LIO — in-year fire perimeters' },
  {
    id: 'Yukon',
    note:
      'CWFIS national layer filtered to Yukon (Yukon publishes no perimeter ' +
      'polygons of its own)',
  },
  {
    id: 'Canada',
    note: 'CWFIS — active wildfire perimeters in Canada (hotspot-derived)',
  },
  {
    id: 'Oregon',
    note: 'NIFC/WFIGS — active US interagency perimeters filtered to Oregon',
  },
];

export function trackDateCompact(f: FirePerimeter): string {
  return f.trackDate.replace(/-/g, '');
}

// MARK: URLs

const BC_URL =
  'https://openmaps.gov.bc.ca/geo/pub/WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_POLYS_SP/ows' +
  '?service=WFS&version=2.0.0&request=GetFeature' +
  '&typeName=pub:WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_POLYS_SP' +
  '&outputFormat=application/json&srsName=EPSG:4326';

const ONTARIO_URL =
  'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open09/MapServer/51/query' +
  '?where=1%3D1&outFields=*&outSR=4326&f=geojson';

function canadaURL(province: string | null): string {
  const where = province === null ? '1=1' : `Province='${province}'`;
  return (
    'https://services.arcgis.com/wjcPoefzjpzCgffS/arcgis/rest/services/' +
    'Active_Wildfire_Perimeters_in_Canada_View/FeatureServer/0/query' +
    `?where=${encodeURIComponent(where)}&outFields=*&outSR=4326&f=geojson`
  );
}

function wfigsURL(state: string): string {
  const where = `attr_POOState='${state}' AND attr_FireOutDateTime IS NULL`;
  return (
    'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
    'WFIGS_Interagency_Perimeters_YearToDate/FeatureServer/0/query' +
    `?where=${encodeURIComponent(where)}` +
    '&outFields=OBJECTID,poly_IncidentName,poly_GISAcres,poly_PolygonDateTime,' +
    'attr_PercentContained,attr_IncidentTypeCategory' +
    '&outSR=4326&f=geojson'
  );
}

export function sourceURL(source: FireSourceId): string {
  switch (source) {
    case 'BC':
      return BC_URL;
    case 'Ontario':
      return ONTARIO_URL;
    case 'Yukon':
      return canadaURL('Yukon');
    case 'Canada':
      return canadaURL(null);
    case 'Oregon':
      return wfigsURL('US-OR');
  }
}

// MARK: parsing

/** ArcGIS epoch milliseconds → "yyyy-MM-dd" in UTC. */
export function epochToDate(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v)) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

type Mapped = {
  id: number | null;
  fireNumber: string;
  status: string;
  sizeHa: number;
  date: string;
  detail: string;
  url: string;
};

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && isFinite(v) ? v : fallback;
const int = (v: unknown): number | null =>
  typeof v === 'number' && isFinite(v) ? Math.trunc(v) : null;

function mapProps(source: FireSourceId, p: Record<string, unknown>): Mapped {
  switch (source) {
    case 'BC':
      return {
        id: int(p.OBJECTID),
        fireNumber: str(p.FIRE_NUMBER, '?'),
        status: str(p.FIRE_STATUS),
        sizeHa: num(p.FIRE_SIZE_HECTARES),
        date: str(p.TRACK_DATE).replace(/Z/g, ''),
        detail: str(p.SOURCE),
        url: str(p.FIRE_URL),
      };
    case 'Ontario':
      return {
        id: int(p.OBJECTID),
        fireNumber: str(p.FIRENUMB, '?'),
        status: str(p.STATUS),
        sizeHa: num(p.CUR_SIZE),
        date: epochToDate(p.DATE_MAPPED),
        detail: [p.FIRETYPE, p.REFERENCE].filter((x) => typeof x === 'string').join(' · '),
        url: '',
      };
    case 'Oregon': {
      const contained =
        typeof p.attr_PercentContained === 'number'
          ? `${Math.trunc(p.attr_PercentContained)}% contained`
          : 'containment n/a';
      const acres = num(p.poly_GISAcres);
      return {
        id: int(p.OBJECTID),
        fireNumber: str(p.poly_IncidentName, '?'),
        status: contained,
        // WFIGS publishes acres; the whole tool speaks hectares. Expect ~1%
        // disagreement between poly_GISAcres and the area measured from the
        // service's own geometry — that is in their data, not our maths.
        sizeHa: Math.round(acres * ACRES_TO_HECTARES * 10) / 10,
        date: epochToDate(p.poly_PolygonDateTime),
        detail: [str(p.attr_IncidentTypeCategory), 'US-OR'].filter((x) => x.length > 0).join(' · '),
        url: '',
      };
    }
    case 'Yukon':
    case 'Canada':
      return {
        id: int(p.OBJECTID),
        fireNumber: p.UID === undefined || p.UID === null ? '?' : String(p.UID),
        status: `${num(p.HCOUNT)} hotspots`,
        sizeHa: num(p.AREA),
        date: epochToDate(p.LASTDATE),
        detail: str(p.Province),
        url: '',
      };
  }
}

const ATTRIBUTION: Record<FireSourceId, string> = {
  BC: 'BC Wildfire Service current fire perimeters (openmaps.gov.bc.ca)',
  Ontario: 'Ontario LIO in-year fire perimeters (lioservices.lrc.gov.on.ca)',
  Yukon: 'CWFIS active wildfire perimeters in Canada (hotspot-derived)',
  Canada: 'CWFIS active wildfire perimeters in Canada (hotspot-derived)',
  Oregon: 'NIFC/WFIGS interagency fire perimeters (services3.arcgis.com)',
};

export function parseFires(json: unknown, source: FireSourceId): FirePerimeter[] {
  const root = json as { features?: unknown };
  if (!root || !Array.isArray(root.features)) {
    throw new Error('Unexpected response from the perimeter service.');
  }
  const fires: FirePerimeter[] = [];
  for (const f of root.features) {
    const props = f?.properties;
    const geom = f?.geometry;
    if (!props || !geom) continue;
    let polygons: MultiPolygon;
    if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
      polygons = [geom.coordinates];
    } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
      polygons = geom.coordinates;
    } else {
      continue;
    }
    const m = mapProps(source, props as Record<string, unknown>);
    fires.push({
      id: m.id ?? fires.length,
      fireNumber: m.fireNumber,
      status: m.status,
      sizeHa: m.sizeHa,
      trackDate: m.date,
      detail: m.detail,
      url: m.url,
      attribution: ATTRIBUTION[source],
      polygons,
    });
  }
  // Newest tracked first, then fire number ascending — same order as the Swift
  // app, so the two list the same fire at the top.
  return fires.sort((a, b) =>
    a.trackDate !== b.trackDate
      ? a.trackDate < b.trackDate
        ? 1
        : -1
      : a.fireNumber < b.fireNumber
        ? -1
        : a.fireNumber > b.fireNumber
          ? 1
          : 0,
  );
}

// MARK: KML

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function fireKML(fire: FirePerimeter): string {
  const ring = (r: number[][]): string =>
    r.map((c) => `${c[0].toFixed(6)},${c[1].toFixed(6)},0`).join(' ');

  const polygon = (p: number[][][]): string => {
    let s = '<Polygon><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>';
    if (p.length > 0) {
      s += `<outerBoundaryIs><LinearRing><coordinates>${ring(p[0])}</coordinates></LinearRing></outerBoundaryIs>`;
    }
    for (const hole of p.slice(1)) {
      s += `<innerBoundaryIs><LinearRing><coordinates>${ring(hole)}</coordinates></LinearRing></innerBoundaryIs>`;
    }
    return s + '</Polygon>';
  };

  const geometry =
    fire.polygons.length === 1
      ? polygon(fire.polygons[0])
      : '<MultiGeometry>' + fire.polygons.map(polygon).join('') + '</MultiGeometry>';

  const name = `${fire.fireNumber} perimeter ${trackDateCompact(fire)}`;
  const desc = [
    `Fire ${fire.fireNumber} — ${fire.status}`,
    `Size: ${fire.sizeHa} ha`,
    `Tracked: ${fire.trackDate}${fire.detail.length === 0 ? '' : ` (${fire.detail})`}`,
    fire.url,
    `Source: ${fire.attribution}`,
  ].join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEscape(name)}</name>
    <Style id="perimeter">
      <LineStyle><color>ff0000ff</color><width>2.5</width></LineStyle>
      <PolyStyle><color>4d0000ff</color></PolyStyle>
    </Style>
    <Placemark>
      <name>${xmlEscape(name)}</name>
      <description>${xmlEscape(desc)}</description>
      <styleUrl>#perimeter</styleUrl>
      ${geometry}
    </Placemark>
  </Document>
</kml>
`;
}

export function kmlFileName(fire: FirePerimeter): string {
  return `${fire.fireNumber} perimeter ${trackDateCompact(fire)}.kml`.replace(/\//g, '-');
}
