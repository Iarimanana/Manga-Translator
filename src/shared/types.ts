/** A rectangle in normalised image space: every value is a fraction of the image width/height (0..1). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box in pixel space, edges inclusive of x0/y0 and exclusive of x1/y1. */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const TEXT_KINDS = ['speech', 'thought', 'narration', 'sfx', 'sign', 'other'] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

export interface TranslatedBlock {
  /** Tight box around the original lettering. */
  textRect: Rect;
  /** The balloon / caption box that contains the text (always contains textRect). */
  bubbleRect: Rect;
  original: string;
  translation: string;
  kind: TextKind;
  /** Background colour sampled from the page, as #rrggbb. */
  bg: string;
  /** Text colour chosen for contrast with bg, as #rrggbb. */
  fg: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface PageTranslation {
  /** Pixel size of the source image the boxes refer to. */
  width: number;
  height: number;
  blocks: TranslatedBlock[];
  model: string;
  targetLang: string;
  createdAt: number;
  usage: Usage;
  /** True when the result came from the local cache. */
  cached?: boolean;
}

/** Where the pixels for a translation request come from. */
export type ImageSource =
  | { kind: 'url'; url: string; pageUrl?: string }
  | { kind: 'dataUrl'; dataUrl: string };

/** Viewport rectangle in CSS pixels, used for screenshot based translation. */
export interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
