import { afterEach, describe, expect, it } from 'vitest';
import { setFetchForTesting, translateWithClaude } from '../../src/background/claude';
import { TranslateError } from '../../src/background/errors';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

function fakeFetch(reply: Record<string, unknown>, captured: Captured[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    captured.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const output = {
  blocks: [
    {
      kind: 'speech',
      text_box: { x_min: 10, y_min: 20, x_max: 60, y_max: 120 },
      bubble_box: { x_min: 0, y_min: 10, x_max: 90, y_max: 140 },
      original: '待って！',
      translation: 'Wait!',
      emphasis: 'shout',
      note: '',
    },
  ],
};

const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: JSON.stringify(output) }],
  stop_reason: 'end_turn',
  stop_details: null,
  stop_sequence: null,
  usage: { input_tokens: 1500, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...overrides,
});

const request = { width: 800, height: 1200, system: 'SYSTEM', userText: 'USER', imageBase64: 'QUJD', mediaType: 'image/jpeg' as const };
const base = { apiKey: 'sk-ant-test', baseURL: '', effort: 'low' as const, useFallbacks: true };

afterEach(() => setFetchForTesting(undefined));

describe('translateWithClaude', () => {
  it('sends the page image with structured output, effort and server-side fallbacks for Opus', async () => {
    const captured: Captured[] = [];
    setFetchForTesting(fakeFetch(message(), captured));
    const res = await translateWithClaude({ ...base, model: 'claude-opus-5-5' }, request);

    expect(res.output).toEqual(output);
    expect(res.usage).toEqual({ inputTokens: 1500, outputTokens: 300 });
    expect(captured).toHaveLength(1);
    const { url, headers, body } = captured[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect(body.system).toBe('SYSTEM');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.properties.blocks.type).toBe('array');
    expect(body.thinking).toBeUndefined();
    expect(body.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' },
    });
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'USER' });
  });

  it('omits fallbacks for Haiku and when disabled', async () => {
    for (const settings of [
      { ...base, model: 'claude-haiku-5-5' },
      { ...base, model: 'claude-opus-5-5', useFallbacks: false },
    ]) {
      const captured: Captured[] = [];
      setFetchForTesting(fakeFetch(message({ model: settings.model }), captured));
      await translateWithClaude(settings, request);
      expect(captured[0].body.fallbacks).toBeUndefined();
      expect(captured[0].headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback');
    }
  });

  it('uses a custom base URL', async () => {
    const captured: Captured[] = [];
    setFetchForTesting(fakeFetch(message(), captured));
    await translateWithClaude({ ...base, baseURL: 'http://127.0.0.1:9999', model: 'claude-opus-5-5' }, request);
    expect(captured[0].url).toBe('http://127.0.0.1:9999/v1/messages?beta=true');
  });

  it('turns a refusal into a typed error', async () => {
    setFetchForTesting(
      fakeFetch(
        message({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: null } }),
        [],
      ),
    );
    const err = await translateWithClaude({ ...base, model: 'claude-opus-5-5' }, request).catch((e) => e);
    expect(err).toBeInstanceOf(TranslateError);
    expect(err.code).toBe('refusal');
    expect(err.message).toContain('general_harms');
  });

  it('requires an API key', async () => {
    const err = await translateWithClaude({ ...base, apiKey: '', model: 'claude-opus-5-5' }, request).catch((e) => e);
    expect(err).toBeInstanceOf(TranslateError);
    expect(err.code).toBe('no_api_key');
  });
});
