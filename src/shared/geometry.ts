import type { PixelBox, Rect } from './types';

/** A horizontal slice of a (possibly very tall) page that is sent to the model on its own. */
export interface Tile {
  /** Source rectangle in full-image pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Vertical band (full-image pixels) this tile is responsible for. Blocks whose centre
   * falls outside the band are dropped because a neighbouring tile owns them.
   */
  coreY0: number;
  coreY1: number;
}

export interface TileOptions {
  /** Pages taller than width × maxAspect are sliced. */
  maxAspect: number;
  /** Height of each slice as a multiple of the image width. */
  sliceAspect: number;
  /** Fraction of a slice shared with the next slice. */
  overlap: number;
}

export const DEFAULT_TILE_OPTIONS: TileOptions = { maxAspect: 2.2, sliceAspect: 1.5, overlap: 0.15 };

/**
 * Split long-strip (webtoon) images into overlapping slices so text stays legible after
 * downscaling. Normal pages produce a single tile.
 */
export function planTiles(width: number, height: number, opts: TileOptions = DEFAULT_TILE_OPTIONS): Tile[] {
  if (width <= 0 || height <= 0) return [];
  if (height <= width * opts.maxAspect) {
    return [{ x: 0, y: 0, w: width, h: height, coreY0: 0, coreY1: height }];
  }
  const tileH = Math.round(width * opts.sliceAspect);
  const minOverlap = Math.round(tileH * opts.overlap);
  const n = Math.ceil((height - tileH) / (tileH - minOverlap)) + 1;
  const step = (height - tileH) / (n - 1);
  const ys = Array.from({ length: n }, (_, k) => Math.round(k * step));
  return ys.map((y, k) => {
    const coreY0 = k === 0 ? 0 : Math.round((y + ys[k - 1] + tileH) / 2);
    const coreY1 = k === n - 1 ? height : Math.round((y + tileH + ys[k + 1]) / 2);
    return { x: 0, y, w: width, h: tileH, coreY0, coreY1 };
  });
}

/** Scale (w, h) down so the longest edge is at most maxEdge. Never upscales. */
export function fitWithin(w: number, h: number, maxEdge: number): { w: number; h: number; scale: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

/** Normalise a box the model produced: order the edges and clamp into [0, maxW] × [0, maxH]. */
export function sanitizeBox(b: PixelBox, maxW: number, maxH: number): PixelBox | null {
  const vals = [b.x0, b.y0, b.x1, b.y1];
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const clampX = (v: number) => Math.min(maxW, Math.max(0, v));
  const clampY = (v: number) => Math.min(maxH, Math.max(0, v));
  const x0 = clampX(Math.min(b.x0, b.x1));
  const x1 = clampX(Math.max(b.x0, b.x1));
  const y0 = clampY(Math.min(b.y0, b.y1));
  const y1 = clampY(Math.max(b.y0, b.y1));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x0, y0, x1, y1 };
}

/** Map a box from the downscaled tile the model saw back into full-image pixels. */
export function tileToImage(b: PixelBox, tile: Tile, sentW: number, sentH: number): PixelBox {
  const sx = tile.w / sentW;
  const sy = tile.h / sentH;
  return {
    x0: tile.x + b.x0 * sx,
    y0: tile.y + b.y0 * sy,
    x1: tile.x + b.x1 * sx,
    y1: tile.y + b.y1 * sy,
  };
}

export function unionBox(a: PixelBox, b: PixelBox): PixelBox {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function boxArea(b: PixelBox): number {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

export function intersectBox(a: PixelBox, b: PixelBox): PixelBox | null {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}

export function iou(a: PixelBox, b: PixelBox): number {
  const i = intersectBox(a, b);
  if (!i) return 0;
  const inter = boxArea(i);
  return inter / (boxArea(a) + boxArea(b) - inter);
}

/** Fraction of the smaller box covered by the other one. */
export function overlapOfSmaller(a: PixelBox, b: PixelBox): number {
  const i = intersectBox(a, b);
  if (!i) return 0;
  return boxArea(i) / Math.min(boxArea(a), boxArea(b));
}

export function centerY(b: PixelBox): number {
  return (b.y0 + b.y1) / 2;
}

export function toRect(b: PixelBox, imgW: number, imgH: number): Rect {
  return { x: b.x0 / imgW, y: b.y0 / imgH, w: (b.x1 - b.x0) / imgW, h: (b.y1 - b.y0) / imgH };
}

export function toPixelBox(r: Rect, imgW: number, imgH: number): PixelBox {
  return { x0: r.x * imgW, y0: r.y * imgH, x1: (r.x + r.w) * imgW, y1: (r.y + r.h) * imgH };
}

export function padBox(b: PixelBox, px: number, py: number = px): PixelBox {
  return { x0: b.x0 - px, y0: b.y0 - py, x1: b.x1 + px, y1: b.y1 + py };
}

/** Shrink a box around its centre to `f` of its width and height. */
export function scaleBox(b: PixelBox, fx: number, fy: number = fx): PixelBox {
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const hw = ((b.x1 - b.x0) * fx) / 2;
  const hh = ((b.y1 - b.y0) * fy) / 2;
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}

export function clampBox(b: PixelBox, maxW: number, maxH: number): PixelBox {
  return {
    x0: Math.max(0, b.x0),
    y0: Math.max(0, b.y0),
    x1: Math.min(maxW, b.x1),
    y1: Math.min(maxH, b.y1),
  };
}

/**
 * Remove duplicates that appear when the same balloon is reported twice (overlapping
 * slices, or the model splitting and re-listing a balloon). Keeps the first occurrence,
 * which preserves reading order.
 */
export function dedupeBoxes<T extends { text: PixelBox }>(items: T[], threshold = 0.6): T[] {
  const kept: T[] = [];
  for (const item of items) {
    if (!kept.some((k) => overlapOfSmaller(k.text, item.text) >= threshold)) kept.push(item);
  }
  return kept;
}
