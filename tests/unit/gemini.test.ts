import { afterEach, describe, expect, it } from 'vitest';
import { TranslateError } from '../../src/background/errors';
import {
  denormalize,
  listGeminiModels,
  setGeminiFetchForTesting,
  testGemini,
  translateWithGemini,
} from '../../src/background/gemini';
import { buildUserText } from '../../src/shared/prompt';
import { GEMINI_DEFAULT_BASE, activeModel, isConfigured, normalizeSettings } from '../../src/shared/settings';

afterEach(() => setGeminiFetchForTesting(undefined));

const settings = { geminiApiKey: 'AIza-test', geminiModel: 'gemini-flash-latest', geminiBaseURL: GEMINI_DEFAULT_BASE };
const request = { width: 800, height: 1200, system: 'SYSTEM', userText: 'USER', imageBase64: 'QUJD', mediaType: 'image/jpeg' as const };

const block = {
  kind: 'speech',
  text_box: { x_min: 400, y_min: 100, x_max: 600, y_max: 300 },
  bubble_box: { x_min: 300, y_min: 50, x_max: 700, y_max: 350 },
  original: '待って',
  translation: 'Wait!',
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ok = (blocks: unknown[] = [block]) =>
  reply({
    candidates: [
      {
        content: { parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify({ blocks }) }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 1300, candidatesTokenCount: 200, thoughtsTokenCount: 50 },
    modelVersion: 'gemini-3-flash',
  });

describe('translateWithGemini', () => {
  it('sends a generateContent request and converts 0–1000 boxes to pixels', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    setGeminiFetchForTesting((async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return ok();
    }) as typeof fetch);
    const res = await translateWithGemini(settings, request);

    expect(calls[0].url).toBe(`${GEMINI_DEFAULT_BASE}/models/gemini-flash-latest:generateContent`);
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.systemInstruction.parts[0].text).toBe('SYSTEM');
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } });
    expect(body.contents[0].parts[1]).toEqual({ text: 'USER' });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema.properties.blocks.type).toBe('array');
    expect(body.generationConfig.responseJsonSchema.$schema).toBeUndefined();
    expect(body.safetySettings).toHaveLength(4);

    // 0–1000 → 800×1200 px.
    expect(res.output.blocks[0].text_box).toEqual({ x_min: 320, y_min: 120, x_max: 480, y_max: 360 });
    expect(res.output.blocks[0].bubble_box).toEqual({ x_min: 240, y_min: 60, x_max: 560, y_max: 420 });
    expect(res.usage).toEqual({ inputTokens: 1300, outputTokens: 250 });
    expect(res.model).toBe('gemini:gemini-3-flash');
  });

  it('waits and retries when the per-minute free limit is hit', async () => {
    let n = 0;
    setGeminiFetchForTesting(
      (async () =>
        ++n === 1
          ? reply(
              {
                error: {
                  code: 429,
                  status: 'RESOURCE_EXHAUSTED',
                  message: 'Quota exceeded',
                  details: [
                    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
                    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' },
                  ],
                },
              },
              429,
            )
          : ok()) as typeof fetch,
      true,
    );
    const res = await translateWithGemini(settings, request);
    expect(n).toBe(2);
    expect(res.output.blocks).toHaveLength(1);
  });

  it('reports an exhausted daily quota without retrying', async () => {
    let n = 0;
    setGeminiFetchForTesting(
      (async () => {
        n++;
        return reply(
          {
            error: {
              code: 429,
              message: 'Quota exceeded',
              details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
            },
          },
          429,
        );
      }) as typeof fetch,
      true,
    );
    const err = await translateWithGemini(settings, request).catch((e) => e);
    expect(n).toBe(1);
    expect(err).toBeInstanceOf(TranslateError);
    expect(err.code).toBe('rate_limit');
    expect(err.message).toMatch(/free Gemini quota/);
  });

  it('explains an invalid key and blocked pages', async () => {
    setGeminiFetchForTesting((async () =>
      reply({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }, 400)) as typeof fetch);
    expect((await translateWithGemini(settings, request).catch((e) => e)).code).toBe('auth');

    setGeminiFetchForTesting((async () => reply({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] })) as typeof fetch);
    const err = await translateWithGemini(settings, request).catch((e) => e);
    expect(err.code).toBe('refusal');
  });

  it('requires a key', async () => {
    expect((await translateWithGemini({ ...settings, geminiApiKey: '' }, request).catch((e) => e)).code).toBe('no_api_key');
  });
});

describe('denormalize', () => {
  it('leaves pixel answers alone', () => {
    const px = { blocks: [{ ...block, text_box: { x_min: 10, y_min: 1100, x_max: 50, y_max: 1180 } }] } as never;
    expect(denormalize(px, 800, 1200)).toBe(px);
  });
});

describe('testGemini / listGeminiModels', () => {
  it('returns the display name and filters usable models', async () => {
    setGeminiFetchForTesting((async (url: RequestInfo | URL) =>
      String(url).includes('pageSize')
        ? reply({
            models: [
              { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
              { name: 'models/gemini-flash-lite-latest', supportedGenerationMethods: ['generateContent', 'countTokens'] },
            ],
          })
        : reply({ name: 'models/gemini-flash-latest', displayName: 'Gemini Flash Latest' })) as typeof fetch);
    expect(await testGemini(settings)).toBe('Gemini Flash Latest');
    expect(await listGeminiModels(settings)).toEqual(['gemini-flash-latest', 'gemini-flash-lite-latest']);
  });
});

describe('Gemini settings and prompt', () => {
  it('needs its own key and has its own cache identity', () => {
    const s = normalizeSettings({ provider: 'gemini', apiKey: 'sk-ant', geminiModel: 'models/gemini-x' });
    expect(isConfigured(s)).toBe(false);
    expect(s.geminiModel).toBe('gemini-x');
    expect(activeModel(s)).toBe('gemini:gemini-x');
    expect(isConfigured({ ...s, geminiApiKey: 'k' })).toBe(true);
  });

  it('asks for 0–1000 coordinates in normalized mode', () => {
    const t = buildUserText({ width: 800, height: 1200, tileIndex: 0, tileCount: 1, coords: 'normalized' });
    expect(t).toContain('0 to 1000');
    expect(buildUserText({ width: 800, height: 1200, tileIndex: 0, tileCount: 1 })).toContain('pixel coordinates');
  });
});
