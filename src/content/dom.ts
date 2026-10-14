/** DOM helpers for finding manga images and measuring where their pixels are drawn. */

export type MangaElement = HTMLImageElement | HTMLCanvasElement;

export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function isMangaElement(el: Element | null): el is MangaElement {
  return el instanceof HTMLImageElement || el instanceof HTMLCanvasElement;
}

/** Current source identity of an element; changes when a reader swaps the page in place. */
export function sourceKey(el: MangaElement): string {
  if (el instanceof HTMLImageElement) return el.currentSrc || el.src || '';
  return `canvas:${el.width}x${el.height}`;
}

/**
 * Whether an element looks like a comic page rather than an icon, avatar or banner.
 * `loose` is used for the hover button, where the user decides explicitly.
 */
export function isCandidate(el: MangaElement, minSize: number, loose = false): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  const min = loose ? Math.min(150, minSize) : minSize;
  if (r.width < min || r.height < min) return false;
  if (el instanceof HTMLImageElement) {
    if (!el.complete || el.naturalWidth === 0) return false;
    if (Math.max(el.naturalWidth, el.naturalHeight) < (loose ? 150 : 300)) return false;
    const src = el.currentSrc || el.src;
    if (!src || /\.svg(\?|#|$)/i.test(src) || src.startsWith('data:image/svg')) return false;
  } else if (el.width < 100 || el.height < 100) {
    return false;
  }
  // Wide banners and ads are rarely comic pages.
  if (!loose && r.width / r.height > 3.2) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
}

export function findCandidates(minSize: number, root: ParentNode = document): MangaElement[] {
  const all = root.querySelectorAll<MangaElement>('img, canvas');
  return Array.from(all).filter((el) => isCandidate(el, minSize));
}

/**
 * Viewport rectangle of the drawn image content — excludes borders and padding and
 * honours object-fit / object-position for <img>.
 */
export function contentRect(el: MangaElement): ViewRect {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  const left = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const top = r.top + px(cs.borderTopWidth) + px(cs.paddingTop);
  const width = Math.max(
    0,
    r.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight),
  );
  const height = Math.max(
    0,
    r.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom),
  );
  if (!(el instanceof HTMLImageElement) || !el.naturalWidth || !el.naturalHeight) {
    return { left, top, width, height };
  }
  const fit = cs.objectFit;
  if (fit === 'fill' || !fit) return { left, top, width, height };
  const nw = el.naturalWidth;
  const nh = el.naturalHeight;
  let scale: number;
  if (fit === 'contain') scale = Math.min(width / nw, height / nh);
  else if (fit === 'cover') scale = Math.max(width / nw, height / nh);
  else if (fit === 'scale-down') scale = Math.min(1, width / nw, height / nh);
  else scale = 1; // none
  const cw = nw * scale;
  const ch = nh * scale;
  const [posX, posY] = parseObjectPosition(cs.objectPosition);
  return { left: left + (width - cw) * posX, top: top + (height - ch) * posY, width: cw, height: ch };
}

function parseObjectPosition(v: string): [number, number] {
  const parts = (v || '50% 50%').split(/\s+/);
  const conv = (p: string | undefined): number => {
    if (!p) return 0.5;
    if (p === 'left' || p === 'top') return 0;
    if (p === 'right' || p === 'bottom') return 1;
    if (p === 'center') return 0.5;
    if (p.endsWith('%')) return parseFloat(p) / 100;
    return 0.5;
  };
  return [conv(parts[0]), conv(parts[1])];
}

/** Ancestors that clip their content (overflow other than visible). */
export function clippingAncestors(el: Element): Element[] {
  const out: Element[] = [];
  for (let p = el.parentElement; p && p !== document.documentElement && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push(p);
    if (cs.position === 'fixed') break;
  }
  return out;
}

/** Visible part of `rect` after clipping by the given ancestors and the element itself. */
export function visibleRect(el: Element, clips: Element[]): ViewRect {
  const r = el.getBoundingClientRect();
  let x0 = r.left;
  let y0 = r.top;
  let x1 = r.right;
  let y1 = r.bottom;
  for (const c of clips) {
    const cr = c.getBoundingClientRect();
    x0 = Math.max(x0, cr.left);
    y0 = Math.max(y0, cr.top);
    x1 = Math.min(x1, cr.right);
    y1 = Math.min(y1, cr.bottom);
  }
  return { left: x0, top: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Topmost manga element under a viewport point, looking through transparent click layers. */
export function mangaElementAt(x: number, y: number, minSize: number): MangaElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.tagName === 'MANGA-TRANSLATOR-ROOT') continue;
    if (isMangaElement(el) && isCandidate(el, minSize, true)) return el;
  }
  return null;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Read pixels straight from the page when the browser allows it (same-origin, CORS, blob:). */
export async function readPixels(el: MangaElement): Promise<string | null> {
  try {
    if (el instanceof HTMLCanvasElement) return el.toDataURL('image/png');
    const src = el.currentSrc || el.src;
    if (src.startsWith('data:')) return src;
    if (src.startsWith('blob:')) {
      try {
        return await blobToDataUrl(await (await fetch(src)).blob());
      } catch {
        /* fall through to canvas */
      }
    }
    const c = document.createElement('canvas');
    c.width = el.naturalWidth;
    c.height = el.naturalHeight;
    c.getContext('2d')!.drawImage(el, 0, 0);
    return c.toDataURL('image/jpeg', 0.92); // throws if the canvas is tainted
  } catch {
    return null;
  }
}

export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
