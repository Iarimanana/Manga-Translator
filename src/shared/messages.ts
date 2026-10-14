import type { ImageSource, PageTranslation, Usage, ViewportRect } from './types';

/** Requests handled by the background service worker. */
export type BackgroundRequest =
  | { type: 'translate'; source: ImageSource; context?: string; force?: boolean }
  | { type: 'captureViewport'; rect: ViewportRect; viewportW: number }
  | { type: 'testConnection' }
  | { type: 'listGeminiModels' }
  | { type: 'clearCache' }
  | { type: 'getStats' }
  | { type: 'openReader' }
  | { type: 'openOptions' };

export type TranslateResponse =
  | { ok: true; result: PageTranslation }
  | { ok: false; error: string; code?: ErrorCode };

export type CaptureResponse = { ok: true; dataUrl: string } | { ok: false; error: string; code?: ErrorCode };

export type ErrorCode = 'no_api_key' | 'auth' | 'rate_limit' | 'refusal' | 'image' | 'network' | 'api' | 'unknown';

export interface Stats {
  pagesTranslated: number;
  cacheHits: number;
  usage: Usage;
  cacheEntries: number;
}

/** Commands sent to the content script of a tab (from popup, context menu or shortcuts). */
export type ContentCommand =
  | { type: 'translatePage' }
  | { type: 'translateImage'; srcUrl: string }
  | { type: 'startRegion' }
  | { type: 'toggleOverlays' }
  | { type: 'clearOverlays' }
  | { type: 'setAuto'; enabled: boolean }
  | { type: 'getStatus' };

export interface ContentStatus {
  images: number;
  translated: number;
  pending: number;
  failed: number;
  overlaysVisible: boolean;
  auto: boolean;
}

export function sendToBackground<T = unknown>(msg: BackgroundRequest): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}
