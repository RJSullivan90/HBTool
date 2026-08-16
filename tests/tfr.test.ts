//
// tfr.test.ts — the TFR parser's safety net, ported assertion-for-assertion
// from the macOS app's tests/main.swift.
//
// Every case here exists because the real FAA feed broke something. Keeping the
// expectations byte-identical to the Swift suite is what makes the two
// implementations comparable: if this file passes and the Swift one passes, the
// port did not drift.
//
// Run with:  npm test
//

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  copyAllText,
  detailPathID,
  formFields,
  isFire,
  obsTimeZ,
  parseList,
  parseMetar,
  parseRecord,
  searchText,
  sortRecords,
  wordsBefore,
  type TFRItem,
} from '../src/shared/tfr.ts';
import { dms, dmsPacked, segmentMetres } from '../src/shared/geo.ts';

const ITEM: TFRItem = {
  notamID: '6/5072',
  type: 'HAZARDS',
  state: 'OR',
  description: '5NM E GRANTS PASS, OR',
};

// Condensed from the real detail_6_5072.xml (Fielder Mountain fire, fetched
// live 2026-08-14). The prose is verbatim, because the centre, radius, agency
// and fire name only exist inside it.
const FIELDER_XML = `
<Not>
  <dateEffective>2026-08-14T05:00:00</dateEffective>
  <dateExpire>2026-08-28T05:00:00</dateExpire>
  <codeTimeZone>UTC</codeTimeZone>
  <txtDescrPurpose>TO PROVIDE A SAFE ENVIRONMENT FOR FIRE FIGHTING ACFT OPS</txtDescrPurpose>
  <AffLocGroup><txtNameCity>5NM E GRANTS PASS</txtNameCity><txtNameUSState>OREGON</txtNameUSState></AffLocGroup>
  <aseTFRArea>
    <codeDistVerUpper>ALT</codeDistVerUpper><valDistVerUpper>8000</valDistVerUpper><uomDistVerUpper>FT</uomDistVerUpper>
    <codeDistVerLower>ALT</codeDistVerLower><valDistVerLower>0</valDistVerLower><uomDistVerLower>FT</uomDistVerLower>
  </aseTFRArea>
  <txtNameCoordFacility>SEATTLE</txtNameCoordFacility>
  <codeCoordFacility>ZSE</codeCoordFacility>
  <codeCoordFacilityType>ARTCC</codeCoordFacilityType>
  <txtAddrCoordPhone>253-351-3520</txtAddrCoordPhone>
  <valFreqPOC>124.4</valFreqPOC>
  <txtDescrUSNS>!FDC 6/5072 ZSE OR..AIRSPACE 5NM E GRANTS PASS, OR..TEMPORARY FLIGHT RESTRICTIONS. PURSUANT TO 14 CFR SECTION 91.137(A)(2) TEMPORARY FLIGHT RESTRICTIONS ARE IN EFFECT TO PROVIDE A SAFE ENVIRONMENT FOR FIRE FIGHTING ACFT OPS. WI AN AREA DEFINED AS 5NM RADIUS OF 422530N1231215W (OED237013.3) SFC-8000FT OREGON DEPARTMENT OF FORESTRY TEL 541-471-3883 OR FREQ 124.40 FIELDER MOUNTAIN FIRE IS IN CHARGE OF THE OPERATION. SEATTLE/ZSE/ARTCC TEL 253-351-3520 IS THE FAA CDN FAC. 2608140500-2608280500</txtDescrUSNS>
</Not>`;

test('fire name parsed from prose', () => {
  const r = parseRecord(ITEM, FIELDER_XML);
  assert.equal(r.fireName, 'FIELDER MOUNTAIN FIRE');
});

test('centre comes from prose with DMS decoded', () => {
  const r = parseRecord(ITEM, FIELDER_XML);
  assert.equal(r.centerFromText, true);
  assert.ok(Math.abs(r.centerLat! - (42 + 25 / 60 + 30 / 3600)) < 1e-9);
  assert.ok(Math.abs(r.centerLon! + (123 + 12 / 60 + 15 / 3600)) < 1e-9);
});

test('radius is 5 NM', () => {
  assert.equal(parseRecord(ITEM, FIELDER_XML).radiusNM, 5);
});

test('floor and ceiling, no thousands separator', () => {
  assert.deepEqual(parseRecord(ITEM, FIELDER_XML).areas, ['SFC – 8000 ft MSL']);
});

test('agency and phone', () => {
  const r = parseRecord(ITEM, FIELDER_XML);
  assert.equal(r.agency, 'OREGON DEPARTMENT OF FORESTRY');
  assert.equal(r.agencyPhone, '541-471-3883');
});

test('air-to-ground frequency', () => {
  assert.equal(parseRecord(ITEM, FIELDER_XML).frequency, '124.4');
});

test('FAA coordination facility', () => {
  const r = parseRecord(ITEM, FIELDER_XML);
  assert.equal(r.coordFacilityName, 'SEATTLE');
  assert.equal(r.coordFacilityCode, 'ZSE');
  assert.equal(r.coordPhone, '253-351-3520');
});

test('effective parses as UTC, not local', () => {
  // 2026-08-14T05:00:00 UTC exactly. Parsing the FAA stamp naked would apply
  // the reader's own timezone and be hours off.
  const r = parseRecord(ITEM, FIELDER_XML);
  assert.equal(Date.parse(r.effective!) / 1000, 1786683600);
});

test('place combines city and state', () => {
  assert.equal(parseRecord(ITEM, FIELDER_XML).place, '5NM E GRANTS PASS, OREGON');
});

test('recognised as a fire TFR', () => {
  assert.equal(isFire(parseRecord(ITEM, FIELDER_XML)), true);
});

test('copy-all carries the form fields', () => {
  const block = copyAllText(parseRecord(ITEM, FIELDER_XML), []);
  assert.match(block, /Incident Name: FIELDER MOUNTAIN FIRE/);
  assert.match(block, /TFR NOTAM Number: 6\/5072/);
  assert.match(block, /TFR Radius: 5 NM/);
  assert.match(block, /42°25'30"N 123°12'15"W/);
});

test('polygon TFR falls back to the geometry centroid', () => {
  const polyXML = `
  <Not>
    <txtDescrUSNS>WI AN AREA DEFINED AS 450000N1200000W TO 460000N1200000W TO 460000N1210000W</txtDescrUSNS>
    <abdMergedArea>
      <Avx><geoLat>45.0N</geoLat><geoLong>120.0W</geoLong></Avx>
      <Avx><geoLat>46.0N</geoLat><geoLong>120.0W</geoLong></Avx>
      <Avx><geoLat>46.0N</geoLat><geoLong>121.0W</geoLong></Avx>
    </abdMergedArea>
  </Not>`;
  const p = parseRecord(ITEM, polyXML);
  assert.equal(p.centerFromText, false);
  assert.equal(p.radiusNM, null);
  assert.ok(Math.abs(p.centerLat! - (45 + 46 + 46) / 3) < 1e-9);
  assert.ok(Math.abs(p.centerLon! + (120 + 120 + 121) / 3) < 1e-9);
  // A centroid must never be presented as if the NOTAM published it.
  assert.match(copyAllText(p, []), /geometry centroid/);
});

// Fire-name variants seen live 2026-08-14. Digits are PART of some names (mile
// markers, "LOST CREEK 2"); the frequency or phone before the name is what
// delimits it. Some NOTAMs skip the word FIRE entirely.
const NAME_CASES: Array<[string, string | null]> = [
  [
    'DISPATCH TEL 208-384-3398 OR FREQ 126.7500 MILE MARKER 81 HIGHWAY 55 FIRE IS IN CHARGE OF THE OPERATION.',
    'MILE MARKER 81 HIGHWAY 55 FIRE',
  ],
  ['TEL 909-383-5651 OR FREQ 128.275 LOST CREEK 2 FIRE IS IN CHARGE OF', 'LOST CREEK 2 FIRE'],
  ['TEL 509-685-6900 OR FREQ 126.800 ALPOWA IS IN CHARGE OF', 'ALPOWA'],
  // Traditional-format prose: a frequency directly before the bare marker must
  // yield null, not junk.
  ['TEL 541-471-3883, /FREQ 124.4 IS IN CHARGE OF ON SCENE', null],
];

for (const [prose, want] of NAME_CASES) {
  test(`fire name: ${want ?? 'null for frequency-before-marker'}`, () => {
    const r = parseRecord(ITEM, `<Not><txtDescrUSNS>${prose}</txtDescrUSNS></Not>`);
    assert.equal(r.fireName, want);
  });
}

test('wordsBefore stops at punctuation-bearing tokens, not digits', () => {
  const stops = new Set(['THE']);
  // A leftmost-first regex would capture from "FT" onward here.
  assert.equal(
    wordsBefore(' TEL ', 'SFC-8000FT OREGON DEPARTMENT OF FORESTRY TEL 1', stops, 8),
    'OREGON DEPARTMENT OF FORESTRY',
  );
});

test('altimeter in inHg comes from the raw METAR A-group', () => {
  // aviationweather.gov's JSON `altim` field is hPa — dialling that in would be
  // the wrong number entirely.
  const stations = parseMetar(
    [
      {
        icaoId: 'K3S8',
        name: 'Grants Pass Arpt, OR, US',
        lat: 42.51,
        lon: -123.388,
        altim: 1014.6,
        reportTime: '2026-08-14T11:00:00.000Z',
        rawOb: 'METAR K3S8 141055Z AUTO 00000KT 10SM CLR 16/11 A2996 RMK AO2',
      },
    ],
    42.425,
    -123.20417,
  );
  assert.equal(stations.length, 1);
  assert.equal(stations[0].altimeterInHg, 29.96);
  assert.equal(stations[0].altimeterHPa, 1014.6);
  assert.equal(obsTimeZ(stations[0]), '1055Z');
});

test('stations sort by true distance from the TFR centre', () => {
  const stations = parseMetar(
    [
      { icaoId: 'FAR', name: '', lat: 43.5, lon: -123.2, rawOb: '' },
      { icaoId: 'NEAR', name: '', lat: 42.5, lon: -123.2, rawOb: '' },
    ],
    42.425,
    -123.20417,
  );
  assert.deepEqual(
    stations.map((s) => s.icaoId),
    ['NEAR', 'FAR'],
  );
  // ~0.075° of latitude ≈ 4.5 NM. Sanity-check the ellipsoidal maths.
  assert.ok(stations[0].distanceNM > 4 && stations[0].distanceNM < 5);
});

test('list parses and the detail path swaps the slash', () => {
  const items = parseList([
    { notam_id: '6/4807', type: 'HAZARDS', state: 'CA', description: 'x' },
    { notam_id: '6/5050', type: 'HAZARDS', state: 'IL', description: 'y' },
    { nope: true },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].notamID, '6/4807');
  assert.equal(detailPathID(items[0].notamID), '6_4807');
});

test('fires sort ahead of non-fires, newest NOTAM first', () => {
  const fire = parseRecord(
    { ...ITEM, notamID: '6/1000' },
    '<Not><txtDescrUSNS>A FIRE</txtDescrUSNS></Not>',
  );
  const fireNewer = parseRecord(
    { ...ITEM, notamID: '6/9000' },
    '<Not><txtDescrUSNS>A FIRE</txtDescrUSNS></Not>',
  );
  const other = parseRecord(
    { ...ITEM, notamID: '6/9999' },
    '<Not><txtDescrUSNS>AIRSHOW</txtDescrUSNS></Not>',
  );
  assert.deepEqual(
    sortRecords([other, fire, fireNewer]).map((r) => r.item.notamID),
    ['6/9000', '6/1000', '6/9999'],
  );
});

test('search matches on fire name, NOTAM number and place', () => {
  const r = parseRecord(ITEM, FIELDER_XML);
  const hay = searchText(r);
  for (const needle of ['FIELDER', '6/5072', 'GRANTS PASS', 'OREGON']) {
    assert.ok(hay.includes(needle), needle);
  }
});

test('geodesy helpers match the Swift originals', () => {
  assert.equal(dms(42.425, true), `42°25'30"N`);
  assert.equal(dms(-123.20417, false), `123°12'15"W`);
  assert.equal(dmsPacked('422530', 'N', false), 42 + 25 / 60 + 30 / 3600);
  assert.equal(dmsPacked('1231215', 'W', true), -(123 + 12 / 60 + 15 / 3600));
  assert.equal(dmsPacked('42253', 'N', false), null); // wrong digit count
  // One degree of latitude at the equator, ellipsoidal: ~110.57 km.
  const d = segmentMetres([0, 0], [0, 1]);
  assert.ok(Math.abs(d - 110574) < 50, String(d));
});
