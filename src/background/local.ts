import { ParseError, extractJson, parseEditorOutput, parsePageOutput } from '../shared/parse';
import { EditorOutputSchema, jsonSchemaOf, modelOutputJsonSchema, type ModelOutput } from '../shared/schema';
import type { Settings } from '../shared/settings';
import type { Usage } from '../shared/types';
import type { EditRequest, EditResponse, PageRequest, PageResponse } from './claude';
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
{"blocks":[{"kind":"speech","text_box":{"x_min":0,"y_min":0,"x_max":0,"y_max":0},"bubble_box":{"x_min":0,"y_min":0,"x_max":0,"y_max":0},"original":"...","translation":"...","emphasis":"normal","note":""}]}`;

const RESPONSE_SCHEMA = modelOutputJsonSchema();
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

/** Extract and repair a page result from a local model's reply. */
export function parseLocalOutput(text: string): ModelOutput {
  try {
    return parsePageOutput(extractJson(text));
  } catch (err) {
    if (err instanceof ParseError) {
      throw new TranslateError('api', `${err.message} Try again or use a different model.`);
    }
    throw err;
  }
}

interface ChatResult {
  text: string;
  usage: Usage;
  model: string;
}

/** One OpenAI-compatible chat completion with a JSON schema response format. */
async function chat(
  settings: LocalSettings,
  system: string,
  user: unknown[],
  schemaName: string,
  schema: Record<string, unknown>,
): Promise<ChatResult> {
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
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
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
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
    model: `local:${json.model ?? settings.localModel}`,
  };
}

export async function translateWithLocal(settings: LocalSettings, req: PageRequest): Promise<PageResponse> {
  const r = await chat(
    settings,
    `${req.system}\n\n${LOCAL_FORMAT_HINT}`,
    [
      { type: 'image_url', image_url: { url: `data:${req.mediaType};base64,${req.imageBase64}` } },
      { type: 'text', text: req.userText },
    ],
    'manga_page',
    RESPONSE_SCHEMA,
  );
  return { output: parseLocalOutput(r.text), usage: r.usage, model: r.model };
}

export const EDITOR_FORMAT_HINT = `Reply with JSON only, exactly in this shape:
{"blocks":[{"id":0,"translation":"...","emphasis":"normal","note":""}]}`;

export async function editWithLocal(settings: LocalSettings, req: EditRequest): Promise<EditResponse> {
  const r = await chat(
    settings,
    `${req.system}\n\n${EDITOR_FORMAT_HINT}`,
    [{ type: 'text', text: req.userText }],
    'manga_script',
    jsonSchemaOf(EditorOutputSchema),
  );
  try {
    return { output: parseEditorOutput(extractJson(r.text)), usage: r.usage, model: r.model };
  } catch (err) {
    throw new TranslateError('api', `The editor pass failed: ${(err as Error).message}`);
  }
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
