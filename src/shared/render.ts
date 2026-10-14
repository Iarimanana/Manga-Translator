import { layoutBlock, type BlockLayout } from './layout';
import { BASE_FONT_SIZE, makeCachedMeasure, type MeasureFn } from './textfit';
import type { PageTranslation, TranslatedBlock } from './types';

export const FONT_FAMILY_NAME = 'MangaTranslatorComic';
export const FONT_WEIGHT = 700;
export const FONT_FILE = 'fonts/comic-neue-700.woff2';

export interface OverlayStyle {
  fontStack: string;
  fontScale: number;
  opacity: number;
  rtl: boolean;
}

let fontPromise: Promise<void> | null = null;

/**
 * Register the bundled comic font with this document. The font bytes are loaded from the
 * extension and handed to FontFace directly, so page CSP font-src rules do not apply.
 */
export function ensureFont(): Promise<void> {
  fontPromise ??= (async () => {
    try {
      if ([...document.fonts].some((f) => f.family.replace(/["']/g, '') === FONT_FAMILY_NAME)) return;
      const buf = await (await fetch(chrome.runtime.getURL(FONT_FILE))).arrayBuffer();
      const face = new FontFace(FONT_FAMILY_NAME, buf, { weight: String(FONT_WEIGHT) });
      await face.load();
      document.fonts.add(face);
    } catch (err) {
      console.warn('[Manga Translator] could not load bundled font, using system fonts', err);
    }
  })();
  return fontPromise;
}

function cssFont(size: number, stack: string): string {
  return `${FONT_WEIGHT} ${size}px ${stack}`;
}

let sharedCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

export function canvasMeasure(stack: string): MeasureFn {
  sharedCtx ??=
    typeof document !== 'undefined'
      ? document.createElement('canvas').getContext('2d')
      : new OffscreenCanvas(1, 1).getContext('2d');
  const ctx = sharedCtx!;
  const font = cssFont(BASE_FONT_SIZE, stack);
  return makeCachedMeasure((text) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  });
}

export function layoutPage(page: PageTranslation, dispW: number, dispH: number, style: OverlayStyle) {
  const measure = canvasMeasure(style.fontStack);
  return page.blocks.map((block) => ({
    block,
    layout: layoutBlock(block, dispW, dispH, measure, { fontScale: style.fontScale }),
  }));
}

/** Render translated blocks as absolutely positioned elements inside `layer`. */
export function renderBlocksDom(
  layer: HTMLElement,
  page: PageTranslation,
  dispW: number,
  dispH: number,
  style: OverlayStyle,
): void {
  const doc = layer.ownerDocument;
  const frag = doc.createDocumentFragment();
  for (const { block, layout } of layoutPage(page, dispW, dispH, style)) {
    frag.appendChild(blockElement(doc, block, layout, style));
  }
  layer.replaceChildren(frag);
}

function blockElement(doc: Document, block: TranslatedBlock, L: BlockLayout, style: OverlayStyle): HTMLElement {
  const el = doc.createElement('div');
  el.className = `mt-block mt-${block.kind}`;
  const s = el.style;
  s.left = `${L.box.x0}px`;
  s.top = `${L.box.y0}px`;
  s.width = `${L.box.x1 - L.box.x0}px`;
  s.height = `${L.box.y1 - L.box.y0}px`;
  s.padding = `${L.padding}px`;
  s.borderRadius = `${L.radius}px`;
  s.background = block.bg;
  s.color = block.fg;
  s.fontFamily = style.fontStack;
  s.fontWeight = String(FONT_WEIGHT);
  s.fontSize = `${L.fontSize}px`;
  s.lineHeight = String(L.lineHeight);
  s.opacity = String(style.opacity);
  if (style.rtl) s.direction = 'rtl';
  el.title = block.original ? `${block.original}\n\n(click to peek at the original)` : '';
  const text = doc.createElement('span');
  text.className = 'mt-text';
  text.textContent = L.lines.join('\n');
  el.appendChild(text);
  return el;
}

/** Styles for overlay elements; injected into the content-script shadow root and the reader. */
export const OVERLAY_CSS = `
.mt-block {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  overflow: visible;
  pointer-events: auto;
  cursor: pointer;
  user-select: text;
  transition: opacity 120ms ease;
  -webkit-font-smoothing: antialiased;
}
.mt-block .mt-text { white-space: pre; display: block; }
.mt-block.mt-sfx, .mt-block.mt-sign { box-shadow: 0 0 0 1px rgba(0,0,0,.08); }
.mt-block.mt-peek { opacity: 0 !important; }
.mt-hidden .mt-block { display: none; }
`;

/** Draw translated blocks onto a canvas (used for exporting translated pages). */
export function drawBlocksCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  page: PageTranslation,
  w: number,
  h: number,
  style: OverlayStyle,
): void {
  for (const { block, layout: L } of layoutPage(page, w, h, style)) {
    const bw = L.box.x1 - L.box.x0;
    const bh = L.box.y1 - L.box.y0;
    ctx.save();
    ctx.globalAlpha = style.opacity;
    ctx.fillStyle = block.bg;
    ctx.beginPath();
    ctx.roundRect(L.box.x0, L.box.y0, bw, bh, Math.min(L.radius, bw / 2, bh / 2));
    ctx.fill();
    ctx.fillStyle = block.fg;
    ctx.font = cssFont(L.fontSize, style.fontStack);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.direction = style.rtl ? 'rtl' : 'ltr';
    const lh = L.fontSize * L.lineHeight;
    const cx = L.box.x0 + bw / 2;
    let y = L.box.y0 + bh / 2 - (lh * L.lines.length) / 2 + lh / 2;
    for (const line of L.lines) {
      ctx.fillText(line, cx, y);
      y += lh;
    }
    ctx.restore();
  }
}
