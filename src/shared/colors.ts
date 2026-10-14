export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function toHex({ r, g, b }: RGB): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Relative luminance (WCAG). */
export function luminance({ r, g, b }: RGB): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Find the most common colour in an RGBA buffer. Inside a speech balloon the paper colour
 * covers far more pixels than the thin lettering strokes, so this recovers the balloon
 * background (white, a tinted narration box, a black flashback panel, ...).
 */
export function dominantColor(data: Uint8ClampedArray | Uint8Array, step = 1): RGB {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const stride = 4 * Math.max(1, Math.floor(step));
  for (let i = 0; i + 3 < data.length; i += stride) {
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key);
    if (bin) {
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
    } else {
      bins.set(key, { n: 1, r, g, b });
    }
  }
  let best: { n: number; r: number; g: number; b: number } | undefined;
  for (const bin of bins.values()) if (!best || bin.n > best.n) best = bin;
  if (!best) return { r: 255, g: 255, b: 255 };
  return { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
}

/** Black or white, whichever reads better on the given background. */
export function contrastText(bg: RGB): RGB {
  const l = luminance(bg);
  // Contrast against black is (l + 0.05) / 0.05, against white 1.05 / (l + 0.05).
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? { r: 17, g: 17, b: 17 } : { r: 255, g: 255, b: 255 };
}

/**
 * Screentone and gradients sometimes make the dominant bin a mid grey; snap near-white
 * and near-black backgrounds to pure values so the patch blends with the paper.
 */
export function snapPaper(c: RGB): RGB {
  const l = luminance(c);
  if (l > 0.9) return { r: 255, g: 255, b: 255 };
  if (l < 0.02) return { r: 0, g: 0, b: 0 };
  return c;
}
