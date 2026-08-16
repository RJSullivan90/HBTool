//
// renderer.ts — the TFR Report UI.
//
// It imports the SAME formatting functions the tests exercise and the CLI would
// use, so what is shown on screen, what "Copy all" puts on the clipboard, and
// what the test suite asserts can never drift apart.
//
// No network here and no secrets here: every fetch is an IPC call into main.
//

import {
  activeNow,
  copyAllText,
  formFields,
  isFire,
  obsTimeZ,
  searchText,
  type MetarStation,
  type TFRRecord,
} from '../shared/tfr.ts';

type FetchResult =
  | { ok: true; records: TFRRecord[]; failures: string[] }
  | { ok: false; error: string };
type WeatherResult = { ok: true; stations: MetarStation[] } | { ok: false; error: string };
type SecretsStatus = {
  unlocked: boolean;
  bundleMissing: boolean;
  canRemember: boolean;
  fingerprint: string | null;
};
type UpdateState = { status: string; version?: string; message?: string };

declare global {
  interface Window {
    hbtool: {
      appInfo(): Promise<{ version: string; platform: string; releasesURL: string }>;
      secretsStatus(): Promise<SecretsStatus>;
      unlock(
        passphrase: string,
        remember: boolean,
      ): Promise<{ ok: boolean; error?: string; status: SecretsStatus }>;
      forgetKey(): Promise<SecretsStatus>;
      onSecretsChanged(fn: (s: SecretsStatus) => void): void;
      fetchTFRs(refresh: boolean): Promise<FetchResult>;
      fetchWeather(lat: number, lon: number): Promise<WeatherResult>;
      copy(text: string): Promise<void>;
      updateState(): Promise<UpdateState>;
      checkForUpdates(): Promise<UpdateState>;
      installUpdate(): Promise<void>;
      openReleases(): Promise<void>;
      onUpdateChanged(fn: (s: UpdateState) => void): void;
    };
  }
}

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as unknown as T;

const els = {
  query: $<HTMLInputElement>('query'),
  search: $<HTMLButtonElement>('search'),
  refresh: $<HTMLButtonElement>('refresh'),
  status: $<HTMLParagraphElement>('status'),
  problem: $<HTMLParagraphElement>('problem'),
  matches: $<HTMLElement>('matches'),
  detail: $<HTMLElement>('detail'),
  version: $<HTMLSpanElement>('version'),
  badge: $<HTMLSpanElement>('update-badge'),
  key: $<HTMLInputElement>('key'),
  remember: $<HTMLInputElement>('remember'),
  unlock: $<HTMLButtonElement>('unlock'),
  forget: $<HTMLButtonElement>('forget'),
  keyState: $<HTMLSpanElement>('key-state'),
  keyMessage: $<HTMLParagraphElement>('key-message'),
};

let records: TFRRecord[] = [];
let selectedID: string | null = null;
let stations: MetarStation[] = [];
let weatherNote = '';
let loading = false;
/** Guards against a slow weather response for a TFR the user has moved on from
 *  landing in the pane for the one now selected. */
let weatherToken = 0;

// MARK: rendering

function matching(): TFRRecord[] {
  const q = els.query.value.trim().toUpperCase();
  if (q.length === 0) return records;
  return records.filter((r) => searchText(r).includes(q));
}

function render(): void {
  renderMatches();
  renderDetail();
}

function renderMatches(): void {
  const list = matching();
  els.matches.replaceChildren();
  if (records.length === 0) return;

  const heading = document.createElement('p');
  heading.className = 'status';
  heading.textContent = `${list.length} match${list.length === 1 ? '' : 'es'}`;
  els.matches.append(heading);

  for (const r of list) {
    const row = document.createElement('button');
    row.className = 'match';
    row.type = 'button';
    row.setAttribute('aria-current', String(r.item.notamID === selectedID));

    const active = activeNow(r);
    const dot = document.createElement('span');
    dot.className = `dot ${active === true ? 'active' : active === false ? 'inactive' : ''}`;
    dot.title =
      active === true ? 'Active now' : active === false ? 'Not currently in effect' : 'Times unparsed';

    const id = document.createElement('span');
    id.className = 'notam';
    id.textContent = r.item.notamID;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.fireName ?? (isFire(r) ? 'fire TFR' : r.item.type);

    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = r.place;

    row.append(dot, id, name, place);
    row.addEventListener('click', () => select(r.item.notamID));
    els.matches.append(row);
  }
}

function renderDetail(): void {
  const r = records.find((x) => x.item.notamID === selectedID);
  els.detail.replaceChildren();
  els.detail.hidden = !r;
  if (!r) return;

  const head = document.createElement('div');
  head.className = 'detail-head';
  const h2 = document.createElement('h2');
  h2.textContent = r.fireName ?? r.item.notamID;
  const place = document.createElement('span');
  place.className = 'place';
  place.textContent = r.place;
  const copyAll = document.createElement('button');
  copyAll.className = 'primary';
  copyAll.textContent = 'Copy all';
  copyAll.addEventListener('click', () => {
    void copy(copyAllText(r, stations), copyAll, 'Copy all');
  });
  head.append(h2, place, copyAll);

  const fields = document.createElement('div');
  fields.className = 'fields';
  for (const [label, value] of formFields(r, stations)) {
    const l = document.createElement('div');
    l.className = 'f-label';
    l.textContent = label;

    const v = document.createElement('div');
    v.className = 'f-value';
    v.textContent = value;

    const b = document.createElement('button');
    b.className = 'copy';
    b.textContent = 'Copy';
    b.title = `Copy ${label}`;
    // The bare value, not "label: value" — the label would only have to be
    // deleted again after pasting into the PDF field.
    b.addEventListener('click', () => void copy(value, b, 'Copy'));

    fields.append(l, v, b);
  }

  els.detail.append(head, fields);

  if (weatherNote.length > 0) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = weatherNote;
    els.detail.append(note);
  }

  if (stations.length > 1) {
    const sub = document.createElement('p');
    sub.className = 'subhead';
    sub.textContent = 'Other nearby airports';
    const box = document.createElement('div');
    box.className = 'stations';
    for (const s of stations.slice(1)) {
      const line = document.createElement('div');
      line.className = 'station';
      const text = document.createElement('span');
      const alt =
        s.altimeterInHg !== null
          ? `${s.altimeterInHg.toFixed(2)} inHg @ ${obsTimeZ(s)}`
          : 'no altimeter';
      text.textContent = `${s.icaoId}  ${s.name}  ${s.distanceNM.toFixed(1)} NM  ${alt}`;
      const b = document.createElement('button');
      b.className = 'copy';
      b.textContent = 'Copy';
      b.addEventListener('click', () => void copy(`${s.icaoId} / ${s.name}`, b, 'Copy'));
      line.append(text, b);
      box.append(line);
    }
    els.detail.append(sub, box);
  }

  const sub = document.createElement('p');
  sub.className = 'subhead';
  sub.textContent = 'NOTAM text';
  const notamCopy = document.createElement('button');
  notamCopy.className = 'copy';
  notamCopy.textContent = 'Copy';
  notamCopy.addEventListener('click', () => void copy(r.notamText, notamCopy, 'Copy'));
  sub.append(' ', notamCopy);

  const pre = document.createElement('pre');
  pre.className = 'notam-text';
  pre.textContent = r.notamText;

  els.detail.append(sub, pre);
}

async function copy(text: string, button: HTMLButtonElement, label: string): Promise<void> {
  await window.hbtool.copy(text);
  button.textContent = 'Copied';
  button.classList.add('done');
  setTimeout(() => {
    button.textContent = label;
    button.classList.remove('done');
  }, 1400);
}

// MARK: actions

function select(id: string): void {
  selectedID = id;
  stations = [];
  weatherNote = '';
  render();
  void loadWeather();
}

async function loadWeather(): Promise<void> {
  const r = records.find((x) => x.item.notamID === selectedID);
  if (!r) return;
  if (r.centerLat === null || r.centerLon === null) {
    weatherNote = 'No center point — cannot find nearby airports.';
    renderDetail();
    return;
  }
  const token = ++weatherToken;
  weatherNote = 'Fetching altimeter from nearby airports…';
  renderDetail();

  const res = await window.hbtool.fetchWeather(r.centerLat, r.centerLon);
  if (token !== weatherToken) return;

  if (!res.ok) {
    weatherNote = `Weather fetch failed: ${res.error}`;
  } else {
    stations = res.stations;
    weatherNote = res.stations.length === 0 ? 'No reporting airports within ~270 NM.' : '';
  }
  renderDetail();
}

async function load(refresh: boolean): Promise<void> {
  if (loading) return;
  loading = true;
  els.search.disabled = true;
  els.refresh.disabled = true;
  els.problem.hidden = true;
  els.status.textContent = 'Fetching current TFR list…';

  const res = await window.hbtool.fetchTFRs(refresh);

  if (!res.ok) {
    els.status.textContent = '';
    els.problem.textContent = res.error;
    els.problem.hidden = false;
  } else {
    records = res.records;
    const fires = records.filter(isFire).length;
    els.status.textContent = `${records.length} hazard TFRs current (${fires} fire-related)`;
    if (res.failures.length > 0) {
      els.problem.textContent =
        `Could not fetch details for: ${res.failures.join(', ')} — these are NOT shown. ` +
        'Retry or check tfr.faa.gov before assuming no TFR.';
      els.problem.hidden = false;
    }
    const list = matching();
    if (list.length === 1) {
      selectedID = list[0].item.notamID;
      stations = [];
      void loadWeather();
    } else if (selectedID && !records.some((r) => r.item.notamID === selectedID)) {
      selectedID = null;
    }
  }

  loading = false;
  els.search.disabled = false;
  els.refresh.disabled = false;
  render();
}

// MARK: secrets panel

function showSecrets(s: SecretsStatus): void {
  if (s.bundleMissing) {
    els.keyState.textContent = '— none shipped in this build';
    els.unlock.disabled = true;
    return;
  }
  els.keyState.textContent = s.unlocked
    ? `— unlocked (key ${s.fingerprint})`
    : '— locked';
  els.remember.disabled = !s.canRemember;
  if (!s.canRemember) {
    els.keyMessage.textContent =
      'This computer has no usable credential store, so the key must be entered each launch.';
  }
}

// MARK: update badge

function showUpdate(s: UpdateState): void {
  const show = (text: string, onClick: () => void) => {
    els.badge.textContent = text;
    els.badge.hidden = false;
    els.badge.onclick = onClick;
  };
  switch (s.status) {
    case 'downloaded':
      show(`Restart to update to ${s.version ?? 'the new version'}`, () => {
        void window.hbtool.installUpdate();
      });
      break;
    case 'available':
      show(`Downloading ${s.version ?? 'update'}…`, () => {});
      break;
    case 'manual':
      show('Update available — download', () => {
        void window.hbtool.openReleases();
      });
      break;
    default:
      els.badge.hidden = true;
  }
}

// MARK: wiring

els.search.addEventListener('click', () => void load(false));
els.refresh.addEventListener('click', () => void load(true));
els.query.addEventListener('input', render);
els.query.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void load(false);
});

els.unlock.addEventListener('click', async () => {
  const res = await window.hbtool.unlock(els.key.value, els.remember.checked);
  els.keyMessage.textContent = res.ok ? 'Unlocked.' : (res.error ?? 'Could not unlock.');
  if (res.ok) els.key.value = '';
  showSecrets(res.status);
});

els.forget.addEventListener('click', async () => {
  showSecrets(await window.hbtool.forgetKey());
  els.keyMessage.textContent = 'Key forgotten on this computer.';
});

window.hbtool.onSecretsChanged(showSecrets);
window.hbtool.onUpdateChanged(showUpdate);

void (async () => {
  const info = await window.hbtool.appInfo();
  els.version.textContent = `v${info.version}`;
  if (info.platform === 'win32') document.body.classList.add('win');
  showSecrets(await window.hbtool.secretsStatus());
  showUpdate(await window.hbtool.updateState());
  // Auto-fetch on launch: the tool has exactly one job, and it needs the list
  // to do it.
  void load(false);
})();
