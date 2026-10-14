import { dominantColor, type RGB } from '../shared/colors';
import { clampBox, fitWithin, padBox, type Tile } from '../shared/geometry';
import type { ImageSource, PixelBox, ViewportRect } from '../shared/types';
import { TranslateError } from './errors';

let nextRuleId = 1000;

/** urlFilter has no escaping; skip the referer rule for URLs containing its special characters. */
function canUseUrlFilter(url: string): boolean {
  return !/[|^*]/.test(url) && url.length < 2000;
}

/**
 * Fetch an image the way the page would: with cookies and the page as Referer, so
 * hotlink-protected manga CDNs still serve it. The Referer header cannot be set from
 * fetch() directly, so a temporary declarativeNetRequest session rule adds it to our own
 * request only.
 */
async function fetchImage(url: string, pageUrl?: string): Promise<Blob> {
  let ruleId: number | null = null;
  if (pageUrl && /^https?:/.test(url) && canUseUrlFilter(url)) {
    ruleId = nextRuleId++;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id: ruleId,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              requestHeaders: [
                { header: 'referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: pageUrl },
              ],
            },
            condition: {
              urlFilter: `|${url}|`,
              initiatorDomains: [chrome.runtime.id],
              resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
            },
          },
        ],
      });
    } catch (err) {
      console.warn('[Manga Translator] could not add referer rule', err);
      ruleId = null;
    }
  }
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!res.ok) throw new TranslateError('image', `Could not download the image (HTTP ${res.status}).`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') && blob.type !== 'application/octet-stream' && blob.type !== '') {
      throw new TranslateError('image', `The link is not an image (${blob.type}).`);
    }
    return blob;
  } catch (err) {
    if (err instanceof TranslateError) throw err;
    throw new TranslateError('image', `Could not download the image: ${(err as Error).message}`);
  } finally {
    if (ruleId !== null) {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
    }
  }
}

export async function loadImageBlob(source: ImageSource): Promise<Blob> {
  if (source.kind === 'dataUrl') {
    return (await fetch(source.dataUrl)).blob();
  }
  return fetchImage(source.url, source.pageUrl);
}

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch {
    throw new TranslateError('image', 'The image format could not be decoded.');
  }
}

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface EncodedTile {
  base64: string;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
}

/** Crop one tile out of the page and downscale it to at most maxEdge on its long side. */
export async function encodeTile(bitmap: ImageBitmap, tile: Tile, maxEdge: number): Promise<EncodedTile> {
  const { w, h } = fitWithin(tile.w, tile.h, maxEdge);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, tile.x, tile.y, tile.w, tile.h, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return {
    base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
    mediaType: 'image/jpeg',
    width: w,
    height: h,
  };
}

/** Returns a function that samples the dominant (paper) colour around a box. */
export function backgroundSampler(bitmap: ImageBitmap): (box: PixelBox) => RGB {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return (box) => {
    const w0 = box.x1 - box.x0;
    const h0 = box.y1 - box.y0;
    const b = clampBox(padBox(box, w0 * 0.1, h0 * 0.1), bitmap.width, bitmap.height);
    const sw = Math.max(1, Math.round(b.x1 - b.x0));
    const sh = Math.max(1, Math.round(b.y1 - b.y0));
    // Nearest-neighbour downsampling keeps real pixel colours instead of blending strokes in.
    const { w, h } = fitWithin(sw, sh, 160);
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bitmap, b.x0, b.y0, sw, sh, 0, 0, w, h);
    return dominantColor(ctx.getImageData(0, 0, w, h).data);
  };
}

/** Crop a region (CSS px of the viewport) out of a captureVisibleTab screenshot. */
export async function cropScreenshot(screenshotDataUrl: string, rect: ViewportRect, viewportW: number): Promise<Blob> {
  const shot = await decodeImage(await (await fetch(screenshotDataUrl)).blob());
  // Derive the CSS px → screenshot px ratio from the capture itself (covers zoom and DPR).
  const dpr = viewportW > 0 ? shot.width / viewportW : 1;
  const sx = Math.round(Math.max(0, rect.x * dpr));
  const sy = Math.round(Math.max(0, rect.y * dpr));
  const sw = Math.round(Math.min(shot.width - sx, rect.w * dpr));
  const sh = Math.round(Math.min(shot.height - sy, rect.h * dpr));
  if (sw < 8 || sh < 8) throw new TranslateError('image', 'The selected area is empty or off-screen.');
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d')!.drawImage(shot, sx, sy, sw, sh, 0, 0, sw, sh);
  shot.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return `data:${blob.type || 'image/png'};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}
