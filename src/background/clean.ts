import { dominantColor, type RGB } from '../shared/colors';
import { clampBox, padBox, toRect } from '../shared/geometry';
import { inpaint, rectMask } from '../shared/inpaint';
import type { CleanPatch, PixelBox } from '../shared/types';
import { blobToDataUrl } from './image';

export interface CleanResult {
  /** 'plain': flat background, a solid fill is enough. 'patch': inpainted artwork. */
  mode: 'plain' | 'patch';
  patch?: CleanPatch;
  /** Colour of the original lettering. */
  ink: RGB;
  /** Share of the text box that matches the background colour (1 = perfectly flat). */
  uniformity: number;
}

const MAX_REGION_PIXELS = 1_500_000;
const dist2 = (d: Uint8ClampedArray, i: number, c: RGB) =>
  (d[i] - c.r) ** 2 + (d[i + 1] - c.g) ** 2 + (d[i + 2] - c.b) ** 2;

/**
 * Step 3 of the workflow, image cleaning: remove the original lettering of one block.
 * Lettering on a flat background (ordinary balloons) only needs a solid fill, which the
 * renderer paints. Lettering over artwork is inpainted from the surrounding pixels.
 */
export async function cleanBlock(bitmap: ImageBitmap, text: PixelBox, force: boolean): Promise<CleanResult> {
  const tw = text.x1 - text.x0;
  const th = text.y1 - text.y0;
  const ring = Math.max(6, Math.min(tw, th) * 0.3);
  const r = clampBox(padBox(text, ring), bitmap.width, bitmap.height);
  const x0 = Math.floor(r.x0);
  const y0 = Math.floor(r.y0);
  const w = Math.max(1, Math.ceil(r.x1) - x0);
  const h = Math.max(1, Math.ceil(r.y1) - y0);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, x0, y0, w, h, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // Pixels of the tight text box, relative to the region.
  const tx0 = Math.max(0, Math.floor(text.x0 - x0));
  const ty0 = Math.max(0, Math.floor(text.y0 - y0));
  const tx1 = Math.min(w, Math.ceil(text.x1 - x0));
  const ty1 = Math.min(h, Math.ceil(text.y1 - y0));
  const inner: number[] = [];
  for (let y = ty0; y < ty1; y++) for (let x = tx0; x < tx1; x++) inner.push((y * w + x) * 4);
  const sample = new Uint8ClampedArray(inner.length * 4);
  inner.forEach((p, k) => sample.set(d.subarray(p, p + 4), k * 4));
  const bg = dominantColor(sample);
  const near = inner.filter((p) => dist2(d, p, bg) < 48 * 48).length;
  const uniformity = inner.length ? near / inner.length : 1;

  const inkPixels = inner.filter((p) => dist2(d, p, bg) > 90 * 90);
  const inkSample = new Uint8ClampedArray(inkPixels.length * 4);
  inkPixels.forEach((p, k) => inkSample.set(d.subarray(p, p + 4), k * 4));
  const ink = inkPixels.length ? dominantColor(inkSample) : { r: 17, g: 17, b: 17 };

  if ((!force && uniformity >= 0.55) || w * h > MAX_REGION_PIXELS) return { mode: 'plain', ink, uniformity };

  // Model boxes tend to hug the lettering a little too tightly; grow the mask so stroke
  // edges and antialiasing are cleaned too.
  inpaint(d, w, h, rectMask(w, h, tx0, ty0, tx1, ty1, Math.max(2, Math.min(tw, th) * 0.06)));
  ctx.putImageData(img, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  return {
    mode: 'patch',
    ink,
    uniformity,
    patch: { rect: toRect({ x0, y0, x1: x0 + w, y1: y0 + h }, bitmap.width, bitmap.height), image: await blobToDataUrl(blob) },
  };
}
