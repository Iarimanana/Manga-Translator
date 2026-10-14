import { describe, expect, it } from 'vitest';
import { BASE_FONT_SIZE, fitText, tokenize, wrapText } from '../../src/shared/textfit';

// Every character is half as wide as the font size.
const measure = (s: string) => s.length * BASE_FONT_SIZE * 0.5;

describe('tokenize', () => {
  it('splits Latin text on spaces', () => {
    expect(tokenize('hello  big world').map((t) => t.text)).toEqual(['hello', 'big', 'world']);
  });

  it('breaks CJK text per character and keeps closing punctuation attached', () => {
    expect(tokenize('本当に。だめ！').map((t) => t.text)).toEqual(['本', '当', 'に。', 'だ', 'め！']);
  });
});

describe('wrapText', () => {
  it('wraps greedily at the given width', () => {
    // At size 10 each char is 5px; 50px fits 10 chars.
    expect(wrapText('the quick brown fox jumps', 50, 10, measure)).toEqual(['the quick', 'brown fox', 'jumps']);
  });

  it('honours explicit line breaks', () => {
    expect(wrapText('one\ntwo', 500, 10, measure)).toEqual(['one', 'two']);
  });

  it('returns null for an unbreakable word unless breaking is allowed', () => {
    expect(wrapText('incomprehensibilities', 50, 10, measure)).toBeNull();
    expect(wrapText('incomprehensibilities', 50, 10, measure, true)).toEqual(['incomprehe', 'nsibilitie', 's']);
  });
});

describe('fitText', () => {
  it('finds the largest size that fits', () => {
    const r = fitText('WAIT FOR ME', 100, 100, measure, { minSize: 4, maxSize: 60, lineHeight: 1 });
    expect(r.overflow).toBe(false);
    // Verify maximality: lines fit, and one step larger does not.
    for (const line of r.lines) expect(measure(line) * (r.fontSize / BASE_FONT_SIZE)).toBeLessThanOrEqual(100);
    expect(r.lines.length * r.fontSize).toBeLessThanOrEqual(100);
    const bigger = fitText('WAIT FOR ME', 100, 100, measure, { minSize: r.fontSize + 0.5, maxSize: 60, lineHeight: 1 });
    expect(bigger.overflow).toBe(true);
  });

  it('respects the maximum size for short text in a big box', () => {
    expect(fitText('Hi', 1000, 1000, measure, { minSize: 4, maxSize: 30, lineHeight: 1.2 }).fontSize).toBe(30);
  });

  it('reports overflow and breaks words when nothing fits', () => {
    const r = fitText('Aaaaaaaaaaaaaaaaaaaargh', 20, 10, measure, { minSize: 6, maxSize: 20, lineHeight: 1.2 });
    expect(r.overflow).toBe(true);
    expect(r.fontSize).toBe(6);
    expect(r.lines.join('')).toBe('Aaaaaaaaaaaaaaaaaaaargh');
  });
});
