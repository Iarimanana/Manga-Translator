import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ModelOutputSchema, type ModelOutput } from '../shared/schema';
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

const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export async function translateWithClaude(
  settings: Pick<Settings, 'apiKey' | 'baseURL' | 'model' | 'effort' | 'useFallbacks'>,
  req: PageRequest,
): Promise<PageResponse> {
  const client = createClient(settings);
  // Opus and Sonnet can decline a page their safety classifiers flag (violent or mature
  // manga sometimes trips them); a server-side fallback re-runs it on Anthropic's
  // recommended substitute model instead of failing the page.
  const fallback = settings.useFallbacks && modelSupportsFallbacks(settings.model);

  const response = await client.beta.messages.parse({
    model: settings.model,
    max_tokens: 16000,
    system: req.system,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: req.mediaType, data: req.imageBase64 } },
          { type: 'text', text: req.userText },
        ],
      },
    ],
    output_config: {
      effort: settings.effort,
      format: betaZodOutputFormat(ModelOutputSchema),
    },
    ...(fallback ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  });

  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category;
    throw new TranslateError(
      'refusal',
      `Claude declined to translate this page${category ? ` (${category})` : ''}.`,
    );
  }
  if (response.stop_reason === 'max_tokens') {
    throw new TranslateError('api', 'The response was cut off before it finished. Try a smaller image or slice.');
  }
  const output = response.parsed_output;
  if (!output) {
    throw new TranslateError('api', 'Claude returned a response that could not be read as a translation.');
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

/** Cheap credential + model check used by the settings page (no tokens are generated). */
export async function testConnection(settings: Pick<Settings, 'apiKey' | 'baseURL' | 'model'>): Promise<string> {
  const client = createClient(settings);
  const model = await client.models.retrieve(settings.model);
  return model.display_name || model.id;
}
