//
// firePerimeter.ts — the Fire Perimeter Tool.
//
// Source → view → Simplify → Measure & clip, in one pane with no export /
// re-import step between stages: switching to Measure already measures the
// SIMPLIFIED geometry, because that is what simplifiedRings materialises.
//
// TWO PERFORMANCE RULES CARRIED OVER FROM THE SWIFT APP:
//
//  * The simplify → measure chain is MEMOISED. It used to be recomputed inside
//    the render path, which meant every redraw re-ran it; a 54,333-vertex
//    perimeter then pinned a core for 30-50 seconds with nothing having changed.
//    Invalidate by key, never by comparing geometry — comparing would cost
//    exactly what the cache saves.
//  * A/B are GEOGRAPHIC anchors. Moving the slider rebuilds the vertex list, so
//    indices would silently point elsewhere; they re-snap by lon/lat.
//

import {
  documentFromPolygons,
  type GeoDocument,
  type LonLat,
  vertexCount,
} from '../shared/geometry.ts';
import { lonLatBounds, projectedBounds, utmForward, type Bounds, type Metres } from '../shared/proj.ts';
import {
  ACCURACY_LIMIT_M,
  areaDeltaHectares,
  areaHectares,
  removedPercent,
  simplifiedKML,
  simplifiedRings,
  simplifyPlan,
  simplifyStats,
  type SimplifyMode,
  type SimplifyStats,
} from '../shared/simplify.ts';
import {
  formatMetres,
  longestRing,
  measuredRings,
  sectionLineKML,
  type EdgePoint,
  type MeasuredRing,
} from '../shared/measure.ts';
import {
  fireKML,
  kmlFileName,
  trackDateCompact,
  type FirePerimeter,
  type FireSourceId,
  FIRE_SOURCES,
} from '../shared/fires.ts';
import { MapCanvas, strokePath } from './mapCanvas.ts';
import './api.ts';

type Stage = 'view' | 'simplify' | 'measure';

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

export class FirePerimeterTool {
  private root: HTMLElement;
  private map: MapCanvas;

  private source: FireSourceId = 'BC';
  private fires: FirePerimeter[] = [];
  private selected: FirePerimeter | null = null;
  private loading = false;
  private status = '';
  private problem = '';

  private stage: Stage = 'view';
  private mode: SimplifyMode = 'tolerance';
  private percent = 50;
  private tolerance = 10;

  /** Geographic anchors, never indices. */
  private anchorA: LonLat | null = null;
  private anchorB: LonLat | null = null;
  private direction: 'forward' | 'reverse' = 'forward';

  /** Memoised simplify → measure chain. Key, not geometry comparison. */
  private cacheKey = '';
  private cache: {
    doc: GeoDocument;
    kept: number[][][][];
    stats: SimplifyStats;
    ring: MeasuredRing | null;
    bounds: Bounds | null;
  } | null = null;

  private els: {
    sources: HTMLElement;
    load: HTMLButtonElement;
    search: HTMLInputElement;
    status: HTMLElement;
    problem: HTMLElement;
    list: HTMLElement;
    canvas: HTMLCanvasElement;
    stageBar: HTMLElement;
    controls: HTMLElement;
    readout: HTMLElement;
    exports: HTMLElement;
  };

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('fp');

    const sourceRow = el('div', 'fp-row');
    const sources = el('div', 'chips');
    const load = el('button', 'primary', 'Load perimeters');
    sourceRow.append(sources, load);

    const searchRow = el('div', 'fp-row');
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Filter by fire number or name';
    searchRow.append(search);

    const status = el('p', 'status');
    const problem = el('p', 'problem');
    problem.hidden = true;
    const list = el('div', 'fp-list');

    const canvas = el('canvas', 'fp-canvas');
    const stageBar = el('div', 'chips');
    const controls = el('div', 'fp-controls');
    const readout = el('div', 'fp-readout');
    const exports = el('div', 'fp-row');

    root.append(sourceRow, searchRow, status, problem, list, stageBar, canvas, controls, readout, exports);

    this.els = {
      sources,
      load: load as HTMLButtonElement,
      search: search as HTMLInputElement,
      status,
      problem,
      list,
      canvas: canvas as HTMLCanvasElement,
      stageBar,
      controls,
      readout,
      exports,
    };

    this.map = new MapCanvas(this.els.canvas);
    this.map.setDraw((ctx, t) => this.paint(ctx, t));

    this.els.load.addEventListener('click', () => void this.load());
    this.els.search.addEventListener('input', () => this.renderList());

    this.renderSources();
    this.renderStageBar();
    this.renderControls();
    this.renderReadout();
    this.renderExports();
  }

  // MARK: chrome

  private renderSources(): void {
    this.els.sources.replaceChildren();
    for (const s of FIRE_SOURCES) {
      const b = el('button', `chip${this.source === s.id ? ' on' : ''}`, s.id);
      b.title = s.note;
      b.addEventListener('click', () => {
        this.source = s.id;
        this.fires = [];
        this.select(null);
        this.status = '';
        this.renderSources();
        this.renderList();
        this.renderStatus();
      });
      this.els.sources.append(b);
    }
  }

  private renderStageBar(): void {
    this.els.stageBar.replaceChildren();
    const stages: Array<[Stage, string]> = [
      ['view', 'View'],
      ['simplify', 'Simplify'],
      ['measure', 'Measure & clip'],
    ];
    for (const [id, label] of stages) {
      const b = el('button', `chip${this.stage === id ? ' on' : ''}`, label);
      b.disabled = !this.selected;
      b.addEventListener('click', () => {
        this.stage = id;
        // Measure clicks set A/B; the other stages must not.
        this.map.setOnClick(id === 'measure' ? (w) => this.clickMeasure(w) : null);
        this.renderStageBar();
        this.renderControls();
        this.renderReadout();
        this.renderExports();
        this.map.render();
      });
      this.els.stageBar.append(b);
    }
  }

  private renderStatus(): void {
    this.els.status.textContent = this.status;
    this.els.problem.textContent = this.problem;
    this.els.problem.hidden = this.problem.length === 0;
  }

  private renderList(): void {
    const q = this.els.search.value.trim().toUpperCase();
    const matches = this.fires.filter(
      (f) => q.length === 0 || `${f.fireNumber} ${f.detail} ${f.status}`.toUpperCase().includes(q),
    );
    this.els.list.replaceChildren();
    for (const f of matches.slice(0, 400)) {
      const row = el('button', `fp-item${this.selected === f ? ' on' : ''}`);
      row.append(
        el('span', 'name', f.fireNumber),
        el('span', 'place', `${f.sizeHa.toLocaleString()} ha`),
        el('span', 'place', f.status),
        el('span', 'notam', f.trackDate),
        el('span', 'place', f.polygons.length > 1 ? `${f.polygons.length} parts` : ''),
      );
      row.addEventListener('click', () => this.select(f));
      this.els.list.append(row);
    }
    if (this.fires.length > matches.length) {
      this.els.list.append(
        el('p', 'muted', `${matches.length} of ${this.fires.length} shown`),
      );
    }
  }

  // MARK: data

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.problem = '';
    this.status = `Loading ${this.source} perimeters…`;
    this.els.load.disabled = true;
    this.renderStatus();

    const res = await window.hbtool.fetchFires(this.source);
    if (!res.ok) {
      this.problem = res.error;
      this.status = '';
      this.fires = [];
    } else {
      this.fires = res.fires;
      const multi = this.fires.filter((f) => f.polygons.length > 1).length;
      this.status =
        `${this.fires.length} perimeters — ${multi} multi-part. ` +
        FIRE_SOURCES.find((s) => s.id === this.source)!.note;
    }
    this.loading = false;
    this.els.load.disabled = false;
    this.renderStatus();
    this.renderList();
  }

  private select(fire: FirePerimeter | null): void {
    this.selected = fire;
    this.anchorA = null;
    this.anchorB = null;
    this.cacheKey = '';
    this.cache = null;
    if (!fire) {
      this.map.fit(null);
    } else {
      const c = this.chain();
      this.map.fit(c.bounds);
    }
    this.renderList();
    this.renderStageBar();
    this.renderControls();
    this.renderReadout();
    this.renderExports();
  }

  /**
   * The memoised simplify → measure chain. Everything that needs the current
   * geometry goes through here, and it recomputes only when the key changes.
   */
  private chain() {
    const fire = this.selected;
    if (!fire) {
      return { doc: null, kept: null, stats: null, ring: null, bounds: null } as const;
    }
    const key = `${this.source}|${fire.id}|${fire.fireNumber}|${this.mode}|${this.percent}|${this.tolerance}`;
    if (key === this.cacheKey && this.cache) return this.cache;

    const doc = documentFromPolygons(fire.fireNumber, fire.polygons);
    const kept = simplifyPlan(doc, this.mode, this.percent, this.tolerance);
    const stats = simplifyStats(doc, kept);
    const ring = longestRing(measuredRings(simplifiedRings(doc, kept)));
    const b = lonLatBounds(
      doc.features.flatMap((f) => f.parts.flatMap((p) => p.rings.map((r) => r.lonlat))),
    );
    const bounds = b ? projectedBounds(b, doc.zone) : null;

    this.cacheKey = key;
    this.cache = { doc, kept, stats, ring, bounds };
    return this.cache;
  }

  // MARK: controls

  private renderControls(): void {
    this.els.controls.replaceChildren();
    if (!this.selected) {
      this.els.controls.append(
        el('p', 'muted', 'Pick a source, press Load, then choose a fire to view it.'),
      );
      return;
    }

    const zoomRow = el('div', 'fp-row');
    const zin = el('button', 'ghost', '+');
    zin.addEventListener('click', () => this.map.zoomBy(1.4));
    const zout = el('button', 'ghost', '−');
    zout.addEventListener('click', () => this.map.zoomBy(1 / 1.4));
    const zreset = el('button', 'ghost', 'Fit');
    zreset.addEventListener('click', () => this.map.reset());
    zoomRow.append(zin, zout, zreset);
    this.els.controls.append(zoomRow);

    if (this.stage === 'simplify') {
      const modeRow = el('div', 'chips');
      for (const [id, label] of [
        ['tolerance', 'Tolerance in metres'],
        ['percent', '% vertices removed'],
      ] as Array<[SimplifyMode, string]>) {
        const b = el('button', `chip${this.mode === id ? ' on' : ''}`, label);
        b.addEventListener('click', () => {
          this.mode = id;
          this.afterGeometryChange();
        });
        modeRow.append(b);
      }

      const slider = el('input');
      slider.type = 'range';
      if (this.mode === 'tolerance') {
        slider.min = '0';
        slider.max = '100';
        slider.step = '1';
        slider.value = String(this.tolerance);
      } else {
        slider.min = '0';
        slider.max = '99';
        slider.step = '1';
        slider.value = String(this.percent);
      }
      slider.addEventListener('input', () => {
        const v = Number((slider as HTMLInputElement).value);
        if (this.mode === 'tolerance') this.tolerance = v;
        else this.percent = v;
        this.afterGeometryChange();
      });
      const sliderRow = el('div', 'fp-row');
      sliderRow.append(
        slider,
        el(
          'span',
          'notam',
          this.mode === 'tolerance' ? `${this.tolerance} m` : `${this.percent}%`,
        ),
      );
      this.els.controls.append(modeRow, sliderRow);
    }

    if (this.stage === 'measure') {
      const dirRow = el('div', 'chips');
      for (const [id, label] of [
        ['forward', 'A → B'],
        ['reverse', 'B → A'],
      ] as Array<['forward' | 'reverse', string]>) {
        const b = el('button', `chip${this.direction === id ? ' on' : ''}`, label);
        b.addEventListener('click', () => {
          this.direction = id;
          this.renderReadout();
          this.map.render();
        });
        dirRow.append(b);
      }
      const clear = el('button', 'ghost', 'Clear A/B');
      clear.addEventListener('click', () => {
        this.anchorA = null;
        this.anchorB = null;
        this.renderReadout();
        this.map.render();
      });
      dirRow.append(clear);
      this.els.controls.append(
        dirRow,
        el('p', 'muted', 'Click the perimeter to place A, then again to place B.'),
      );
    }
  }

  /** Slider or mode moved: re-anchor A/B geographically, then repaint. */
  private afterGeometryChange(): void {
    this.renderControls();
    this.renderReadout();
    this.map.render();
  }

  private renderReadout(): void {
    this.els.readout.replaceChildren();
    const fire = this.selected;
    if (!fire) return;
    const c = this.chain();
    if (!c.stats || !c.doc) return;

    const line = (label: string, value: string, warn = false) => {
      const row = el('div', 'fp-stat');
      row.append(el('span', 'f-label', label), el('span', warn ? 'f-value warn' : 'f-value', value));
      return row;
    };

    this.els.readout.append(
      line('Fire', `${fire.fireNumber} — ${fire.status}`),
      line('Reported size', `${fire.sizeHa.toLocaleString()} ha (${fire.attribution.split(' (')[0]})`),
      line('Measured area', `${areaHectares(c.stats.areaAfter).toFixed(1)} ha`),
      line('Parts', String(c.stats.parts)),
      line('Vertices', `${c.stats.after.toLocaleString()} of ${c.stats.before.toLocaleString()}`),
    );

    if (this.stage === 'simplify') {
      const dev = c.stats.deviation;
      const past = dev > ACCURACY_LIMIT_M;
      this.els.readout.append(
        line('Removed', `${removedPercent(c.stats).toFixed(1)}%`),
        line(
          'Max deviation',
          `${dev.toFixed(2)} m${past ? `  — past the ${ACCURACY_LIMIT_M} m BCWS limit` : ''}`,
          past,
        ),
        line('Area change', `${areaDeltaHectares(c.stats).toFixed(1)} ha`),
      );
      if (this.mode === 'percent') {
        this.els.readout.append(
          el(
            'p',
            'muted',
            'Percentage mode ranks by triangle area, so it does not bound deviation — ' +
              'trust the measured figure above, not the percentage.',
          ),
        );
      }
    }

    if (this.stage === 'measure' && c.ring) {
      this.els.readout.append(line('Perimeter', formatMetres(c.ring.total)));
      const a = this.edge(c.ring, this.anchorA);
      const b = this.edge(c.ring, this.anchorB);
      if (a && b) {
        const fwd = c.ring.forwardDistance(a, b);
        const rev = c.ring.forwardDistance(b, a);
        this.els.readout.append(
          line('A → B', formatMetres(fwd)),
          line('B → A', formatMetres(rev)),
          line(
            'Selected section',
            formatMetres(this.direction === 'forward' ? fwd : rev),
          ),
        );
      } else {
        this.els.readout.append(
          el('p', 'muted', a ? 'Click again to place B.' : 'Click the perimeter to place A.'),
        );
      }
    }
  }

  private renderExports(): void {
    this.els.exports.replaceChildren();
    const fire = this.selected;
    if (!fire) return;
    const c = this.chain();

    const full = el('button', 'ghost', 'Export perimeter KML');
    full.addEventListener('click', () => {
      void this.save(kmlFileName(fire), fireKML(fire));
    });
    this.els.exports.append(full);

    if (this.stage === 'simplify' && c.doc && c.kept && c.stats) {
      const simp = el('button', 'primary', 'Export simplified KML');
      simp.addEventListener('click', () => {
        const note =
          `${fire.fireNumber} simplified — ${this.mode === 'tolerance' ? `${this.tolerance} m tolerance` : `${this.percent}% removed`}; ` +
          `max deviation ${c.stats!.deviation.toFixed(2)} m; ` +
          `${c.stats!.after} of ${c.stats!.before} vertices. ` +
          `Source: ${fire.attribution}. Reference only, not flight clearance.`;
        void this.save(
          `${fire.fireNumber} perimeter ${trackDateCompact(fire)} simplified.kml`.replace(/\//g, '-'),
          simplifiedKML(fire.fireNumber, c.doc!, c.kept!, note),
        );
      });
      this.els.exports.append(simp);
    }

    if (this.stage === 'measure' && c.ring) {
      const a = this.edge(c.ring, this.anchorA);
      const b = this.edge(c.ring, this.anchorB);
      const sec = el('button', 'primary', 'Export section as KML line');
      sec.disabled = !(a && b);
      sec.addEventListener('click', () => {
        if (!a || !b) return;
        const from = this.direction === 'forward' ? a : b;
        const to = this.direction === 'forward' ? b : a;
        const points = c.ring!.forwardPathLonLat(from, to);
        const length = c.ring!.forwardDistance(from, to);
        const note =
          `${fire.fireNumber} section ${this.direction === 'forward' ? 'A → B' : 'B → A'}, ` +
          `${formatMetres(length)}, ${points.length} vertices. ` +
          `Source: ${fire.attribution}. Reference only, not flight clearance.`;
        void this.save(
          `${fire.fireNumber} section ${trackDateCompact(fire)}.kml`.replace(/\//g, '-'),
          sectionLineKML(`${fire.fireNumber} section`, points, note),
        );
      });
      this.els.exports.append(sec);
    }
  }

  private async save(name: string, contents: string): Promise<void> {
    const res = await window.hbtool.saveKML(name, contents);
    if (res.ok) {
      this.status = `Wrote ${res.path}`;
      this.problem = '';
    } else if (!res.cancelled) {
      this.problem = res.error;
    }
    this.renderStatus();
  }

  // MARK: measure interaction

  private edge(ring: MeasuredRing, anchor: LonLat | null): EdgePoint | null {
    return anchor ? ring.nearestEdgePointLonLat(anchor) : null;
  }

  private clickMeasure(world: Metres): void {
    const c = this.chain();
    if (!c.ring) return;
    const { point } = c.ring.nearestEdgePoint(world);
    const lonlat = c.ring.lonlatPosition(point);
    // Store geographically, so the anchor survives the slider moving.
    if (!this.anchorA || (this.anchorA && this.anchorB)) {
      this.anchorA = lonlat;
      this.anchorB = null;
    } else {
      this.anchorB = lonlat;
    }
    this.renderReadout();
    this.renderExports();
    this.map.render();
  }

  // MARK: drawing

  private paint(ctx: CanvasRenderingContext2D, t: ReturnType<MapCanvas['transform']>): void {
    const c = this.chain();
    if (!c.doc || !c.kept) return;
    const zone = c.doc.zone;
    const toScreen = (p: LonLat) => t.place(utmForward(p[1], p[0], zone));

    // The original geometry as a faint ghost, so simplification is visible as a
    // change rather than just a number.
    if (this.stage === 'simplify') {
      ctx.save();
      ctx.globalAlpha = 0.35;
      for (const f of c.doc.features) {
        for (const part of f.parts) {
          for (const ring of part.rings) {
            strokePath(
              ctx,
              (cc) => {
                ring.lonlat.forEach((p, i) => {
                  const s = toScreen(p);
                  if (i === 0) cc.moveTo(s.x, s.y);
                  else cc.lineTo(s.x, s.y);
                });
              },
              '#9c9391',
              1,
            );
          }
        }
      }
      ctx.restore();
    }

    // The current (possibly simplified) geometry.
    const simplified = simplifiedRings(c.doc, c.kept);
    for (const f of simplified) {
      for (const part of f.parts) {
        part.rings.forEach((ring, ri) => {
          const build = (cc: CanvasRenderingContext2D) => {
            ring.lonlat.forEach((p, i) => {
              const s = toScreen(p);
              if (i === 0) cc.moveTo(s.x, s.y);
              else cc.lineTo(s.x, s.y);
            });
          };
          if (f.isPolygon && ri === 0) {
            ctx.save();
            ctx.beginPath();
            build(ctx);
            ctx.closePath();
            ctx.fillStyle = 'rgba(239,106,94,0.15)';
            ctx.fill();
            ctx.restore();
          }
          strokePath(ctx, build, ri === 0 ? '#ef6a5e' : '#e8a33d', 1.8);
        });
      }
    }

    // The selected arc, then the markers — markers drawn independently so A
    // appears on the first click, before there is any arc to draw.
    if (this.stage === 'measure' && c.ring) {
      const a = this.edge(c.ring, this.anchorA);
      const b = this.edge(c.ring, this.anchorB);
      if (a && b) {
        const from = this.direction === 'forward' ? a : b;
        const to = this.direction === 'forward' ? b : a;
        const path = c.ring.forwardPathLonLat(from, to);
        strokePath(
          ctx,
          (cc) => {
            path.forEach((p, i) => {
              const s = toScreen(p);
              if (i === 0) cc.moveTo(s.x, s.y);
              else cc.lineTo(s.x, s.y);
            });
          },
          '#f1ff66',
          3.4,
        );
      }
      const marker = (p: EdgePoint | null, label: string) => {
        if (!p) return;
        const s = toScreen(c.ring!.lonlatPosition(p));
        ctx.save();
        ctx.beginPath();
        ctx.arc(s.x, s.y, 6, 0, 2 * Math.PI);
        ctx.fillStyle = '#191314';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#f1ff66';
        ctx.stroke();
        ctx.fillStyle = '#f1ff66';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillText(label, s.x + 9, s.y + 4);
        ctx.restore();
      };
      marker(a, 'A');
      marker(b, 'B');
    }
  }

  /** Called when the tool becomes visible, so the canvas sizes correctly. */
  activate(): void {
    this.map.setOnClick(this.stage === 'measure' ? (w) => this.clickMeasure(w) : null);
    this.map.render();
  }
}
