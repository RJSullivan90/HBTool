//
// mapCanvas.ts — the shared map viewport: fit, zoom, pan, and click-to-world.
//
// IT DRAWS IN UTM METRES. The caller supplies the projected bounds and the zone,
// because the caller owns the geometry those came from — one zone per view, the
// same rule as `assemble`.
//
// Only the scaffolding is shared. Each tool draws its own content through the
// `draw` callback, because a perimeter (ring selection, A/B markers, a
// simplification ghost) and a flight path have nothing in common at the drawing
// level, and fusing them would need a pile of flags nobody could follow.
//

import type { Bounds, Metres } from '../shared/proj.ts';

export type MapTransform = {
  /** Projected metres → canvas pixels. */
  place(p: Metres): { x: number; y: number };
  /** Canvas pixels → projected metres. */
  unplace(x: number, y: number): Metres;
  /** Metres per CSS pixel at the current zoom — for scale bars and tolerances. */
  metresPerPixel: number;
  width: number;
  height: number;
};

export type DrawFn = (ctx: CanvasRenderingContext2D, t: MapTransform) => void;

export class MapCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bounds: Bounds | null = null;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private draw: DrawFn = () => {};
  private onClick: ((world: Metres) => void) | null = null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private movedWhileDown = 0;
  private frame: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.movedWhileDown = 0;
      this.lastX = e.offsetX;
      this.lastY = e.offsetY;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.offsetX - this.lastX;
      const dy = e.offsetY - this.lastY;
      this.movedWhileDown += Math.abs(dx) + Math.abs(dy);
      this.panX += dx;
      this.panY += dy;
      this.lastX = e.offsetX;
      this.lastY = e.offsetY;
      this.render();
    });

    canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      canvas.releasePointerCapture(e.pointerId);
      // A drag is not a click. Without this, panning the map would also move an
      // A/B marker to wherever the pointer came to rest.
      if (this.movedWhileDown < 4 && this.onClick && this.bounds) {
        this.onClick(this.transform().unplace(e.offsetX, e.offsetY));
      }
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Zoom anchored on the cursor: whatever is under it stays under it.
        // screen = centre + (world - worldCentre)·scale + pan, so holding a point
        // fixed while scale changes by k gives pan' = d + (pan - d)·k, with d the
        // anchor's offset from the canvas centre.
        const k = Math.exp(-e.deltaY / 400);
        const next = Math.max(0.2, Math.min(4000, this.zoom * k));
        const applied = next / this.zoom;
        const dx = e.offsetX - this.canvas.clientWidth / 2;
        const dy = e.offsetY - this.canvas.clientHeight / 2;
        this.panX = dx + (this.panX - dx) * applied;
        this.panY = dy + (this.panY - dy) * applied;
        this.zoom = next;
        this.render();
      },
      { passive: false },
    );

    new ResizeObserver(() => this.render()).observe(canvas);
  }

  setDraw(fn: DrawFn): void {
    this.draw = fn;
  }

  setOnClick(fn: ((world: Metres) => void) | null): void {
    this.onClick = fn;
  }

  /** Frame new geometry, resetting zoom and pan. */
  fit(bounds: Bounds | null): void {
    this.bounds = bounds;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.render();
  }

  zoomBy(factor: number): void {
    this.zoom = Math.max(0.2, Math.min(4000, this.zoom * factor));
    this.render();
  }

  reset(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.render();
  }

  get currentZoom(): number {
    return this.zoom;
  }

  transform(): MapTransform {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const b = this.bounds;
    if (!b) {
      return {
        place: () => ({ x: 0, y: 0 }),
        unplace: () => ({ x: 0, y: 0 }),
        metresPerPixel: 1,
        width: w,
        height: h,
      };
    }
    const spanX = Math.max(1e-6, b.maxX - b.minX);
    const spanY = Math.max(1e-6, b.maxY - b.minY);
    // 0.92 leaves a margin so a perimeter never touches the frame edge.
    const base = Math.min(w / spanX, h / spanY) * 0.92;
    const scale = base * this.zoom;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const panX = this.panX;
    const panY = this.panY;
    return {
      // y is negated: metres go up, canvas pixels go down.
      place: (p) => ({
        x: w / 2 + (p.x - cx) * scale + panX,
        y: h / 2 - (p.y - cy) * scale + panY,
      }),
      unplace: (x, y) => ({
        x: (x - panX - w / 2) / scale + cx,
        y: -(y - panY - h / 2) / scale + cy,
      }),
      metresPerPixel: 1 / scale,
      width: w,
      height: h,
    };
  }

  /** Coalesces to one paint per frame — pointermove fires far faster than 60 Hz. */
  render(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.paint();
    });
  }

  private paint(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.bounds) return;
    this.draw(ctx, this.transform());
    this.drawScaleBar(ctx, this.transform());
  }

  /** A scale bar, because a view in metres with no reference is unreadable. */
  private drawScaleBar(ctx: CanvasRenderingContext2D, t: MapTransform): void {
    const targetPx = 110;
    const rawMetres = targetPx * t.metresPerPixel;
    // Snap to a 1/2/5 × 10^n figure so the label is a round number.
    const pow = Math.pow(10, Math.floor(Math.log10(rawMetres)));
    const nice = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= rawMetres) ?? 10 * pow;
    const px = nice / t.metresPerPixel;
    const label = nice >= 1000 ? `${(nice / 1000).toFixed(nice % 1000 === 0 ? 0 : 1)} km` : `${nice} m`;

    const x = 12;
    const y = t.height - 16;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.moveTo(x + px, y - 4);
    ctx.lineTo(x + px, y + 4);
    ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(label, x, y - 8);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(label, x, y - 8);
    ctx.restore();
  }
}

/**
 * A dark casing under a light core, so a line stays readable over any ground —
 * imagery, a pale basemap, or nothing. `Color.primary` alone disappears into
 * forest, which is exactly where these lines get drawn.
 */
export function strokePath(
  ctx: CanvasRenderingContext2D,
  build: (c: CanvasRenderingContext2D) => void,
  colour: string,
  width: number,
): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  build(ctx);
  ctx.lineWidth = width + 2.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = colour;
  ctx.stroke();
  ctx.restore();
}
