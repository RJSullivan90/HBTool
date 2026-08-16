//
// net.ts — all outbound HTTP, in the MAIN process.
//
// Fetching here rather than in the renderer is deliberate: tfr.faa.gov and
// aviationweather.gov send no CORS headers, so a renderer-side fetch would be
// blocked by the browser. Main-process Node fetch has no such restriction, and
// it keeps the network surface in one auditable file.
//

import {
  detailURL,
  parseList,
  parseMetar,
  parseRecord,
  sortRecords,
  TFR_LIST_URL,
  type MetarStation,
  type TFRRecord,
} from '../shared/tfr.ts';

const UA = 'HBTool (Hummingbird Drones; rs@hummingbirddrones.ca)';

/** Concurrency cap for the detail fan-out. The Swift app let all ~55 fly at
 *  once; a cap is politer to the FAA and makes no measurable difference to
 *  wall-clock at this size. */
const DETAIL_CONCURRENCY = 8;

/**
 * Retries on 5xx and on transport failures, with a short backoff.
 *
 * Not gold-plating: aviationweather.gov was observed returning a one-off HTTP
 * 502 mid-session while the very next request succeeded. Without a retry that
 * single blip costs the altimeter reading, and the person filling the form is
 * doing it at the end of a night shift. A 4xx is NOT retried — that is a real
 * answer about a bad request, and repeating it just wastes time.
 */
export const RETRY_DELAYS_MS = [400, 1200];

export async function getText(url: string, timeoutMs: number): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res.text();
      const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      if (res.status < 500) throw err;
      lastError = err;
    } catch (e) {
      // A 4xx thrown just above must not be swallowed into another retry.
      if (e instanceof Error && /^HTTP 4/.test(e.message)) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
  }
  throw lastError ?? new Error(`Request to ${new URL(url).host} failed`);
}

async function getJSON(url: string, timeoutMs: number): Promise<unknown> {
  return JSON.parse(await getText(url, timeoutMs));
}

/** Session cache: NOTAM id → parsed record. TFRs change by NOTAM, so this is
 *  never persisted to disk — a stale layer restored at launch would look
 *  authoritative and be wrong. "Refresh" clears it. */
const cache = new Map<string, TFRRecord>();

export type FetchResult = {
  records: TFRRecord[];
  /** NOTAMs whose detail could not be fetched. Reported, never silently
   *  dropped: a missing TFR looks exactly like "no TFR over my fire". */
  failures: string[];
};

export async function fetchAllTFRs(refresh: boolean): Promise<FetchResult> {
  if (refresh) cache.clear();

  const list = parseList(await getJSON(TFR_LIST_URL, 60_000));
  const hazards = list.filter((i) => i.type.toUpperCase().startsWith('HAZ'));

  const records: TFRRecord[] = [];
  const failures: string[] = [];
  const pending = hazards.filter((item) => {
    const hit = cache.get(item.notamID);
    if (hit) {
      records.push(hit);
      return false;
    }
    return true;
  });

  let next = 0;
  const workers = Array.from(
    { length: Math.min(DETAIL_CONCURRENCY, pending.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= pending.length) return;
        const item = pending[i];
        try {
          const record = parseRecord(item, await getText(detailURL(item.notamID), 45_000));
          cache.set(item.notamID, record);
          records.push(record);
        } catch {
          failures.push(item.notamID);
        }
      }
    },
  );
  await Promise.all(workers);

  return { records: sortRecords(records), failures: failures.sort() };
}

/**
 * Nearest reporting stations to a TFR centre.
 *
 * ±1.5° of latitude is about 90 NM; the east–west span is widened by 1/cos(lat)
 * so the box is square on the ground rather than square in degrees. One retry
 * at triple size covers remote country with no nearby reporting station.
 */
export async function fetchNearestStations(
  lat: number,
  lon: number,
  count = 3,
): Promise<MetarStation[]> {
  for (const span of [1.5, 4.5]) {
    const dLon = span / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const bbox = [lat - span, lon - dLon, lat + span, lon + dLon]
      .map((v) => v.toFixed(3))
      .join(',');
    const url = `https://aviationweather.gov/api/data/metar?bbox=${bbox}&format=json`;
    const stations = parseMetar(await getJSON(url, 45_000), lat, lon);
    if (stations.length > 0) return stations.slice(0, count);
  }
  return [];
}
