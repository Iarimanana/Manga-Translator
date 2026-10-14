import { clampBox, padBox, scaleBox, toPixelBox, unionBox } from './geometry';
import { fitText, type MeasureFn } from './textfit';
import type { PixelBox, TranslatedBlock } from './types';

export const LINE_HEIGHT = 1.12;

/** Font roles used by the letterer. Each maps to a concrete font in the renderer. */
export type FontRole = 'dialogue' | 'whisper' | 'thought' | 'shout' | 'sfx';

/**
 * How a block is lettered:
 * - balloon: text in a plain balloon/caption, original covered with the paper colour
 * - overprint: text over cleaned (inpainted) artwork, outlined for legibility
 * - subtitle: small caption beside an untouched sound effect (Yen Press / Kodansha style)
 * - sfx: sound effect redrawn in a display font over the cleaned art (Viz style)
 */
export type Variant = 'balloon' | 'overprint' | 'subtitle' | 'sfx';

export interface LayoutOptions {
  fontScale: number;
  letteringCase?: 'upper' | 'sentence';
  sfxStyle?: 'none' | 'subtitle' | 'replace';
  /** BCP-47 code of the lettering language, for locale-aware upper-casing. */
  lang?: string;
}

export interface BlockLayout {
  variant: Variant;
  role: FontRole;
  /** Text area in display pixels. */
  box: PixelBox;
  fontSize: number;
  lines: string[];
  padding: number;
  radius: number;
  lineHeight: number;
  /** Background paint behind the text, or null for none. */
  fill: string | null;
  color: string;
  /** Outline around glyphs, in px (0 = none). */
  stroke: number;
  strokeColor: string;
  /** Inpainted patch to draw before the text, in display pixels. */
  patch?: { box: PixelBox; image: string };
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

/** Patch rectangle and inner padding for a block shown at dispW × dispH (before text fitting). */
export function blockArea(block: TranslatedBlock, dispW: number, dispH: number): { box: PixelBox; padding: number } {
  const text = toPixelBox(block.textRect, dispW, dispH);
  const bubble = toPixelBox(block.bubbleRect, dispW, dispH);
  const pad = Math.max(2, dispW * 0.004);
  const box = clampBox(unionBox(padBox(text, pad), safeInterior(block, bubble)), dispW, dispH);
  const padding = Math.max(1, Math.min(box.x1 - box.x0, box.y1 - box.y0) * 0.07);
  return { box, padding };
}

export function variantOf(block: TranslatedBlock, opts: Pick<LayoutOptions, 'sfxStyle'>): Variant {
  if (block.kind === 'sfx') return opts.sfxStyle === 'replace' ? 'sfx' : 'subtitle';
  return block.clean ? 'overprint' : 'balloon';
}

export function roleOf(block: TranslatedBlock, variant: Variant): FontRole {
  if (variant === 'sfx') return 'sfx';
  if (variant === 'subtitle') return 'dialogue';
  if (block.emphasis === 'shout') return 'shout';
  if (block.emphasis === 'whisper') return 'whisper';
  if (block.kind === 'thought') return 'thought';
  return 'dialogue';
}

/** Apply lettering case: comics are traditionally lettered in capitals; SFX always are. */
export function letterText(block: TranslatedBlock, variant: Variant, opts: Pick<LayoutOptions, 'letteringCase' | 'lang'>): string {
  const upper = variant === 'sfx' || opts.letteringCase !== 'sentence';
  if (!upper) return block.translation;
  try {
    return block.translation.toLocaleUpperCase(opts.lang || undefined);
  } catch {
    return block.translation.toUpperCase();
  }
}

/** Measurement function for a font role (widths at BASE_FONT_SIZE). */
export type MeasureFor = (role: FontRole) => MeasureFn;

const luminanceHex = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

/**
 * Compute where and how large to draw one translated block on an image displayed at
 * dispW × dispH pixels.
 */
export function layoutBlock(
  block: TranslatedBlock,
  dispW: number,
  dispH: number,
  measureFor: MeasureFor | MeasureFn,
  opts: LayoutOptions,
): BlockLayout {
  const variant = variantOf(block, opts);
  const role = roleOf(block, variant);
  // Tests pass one plain measure function; the renderers pass a per-font factory.
  const measure = isRoleFn(measureFor) ? (measureFor as MeasureFor)(role) : (measureFor as MeasureFn);
  const text = letterText(block, variant, opts);
  const scale = opts.fontScale || 1;
  const textBox = toPixelBox(block.textRect, dispW, dispH);

  let box: PixelBox;
  let padding: number;
  let maxRatio = 0.045;
  if (variant === 'subtitle') {
    // A small caption just below (or above) the effect, leaving the artwork untouched.
    const w = Math.max(textBox.x1 - textBox.x0, dispW * 0.16);
    const h = dispW * 0.05;
    const cx = (textBox.x0 + textBox.x1) / 2;
    const below = textBox.y1 + h + 2 <= dispH;
    const y0 = below ? textBox.y1 + 2 : Math.max(0, textBox.y0 - h - 2);
    box = clampBox({ x0: cx - w / 2, y0, x1: cx + w / 2, y1: y0 + h }, dispW, dispH);
    padding = Math.max(1, h * 0.12);
    maxRatio = 0.022;
  } else if (variant === 'sfx') {
    box = clampBox(padBox(textBox, dispW * 0.004), dispW, dispH);
    padding = 0;
    maxRatio = 0.25;
  } else {
    ({ box, padding } = blockArea(block, dispW, dispH));
  }

  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const innerW = Math.max(1, w - 2 * padding);
  const innerH = Math.max(1, h - 2 * padding);
  const roleScale = role === 'shout' ? 1.25 : role === 'whisper' ? 0.72 : 1;
  const maxSize = Math.max(6, Math.min(dispW * maxRatio * scale * roleScale, innerH));
  const minSize = Math.max(5, Math.min(maxSize, dispW * 0.009 * scale * (role === 'whisper' ? 0.85 : 1)));
  const fit = fitText(text, innerW, innerH, measure, {
    minSize,
    maxSize,
    lineHeight: LINE_HEIGHT,
    balance: variant !== 'sfx',
  });

  if (fit.overflow && variant !== 'sfx') {
    // Grow the area vertically (within the image) so overflowing text is still covered.
    const needH = fit.lines.length * fit.fontSize * LINE_HEIGHT + 2 * padding;
    if (needH > h) {
      const cy = (box.y0 + box.y1) / 2;
      box = clampBox({ x0: box.x0, y0: cy - needH / 2, x1: box.x1, y1: cy + needH / 2 }, dispW, dispH);
    }
  }

  const minSide = Math.min(box.x1 - box.x0, box.y1 - box.y0);
  const radius =
    variant === 'subtitle'
      ? minSide / 2
      : block.kind === 'speech' || block.kind === 'thought'
        ? minSide * 0.35
        : block.kind === 'narration'
          ? 2
          : 4;

  let fill: string | null = block.bg;
  let color = block.fg;
  let stroke = 0;
  let strokeColor = '#ffffff';
  if (variant === 'subtitle') {
    fill = 'rgba(255,255,255,0.88)';
    color = '#111111';
  } else if (variant === 'sfx') {
    fill = null;
    color = block.ink ?? block.fg;
    strokeColor = luminanceHex(color) > 0.5 ? '#111111' : '#ffffff';
    stroke = Math.max(1.5, fit.fontSize * 0.12);
  } else if (variant === 'overprint') {
    fill = null;
    strokeColor = luminanceHex(color) > 0.5 ? '#111111' : '#ffffff';
    stroke = Math.max(1.5, fit.fontSize * 0.16);
  }

  const patch = block.clean
    ? { box: toPixelBox(block.clean.rect, dispW, dispH), image: block.clean.image }
    : undefined;

  return {
    variant,
    role,
    box,
    fontSize: fit.fontSize,
    lines: fit.lines,
    padding,
    radius,
    lineHeight: LINE_HEIGHT,
    fill,
    color,
    stroke,
    strokeColor,
    patch,
  };
}

/** Distinguish a per-role measure factory from a plain measure function. */
const ROLE_FN = Symbol('measureFor');
export function measureForRoles(fn: (role: FontRole) => MeasureFn): MeasureFor {
  const f = ((role: FontRole) => fn(role)) as MeasureFor & { [ROLE_FN]?: true };
  f[ROLE_FN] = true;
  return f;
}
function isRoleFn(f: unknown): boolean {
  return typeof f === 'function' && (f as { [ROLE_FN]?: true })[ROLE_FN] === true;
}
