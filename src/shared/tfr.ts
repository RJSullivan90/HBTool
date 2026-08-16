//
// tfr.ts — TFR Report parsing, ported from TFRReportTab.swift.
//
// Pure functions only: no Electron, no network, no DOM. That is what lets the
// test suite run it under `node --test` and lets both the main process and the
// tests share exactly one implementation.
//
// Data shape notes carried over from the Swift original (verified live
// 2026-08-14):
//  * The detail XML holds the structured fields — effective/expire, per-area
//    floor/ceiling, valFreqPOC, the coordination facility and its phone.
//  * The centre point, radius, agency in charge and the FIRE NAME exist ONLY in
//    the NOTAM prose (txtDescrUSNS) and are parsed out of the text.
//  * Polygon TFRs have no radius call, so the centroid of the published
//    geometry stands in and is labelled as such.
//

import { dms, dmsPacked, faaCoordinate, segmentMetres } from './geo.ts';

export type TFRItem = {
  notamID: string; // "6/4807"
  type: string; // HAZARDS / SECURITY / VIP / …
  state: string; // "OR"
  description: string;
};

export type TFRRecord = {
  item: TFRItem;
  fireName: string | null;
  place: string;
  effective: string | null; // ISO 8601 UTC
  expire: string | null;
  rawEffective: string;
  rawExpire: string;
  timeZoneCode: string;
  areas: string[];
  centerLat: number | null;
  centerLon: number | null;
  centerFromText: boolean;
  radiusNM: number | null;
  frequency: string | null;
  agency: string | null;
  agencyPhone: string | null;
  coordFacilityName: string | null;
  coordFacilityCode: string | null;
  coordFacilityType: string | null;
  coordPhone: string | null;
  purpose: string | null;
  notamText: string;
};

export type MetarStation = {
  icaoId: string;
  name: string;
  lat: number;
  lon: number;
  altimeterInHg: number | null;
  altimeterHPa: number | null;
  reportTime: string;
  rawOb: string;
  distanceNM: number;
};

export const TFR_LIST_URL = 'https://tfr.faa.gov/tfrapi/exportTfrList';

/** "6/4807" → the detail file's "6_4807". */
export function detailPathID(notamID: string): string {
  return notamID.replace(/\//g, '_');
}

export function detailURL(notamID: string): string {
  return `https://tfr.faa.gov/download/detail_${detailPathID(notamID)}.xml`;
}

export function parseList(json: unknown): TFRItem[] {
  if (!Array.isArray(json)) throw new Error('TFR list is not a JSON array');
  const out: TFRItem[] = [];
  for (const t of json) {
    const id = t?.notam_id;
    if (typeof id !== 'string') continue;
    out.push({
      notamID: id,
      type: typeof t.type === 'string' ? t.type : '',
      state: typeof t.state === 'string' ? t.state : '',
      description: typeof t.description === 'string' ? t.description : '',
    });
  }
  return out;
}

// MARK: XML helpers

function tagValue(xml: string, tag: string): string | null {
  const open = xml.indexOf(`<${tag}>`);
  if (open < 0) return null;
  const from = open + tag.length + 2;
  const close = xml.indexOf(`</${tag}>`, from);
  if (close < 0) return null;
  const v = xml.slice(from, close).trim();
  return v.length === 0 ? null : v;
}

function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const a = xml.indexOf(`<${tag}>`, i);
    if (a < 0) break;
    const from = a + tag.length + 2;
    const b = xml.indexOf(`</${tag}>`, from);
    if (b < 0) break;
    out.push(xml.slice(from, b));
    i = b + tag.length + 3;
  }
  return out;
}

/** Rings from a detail XML. Prefers the pre-discretised <abdMergedArea>;
 *  falls back to raw <Abd>. Circles arrive already flattened by the FAA, so the
 *  <codeType>CIR synthesis the Swift app carries is only needed for the
 *  fallback path — and the centroid is all this port uses it for.
 */
export function parseDetailRings(xml: string): Array<Array<[number, number]>> {
  let rings = ringsInBlocks(blocks(xml, 'abdMergedArea'));
  if (rings.length === 0) rings = ringsInBlocks(blocks(xml, 'Abd'));
  return rings.filter((r) => r.length >= 3);
}

function ringsInBlocks(areas: string[]): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = [];
  for (const area of areas) {
    const ring: Array<[number, number]> = [];
    for (const avx of blocks(area, 'Avx')) {
      const latRaw = tagValue(avx, 'geoLat');
      const lonRaw = tagValue(avx, 'geoLong');
      if (!latRaw || !lonRaw) continue;
      const lat = faaCoordinate(latRaw);
      const lon = faaCoordinate(lonRaw);
      if (lat === null || lon === null) continue;
      ring.push([lon, lat]);
    }
    if (ring.length > 0) rings.push(ring);
  }
  return rings;
}

// MARK: prose parsing

/**
 * Walks BACKWARDS from the first occurrence of `marker`, collecting plain
 * uppercase words.
 *
 * A leftmost-first regex cannot do this. Matching `([A-Z ]+?) TEL` against
 * "…SFC-8000FT OREGON DEPARTMENT OF FORESTRY TEL…" captures from "FT" onward,
 * because that is the leftmost position that satisfies the pattern.
 *
 * Digits are legitimately part of fire names ("LOST CREEK 2 FIRE", "MILE MARKER
 * 81 HIGHWAY 55 FIRE"), so a plain digit test would truncate real names. What
 * actually delimits the name is a token carrying punctuation — a frequency
 * ("126.7500"), a phone ("208-384-3398"), or an FRD ("(OED237013.3)").
 */
export function wordsBefore(
  marker: string,
  text: string,
  stopWords: Set<string>,
  maxWords: number,
): string | null {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const words = text.slice(0, at).split(' ').filter((w) => w.length > 0);
  const collected: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (collected.length >= maxWords) break;
    if (stopWords.has(w)) break;
    const pureInt = /^[0-9]+$/.test(w);
    if (pureInt && w.length <= 4) {
      collected.unshift(w);
      continue;
    }
    if (/[.\-()/,]/.test(w)) break;
    if (/[0-9]/.test(w)) break;
    if (!/[A-Z]/.test(w)) break;
    collected.unshift(w);
  }
  const name = collected.join(' ').replace(/^[\s.,]+|[\s.,]+$/g, '');
  // All-numeric leftovers are not a name — but trailing numbers that are part
  // of one ("LOST CREEK 2") must survive, so reject rather than trim.
  if (!/[A-Z]/.test(name)) return null;
  return name;
}

const AGENCY_STOPS = new Set(['THE', 'WI', 'AS', 'OPS', 'OPS.']);
const NAME_STOPS = new Set(['THE', 'OR', 'AND', 'TEL', 'FREQ', 'OF', 'A', 'AN']);

export function parseRecord(item: TFRItem, xml: string): TFRRecord {
  const usns = tagValue(xml, 'txtDescrUSNS') ?? '';
  const tz = tagValue(xml, 'codeTimeZone') ?? 'UTC';
  const rawEff = tagValue(xml, 'dateEffective') ?? '';
  const rawExp = tagValue(xml, 'dateExpire') ?? '';

  // The FAA stamps are wall-clock in codeTimeZone, which is UTC on every fire
  // TFR seen. Appending the Z is what makes them absolute; parsing them naked
  // would silently apply the reader's own timezone.
  const asUTC = (s: string): string | null => {
    if (s.length === 0) return null;
    const d = new Date(`${s}Z`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  };

  // Floor/ceiling per hazard area. codeDistVer ALT = MSL, HEI = AGL.
  const areas: string[] = [];
  for (const block of blocks(xml, 'aseTFRArea')) {
    const level = (
      val: string | null,
      code: string | null,
      uom: string | null,
    ): string => {
      if (val === null) return '?';
      const n = Number(val);
      if (!isFinite(n)) return '?';
      if (n === 0) return 'SFC';
      const unit = uom === 'FL' ? 'FL' : (uom ?? 'FT').toLowerCase();
      const datum = code === 'HEI' ? 'AGL' : 'MSL';
      // No thousands separator: the value gets pasted into a form field.
      const formatted = n === Math.round(n) ? String(Math.round(n)) : val;
      return unit === 'FL' ? `FL${val}` : `${formatted} ${unit} ${datum}`;
    };
    areas.push(
      level(
        tagValue(block, 'valDistVerLower'),
        tagValue(block, 'codeDistVerLower'),
        tagValue(block, 'uomDistVerLower'),
      ) +
        ' – ' +
        level(
          tagValue(block, 'valDistVerUpper'),
          tagValue(block, 'codeDistVerUpper'),
          tagValue(block, 'uomDistVerUpper'),
        ),
    );
  }

  // Centre + radius from the prose: "5NM RADIUS OF 422530N1231215W".
  let lat: number | null = null;
  let lon: number | null = null;
  let radiusNM: number | null = null;
  let centerFromText = false;
  const m = usns.match(/([0-9.]+)\s*NM RADIUS OF (\d{6})([NS])\s*(\d{7})([EW])/);
  if (m) {
    radiusNM = Number(m[1]);
    lat = dmsPacked(m[2], m[3], false);
    lon = dmsPacked(m[4], m[5], true);
    centerFromText = lat !== null && lon !== null;
  }
  if (!centerFromText) {
    radiusNM = null;
    const pts = parseDetailRings(xml).flat();
    if (pts.length > 0) {
      lon = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    }
  }

  // Agency in charge + phone: words before the FIRST " TEL " (the FAA
  // facility's own TEL comes later in the prose).
  let agency: string | null = null;
  let agencyPhone: string | null = null;
  const agencyName = wordsBefore(' TEL ', usns, AGENCY_STOPS, 8);
  if (agencyName !== null) {
    agency = agencyName;
    const p = usns.match(/TEL\s+([0-9][0-9\-() ]{6,})/);
    if (p) agencyPhone = p[1].trim();
  }

  // Fire name. Some NOTAMs skip the word FIRE ("ALPOWA IS IN CHARGE"), hence
  // the bare fallback; in traditional-format prose the bare marker is preceded
  // by the frequency, which stops the walk, so it yields null rather than junk.
  let fireName: string | null = null;
  for (const [marker, suffix] of [
    [' FIRE IS IN CHARGE', ' FIRE'],
    [' COMPLEX IS IN CHARGE', ' COMPLEX'],
    [' IS IN CHARGE', ''],
  ] as const) {
    const name = wordsBefore(marker, usns, NAME_STOPS, 5);
    if (name !== null) {
      fireName = name + suffix;
      break;
    }
  }

  const city = tagValue(xml, 'txtNameCity') ?? '';
  const state = tagValue(xml, 'txtNameUSState') ?? item.state;

  return {
    item,
    fireName,
    place: city.length === 0 ? state : `${city}, ${state}`,
    effective: asUTC(rawEff),
    expire: asUTC(rawExp),
    rawEffective: rawEff,
    rawExpire: rawExp,
    timeZoneCode: tz,
    areas,
    centerLat: lat,
    centerLon: lon,
    centerFromText,
    radiusNM,
    frequency: tagValue(xml, 'valFreqPOC'),
    agency,
    agencyPhone,
    coordFacilityName: tagValue(xml, 'txtNameCoordFacility'),
    coordFacilityCode: tagValue(xml, 'codeCoordFacility'),
    coordFacilityType: tagValue(xml, 'codeCoordFacilityType'),
    coordPhone: tagValue(xml, 'txtAddrCoordPhone'),
    purpose: tagValue(xml, 'txtDescrPurpose'),
    notamText: usns,
  };
}

// MARK: derived views

export function isFire(r: TFRRecord): boolean {
  return (r.purpose ?? '').includes('FIRE') || r.notamText.includes('FIRE');
}

/** null when the times could not be parsed — "unknown", not "inactive". */
export function activeNow(r: TFRRecord, now: Date = new Date()): boolean | null {
  if (!r.effective || !r.expire) return null;
  const t = now.getTime();
  return t >= Date.parse(r.effective) && t <= Date.parse(r.expire);
}

export function searchText(r: TFRRecord): string {
  return `${r.item.notamID} ${r.fireName ?? ''} ${r.place} ${r.item.state} ${r.notamText}`.toUpperCase();
}

/** The METAR's own observation minute: "141055Z" → "1055Z". */
export function obsTimeZ(s: MetarStation): string {
  const m = s.rawOb.match(/\b(\d{6})Z\b/);
  return m ? m[0].slice(2) : s.reportTime;
}

export function parseMetar(
  list: unknown,
  fromLat: number,
  fromLon: number,
): MetarStation[] {
  if (!Array.isArray(list)) return [];
  const out: MetarStation[] = [];
  for (const m of list) {
    const id = m?.icaoId;
    const slat = m?.lat;
    const slon = m?.lon;
    if (typeof id !== 'string' || typeof slat !== 'number' || typeof slon !== 'number') {
      continue;
    }
    const rawOb = typeof m.rawOb === 'string' ? m.rawOb : '';
    // Inches of mercury from the raw "A2996" group. The JSON's `altim` field is
    // hPa, which is not the number a pilot dials into the altimeter.
    const a = rawOb.match(/\bA(\d{4})\b/);
    out.push({
      icaoId: id,
      name: typeof m.name === 'string' ? m.name : '',
      lat: slat,
      lon: slon,
      altimeterInHg: a ? Number(a[1]) / 100 : null,
      altimeterHPa: typeof m.altim === 'number' ? m.altim : null,
      reportTime: typeof m.reportTime === 'string' ? m.reportTime : '',
      rawOb,
      distanceNM: segmentMetres([fromLon, fromLat], [slon, slat]) / 1852,
    });
  }
  out.sort((a, b) => a.distanceNM - b.distanceNM);
  return out;
}

// MARK: form output

const UTC_STAMP = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function utcLabel(iso: string): string {
  const parts = Object.fromEntries(
    UTC_STAMP.formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}${parts.minute}Z`;
}

function localLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(new Date(iso));
}

export function timeLabel(iso: string | null, raw: string, tz: string): string {
  if (!iso) return raw.length === 0 ? '—' : `${raw} ${tz}`;
  return `${utcLabel(iso)} (${localLabel(iso)})`;
}

function trimZeros(v: number): string {
  return v === Math.round(v) ? String(Math.round(v)) : String(v);
}

/**
 * The form's Section A fields as label/value pairs, in the form's order.
 * One place builds this so the UI rows, "Copy all" and the CLI can never
 * disagree about what the form says.
 */
export function formFields(
  r: TFRRecord,
  stations: MetarStation[],
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (r.fireName) out.push(['Incident Name', r.fireName]);
  out.push(['TFR NOTAM Number', r.item.notamID]);
  out.push(['TFR Effective', timeLabel(r.effective, r.rawEffective, r.timeZoneCode)]);
  out.push(['TFR Expires', timeLabel(r.expire, r.rawExpire, r.timeZoneCode)]);
  if (r.centerLat !== null && r.centerLon !== null) {
    const label = r.centerFromText
      ? 'TFR Center Point'
      : 'TFR Center Point (geometry centroid)';
    out.push([
      label,
      `${dms(r.centerLat, true)} ${dms(r.centerLon, false)}  (${r.centerLat.toFixed(5)}, ${r.centerLon.toFixed(5)})`,
    ]);
  }
  if (r.radiusNM !== null) {
    out.push(['TFR Radius', `${trimZeros(r.radiusNM)} NM`]);
  } else if (!r.centerFromText) {
    out.push(['TFR Radius', '— (polygon TFR, see NOTAM text)']);
  }
  if (r.areas.length > 0) {
    out.push([
      'TFR Floor – Ceiling',
      r.areas.length === 1
        ? r.areas[0]
        : r.areas.map((a, i) => `Area ${i + 1}: ${a}`).join('; '),
    ]);
  }
  const s = stations[0];
  if (s) {
    out.push([
      'Closest Airport',
      `${s.icaoId} / ${s.name}  (${s.distanceNM.toFixed(1)} NM from center)`,
    ]);
    if (s.altimeterInHg !== null) {
      out.push(['Altimeter Setting', `${s.altimeterInHg.toFixed(2)} inHg @ ${obsTimeZ(s)}`]);
    } else if (s.altimeterHPa !== null) {
      out.push(['Altimeter Setting', `${s.altimeterHPa.toFixed(0)} hPa @ ${obsTimeZ(s)}`]);
    }
    out.push(['Altimeter Source', `${s.icaoId} METAR`]);
  }
  if (r.frequency) out.push(['Air-to-Ground Frequency', r.frequency]);
  if (r.agency) {
    out.push(['Agency in Charge', r.agency + (r.agencyPhone ? ` — TEL ${r.agencyPhone}` : '')]);
  }
  if (r.coordFacilityName) {
    let v = r.coordFacilityName;
    if (r.coordFacilityType) v += ` ${r.coordFacilityType}`;
    if (r.coordFacilityCode) v += ` (${r.coordFacilityCode})`;
    if (r.coordPhone) v += ` — TEL ${r.coordPhone}`;
    out.push(['FAA Coordination Facility', v]);
  }
  return out;
}

export function copyAllText(r: TFRRecord, stations: MetarStation[]): string {
  return formFields(r, stations)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/** Sort: fires first, then newest NOTAM number first within each group. */
export function sortRecords(records: TFRRecord[]): TFRRecord[] {
  return [...records].sort((a, b) => {
    const fa = isFire(a);
    const fb = isFire(b);
    if (fa !== fb) return fa ? -1 : 1;
    return a.item.notamID < b.item.notamID ? 1 : a.item.notamID > b.item.notamID ? -1 : 0;
  });
}
