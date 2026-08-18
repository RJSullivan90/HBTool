//
// tfrReport.ts — the TFR Report tool.
//
// Imports the SAME formatting functions the tests exercise, so what is on screen,
// what "Copy all" puts on the clipboard, and what the test suite asserts cannot
// drift apart. No network and no secrets here: every fetch is an IPC call.
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
import './api.ts';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

export class TfrReportTool {
  private records: TFRRecord[] = [];
  private selectedID: string | null = null;
  private stations: MetarStation[] = [];
  private weatherNote = '';
  private loading = false;
  /** Guards against a slow weather response for a TFR the user has moved on from
   *  landing in the pane for the one now selected. */
  private weatherToken = 0;
  private started = false;

  private query: HTMLInputElement;
  private searchBtn: HTMLButtonElement;
  private refreshBtn: HTMLButtonElement;
  private status: HTMLElement;
  private problem: HTMLElement;
  private matchesEl: HTMLElement;
  private detailEl: HTMLElement;

  constructor(root: HTMLElement) {
    const searchRow = el('div', 'search');
    this.query = el('input') as HTMLInputElement;
    this.query.type = 'search';
    this.query.placeholder = 'Fire name, NOTAM number, or place — blank lists all';
    this.query.autocomplete = 'off';
    this.searchBtn = el('button', 'primary', 'Search TFRs') as HTMLButtonElement;
    this.refreshBtn = el('button', 'ghost', 'Refresh') as HTMLButtonElement;
    this.refreshBtn.title = 'Discard the cache and refetch every current TFR';
    searchRow.append(this.query, this.searchBtn, this.refreshBtn);

    this.status = el('p', 'status');
    this.problem = el('p', 'problem');
    this.problem.hidden = true;
    this.matchesEl = el('section', 'matches');
    this.detailEl = el('section', 'detail');
    this.detailEl.hidden = true;

    root.append(searchRow, this.status, this.problem, this.matchesEl, this.detailEl);

    this.searchBtn.addEventListener('click', () => void this.load(false));
    this.refreshBtn.addEventListener('click', () => void this.load(true));
    this.query.addEventListener('input', () => this.render());
    this.query.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.load(false);
    });
  }

  /** Fetch on first visit only — the tool has one job and needs the list to do
   *  it, but a second visit should not refetch what is already on screen. */
  activate(): void {
    if (this.started) return;
    this.started = true;
    void this.load(false);
  }

  private matching(): TFRRecord[] {
    const q = this.query.value.trim().toUpperCase();
    if (q.length === 0) return this.records;
    return this.records.filter((r) => searchText(r).includes(q));
  }

  private render(): void {
    this.renderMatches();
    this.renderDetail();
  }

  private renderMatches(): void {
    const list = this.matching();
    this.matchesEl.replaceChildren();
    if (this.records.length === 0) return;

    const heading = el('p', 'status', `${list.length} match${list.length === 1 ? '' : 'es'}`);
    this.matchesEl.append(heading);

    for (const r of list) {
      const row = el('button', 'match');
      row.type = 'button';
      row.setAttribute('aria-current', String(r.item.notamID === this.selectedID));

      const active = activeNow(r);
      const dot = el('span', `dot ${active === true ? 'active' : active === false ? 'inactive' : ''}`);
      dot.title =
        active === true
          ? 'Active now'
          : active === false
            ? 'Not currently in effect'
            : 'Times unparsed';

      row.append(
        dot,
        el('span', 'notam', r.item.notamID),
        el('span', 'name', r.fireName ?? (isFire(r) ? 'fire TFR' : r.item.type)),
        el('span', 'place', r.place),
      );
      row.addEventListener('click', () => this.select(r.item.notamID));
      this.matchesEl.append(row);
    }
  }

  private renderDetail(): void {
    const r = this.records.find((x) => x.item.notamID === this.selectedID);
    this.detailEl.replaceChildren();
    this.detailEl.hidden = !r;
    if (!r) return;

    const head = el('div', 'detail-head');
    const copyAll = el('button', 'primary', 'Copy all');
    copyAll.addEventListener('click', () => {
      void this.copy(copyAllText(r, this.stations), copyAll as HTMLButtonElement, 'Copy all');
    });
    head.append(el('h2', undefined, r.fireName ?? r.item.notamID), el('span', 'place', r.place), copyAll);

    const fields = el('div', 'fields');
    for (const [label, value] of formFields(r, this.stations)) {
      const b = el('button', 'copy', 'Copy');
      b.title = `Copy ${label}`;
      // The bare value, not "label: value" — the label would only have to be
      // deleted again after pasting into the PDF field.
      b.addEventListener('click', () => void this.copy(value, b as HTMLButtonElement, 'Copy'));
      fields.append(el('div', 'f-label', label), el('div', 'f-value', value), b);
    }
    this.detailEl.append(head, fields);

    if (this.weatherNote.length > 0) {
      this.detailEl.append(el('p', 'muted', this.weatherNote));
    }

    if (this.stations.length > 1) {
      const box = el('div', 'stations');
      for (const s of this.stations.slice(1)) {
        const line = el('div', 'station');
        const alt =
          s.altimeterInHg !== null
            ? `${s.altimeterInHg.toFixed(2)} inHg @ ${obsTimeZ(s)}`
            : 'no altimeter';
        const b = el('button', 'copy', 'Copy');
        b.addEventListener('click', () =>
          void this.copy(`${s.icaoId} / ${s.name}`, b as HTMLButtonElement, 'Copy'),
        );
        line.append(
          el('span', undefined, `${s.icaoId}  ${s.name}  ${s.distanceNM.toFixed(1)} NM  ${alt}`),
          b,
        );
        box.append(line);
      }
      this.detailEl.append(el('p', 'subhead', 'Other nearby airports'), box);
    }

    const sub = el('p', 'subhead', 'NOTAM text');
    const notamCopy = el('button', 'copy', 'Copy');
    notamCopy.addEventListener('click', () =>
      void this.copy(r.notamText, notamCopy as HTMLButtonElement, 'Copy'),
    );
    sub.append(' ', notamCopy);
    const pre = el('pre', 'notam-text', r.notamText);
    this.detailEl.append(sub, pre);
  }

  private async copy(text: string, button: HTMLButtonElement, label: string): Promise<void> {
    await window.hbtool.copy(text);
    button.textContent = 'Copied';
    button.classList.add('done');
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove('done');
    }, 1400);
  }

  private select(id: string): void {
    this.selectedID = id;
    this.stations = [];
    this.weatherNote = '';
    this.render();
    void this.loadWeather();
  }

  private async loadWeather(): Promise<void> {
    const r = this.records.find((x) => x.item.notamID === this.selectedID);
    if (!r) return;
    if (r.centerLat === null || r.centerLon === null) {
      this.weatherNote = 'No center point — cannot find nearby airports.';
      this.renderDetail();
      return;
    }
    const token = ++this.weatherToken;
    this.weatherNote = 'Fetching altimeter from nearby airports…';
    this.renderDetail();

    const res = await window.hbtool.fetchWeather(r.centerLat, r.centerLon);
    if (token !== this.weatherToken) return;

    if (!res.ok) {
      this.weatherNote = `Weather fetch failed: ${res.error}`;
    } else {
      this.stations = res.stations;
      this.weatherNote = res.stations.length === 0 ? 'No reporting airports within ~270 NM.' : '';
    }
    this.renderDetail();
  }

  private async load(refresh: boolean): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.searchBtn.disabled = true;
    this.refreshBtn.disabled = true;
    this.problem.hidden = true;
    this.status.textContent = 'Fetching current TFR list…';

    const res = await window.hbtool.fetchTFRs(refresh);

    if (!res.ok) {
      this.status.textContent = '';
      this.problem.textContent = res.error;
      this.problem.hidden = false;
    } else {
      this.records = res.records;
      const fires = this.records.filter(isFire).length;
      this.status.textContent = `${this.records.length} hazard TFRs current (${fires} fire-related)`;
      if (res.failures.length > 0) {
        this.problem.textContent =
          `Could not fetch details for: ${res.failures.join(', ')} — these are NOT shown. ` +
          'Retry or check tfr.faa.gov before assuming no TFR.';
        this.problem.hidden = false;
      }
      const list = this.matching();
      if (list.length === 1) {
        this.selectedID = list[0].item.notamID;
        this.stations = [];
        void this.loadWeather();
      } else if (this.selectedID && !this.records.some((r) => r.item.notamID === this.selectedID)) {
        this.selectedID = null;
      }
    }

    this.loading = false;
    this.searchBtn.disabled = false;
    this.refreshBtn.disabled = false;
    this.render();
  }
}
