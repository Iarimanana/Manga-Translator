import { z } from 'zod';
import { ModelOutputSchema, type ModelOutput } from '../shared/schema';
import type { Settings } from '../shared/settings';
import { TEXT_KINDS, type TextKind } from '../shared/types';
import type { PageRequest, PageResponse } from './claude';
import { TranslateError } from './errors';

/**
 * Local vision models served through an OpenAI-compatible API (Ollama, LM Studio,
 * llama.cpp server, vLLM, ...). Nothing leaves the computer.
 */

type LocalSettings = Pick<Settings, 'localBaseURL' | 'localModel'>;

let fetchOverride: typeof fetch | undefined;
export function setLocalFetchForTesting(f: typeof fetch | undefined): void {
  fetchOverride = f;
}

/** Small models follow a concrete example far better than a schema description. */
export const LOCAL_FORMAT_HINT = `Reply with JSON only, no other text, exactly in this shape:
{"blocks":[{"kind":"speech","text_box":{"x_min":0,"y_min":0,"x_max":0,"y_max":0},"bubble_box":{"x_min":0,"y_min":0,"x_max":0,"y_max":0},"original":"...","translation":"..."}]}`;

const RESPONSE_SCHEMA = z.toJSONSchema(ModelOutputSchema);
const TIMEOUT_MS = 10 * 60 * 1000;

function friendlyNetworkError(base: string, err: unknown): TranslateError {
  if ((err as Error)?.name === 'TimeoutError') {
    return new TranslateError('network', 'The local model took too long to answer. Try a smaller model or a lower image resolution.');
  }
  return new TranslateError(
    'network',
    `Could not reach the local model server at ${base}. Is Ollama / LM Studio running? (${(err as Error)?.message ?? err})`,
  );
}

async function httpError(res: Response, base: string, model: string): Promise<TranslateError> {
  const body = (await res.text().catch(() => '')).slice(0, 300);
  if (res.status === 403) {
    return new TranslateError(
      'network',
      'The local server refused the extension (HTTP 403). For Ollama, allow browser extensions by setting OLLAMA_ORIGINS="chrome-extension://*" and restarting Ollama.',
    );
  }
  if (res.status === 404 && /model/i.test(body)) {
    return new TranslateError('api', `The model "${model}" isn't installed. Run: ollama pull ${model}`);
  }
  return new TranslateError('api', `Local model server error ${res.status} at ${base}: ${body || res.statusText}`);
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

/**
 * Extract and repair the model's JSON. Local models often wrap it in prose or code fences,
 * emit <think> sections, use [x0,y0,x1,y1] arrays or omit fields.
 */
export function parseLocalOutput(text: string): ModelOutput {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/gi, '');
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start < 0 || end < start) throw new TranslateError('api', 'The local model did not return JSON. Try a different model.');
  let data: unknown;
  try {
    data = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new TranslateError('api', 'The local model returned malformed JSON. Try again or use a larger model.');
  }
  const exact = ModelOutputSchema.safeParse(data);
  if (exact.success) return exact.data;

  const list = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.blocks ?? []);
  const blocks: ModelOutput['blocks'] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const text_box = box(r.text_box ?? r.bbox ?? r.box ?? r.bubble_box);
    if (!text_box || Object.values(text_box).some((n) => !Number.isFinite(n))) continue;
    const bubble = box(r.bubble_box);
    const bubble_box = bubble && Object.values(bubble).every(Number.isFinite) ? bubble : text_box;
    const translation = String(r.translation ?? r.translated ?? r.text_translated ?? '').trim();
    if (!translation) continue;
    const kind = (TEXT_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as TextKind) : 'speech';
    blocks.push({ kind, text_box, bubble_box, original: String(r.original ?? r.text ?? ''), translation });
  }
  return { blocks };
}

export async function translateWithLocal(settings: LocalSettings, req: PageRequest): Promise<PageResponse> {
  const base = settings.localBaseURL;
  const doFetch = fetchOverride ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: settings.localModel,
        temperature: 0,
        stream: false,
        messages: [
          { role: 'system', content: `${req.system}\n\n${LOCAL_FORMAT_HINT}` },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${req.mediaType};base64,${req.imageBase64}` } },
              { type: 'text', text: req.userText },
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'manga_page', strict: true, schema: RESPONSE_SCHEMA },
        },
      }),
    });
  } catch (err) {
    throw friendlyNetworkError(base, err);
  }
  if (!res.ok) throw await httpError(res, base, settings.localModel);

  const json = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = json.choices?.[0]?.message?.content ?? '';
  return {
    output: parseLocalOutput(content),
    usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
    model: `local:${json.model ?? settings.localModel}`,
  };
}

/** Check the server is up and the model is installed. */
export async function testLocal(settings: LocalSettings): Promise<string> {
  const base = settings.localBaseURL;
  let res: Response;
  try {
    res = await (fetchOverride ?? fetch)(`${base}/models`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw friendlyNetworkError(base, err);
  }
  if (!res.ok) throw await httpError(res, base, settings.localModel);
  const ids = (((await res.json()) as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
  const want = settings.localModel;
  const found = ids.find((id) => id === want || id === `${want}:latest` || `${id}:latest` === want);
  if (!found) {
    throw new TranslateError(
      'api',
      `Connected, but "${want}" isn't installed.${ids.length ? ` Installed: ${ids.join(', ')}.` : ''} For Ollama run: ollama pull ${want}`,
    );
  }
  return `${found} (local)`;
}
