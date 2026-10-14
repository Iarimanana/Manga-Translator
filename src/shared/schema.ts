import { z } from 'zod';
import { EMPHASES, TEXT_KINDS } from './types';

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
  emphasis: z.enum(EMPHASES),
  note: z.string(),
});

export const ModelOutputSchema = z.object({
  blocks: z.array(ModelBlockSchema),
});

export type ModelBlock = z.infer<typeof ModelBlockSchema>;
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

/** The editor's revision of a page script (text only, no image). */
export const EditorOutputSchema = z.object({
  blocks: z.array(
    z.object({
      id: z.number(),
      translation: z.string(),
      emphasis: z.enum(EMPHASES),
      note: z.string(),
    }),
  ),
});
export type EditorOutput = z.infer<typeof EditorOutputSchema>;

/** Plain JSON Schema for APIs that take one directly (OpenAI-compatible servers, Gemini). */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export function modelOutputJsonSchema(): Record<string, unknown> {
  return jsonSchemaOf(ModelOutputSchema);
}
