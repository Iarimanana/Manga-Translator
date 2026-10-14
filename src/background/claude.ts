import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { EditorOutputSchema, ModelOutputSchema, type EditorOutput, type ModelOutput } from '../shared/schema';
import { modelSupportsFallbacks, type Settings } from '../shared/settings';
import type { Usage } from '../shared/types';
import { TranslateError } from './errors';

type ClientSettings = Pick<Settings, 'apiKey' | 'baseURL'>;

/** Lets tests swap the network layer without touching the SDK. */
let fetchOverride: typeof fetch | undefined;
export function setFetchForTesting(f: typeof fetch | undefined): void {
  fetchOverride = f;
}

export function createClient(s: ClientSettings): Anthropic {
  if (!s.apiKey) {
    throw new TranslateError('no_api_key', 'Add your Anthropic API key in the extension settings to start translating.');
  }
  return new Anthropic({
    apiKey: s.apiKey,
    baseURL: s.baseURL || undefined,
    // The key belongs to the person using the extension and never leaves their browser
    // except to go to the API itself.
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
    timeout: 5 * 60 * 1000,
    fetch: fetchOverride,
  });
}

export interface PageRequest {
  /** Size of the image being sent, in pixels. */
  width: number;
  height: number;
  system: string;
  userText: string;
  imageBase64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export interface PageResponse {
  output: ModelOutput;
  usage: Usage;
  model: string;
}

/** Text-only request for the editor / proofreader pass. */
export interface EditRequest {
  system: string;
  userText: string;
}

export interface EditResponse {
  output: EditorOutput;
  usage: Usage;
  model: string;
}

const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
type ClaudeSettings = Pick<Settings, 'apiKey' | 'baseURL' | 'model' | 'effort' | 'useFallbacks'>;

/** One structured-output Messages API call; the reply is validated against `schema`. */
async function callClaude<S extends z.ZodType>(
  settings: ClaudeSettings,
  system: string,
  content: Anthropic.Beta.BetaContentBlockParam[],
  schema: S,
  what: string,
): Promise<{ output: z.infer<S>; usage: Usage; model: string }> {
  const client = createClient(settings);
  // Opus and Sonnet can decline a page their safety classifiers flag (violent or mature
  // manga sometimes trips them); a server-side fallback re-runs it on Anthropic's
  // recommended substitute model instead of failing the page.
  const fallback = settings.useFallbacks && modelSupportsFallbacks(settings.model);

  const response = await client.beta.messages.parse({
    model: settings.model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content }],
    output_config: {
      effort: settings.effort,
      format: betaZodOutputFormat(schema),
    },
    ...(fallback ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  });

  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category;
    throw new TranslateError('refusal', `Claude declined to ${what}${category ? ` (${category})` : ''}.`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new TranslateError('api', 'The response was cut off before it finished. Try a smaller image or slice.');
  }
  const output = response.parsed_output as z.infer<S> | null;
  if (!output) {
    throw new TranslateError('api', `Claude returned a response that could not be read (${what}).`);
  }
  return {
    output,
    usage: {
      inputTokens:
        response.usage.input_tokens +
        (response.usage.cache_creation_input_tokens ?? 0) +
        (response.usage.cache_read_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
    },
    model: response.model,
  };
}

export function translateWithClaude(settings: ClaudeSettings, req: PageRequest): Promise<PageResponse> {
  return callClaude(
    settings,
    req.system,
    [
      { type: 'image', source: { type: 'base64', media_type: req.mediaType, data: req.imageBase64 } },
      { type: 'text', text: req.userText },
    ],
    ModelOutputSchema,
    'translate this page',
  );
}

export function editWithClaude(settings: ClaudeSettings, req: EditRequest): Promise<EditResponse> {
  return callClaude(settings, req.system, [{ type: 'text', text: req.userText }], EditorOutputSchema, 'edit this page');
}

/** Cheap credential + model check used by the settings page (no tokens are generated). */
export async function testConnection(settings: Pick<Settings, 'apiKey' | 'baseURL' | 'model'>): Promise<string> {
  const client = createClient(settings);
  const model = await client.models.retrieve(settings.model);
  return model.display_name || model.id;
}
