//
// fires.test.ts — wildfire perimeter sources, ported from the Swift app.
//
// The assertions that matter most here are the ones guarding invariants that
// have caused real damage: multi-part geometry staying multi-part, and the
// acres→hectares conversion on the one source that publishes acres.
//

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACRES_TO_HECTARES,
  epochToDate,
  fireKML,
  kmlFileName,
  parseFires,
  sourceURL,
  trackDateCompact,
  xmlEscape,
  type FirePerimeter,
} from '../src/shared/fires.ts';

const SQUARE = [
  [
    [-120.0, 50.0],
    [-120.0, 50.1],
    [-119.9, 50.1],
    [-119.9, 50.0],
    [-120.0, 50.0],
  ],
];

function fc(features: unknown[]): unknown {
  return { type: 'FeatureCollection', features };
}

test('BC properties map to the display fields', () => {
  const fires = parseFires(
    fc([
      {
        properties: {
          OBJECTID: 7,
          FIRE_NUMBER: 'V82345',
          FIRE_STATUS: 'Out of Control',
          FIRE_SIZE_HECTARES: 1234.5,
          TRACK_DATE: '2026-08-14Z',
          SOURCE: 'Satellite',
          FIRE_URL: 'https://example.test/fire',
        },
        geometry: { type: 'Polygon', coordinates: SQUARE },
      },
    ]),
    'BC',
  );
  assert.equal(fires.length, 1);
  const f = fires[0];
  assert.equal(f.id, 7);
  assert.equal(f.fireNumber, 'V82345');
  assert.equal(f.status, 'Out of Control');
  assert.equal(f.sizeHa, 1234.5);
  assert.equal(f.trackDate, '2026-08-14'); // the Z is stripped
  assert.equal(trackDateCompact(f), '20260814');
  assert.match(f.attribution, /BC Wildfire Service/);
});

test('MultiPolygon stays multi-part', () => {
  // 25 of BC's ~175 perimeters are MultiPolygon with up to 6 parts. Collapsing
  // them produces "hole lies outside shell" geometry that Google Earth draws as
  // fragments, so this is a damage-prevention assertion, not a nicety.
  const second = [
    [
      [-118.0, 51.0],
      [-118.0, 51.1],
      [-117.9, 51.1],
      [-118.0, 51.0],
    ],
  ];
  const fires = parseFires(
    fc([
      {
        properties: { FIRE_NUMBER: 'M1', TRACK_DATE: '2026-08-01' },
        geometry: { type: 'MultiPolygon', coordinates: [SQUARE, second] },
      },
    ]),
    'BC',
  );
  assert.equal(fires[0].polygons.length, 2);
  const kml = fireKML(fires[0]);
  assert.match(kml, /<MultiGeometry>/);
  assert.equal((kml.match(/<Polygon>/g) ?? []).length, 2);
});

test('a single polygon does NOT get wrapped in MultiGeometry', () => {
  const fires = parseFires(
    fc([
      {
        properties: { FIRE_NUMBER: 'S1', TRACK_DATE: '2026-08-01' },
        geometry: { type: 'Polygon', coordinates: SQUARE },
      },
    ]),
    'BC',
  );
  const kml = fireKML(fires[0]);
  assert.ok(!kml.includes('<MultiGeometry>'));
  assert.equal((kml.match(/<Polygon>/g) ?? []).length, 1);
});

test('holes become innerBoundaryIs, not extra polygons', () => {
  const withHole = [
    SQUARE[0],
    [
      [-119.98, 50.02],
      [-119.98, 50.04],
      [-119.96, 50.04],
      [-119.98, 50.02],
    ],
  ];
  const fires = parseFires(
    fc([
      {
        properties: { FIRE_NUMBER: 'H1', TRACK_DATE: '2026-08-01' },
        geometry: { type: 'Polygon', coordinates: withHole },
      },
    ]),
    'BC',
  );
  const kml = fireKML(fires[0]);
  assert.equal((kml.match(/<outerBoundaryIs>/g) ?? []).length, 1);
  assert.equal((kml.match(/<innerBoundaryIs>/g) ?? []).length, 1);
});

test('WFIGS acres convert to hectares', () => {
  // 1000 acres = 404.7 ha. Getting this wrong misreports every Oregon fire.
  const fires = parseFires(
    fc([
      {
        properties: {
          poly_IncidentName: 'BOLOGNA',
          poly_GISAcres: 1000,
          attr_PercentContained: 45.7,
          poly_PolygonDateTime: 1786683600000,
          attr_IncidentTypeCategory: 'WF',
        },
        geometry: { type: 'Polygon', coordinates: SQUARE },
      },
    ]),
    'Oregon',
  );
  const f = fires[0];
  assert.equal(f.sizeHa, Math.round(1000 * ACRES_TO_HECTARES * 10) / 10);
  assert.equal(f.sizeHa, 404.7);
  assert.equal(f.status, '45% contained');
  assert.equal(f.trackDate, '2026-08-14');
  assert.equal(f.detail, 'WF · US-OR');
});

test('missing containment reads as n/a rather than 0%', () => {
  const fires = parseFires(
    fc([
      {
        properties: { poly_IncidentName: 'X', poly_GISAcres: 1 },
        geometry: { type: 'Polygon', coordinates: SQUARE },
      },
    ]),
    'Oregon',
  );
  assert.equal(fires[0].status, 'containment n/a');
});

test('CWFIS hotspot fields map through for Yukon and Canada', () => {
  for (const source of ['Yukon', 'Canada'] as const) {
    const fires = parseFires(
      fc([
        {
          properties: {
            UID: 4021,
            HCOUNT: 12,
            AREA: 88.5,
            LASTDATE: 1786683600000,
            Province: 'Yukon',
          },
          geometry: { type: 'Polygon', coordinates: SQUARE },
        },
      ]),
      source,
    );
    assert.equal(fires[0].fireNumber, '4021');
    assert.equal(fires[0].status, '12 hotspots');
    assert.equal(fires[0].sizeHa, 88.5);
    assert.equal(fires[0].detail, 'Yukon');
  }
});

test('sorted newest tracked first, then fire number ascending', () => {
  const mk = (n: string, d: string) => ({
    properties: { FIRE_NUMBER: n, TRACK_DATE: d },
    geometry: { type: 'Polygon', coordinates: SQUARE },
  });
  const fires = parseFires(
    fc([mk('B', '2026-08-01'), mk('A', '2026-08-02'), mk('A', '2026-08-01')]),
    'BC',
  );
  assert.deepEqual(
    fires.map((f) => `${f.trackDate} ${f.fireNumber}`),
    ['2026-08-02 A', '2026-08-01 A', '2026-08-01 B'],
  );
});

test('non-polygon geometry is skipped, not crashed on', () => {
  const fires = parseFires(
    fc([
      { properties: { FIRE_NUMBER: 'P' }, geometry: { type: 'Point', coordinates: [-120, 50] } },
      { properties: { FIRE_NUMBER: 'OK' }, geometry: { type: 'Polygon', coordinates: SQUARE } },
      { properties: { FIRE_NUMBER: 'NOGEOM' } },
    ]),
    'BC',
  );
  assert.deepEqual(
    fires.map((f) => f.fireNumber),
    ['OK'],
  );
});

test('a malformed payload throws a legible error', () => {
  assert.throws(() => parseFires({ nope: true }, 'BC'), /Unexpected response/);
});

test('Oregon URL carries both WFIGS guards', () => {
  const u = sourceURL('Oregon');
  // YearToDate, not Current — Current was missing a same-day-updated fire.
  assert.match(u, /WFIGS_Interagency_Perimeters_YearToDate/);
  assert.match(u, /attr_FireOutDateTime%20IS%20NULL/);
  assert.match(u, /attr_POOState%3D'US-OR'/);
});

test('Yukon filters the national layer; Canada does not', () => {
  assert.match(sourceURL('Yukon'), /Province%3D'Yukon'/);
  assert.match(sourceURL('Canada'), /where=1%3D1/);
  assert.match(sourceURL('BC'), /PROT_CURRENT_FIRE_POLYS_SP/);
  assert.match(sourceURL('Ontario'), /LIO_Open09/);
});

test('epoch conversion is UTC and tolerates junk', () => {
  assert.equal(epochToDate(1786683600000), '2026-08-14');
  assert.equal(epochToDate(null), '');
  assert.equal(epochToDate('nope'), '');
  assert.equal(epochToDate(undefined), '');
});

test('KML escapes XML and coordinates carry 6 decimals', () => {
  const f: FirePerimeter = {
    id: 1,
    fireNumber: 'A&B<test>',
    status: 'Out of Control',
    sizeHa: 1,
    trackDate: '2026-08-14',
    detail: '',
    url: '',
    attribution: 'x',
    polygons: [SQUARE],
  };
  const kml = fireKML(f);
  assert.match(kml, /A&amp;B&lt;test&gt;/);
  assert.ok(!kml.includes('A&B<test>'));
  assert.match(kml, /-120\.000000,50\.000000,0/);
  assert.equal(xmlEscape(`a"b'c`), 'a&quot;b&apos;c');
  // A slash in a fire name would create a subdirectory rather than a file.
  assert.equal(kmlFileName({ ...f, fireNumber: 'V8/2' }), 'V8-2 perimeter 20260814.kml');
});
