import { modelOutputJsonSchema, type ModelOutput } from '../shared/schema';
import type { Settings } from '../shared/settings';
import type { PageRequest, PageResponse } from './claude';
import { TranslateError } from './errors';
import { parseLocalOutput } from './local';

/**
 * Google Gemini through the Generative Language REST API. Works with a free Google AI
 * Studio key; the free tier is rate limited per minute and per day.
 */

type GeminiSettings = Pick<Settings, 'geminiApiKey' | 'geminiModel' | 'geminiBaseURL'>;

let fetchOverride: typeof fetch | undefined;
let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function setGeminiFetchForTesting(f: typeof fetch | undefined, fastSleep = false): void {
  fetchOverride = f;
  sleep = fastSleep ? async () => {} : (ms) => new Promise<void>((r) => setTimeout(r, ms));
}

const RESPONSE_SCHEMA = modelOutputJsonSchema();
// Manga is full of fights and drama; don't let default filters drop ordinary pages.
const SAFETY = ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT'].map((c) => ({
  category: `HARM_CATEGORY_${c}`,
  threshold: 'BLOCK_NONE',
}));
const MAX_ATTEMPTS = 4;

interface GeminiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { '@type'?: string; retryDelay?: string; violations?: { quotaId?: string }[]; reason?: string }[];
  };
}

function retryDelayMs(err: GeminiError, fallback: number): number {
  const d = err.error?.details?.find((x) => x.retryDelay)?.retryDelay;
  const secs = d ? parseFloat(d) : NaN;
  return Number.isFinite(secs) ? Math.min(60_000, Math.ceil(secs * 1000) + 500) : fallback;
}

function isDailyQuota(err: GeminiError): boolean {
  const ids = (err.error?.details ?? []).flatMap((d) => d.violations ?? []).map((v) => v.quotaId ?? '');
  return ids.some((id) => /PerDay/i.test(id)) || /per day|daily/i.test(err.error?.message ?? '');
}

function apiError(status: number, err: GeminiError, model: string): TranslateError {
  const msg = err.error?.message ?? `HTTP ${status}`;
  const reason = err.error?.details?.find((d) => d.reason)?.reason ?? '';
  if (reason === 'API_KEY_INVALID' || /api key not valid/i.test(msg) || status === 401) {
    return new TranslateError('auth', 'Google rejected the Gemini API key. Check it in the extension settings.');
  }
  if (status === 403) return new TranslateError('auth', `Gemini refused the request: ${msg}`);
  if (status === 404) {
    return new TranslateError('api', `Gemini model "${model}" was not found. Pick one from the list in settings.`);
  }
  if (status === 429) {
    return isDailyQuota(err)
      ? new TranslateError(
          'rate_limit',
          `Today's free Gemini quota for ${model} is used up. It resets daily (midnight Pacific time); switch to Flash-Lite in settings for more pages.`,
        )
      : new TranslateError('rate_limit', 'Gemini free-tier rate limit hit. Wait a minute and retry.');
  }
  return new TranslateError('api', `Gemini API error ${status}: ${msg}`);
}

/** Convert 0–1000 boxes to pixels of the sent image; leave pixel-looking output alone. */
export function denormalize(out: ModelOutput, width: number, height: number): ModelOutput {
  const values = out.blocks.flatMap((b) => [b.text_box, b.bubble_box].flatMap((x) => [x.x_max, x.y_max]));
  if (values.some((v) => v > 1001)) return out; // the model answered in pixels after all
  const sx = width / 1000;
  const sy = height / 1000;
  const scale = (b: ModelOutput['blocks'][number]['text_box']) => ({
    x_min: b.x_min * sx,
    y_min: b.y_min * sy,
    x_max: b.x_max * sx,
    y_max: b.y_max * sy,
  });
  return { blocks: out.blocks.map((b) => ({ ...b, text_box: scale(b.text_box), bubble_box: scale(b.bubble_box) })) };
}

async function call(s: GeminiSettings, url: string, init: RequestInit): Promise<Response> {
  try {
    return await (fetchOverride ?? fetch)(url, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': s.geminiApiKey, ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw new TranslateError('network', `Could not reach the Gemini API: ${(err as Error).message}`);
  }
}

export async function translateWithGemini(s: GeminiSettings, req: PageRequest): Promise<PageResponse> {
  if (!s.geminiApiKey) {
    throw new TranslateError('no_api_key', 'Add your free Gemini API key in the extension settings to start translating.');
  }
  const url = `${s.geminiBaseURL}/models/${encodeURIComponent(s.geminiModel)}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: req.mediaType, data: req.imageBase64 } }, { text: req.userText }],
      },
    ],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: RESPONSE_SCHEMA },
    safetySettings: SAFETY,
  });

  for (let attempt = 1; ; attempt++) {
    const res = await call(s, url, { method: 'POST', body });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as GeminiError;
      // Per-minute limits and overload are temporary: wait and try again.
      const transient = (res.status === 429 && !isDailyQuota(err)) || res.status === 500 || res.status === 503;
      if (transient && attempt < MAX_ATTEMPTS) {
        await sleep(res.status === 429 ? retryDelayMs(err, 15_000) : 2000 * attempt);
        continue;
      }
      throw apiError(res.status, err, s.geminiModel);
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      modelVersion?: string;
    };
    if (json.promptFeedback?.blockReason) {
      throw new TranslateError('refusal', `Gemini blocked this page (${json.promptFeedback.blockReason}).`);
    }
    const cand = json.candidates?.[0];
    const finish = cand?.finishReason ?? '';
    if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'].includes(finish)) {
      throw new TranslateError('refusal', `Gemini declined to translate this page (${finish}).`);
    }
    if (finish === 'MAX_TOKENS') throw new TranslateError('api', 'Gemini stopped before finishing this page.');
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    const u = json.usageMetadata ?? {};
    return {
      output: denormalize(parseLocalOutput(text), req.width, req.height),
      usage: {
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      },
      model: `gemini:${json.modelVersion ?? s.geminiModel}`,
    };
  }
}

/** Verify the key and model; returns the model's display name. */
export async function testGemini(s: GeminiSettings): Promise<string> {
  if (!s.geminiApiKey) throw new TranslateError('no_api_key', 'Paste your Gemini API key first.');
  const res = await call(s, `${s.geminiBaseURL}/models/${encodeURIComponent(s.geminiModel)}`, { method: 'GET' });
  if (!res.ok) throw apiError(res.status, (await res.json().catch(() => ({}))) as GeminiError, s.geminiModel);
  const m = (await res.json()) as { displayName?: string; name?: string };
  return m.displayName || m.name || s.geminiModel;
}

/** Gemini models this key can use for image + text generation. */
export async function listGeminiModels(s: GeminiSettings): Promise<string[]> {
  if (!s.geminiApiKey) throw new TranslateError('no_api_key', 'Paste your Gemini API key first.');
  const res = await call(s, `${s.geminiBaseURL}/models?pageSize=1000`, { method: 'GET' });
  if (!res.ok) throw apiError(res.status, (await res.json().catch(() => ({}))) as GeminiError, s.geminiModel);
  const data = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
  return (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name))
    .filter((m) => !/(tts|image-generation|embedding|live|audio)/i.test(m.name))
    .map((m) => m.name.replace(/^models\//, ''))
    .sort();
}
