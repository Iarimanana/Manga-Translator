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

/** How a line is delivered, which drives the lettering style. */
export const EMPHASES = ['normal', 'shout', 'whisper'] as const;
export type Emphasis = (typeof EMPHASES)[number];

/** Result of image cleaning for one block: the inpainted pixels to lay over the original. */
export interface CleanPatch {
  /** Area the patch covers, normalised to the page. */
  rect: Rect;
  /** Inpainted image of that area (data URL). */
  image: string;
}

export interface QcIssue {
  /** Index of the block in PageTranslation.blocks, or -1 for the whole page. */
  block: number;
  kind: 'leftover-source' | 'untranslated' | 'too-long' | 'editor';
  message: string;
}

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
  /** Delivery: shouting gets heavy lettering, whispers small light lettering. */
  emphasis?: Emphasis;
  /** Translator's note explaining a cultural reference, pun or term (may be empty). */
  note?: string;
  /** Colour of the original lettering (used to redraw sound effects). */
  ink?: string;
  /** Inpainted background for text drawn over artwork; absent for plain balloons. */
  clean?: CleanPatch;
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
  /** Automatic quality-control findings that are still open after editing. */
  qc?: QcIssue[];
  /** Which steps of the translation workflow ran ('translate', 'edit', 'qc', 'clean'). */
  steps?: string[];
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
