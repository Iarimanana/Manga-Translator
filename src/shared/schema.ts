import { z } from 'zod';
import { TEXT_KINDS } from './types';

/** Shape of Claude's structured output for one page (or slice). Kept separate from the
 * prompt so pages that only need prompt helpers don't bundle zod. */
const Box = z.object({
  x_min: z.number(),
  y_min: z.number(),
  x_max: z.number(),
  y_max: z.number(),
});

export const ModelBlockSchema = z.object({
  kind: z.enum(TEXT_KINDS),
  text_box: Box,
  bubble_box: Box,
  original: z.string(),
  translation: z.string(),
});

export const ModelOutputSchema = z.object({
  blocks: z.array(ModelBlockSchema),
});

export type ModelBlock = z.infer<typeof ModelBlockSchema>;
export type ModelOutput = z.infer<typeof ModelOutputSchema>;
