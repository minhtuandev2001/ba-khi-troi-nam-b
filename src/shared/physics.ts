import { clamp, segmentCircle, segmentRect, type Rect } from './geometry';
import { chestRect, type GameMap } from './map';

export type Collider =
  | { type: 'circle'; kind: 'tree' | 'rock'; id: number; x: number; y: number; r: number }
  | { type: 'rect'; kind: 'wall' | 'door' | 'chest'; id: number; x: number; y: number; w: number; h: number };

const CELL = 200;

export interface RayHit {
  t: number;
  collider: Collider;
}

/**
 * Static obstacle index shared by the server simulation and client prediction.
 * Doors and chests are toggled through `doorOpen` / `chestAlive`.
 */
export class CollisionWorld {
  readonly doorOpen: boolean[];
  readonly chestAlive: boolean[];
  private readonly cols: number;
  private readonly cells: Collider[][];
  private stamp = 0;
  private readonly marks = new Map<Collider, number>();

  constructor(readonly map: GameMap) {
    this.cols = Math.ceil(map.size / CELL);
    this.cells = Array.from({ length: this.cols * this.cols }, () => []);
    this.doorOpen = map.doors.map(() => false);
    this.chestAlive = map.chests.map(() => true);
    for (const t of map.trees) this.insert({ type: 'circle', kind: 'tree', id: t.id, x: t.x, y: t.y, r: t.r });
    for (const r of map.rocks) this.insert({ type: 'circle', kind: 'rock', id: r.id, x: r.x, y: r.y, r: r.r });
    for (const w of map.walls) this.insert({ type: 'rect', kind: 'wall', id: w.id, x: w.x, y: w.y, w: w.w, h: w.h });
    for (const d of map.doors) this.insert({ type: 'rect', kind: 'door', id: d.id, x: d.x, y: d.y, w: d.w, h: d.h });
    for (const c of map.chests) this.insert({ type: 'rect', kind: 'chest', id: c.id, ...chestRect(c) });
  }

  private insert(c: Collider) {
    const b = bounds(c);
    this.forCells(b.x, b.y, b.x + b.w, b.y + b.h, (cell) => cell.push(c));
  }

  private forCells(x0: number, y0: number, x1: number, y1: number, fn: (cell: Collider[]) => void) {
    const c0 = clamp(Math.floor(x0 / CELL), 0, this.cols - 1);
    const c1 = clamp(Math.floor(x1 / CELL), 0, this.cols - 1);
    const r0 = clamp(Math.floor(y0 / CELL), 0, this.cols - 1);
    const r1 = clamp(Math.floor(y1 / CELL), 0, this.cols - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(this.cells[r * this.cols + c]);
  }

  isActive(c: Collider): boolean {
    if (c.kind === 'door') return !this.doorOpen[c.id];
    if (c.kind === 'chest') return this.chestAlive[c.id];
    return true;
  }

  query(x0: number, y0: number, x1: number, y1: number): Collider[] {
    const out: Collider[] = [];
    const stamp = ++this.stamp;
    this.forCells(x0, y0, x1, y1, (cell) => {
      for (const c of cell) {
        if (this.marks.get(c) === stamp || !this.isActive(c)) continue;
        this.marks.set(c, stamp);
        out.push(c);
      }
    });
    return out;
  }

  overlapsCircle(x: number, y: number, r: number): boolean {
    for (const c of this.query(x - r, y - r, x + r, y + r)) {
      if (c.type === 'circle') {
        if (Math.hypot(x - c.x, y - c.y) < r + c.r) return true;
      } else {
        const px = clamp(x, c.x, c.x + c.w);
        const py = clamp(y, c.y, c.y + c.h);
        if ((x - px) ** 2 + (y - py) ** 2 < r * r) return true;
      }
    }
    return false;
  }

  /** Moves a circle by (dx, dy), sliding along obstacles. */
  moveCircle(x: number, y: number, dx: number, dy: number, r: number): { x: number; y: number } {
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(len / (r * 0.5)));
    const sx = dx / steps;
    const sy = dy / steps;
    for (let i = 0; i < steps; i++) {
      x += sx;
      y += sy;
      for (let iter = 0; iter < 2; iter++) {
        const pushed = this.resolve(x, y, r);
        x = pushed.x;
        y = pushed.y;
      }
    }
    return { x: clamp(x, r, this.map.size - r), y: clamp(y, r, this.map.size - r) };
  }

  private resolve(x: number, y: number, r: number): { x: number; y: number } {
    for (const c of this.query(x - r, y - r, x + r, y + r)) {
      if (c.type === 'circle') {
        const dx = x - c.x;
        const dy = y - c.y;
        const d = Math.hypot(dx, dy);
        const min = r + c.r;
        if (d < min) {
          if (d < 1e-6) {
            x += min;
          } else {
            x = c.x + (dx / d) * min;
            y = c.y + (dy / d) * min;
          }
        }
      } else {
        const px = clamp(x, c.x, c.x + c.w);
        const py = clamp(y, c.y, c.y + c.h);
        const dx = x - px;
        const dy = y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          x = px + (dx / d) * r;
          y = py + (dy / d) * r;
        } else {
          const left = x - c.x;
          const right = c.x + c.w - x;
          const top = y - c.y;
          const bottom = c.y + c.h - y;
          const m = Math.min(left, right, top, bottom);
          if (m === left) x = c.x - r;
          else if (m === right) x = c.x + c.w + r;
          else if (m === top) y = c.y - r;
          else y = c.y + c.h + r;
        }
      }
    }
    return { x, y };
  }

  /** First obstacle hit along the segment. */
  raycast(x1: number, y1: number, x2: number, y2: number, ignoreChests = false): RayHit | null {
    let best: RayHit | null = null;
    const cands = this.query(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2));
    for (const c of cands) {
      if (ignoreChests && c.kind === 'chest') continue;
      const t = c.type === 'circle' ? segmentCircle(x1, y1, x2, y2, c.x, c.y, c.r) : segmentRect(x1, y1, x2, y2, c);
      if (t >= 0 && (!best || t < best.t)) best = { t, collider: c };
    }
    return best;
  }

  /** True when no active obstacle (wall, closed door, chest, tree, rock) lies between the two points. */
  lineClear(x1: number, y1: number, x2: number, y2: number): boolean {
    return !this.raycast(x1, y1, x2, y2);
  }
}

function bounds(c: Collider): Rect {
  if (c.type === 'circle') return { x: c.x - c.r, y: c.y - c.r, w: c.r * 2, h: c.r * 2 };
  return c;
}
