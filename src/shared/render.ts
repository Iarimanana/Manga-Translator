import { isRtl } from './languages';
import { layoutBlock, measureForRoles, type BlockLayout, type FontRole } from './layout';
import { fontStack, type Settings } from './settings';
import { BASE_FONT_SIZE, makeCachedMeasure, type MeasureFn } from './textfit';
import type { PageTranslation, TranslatedBlock } from './types';

export const FONT_FAMILY_NAME = 'MangaTranslatorComic';
export const SHOUT_FAMILY_NAME = 'MangaTranslatorShout';
const SHOUT_STACK = `'${SHOUT_FAMILY_NAME}', Bangers, Impact, 'Arial Black', sans-serif`;

/** Bundled fonts: Comic Neue (dialogue, whispers, thoughts) and Bangers (shouts, SFX). */
const FONT_FACES = [
  { family: FONT_FAMILY_NAME, file: 'fonts/comic-neue-700.woff2', weight: '700', style: 'normal' },
  { family: FONT_FAMILY_NAME, file: 'fonts/comic-neue-400.woff2', weight: '400', style: 'normal' },
  { family: FONT_FAMILY_NAME, file: 'fonts/comic-neue-700-italic.woff2', weight: '700', style: 'italic' },
  { family: SHOUT_FAMILY_NAME, file: 'fonts/bangers-400.woff2', weight: '400', style: 'normal' },
];

export interface OverlayStyle {
  fontStack: string;
  /** Font for shouting; the dialogue font in bold when the reader picked their own font. */
  shoutStack: string;
  fontScale: number;
  opacity: number;
  rtl: boolean;
  letteringCase: 'upper' | 'sentence';
  sfxStyle: 'none' | 'subtitle' | 'replace';
  lang: string;
  showNotes: boolean;
}

export function overlayStyleFrom(s: Settings): OverlayStyle {
  const stack = fontStack(s);
  return {
    fontStack: stack,
    shoutStack: s.fontFamily === 'comic' ? SHOUT_STACK : stack,
    fontScale: s.fontScale,
    opacity: s.overlayOpacity,
    rtl: isRtl(s.targetLang),
    letteringCase: s.letteringCase,
    sfxStyle: s.sfxStyle,
    lang: s.targetLang,
    showNotes: s.showNotes,
  };
}

let fontPromise: Promise<void> | null = null;

/**
 * Register the bundled fonts with this document. The font bytes are loaded from the
 * extension and handed to FontFace directly, so page CSP font-src rules do not apply.
 */
export function ensureFont(): Promise<void> {
  fontPromise ??= (async () => {
    await Promise.all(
      FONT_FACES.map(async (f) => {
        try {
          const loaded = [...document.fonts].some(
            (x) => x.family.replace(/["']/g, '') === f.family && x.weight === f.weight && x.style === f.style,
          );
          if (loaded) return;
          const buf = await (await fetch(chrome.runtime.getURL(f.file))).arrayBuffer();
          const face = new FontFace(f.family, buf, { weight: f.weight, style: f.style });
          await face.load();
          document.fonts.add(face);
        } catch (err) {
          console.warn('[Manga Translator] could not load bundled font', f.file, err);
        }
      }),
    );
  })();
  return fontPromise;
}

interface FontSpec {
  weight: number;
  italic: boolean;
  stack: string;
}

function fontSpec(role: FontRole, style: OverlayStyle): FontSpec {
  switch (role) {
    case 'whisper':
      return { weight: 400, italic: false, stack: style.fontStack };
    case 'thought':
      return { weight: 700, italic: true, stack: style.fontStack };
    case 'shout':
      return style.shoutStack === style.fontStack
        ? { weight: 800, italic: false, stack: style.fontStack }
        : { weight: 400, italic: false, stack: style.shoutStack };
    case 'sfx':
      return { weight: 400, italic: false, stack: SHOUT_STACK };
    default:
      return { weight: 700, italic: false, stack: style.fontStack };
  }
}

function cssFont(size: number, spec: FontSpec): string {
  return `${spec.italic ? 'italic ' : ''}${spec.weight} ${size}px ${spec.stack}`;
}

let sharedCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
const measureCache = new Map<string, MeasureFn>();

function measureForFont(font: string): MeasureFn {
  let m = measureCache.get(font);
  if (!m) {
    sharedCtx ??=
      typeof document !== 'undefined'
        ? document.createElement('canvas').getContext('2d')
        : new OffscreenCanvas(1, 1).getContext('2d');
    const ctx = sharedCtx!;
    m = makeCachedMeasure((text) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    });
    measureCache.set(font, m);
  }
  return m;
}

export function layoutPage(page: PageTranslation, dispW: number, dispH: number, style: OverlayStyle) {
  const measureFor = measureForRoles((role) => measureForFont(cssFont(BASE_FONT_SIZE, fontSpec(role, style))));
  return page.blocks.map((block) => ({
    block,
    layout: layoutBlock(block, dispW, dispH, measureFor, {
      fontScale: style.fontScale,
      letteringCase: style.letteringCase,
      sfxStyle: style.sfxStyle,
      lang: style.lang,
    }),
  }));
}

function outlineShadow(px: number, color: string): string {
  const s = px.toFixed(1);
  const d = (px * 0.7).toFixed(1);
  return [`${s}px 0`, `-${s}px 0`, `0 ${s}px`, `0 -${s}px`, `${d}px ${d}px`, `-${d}px -${d}px`, `${d}px -${d}px`, `-${d}px ${d}px`]
    .map((o) => `${o} 0 ${color}`)
    .join(', ');
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
    if (block.kind === 'sfx' && style.sfxStyle === 'none') continue;
    frag.appendChild(itemElement(doc, block, layout, style));
  }
  layer.replaceChildren(frag);
}

function itemElement(doc: Document, block: TranslatedBlock, L: BlockLayout, style: OverlayStyle): HTMLElement {
  const item = doc.createElement('div');
  item.className = 'mt-item';
  if (L.patch) {
    const p = doc.createElement('div');
    p.className = 'mt-patch';
    Object.assign(p.style, {
      left: `${L.patch.box.x0}px`,
      top: `${L.patch.box.y0}px`,
      width: `${L.patch.box.x1 - L.patch.box.x0}px`,
      height: `${L.patch.box.y1 - L.patch.box.y0}px`,
      backgroundImage: `url("${L.patch.image}")`,
      opacity: String(style.opacity),
    });
    item.appendChild(p);
  }

  const el = doc.createElement('div');
  el.className = `mt-block mt-${block.kind} mt-${L.variant}`;
  const spec = fontSpec(L.role, style);
  const s = el.style;
  s.left = `${L.box.x0}px`;
  s.top = `${L.box.y0}px`;
  s.width = `${L.box.x1 - L.box.x0}px`;
  s.height = `${L.box.y1 - L.box.y0}px`;
  s.padding = `${L.padding}px`;
  s.borderRadius = `${L.radius}px`;
  s.background = L.fill ?? 'transparent';
  s.color = L.color;
  s.fontFamily = spec.stack;
  s.fontWeight = String(spec.weight);
  s.fontStyle = spec.italic ? 'italic' : 'normal';
  s.fontSize = `${L.fontSize}px`;
  s.lineHeight = String(L.lineHeight);
  s.opacity = String(style.opacity);
  if (L.stroke) s.textShadow = outlineShadow(L.stroke, L.strokeColor);
  if (L.role === 'sfx' || L.role === 'shout') s.letterSpacing = '0.02em';
  if (style.rtl) s.direction = 'rtl';
  const note = style.showNotes && block.note ? block.note.trim() : '';
  el.title = [block.original, note && `Translator's note: ${note}`, '(click to peek at the original)']
    .filter(Boolean)
    .join('\n\n');

  const text = doc.createElement('span');
  text.className = 'mt-text';
  text.textContent = L.lines.join('\n');
  el.appendChild(text);
  if (note) {
    const mark = doc.createElement('span');
    mark.className = 'mt-note';
    mark.textContent = '✱';
    mark.title = `Translator's note: ${note}`;
    el.appendChild(mark);
  }
  item.appendChild(el);
  return item;
}

/** Toggle "peek at the original" for the bubble containing `target`. Returns true if handled. */
export function togglePeek(target: EventTarget | null): boolean {
  const block = (target as Element | null)?.closest?.('.mt-block');
  if (!block) return false;
  (block.closest('.mt-item') ?? block).classList.toggle('mt-peek');
  return true;
}

/** Styles for overlay elements; injected into the content-script shadow root and the reader. */
export const OVERLAY_CSS = `
.mt-item { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: visible; pointer-events: none; }
.mt-patch { position: absolute; background-size: 100% 100%; background-repeat: no-repeat; pointer-events: none; }
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
.mt-block.mt-subtitle { box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.mt-note {
  position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font: 700 10px/1 system-ui, sans-serif; font-style: normal; letter-spacing: 0; text-shadow: none;
  color: #fff; background: #e63950; box-shadow: 0 1px 3px rgba(0,0,0,.3); cursor: help;
}
.mt-item.mt-peek > * { opacity: 0 !important; }
.mt-hidden .mt-item { display: none; }
`;

async function loadPatch(dataUrl: string): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(await (await fetch(dataUrl)).blob());
  } catch {
    return null;
  }
}

/** Draw translated blocks onto a canvas (used for exporting translated pages). */
export async function drawBlocksCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  page: PageTranslation,
  w: number,
  h: number,
  style: OverlayStyle,
): Promise<void> {
  const laid = layoutPage(page, w, h, style).filter(({ block }) => !(block.kind === 'sfx' && style.sfxStyle === 'none'));
  // Cleaning first so no patch covers a neighbour's lettering.
  for (const { layout: L } of laid) {
    if (!L.patch) continue;
    const bmp = await loadPatch(L.patch.image);
    if (!bmp) continue;
    ctx.save();
    ctx.globalAlpha = style.opacity;
    ctx.drawImage(bmp, L.patch.box.x0, L.patch.box.y0, L.patch.box.x1 - L.patch.box.x0, L.patch.box.y1 - L.patch.box.y0);
    ctx.restore();
    bmp.close();
  }
  for (const { block, layout: L } of laid) {
    const bw = L.box.x1 - L.box.x0;
    const bh = L.box.y1 - L.box.y0;
    ctx.save();
    ctx.globalAlpha = style.opacity;
    if (L.fill) {
      ctx.fillStyle = L.fill;
      ctx.beginPath();
      ctx.roundRect(L.box.x0, L.box.y0, bw, bh, Math.min(L.radius, bw / 2, bh / 2));
      ctx.fill();
    }
    ctx.font = cssFont(L.fontSize, fontSpec(L.role, style));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.direction = style.rtl ? 'rtl' : 'ltr';
    ctx.lineJoin = 'round';
    const lh = L.fontSize * L.lineHeight;
    const cx = L.box.x0 + bw / 2;
    const y0 = L.box.y0 + bh / 2 - (lh * L.lines.length) / 2 + lh / 2;
    L.lines.forEach((line, i) => {
      if (L.stroke) {
        ctx.strokeStyle = L.strokeColor;
        ctx.lineWidth = L.stroke * 2;
        ctx.strokeText(line, cx, y0 + i * lh);
      }
      ctx.fillStyle = L.color;
      ctx.fillText(line, cx, y0 + i * lh);
    });
    if (style.showNotes && block.note?.trim()) {
      ctx.font = `700 ${Math.max(10, L.fontSize * 0.7)}px system-ui, sans-serif`;
      ctx.fillStyle = '#e63950';
      ctx.fillText('*', L.box.x1 - L.fontSize * 0.3, L.box.y0 + L.fontSize * 0.4);
    }
    ctx.restore();
  }
}

/** Translator's notes of a page, in reading order, for footnotes. */
export function pageNotes(page: PageTranslation): string[] {
  return page.blocks.map((b) => b.note?.trim() ?? '').filter(Boolean);
}
