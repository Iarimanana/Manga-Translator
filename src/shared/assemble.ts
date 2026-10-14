import { contrastText, snapPaper, toHex, type RGB } from './colors';
import { centerY, dedupeBoxes, sanitizeBox, tileToImage, toRect, unionBox, type Tile } from './geometry';
import type { ModelBlock } from './schema';
import type { Emphasis, PixelBox, TextKind, TranslatedBlock } from './types';

export interface TileResult {
  tile: Tile;
  /** Size of the (downscaled) image the model actually saw. */
  sentW: number;
  sentH: number;
  blocks: ModelBlock[];
}

export interface RawBlock {
  text: PixelBox;
  bubble: PixelBox;
  original: string;
  translation: string;
  kind: TextKind;
  emphasis?: Emphasis;
  note?: string;
}

const box = (b: ModelBlock['text_box']): PixelBox => ({ x0: b.x_min, y0: b.y_min, x1: b.x_max, y1: b.y_max });

/** Merge per-slice model output into one list of blocks in full-image pixel space. */
export function assembleBlocks(results: TileResult[]): RawBlock[] {
  const out: RawBlock[] = [];
  for (const { tile, sentW, sentH, blocks } of results) {
    const isLast = tile.coreY1 >= tile.y + tile.h;
    for (const b of blocks) {
      const translation = b.translation.trim();
      if (!translation) continue;
      const textSent = sanitizeBox(box(b.text_box), sentW, sentH);
      if (!textSent) continue;
      const bubbleSent = sanitizeBox(box(b.bubble_box), sentW, sentH) ?? textSent;
      const text = tileToImage(textSent, tile, sentW, sentH);
      const bubble = unionBox(tileToImage(bubbleSent, tile, sentW, sentH), text);
      const cy = centerY(text);
      if (cy < tile.coreY0 || cy > tile.coreY1 || (cy === tile.coreY1 && !isLast)) continue;
      out.push({
        text,
        bubble,
        original: b.original.trim(),
        translation,
        kind: b.kind,
        emphasis: b.emphasis ?? 'normal',
        note: (b.note ?? '').trim(),
      });
    }
  }
  return dedupeBoxes(out);
}

/** Attach colours and convert to the normalised representation stored and rendered. */
export function finalizeBlocks(
  raw: RawBlock[],
  imgW: number,
  imgH: number,
  sampleBackground: (b: PixelBox) => RGB,
): TranslatedBlock[] {
  return raw.map((r) => {
    const bg = snapPaper(sampleBackground(r.text));
    return {
      textRect: toRect(r.text, imgW, imgH),
      bubbleRect: toRect(r.bubble, imgW, imgH),
      original: r.original,
      translation: r.translation,
      kind: r.kind,
      emphasis: r.emphasis ?? 'normal',
      note: r.note ?? '',
      bg: toHex(bg),
      fg: toHex(contrastText(bg)),
    };
  });
}
