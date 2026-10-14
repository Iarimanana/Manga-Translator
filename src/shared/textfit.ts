/**
 * Text wrapping and font-size fitting shared by the on-page overlay and the image exporter.
 * Measurement is injected so the same code runs with canvas measureText in the browser and
 * with a fake measurer in unit tests.
 */

/** Font size at which `MeasureFn` reports widths. Widths scale linearly with the size. */
export const BASE_FONT_SIZE = 100;

/** Width of `text` in px when rendered at BASE_FONT_SIZE. */
export type MeasureFn = (text: string) => number;

export interface FitOptions {
  minSize: number;
  maxSize: number;
  lineHeight: number;
  /** Re-break lines so they are evenly long (the way letterers shape text in a balloon). */
  balance?: boolean;
}

export interface FitResult {
  fontSize: number;
  lines: string[];
  /** True when the text could not fit even at minSize; lines may then exceed the box. */
  overflow: boolean;
}

interface Token {
  text: string;
  /** Whether a space separates this token from the previous one on the same line. */
  space: boolean;
}

// Scripts written without spaces between words: break between any two characters.
const NO_SPACE_SCRIPT =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ฀-๿຀-໿က-႟ក-៿]/;
// Punctuation that must not start a line (kinsoku) — glue it to the previous token.
const NO_LINE_START = /^[、。，．・：；？！ー…‥」』）】〉》〕｝〙〗”’,.!?:;)\]}~～]+/;

export function tokenize(paragraph: string): Token[] {
  const tokens: Token[] = [];
  for (const [i, word] of paragraph.split(/\s+/).filter(Boolean).entries()) {
    if (!NO_SPACE_SCRIPT.test(word)) {
      tokens.push({ text: word, space: i > 0 });
      continue;
    }
    let first = true;
    for (const ch of Array.from(word)) {
      const prev = tokens[tokens.length - 1];
      if (!first && prev && NO_LINE_START.test(ch)) {
        prev.text += ch;
      } else {
        tokens.push({ text: ch, space: first && i > 0 });
      }
      first = false;
    }
  }
  return tokens;
}

export function makeCachedMeasure(measure: MeasureFn): MeasureFn {
  const cache = new Map<string, number>();
  return (text: string) => {
    let w = cache.get(text);
    if (w === undefined) {
      w = measure(text);
      cache.set(text, w);
    }
    return w;
  };
}

/** Split a token that is wider than the line into character runs that fit. */
function breakToken(token: string, maxWidth: number, width: (s: string) => number): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const ch of Array.from(token)) {
    if (cur && width(cur + ch) > maxWidth) {
      parts.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * Greedy line wrapping at `fontSize`. Returns null when `breakWords` is false and some
 * single word is wider than `maxWidth`.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  measure: MeasureFn,
  breakWords = false,
): string[] | null {
  const width = (s: string) => (measure(s) * fontSize) / BASE_FONT_SIZE;
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const tok of tokenize(paragraph)) {
      const candidate = line ? line + (tok.space ? ' ' : '') + tok.text : tok.text;
      if (width(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (width(tok.text) <= maxWidth) {
        line = tok.text;
      } else if (breakWords) {
        const parts = breakToken(tok.text, maxWidth, width);
        lines.push(...parts.slice(0, -1));
        line = parts[parts.length - 1] ?? '';
      } else {
        return null;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Largest font size (in 0.5px steps) at which `text` wraps inside boxW × boxH. */
export function fitText(text: string, boxW: number, boxH: number, measure: MeasureFn, opts: FitOptions): FitResult {
  const minSize = Math.max(1, opts.minSize);
  const maxSize = Math.max(minSize, opts.maxSize);
  const fits = (size: number): string[] | null => {
    const lines = wrapText(text, boxW, size, measure);
    if (!lines) return null;
    return lines.length * size * opts.lineHeight <= boxH ? lines : null;
  };

  let lo = Math.round(minSize * 2);
  let hi = Math.round(maxSize * 2);
  let best: { size: number; lines: string[] } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const lines = fits(mid / 2);
    if (lines) {
      best = { size: mid / 2, lines };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) {
    const lines = opts.balance ? balanceLines(text, best.lines.length, boxW, best.size, measure) : best.lines;
    return { fontSize: best.size, lines, overflow: false };
  }

  const lines = wrapText(text, boxW, minSize, measure, true) ?? [text];
  return { fontSize: minSize, lines, overflow: true };
}

/**
 * Narrowest wrap that still needs no more than `maxLines` lines, so a 3-line balloon reads
 * "WAIT, YOU / CAN READ / THIS NOW?!" instead of "WAIT, YOU CAN READ / THIS NOW?! / ..." .
 */
export function balanceLines(
  text: string,
  maxLines: number,
  maxWidth: number,
  fontSize: number,
  measure: MeasureFn,
): string[] {
  const full = wrapText(text, maxWidth, fontSize, measure) ?? [text];
  if (full.length <= 1 || maxLines <= 1) return full;
  let lo = 1;
  let hi = Math.ceil(maxWidth);
  let best = full;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const lines = wrapText(text, mid, fontSize, measure);
    if (lines && lines.length <= maxLines) {
      best = lines;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return best;
}
