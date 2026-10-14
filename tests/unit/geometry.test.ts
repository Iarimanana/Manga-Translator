import { describe, expect, it } from 'vitest';
import {
  dedupeBoxes,
  fitWithin,
  iou,
  planTiles,
  sanitizeBox,
  tileToImage,
  toPixelBox,
  toRect,
} from '../../src/shared/geometry';

describe('planTiles', () => {
  it('keeps a normal page whole', () => {
    expect(planTiles(1000, 1500)).toEqual([{ x: 0, y: 0, w: 1000, h: 1500, coreY0: 0, coreY1: 1500 }]);
  });

  it('returns nothing for empty images', () => {
    expect(planTiles(0, 100)).toEqual([]);
  });

  it('slices a long webtoon strip into overlapping tiles whose cores partition the strip', () => {
    const W = 800;
    const H = 12000;
    const tiles = planTiles(W, H);
    expect(tiles.length).toBeGreaterThan(5);
    expect(tiles[0].y).toBe(0);
    expect(tiles[tiles.length - 1].y + tiles[tiles.length - 1].h).toBe(H);
    for (const t of tiles) {
      expect(t.h).toBe(1200);
      expect(t.w).toBe(W);
      expect(t.coreY0).toBeGreaterThanOrEqual(t.y);
      expect(t.coreY1).toBeLessThanOrEqual(t.y + t.h);
    }
    expect(tiles[0].coreY0).toBe(0);
    expect(tiles[tiles.length - 1].coreY1).toBe(H);
    for (let i = 1; i < tiles.length; i++) {
      // Cores are contiguous and tiles overlap by at least the planned 15%.
      expect(tiles[i].coreY0).toBe(tiles[i - 1].coreY1);
      expect(tiles[i - 1].y + tiles[i - 1].h - tiles[i].y).toBeGreaterThanOrEqual(Math.round(1200 * 0.15) - 1);
    }
  });
});

describe('fitWithin', () => {
  it('downscales to the max edge and never upscales', () => {
    expect(fitWithin(4000, 2000, 2000)).toEqual({ w: 2000, h: 1000, scale: 0.5 });
    expect(fitWithin(800, 600, 2000)).toEqual({ w: 800, h: 600, scale: 1 });
  });
});

describe('sanitizeBox', () => {
  it('orders swapped edges and clamps to the image', () => {
    expect(sanitizeBox({ x0: 120, y0: -5, x1: 20, y1: 60 }, 100, 50)).toEqual({ x0: 20, y0: 0, x1: 100, y1: 50 });
  });

  it('rejects degenerate and non-finite boxes', () => {
    expect(sanitizeBox({ x0: 10, y0: 10, x1: 11, y1: 40 }, 100, 100)).toBeNull();
    expect(sanitizeBox({ x0: NaN, y0: 10, x1: 20, y1: 40 }, 100, 100)).toBeNull();
    expect(sanitizeBox({ x0: 200, y0: 10, x1: 300, y1: 40 }, 100, 100)).toBeNull();
  });
});

describe('coordinate mapping', () => {
  it('maps from a downscaled tile back to full-image pixels', () => {
    const tile = { x: 0, y: 1000, w: 800, h: 1200, coreY0: 1100, coreY1: 2100 };
    // Model saw the tile at half size.
    expect(tileToImage({ x0: 10, y0: 20, x1: 110, y1: 70 }, tile, 400, 600)).toEqual({
      x0: 20,
      y0: 1040,
      x1: 220,
      y1: 1140,
    });
  });

  it('round-trips between pixel boxes and normalised rects', () => {
    const b = { x0: 50, y0: 100, x1: 150, y1: 300 };
    const r = toRect(b, 500, 1000);
    expect(r).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const back = toPixelBox(r, 500, 1000);
    for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(back[k]).toBeCloseTo(b[k], 9);
  });
});

describe('dedupeBoxes', () => {
  it('drops a box mostly covered by an earlier one and keeps order', () => {
    const items = [
      { id: 'a', text: { x0: 0, y0: 0, x1: 100, y1: 100 } },
      { id: 'b', text: { x0: 200, y0: 0, x1: 300, y1: 100 } },
      { id: 'a-dup', text: { x0: 5, y0: 5, x1: 95, y1: 98 } },
    ];
    expect(dedupeBoxes(items).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('iou is symmetric and 0 for disjoint boxes', () => {
    const a = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const b = { x0: 5, y0: 0, x1: 15, y1: 10 };
    expect(iou(a, b)).toBeCloseTo(1 / 3);
    expect(iou(b, a)).toBeCloseTo(1 / 3);
    expect(iou(a, { x0: 20, y0: 20, x1: 30, y1: 30 })).toBe(0);
  });
});
