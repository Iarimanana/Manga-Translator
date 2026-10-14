import { describe, expect, it } from 'vitest';
import { assembleBlocks, finalizeBlocks } from '../../src/shared/assemble';
import { planTiles } from '../../src/shared/geometry';
import type { ModelBlock } from '../../src/shared/schema';

const block = (
  t: [number, number, number, number],
  b: [number, number, number, number],
  translation = 'Hello',
  original = 'こんにちは',
): ModelBlock => ({
  kind: 'speech',
  text_box: { x_min: t[0], y_min: t[1], x_max: t[2], y_max: t[3] },
  bubble_box: { x_min: b[0], y_min: b[1], x_max: b[2], y_max: b[3] },
  original,
  translation,
});

describe('assembleBlocks', () => {
  it('maps a single downscaled page back to image pixels and unions the bubble with the text', () => {
    const [tile] = planTiles(2000, 3000);
    const raw = assembleBlocks([
      // Model saw 1000×1500; bubble box is wrongly smaller than the text box.
      { tile, sentW: 1000, sentH: 1500, blocks: [block([100, 100, 200, 300], [120, 120, 180, 280])] },
    ]);
    expect(raw).toHaveLength(1);
    expect(raw[0].text).toEqual({ x0: 200, y0: 200, x1: 400, y1: 600 });
    expect(raw[0].bubble).toEqual({ x0: 200, y0: 200, x1: 400, y1: 600 });
  });

  it('skips empty translations and boxes outside the image', () => {
    const [tile] = planTiles(1000, 1000);
    const raw = assembleBlocks([
      {
        tile,
        sentW: 1000,
        sentH: 1000,
        blocks: [block([10, 10, 50, 50], [0, 0, 60, 60], '   '), block([2000, 10, 2100, 50], [0, 0, 60, 60])],
      },
    ]);
    expect(raw).toEqual([]);
  });

  it('keeps each balloon once when slices overlap', () => {
    const tiles = planTiles(800, 4000);
    expect(tiles.length).toBeGreaterThan(1);
    const [t0, t1] = tiles;
    // A balloon in the overlap of tile 0 and tile 1, reported by both.
    const overlapMidY = (t1.y + t0.y + t0.h) / 2;
    const yTop = Math.round(overlapMidY - 40);
    const inT0 = [100, yTop - t0.y, 300, yTop - t0.y + 60] as [number, number, number, number];
    const inT1 = [100, yTop - t1.y, 300, yTop - t1.y + 60] as [number, number, number, number];
    const raw = assembleBlocks([
      { tile: t0, sentW: t0.w, sentH: t0.h, blocks: [block(inT0, inT0, 'Overlap')] },
      { tile: t1, sentW: t1.w, sentH: t1.h, blocks: [block(inT1, inT1, 'Overlap')] },
    ]);
    expect(raw.map((r) => r.translation)).toEqual(['Overlap']);
  });
});

describe('finalizeBlocks', () => {
  it('normalises rects and picks contrasting colours', () => {
    const out = finalizeBlocks(
      [
        {
          text: { x0: 100, y0: 200, x1: 300, y1: 400 },
          bubble: { x0: 50, y0: 150, x1: 350, y1: 450 },
          original: 'あ',
          translation: 'Ah',
          kind: 'narration',
        },
      ],
      1000,
      1000,
      () => ({ r: 10, g: 10, b: 10 }),
    );
    expect(out[0].textRect).toEqual({ x: 0.1, y: 0.2, w: 0.2, h: 0.2 });
    expect(out[0].bubbleRect).toEqual({ x: 0.05, y: 0.15, w: 0.3, h: 0.3 });
    expect(out[0].bg).toBe('#000000');
    expect(out[0].fg).toBe('#ffffff');
  });
});
