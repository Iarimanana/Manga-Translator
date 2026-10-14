import { describe, expect, it } from 'vitest';
import { layoutBlock } from '../../src/shared/layout';
import { BASE_FONT_SIZE } from '../../src/shared/textfit';
import type { TranslatedBlock } from '../../src/shared/types';

const measure = (s: string) => s.length * BASE_FONT_SIZE * 0.55;

const base: TranslatedBlock = {
  textRect: { x: 0.45, y: 0.1, w: 0.05, h: 0.2 }, // narrow vertical Japanese column
  bubbleRect: { x: 0.35, y: 0.08, w: 0.25, h: 0.24 },
  original: '大丈夫か？',
  translation: 'Are you okay?',
  kind: 'speech',
  bg: '#ffffff',
  fg: '#111111',
};

describe('layoutBlock', () => {
  it('widens a narrow vertical column into the balloon and covers the original text', () => {
    const L = layoutBlock(base, 800, 1200, measure, { fontScale: 1 });
    const text = { x0: 0.45 * 800, y0: 0.1 * 1200, x1: 0.5 * 800, y1: 0.3 * 1200 };
    expect(L.box.x0).toBeLessThanOrEqual(text.x0);
    expect(L.box.x1).toBeGreaterThanOrEqual(text.x1);
    expect(L.box.y0).toBeLessThanOrEqual(text.y0);
    expect(L.box.y1).toBeGreaterThanOrEqual(text.y1);
    // Wider than the original column but within the balloon.
    expect(L.box.x1 - L.box.x0).toBeGreaterThan(text.x1 - text.x0 + 50);
    expect(L.box.x0).toBeGreaterThanOrEqual(0.35 * 800 - 1);
    expect(L.box.x1).toBeLessThanOrEqual(0.6 * 800 + 1);
    expect(L.lines.join(' ')).toBe('ARE YOU OKAY?'); // comics are lettered in capitals by default
    expect(L.fontSize).toBeGreaterThan(8);
  });

  it('stays inside the image near the edges', () => {
    const edge = { ...base, textRect: { x: 0.95, y: 0.95, w: 0.05, h: 0.05 }, bubbleRect: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 } };
    const L = layoutBlock(edge, 500, 500, measure, { fontScale: 1 });
    expect(L.box.x1).toBeLessThanOrEqual(500);
    expect(L.box.y1).toBeLessThanOrEqual(500);
    expect(L.box.x0).toBeGreaterThanOrEqual(0);
  });

  it('scales text with the font scale setting when there is room', () => {
    const roomy = { ...base, translation: 'Hm', bubbleRect: { x: 0.2, y: 0.05, w: 0.6, h: 0.4 } };
    const small = layoutBlock(roomy, 800, 1200, measure, { fontScale: 0.6 });
    const big = layoutBlock(roomy, 800, 1200, measure, { fontScale: 1.5 });
    expect(big.fontSize).toBeGreaterThan(small.fontSize);
  });
});
