import { sourceLanguage, targetLanguage } from './languages';
import type { PageTranslation } from './types';

/** Bump when the prompt or schema changes so stale cache entries are not reused. */
export const PROMPT_VERSION = 3;

export interface PromptOptions {
  targetLang: string;
  sourceLang: string;
  sfxStyle: 'none' | 'subtitle' | 'replace';
  adaptation: 'localize' | 'notes';
  customInstructions: string;
}

function adaptationRule(o: PromptOptions, target: string): string {
  return o.adaptation === 'notes'
    ? `Cultural adaptation: keep culturally specific terms, honorifics, food, places and wordplay where they carry meaning, and explain anything a ${target} reader would not know in a short translator's note (the "note" field, one sentence, no "TL:" prefix). Leave "note" empty when no explanation is needed; most lines need none.`
    : `Cultural adaptation: localise references, idioms, jokes and puns into natural ${target} equivalents that land the same way for a ${target} reader, the way an official release would. Leave "note" empty unless a reference truly cannot be adapted.`;
}

function customBlock(o: PromptOptions): string[] {
  const custom = o.customInstructions.trim();
  return custom ? ['', 'Additional instructions and glossary from the reader (follow them):', custom] : [];
}

/** Step 1 — translation and adaptation (reads the page image). */
export function buildSystemPrompt(o: PromptOptions): string {
  const target = targetLanguage(o.targetLang).prompt;
  const source = sourceLanguage(o.sourceLang).prompt;
  const sfx =
    o.sfxStyle === 'none'
      ? 'Do not include sound effects or onomatopoeia drawn into the artwork; skip them entirely.'
      : `Include sound effects (kind "sfx"): give text_box tightly around the drawn effect and render it as a short, punchy ${target} onomatopoeia (e.g. "SLAM", "THUMP", "SHFF") or, if there is none, a brief descriptive word ("glare", "stomp").`;

  return [
    `You are a professional manga, manhwa and manhua translator. You receive an image of a comic page (or a slice of a long vertical webtoon strip). Find the text a reader needs translated and translate it into ${target}.`,
    `Source language: ${source}.`,
    '',
    'Translate like a professional localisation team:',
    `- Preserve meaning first, then tone and subtext. Give each character a distinct, consistent voice (a gruff delinquent, a polite heroine, an old-fashioned master), matching their speech register in ${target}.`,
    `- ${adaptationRule(o, target)}`,
    `- Write natural ${target} that reads well when lettered in a balloon: concise, no stiff literal phrasing, keep emphasis (…, !, ?, stammers, trailing off).`,
    '',
    'For every piece of text, return one block with:',
    '- kind: "speech" (speech balloon), "thought" (thought balloon), "narration" (caption or narration box), "sfx" (sound effect drawn into the art), "sign" (signs, screens, letters, labels inside the scene) or "other".',
    '- text_box: the tight box around the original lettering, in the coordinate system described in the request (origin top-left, x to the right, y downwards).',
    '- bubble_box: the box of the inside of the balloon or caption that contains the text, i.e. the blank area a letterer could fill with the translation. For text with no balloon, use the text box.',
    '- original: the exact transcription of the original text. Join vertical columns and line breaks in reading order.',
    `- translation: the ${target} text to letter.`,
    '- emphasis: "shout" for yelling, screaming or very large/bold lettering, "whisper" for whispers, mutters or tiny lettering, otherwise "normal".',
    '- note: a translator\'s note, or an empty string.',
    '',
    'Rules:',
    '- One block per balloon or caption. Merge the lines and columns of one balloon into a single block; list separate balloons separately even when they touch.',
    '- List blocks in reading order (right-to-left for Japanese manga, left-to-right for Korean and Chinese webtoons; top to bottom).',
    `- ${sfx}`,
    `- Skip text that is already written in ${target}, page numbers, watermarks, website URLs and scanlation credits.`,
    '- When text is cut off by the image edge, include it only if most of it is visible.',
    '- If there is no text to translate, return an empty list of blocks.',
    ...customBlock(o),
  ].join('\n');
}

export interface ScriptLine {
  id: number;
  kind: string;
  original: string;
  translation: string;
  emphasis: string;
  note: string;
  /** Roughly how many characters fit in the balloon at a comfortable size. */
  capacity: number;
}

/** Step 2 (and the QC fix round) — editing, adaptation and proofreading of the script. */
export function buildEditorPrompt(o: PromptOptions): string {
  const target = targetLanguage(o.targetLang).prompt;
  return [
    `You are the editor and proofreader on a professional manga localisation team. You receive the script of one page: each line has the original text, the translator's draft in ${target}, its balloon type, delivery and a rough character budget for the balloon.`,
    '',
    'Revise the script so it is ready for lettering:',
    '- Accuracy: fix mistranslations, omissions and misread names against the original. Keep the creator\'s intent.',
    `- Flow: make every line sound like natural ${target} dialogue that a reader would believe the character says; vary rhythm; no translationese.`,
    '- Consistency: keep names, terms, honorific choices and each character\'s voice consistent across the page and with the previous page and glossary.',
    `- ${adaptationRule(o, target)}`,
    '- Fit: keep each line within its character budget when you can do so without losing meaning; shorten wordy lines. Never pad short lines.',
    '- Proofread spelling, grammar and punctuation. Use … for trailing off and an em dash for interruptions. Do not use ALL CAPS (lettering handles case).',
    '- Keep "emphasis" correct ("shout", "whisper" or "normal") and keep translator\'s notes short.',
    '',
    'Return every line, with the same id, in the same order. If a line is already right, return it unchanged.',
    ...customBlock(o),
  ].join('\n');
}

export function buildEditorUserText(lines: ScriptLine[], context?: string, issues?: string[]): string {
  const out: string[] = [];
  if (context?.trim()) {
    out.push('Previous page, for consistency only:', context.trim(), '');
  }
  if (issues?.length) {
    out.push('Quality control flagged these problems; fix them:', ...issues.map((i) => `- ${i}`), '');
  }
  out.push('Page script:');
  for (const l of lines) {
    out.push(
      JSON.stringify({
        id: l.id,
        kind: l.kind,
        original: l.original,
        draft: l.translation,
        emphasis: l.emphasis,
        note: l.note,
        budget_chars: l.capacity,
      }),
    );
  }
  return out.join('\n');
}

export interface UserTextOptions {
  width: number;
  height: number;
  tileIndex: number;
  tileCount: number;
  context?: string;
  /** 'normalized' asks for 0–1000 coordinates (what Gemini is trained to produce). */
  coords?: 'pixels' | 'normalized';
}

export function buildUserText(o: UserTextOptions): string {
  const lines = [
    o.coords === 'normalized'
      ? `The image is ${o.width}×${o.height} pixels. Return every box in normalized coordinates from 0 to 1000: (0,0) is the top-left corner and (1000,1000) the bottom-right corner of the image, whatever its size.`
      : `The image is ${o.width}×${o.height} pixels. Return boxes in pixel coordinates of this image.`,
  ];
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
