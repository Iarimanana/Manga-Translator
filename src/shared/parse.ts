import { EditorOutputSchema, ModelOutputSchema, type EditorOutput, type ModelOutput } from './schema';
import { EMPHASES, TEXT_KINDS, type Emphasis, type TextKind } from './types';

/** Thrown when a model's text can't be turned into JSON at all. */
export class ParseError extends Error {}

/**
 * Pull the JSON value out of a model reply. Smaller models wrap it in prose or code
 * fences, or prefix a <think> section.
 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/gi, '');
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start < 0 || end < start) throw new ParseError('The model did not return JSON.');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new ParseError('The model returned malformed JSON.');
  }
}

const box = (v: unknown) => {
  if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' || typeof n === 'string')) {
    const [x_min, y_min, x_max, y_max] = v.map(Number);
    return { x_min, y_min, x_max, y_max };
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const pick = (...keys: string[]) => Number(keys.map((k) => o[k]).find((x) => x !== undefined));
    return {
      x_min: pick('x_min', 'xmin', 'x0', 'left'),
      y_min: pick('y_min', 'ymin', 'y0', 'top'),
      x_max: pick('x_max', 'xmax', 'x1', 'right'),
      y_max: pick('y_max', 'ymax', 'y1', 'bottom'),
    };
  }
  return undefined;
};

const emphasisOf = (v: unknown): Emphasis => ((EMPHASES as readonly string[]).includes(String(v)) ? (v as Emphasis) : 'normal');
const listOf = (data: unknown): unknown[] => {
  const list = Array.isArray(data) ? data : (data as Record<string, unknown>)?.blocks;
  return Array.isArray(list) ? list : [];
};

/** Page output, repairing [x0,y0,x1,y1] arrays, alternative key names and missing fields. */
export function parsePageOutput(data: unknown): ModelOutput {
  const exact = ModelOutputSchema.safeParse(data);
  if (exact.success) return exact.data;
  const blocks: ModelOutput['blocks'] = [];
  for (const raw of listOf(data)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const text_box = box(r.text_box ?? r.bbox ?? r.box ?? r.bubble_box);
    if (!text_box || Object.values(text_box).some((n) => !Number.isFinite(n))) continue;
    const bubble = box(r.bubble_box);
    const bubble_box = bubble && Object.values(bubble).every(Number.isFinite) ? bubble : text_box;
    const translation = String(r.translation ?? r.translated ?? r.text_translated ?? '').trim();
    if (!translation) continue;
    const kind = (TEXT_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as TextKind) : 'speech';
    blocks.push({
      kind,
      text_box,
      bubble_box,
      original: String(r.original ?? r.text ?? ''),
      translation,
      emphasis: emphasisOf(r.emphasis),
      note: typeof r.note === 'string' ? r.note : '',
    });
  }
  return { blocks };
}

/** Editor output; lines are matched by id (or position when ids are missing). */
export function parseEditorOutput(data: unknown): EditorOutput {
  const exact = EditorOutputSchema.safeParse(data);
  if (exact.success) return exact.data;
  const blocks: EditorOutput['blocks'] = [];
  listOf(data).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const translation = String(r.translation ?? r.revised ?? r.text ?? '').trim();
    if (!translation) return;
    const id = Number(r.id ?? r.index ?? i);
    blocks.push({
      id: Number.isFinite(id) ? id : i,
      translation,
      emphasis: emphasisOf(r.emphasis),
      note: typeof r.note === 'string' ? r.note : '',
    });
  });
  return { blocks };
}
