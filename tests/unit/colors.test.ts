import { describe, expect, it } from 'vitest';
import { contrastText, dominantColor, snapPaper, toHex } from '../../src/shared/colors';

function pixels(colors: [number, number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(colors.flat());
}

describe('dominantColor', () => {
  it('finds the paper colour behind black lettering', () => {
    const data = pixels([
      ...Array(70).fill([252, 252, 250, 255]),
      ...Array(30).fill([10, 10, 10, 255]),
    ]);
    expect(toHex(dominantColor(data))).toBe('#fcfcfa');
  });

  it('finds a dark narration box behind white text and ignores transparent pixels', () => {
    const data = pixels([
      ...Array(40).fill([20, 22, 30, 255]),
      ...Array(20).fill([255, 255, 255, 255]),
      ...Array(80).fill([255, 0, 0, 0]),
    ]);
    expect(toHex(dominantColor(data))).toBe('#14161e');
  });

  it('defaults to white for empty input', () => {
    expect(dominantColor(new Uint8ClampedArray())).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe('contrastText / snapPaper', () => {
  it('picks dark text on light paper and white text on dark boxes', () => {
    expect(contrastText({ r: 250, g: 250, b: 250 })).toEqual({ r: 17, g: 17, b: 17 });
    expect(contrastText({ r: 20, g: 20, b: 40 })).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('snaps near-white paper to white and keeps tinted boxes', () => {
    expect(snapPaper({ r: 248, g: 249, b: 247 })).toEqual({ r: 255, g: 255, b: 255 });
    expect(snapPaper({ r: 200, g: 220, b: 255 })).toEqual({ r: 200, g: 220, b: 255 });
  });
});
