import Anthropic from '@anthropic-ai/sdk';
import type { ErrorCode } from '../shared/messages';

export class TranslateError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TranslateError';
  }
}

/** Turn anything thrown during a translation into a user-facing error with a stable code. */
export function toTranslateError(err: unknown): TranslateError {
  if (err instanceof TranslateError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new TranslateError('auth', 'Claude rejected the API key. Check it in the extension settings.');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new TranslateError('auth', `This API key cannot use the selected model: ${err.message}`);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new TranslateError('api', `Model or endpoint not found — check the model name in settings. (${err.message})`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new TranslateError('rate_limit', 'Rate limited by the Claude API. Wait a moment or lower the concurrency in settings.');
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new TranslateError('api', `Claude API rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new TranslateError('network', 'The request to Claude timed out.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new TranslateError('network', 'Could not reach the Claude API. Check your connection or API base URL.');
  }
  if (err instanceof Anthropic.APIError) {
    return new TranslateError('api', `Claude API error ${err.status ?? ''}: ${err.message}`.trim());
  }
  const message = err instanceof Error ? err.message : String(err);
  return new TranslateError('unknown', message);
}
