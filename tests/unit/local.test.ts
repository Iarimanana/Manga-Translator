import { afterEach, describe, expect, it } from 'vitest';
import { TranslateError } from '../../src/background/errors';
import { parseLocalOutput, setLocalFetchForTesting, testLocal, translateWithLocal } from '../../src/background/local';

afterEach(() => setLocalFetchForTesting(undefined));

const settings = { localBaseURL: 'http://localhost:11434/v1', localModel: 'qwen2.5vl:7b' };
const request = { width: 800, height: 1200, system: 'SYSTEM', userText: 'USER', imageBase64: 'QUJD', mediaType: 'image/jpeg' as const };

describe('parseLocalOutput', () => {
  it('accepts exact schema output', () => {
    const out = {
      blocks: [
        {
          kind: 'narration',
          text_box: { x_min: 1, y_min: 2, x_max: 30, y_max: 40 },
          bubble_box: { x_min: 0, y_min: 0, x_max: 50, y_max: 50 },
          original: 'あ',
          translation: 'Ah',
        },
      ],
    };
    expect(parseLocalOutput(JSON.stringify(out))).toEqual(out);
  });

  it('repairs fenced, thinking-prefixed output with array boxes and missing fields', () => {
    const text = `<think>let me look</think>Here you go:
\`\`\`json
{"blocks":[{"bbox":[10,20,110,220],"text":"待って","translation":"Wait!"},{"bbox":[1,1,5,5],"translation":""},{"kind":"weird","text_box":{"xmin":5,"ymin":6,"xmax":7,"ymax":80},"translation":"Hm"}]}
\`\`\``;
    expect(parseLocalOutput(text).blocks).toEqual([
      {
        kind: 'speech',
        text_box: { x_min: 10, y_min: 20, x_max: 110, y_max: 220 },
        bubble_box: { x_min: 10, y_min: 20, x_max: 110, y_max: 220 },
        original: '待って',
        translation: 'Wait!',
      },
      {
        kind: 'speech',
        text_box: { x_min: 5, y_min: 6, x_max: 7, y_max: 80 },
        bubble_box: { x_min: 5, y_min: 6, x_max: 7, y_max: 80 },
        original: '',
        translation: 'Hm',
      },
    ]);
  });

  it('accepts a bare array of blocks', () => {
    expect(parseLocalOutput('[{"text_box":[0,0,10,10],"translation":"Yo"}]').blocks).toHaveLength(1);
  });

  it('rejects text with no JSON', () => {
    expect(() => parseLocalOutput('I cannot read this image.')).toThrow(TranslateError);
  });
});

describe('translateWithLocal', () => {
  it('sends an OpenAI-compatible vision request with a JSON schema', async () => {
    let url = '';
    let body: any;
    setLocalFetchForTesting((async (u: RequestInfo | URL, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          model: 'qwen2.5vl:7b',
          choices: [{ message: { content: '{"blocks":[]}' } }],
          usage: { prompt_tokens: 900, completion_tokens: 12 },
        }),
      );
    }) as typeof fetch);
    const res = await translateWithLocal(settings, request);
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(body.model).toBe('qwen2.5vl:7b');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('SYSTEM');
    expect(body.messages[1].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
    expect(body.messages[1].content[1]).toEqual({ type: 'text', text: 'USER' });
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.properties.blocks.type).toBe('array');
    expect(res).toEqual({ output: { blocks: [] }, usage: { inputTokens: 900, outputTokens: 12 }, model: 'local:qwen2.5vl:7b' });
  });

  it('explains how to fix a 403 from Ollama', async () => {
    setLocalFetchForTesting((async () => new Response('', { status: 403 })) as typeof fetch);
    await expect(translateWithLocal(settings, request)).rejects.toThrow(/OLLAMA_ORIGINS/);
  });

  it('explains when the server is not running', async () => {
    setLocalFetchForTesting((async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    await expect(translateWithLocal(settings, request)).rejects.toThrow(/Is Ollama \/ LM Studio running/);
  });
});

describe('testLocal', () => {
  it('finds the model, tolerating the :latest tag', async () => {
    setLocalFetchForTesting((async () =>
      new Response(JSON.stringify({ data: [{ id: 'gemma3:12b' }, { id: 'qwen2.5vl:7b' }] }))) as typeof fetch);
    expect(await testLocal(settings)).toBe('qwen2.5vl:7b (local)');
    expect(await testLocal({ ...settings, localModel: 'gemma3:12b' })).toBe('gemma3:12b (local)');
  });

  it('tells the user to pull a missing model', async () => {
    setLocalFetchForTesting((async () => new Response(JSON.stringify({ data: [{ id: 'llama3:8b' }] }))) as typeof fetch);
    await expect(testLocal(settings)).rejects.toThrow(/ollama pull qwen2.5vl:7b/);
  });
});
