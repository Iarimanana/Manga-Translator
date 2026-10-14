import { sourceLanguage, targetLanguage } from './languages';
import type { PageTranslation } from './types';

/** Bump when the prompt or schema changes so stale cache entries are not reused. */
export const PROMPT_VERSION = 1;

export interface PromptOptions {
  targetLang: string;
  sourceLang: string;
  translateSfx: boolean;
  customInstructions: string;
}

export function buildSystemPrompt(o: PromptOptions): string {
  const target = targetLanguage(o.targetLang).prompt;
  const source = sourceLanguage(o.sourceLang).prompt;
  const sfx = o.translateSfx
    ? `Include sound effects (kind "sfx") and render each as a short ${target} onomatopoeia or descriptive word.`
    : 'Do not include sound effects or onomatopoeia drawn into the artwork; skip them entirely.';

  const parts = [
    `You are a professional manga, manhwa and manhua translator and letterer. You receive an image of a comic page (or a slice of a long vertical webtoon strip). Find the text a reader needs translated and translate it into ${target}.`,
    `Source language: ${source}.`,
    '',
    'For every piece of text, return one block with:',
    '- kind: "speech" (speech balloon), "thought" (thought balloon), "narration" (caption or narration box), "sfx" (sound effect drawn into the art), "sign" (signs, screens, letters, labels inside the scene) or "other".',
    '- text_box: the tight box around the original lettering, in pixel coordinates of the image you were given (origin top-left, x to the right, y downwards).',
    '- bubble_box: the box of the inside of the balloon or caption that contains the text, i.e. the blank area a letterer could fill with the translation. For text with no balloon, use the text box.',
    '- original: the exact transcription of the original text. Join vertical columns and line breaks in reading order.',
    `- translation: a natural, fluent ${target} rendering, written the way an official localisation would letter it. Keep the tone, personality and emphasis (…, !, ?) of each speaker, keep names consistent, and do not add notes or explanations.`,
    '',
    'Rules:',
    '- One block per balloon or caption. Merge the lines and columns of one balloon into a single block; list separate balloons separately even when they touch.',
    '- List blocks in reading order (right-to-left for Japanese manga, left-to-right for Korean and Chinese webtoons; top to bottom).',
    `- ${sfx}`,
    `- Skip text that is already written in ${target}, page numbers, watermarks, website URLs and scanlation credits.`,
    '- When text is cut off by the image edge, include it only if most of it is visible.',
    '- If there is no text to translate, return an empty list of blocks.',
  ];
  const custom = o.customInstructions.trim();
  if (custom) {
    parts.push('', 'Additional instructions and glossary from the reader (follow them):', custom);
  }
  return parts.join('\n');
}

export interface UserTextOptions {
  width: number;
  height: number;
  tileIndex: number;
  tileCount: number;
  context?: string;
}

export function buildUserText(o: UserTextOptions): string {
  const lines = [`The image is ${o.width}×${o.height} pixels. Return boxes in that coordinate space.`];
  if (o.tileCount > 1) {
    lines.push(
      `This is slice ${o.tileIndex + 1} of ${o.tileCount} of a long vertical strip, sliced top to bottom with some overlap between slices.`,
    );
  }
  if (o.context?.trim()) {
    lines.push(
      '',
      'Dialogue from the previous page, for context and consistent names and terms only (do not translate it again):',
      o.context.trim(),
    );
  }
  lines.push('', 'Translate the text on this page.');
  return lines.join('\n');
}

/** Summarise a translated page as context for the next one. */
export function pageContext(page: PageTranslation, maxBlocks = 40): string {
  return page.blocks
    .slice(-maxBlocks)
    .map((b) => `${b.original.replace(/\s+/g, ' ')} => ${b.translation.replace(/\s+/g, ' ')}`)
    .join('\n');
}
