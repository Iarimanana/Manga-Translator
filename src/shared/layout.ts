import { clampBox, padBox, scaleBox, toPixelBox, unionBox } from './geometry';
import { fitText, type MeasureFn } from './textfit';
import type { PixelBox, TranslatedBlock } from './types';

export const LINE_HEIGHT = 1.12;

export interface LayoutOptions {
  fontScale: number;
}

export interface BlockLayout {
  /** Patch rectangle in display pixels (covers the original lettering). */
  box: PixelBox;
  fontSize: number;
  lines: string[];
  padding: number;
  radius: number;
  lineHeight: number;
}

/** Part of the balloon box that is safe to paint over without spilling outside an oval balloon. */
function safeInterior(block: TranslatedBlock, bubble: PixelBox): PixelBox {
  switch (block.kind) {
    case 'speech':
    case 'thought':
      return scaleBox(bubble, 0.78, 0.8);
    case 'narration':
      return scaleBox(bubble, 0.94, 0.92);
    default:
      return scaleBox(bubble, 0.98, 0.98);
  }
}

/**
 * Compute where and how large to draw one translated block on an image displayed at
 * dispW × dispH pixels.
 */
export function layoutBlock(
  block: TranslatedBlock,
  dispW: number,
  dispH: number,
  measure: MeasureFn,
  opts: LayoutOptions,
): BlockLayout {
  const text = toPixelBox(block.textRect, dispW, dispH);
  const bubble = toPixelBox(block.bubbleRect, dispW, dispH);
  const pad = Math.max(2, dispW * 0.004);
  let box = clampBox(unionBox(padBox(text, pad), safeInterior(block, bubble)), dispW, dispH);

  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const padding = Math.max(1, Math.min(w, h) * 0.07);
  const innerW = Math.max(1, w - 2 * padding);
  const innerH = Math.max(1, h - 2 * padding);

  const scale = opts.fontScale || 1;
  const maxSize = Math.max(6, Math.min(dispW * 0.045 * scale, innerH));
  const minSize = Math.max(5, Math.min(maxSize, dispW * 0.009 * scale));
  const fit = fitText(block.translation, innerW, innerH, measure, { minSize, maxSize, lineHeight: LINE_HEIGHT });

  if (fit.overflow) {
    // Grow the patch vertically (within the image) so overflowing text is still covered.
    const needH = fit.lines.length * fit.fontSize * LINE_HEIGHT + 2 * padding;
    if (needH > h) {
      const cy = (box.y0 + box.y1) / 2;
      box = clampBox({ x0: box.x0, y0: cy - needH / 2, x1: box.x1, y1: cy + needH / 2 }, dispW, dispH);
    }
  }

  const minSide = Math.min(box.x1 - box.x0, box.y1 - box.y0);
  const radius =
    block.kind === 'speech' || block.kind === 'thought' ? minSide * 0.35 : block.kind === 'narration' ? 2 : 4;

  return { box, fontSize: fit.fontSize, lines: fit.lines, padding, radius, lineHeight: LINE_HEIGHT };
}
