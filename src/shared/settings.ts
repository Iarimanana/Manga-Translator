export type Effort = 'low' | 'medium' | 'high';
export type FontChoice = 'comic' | 'sans' | 'serif' | 'custom';

export interface Settings {
  /** Anthropic API key. Stored only in chrome.storage.local on this device. */
  apiKey: string;
  model: string;
  effort: Effort;
  /** Retry pages Claude declines on Anthropic's recommended fallback model (Opus/Sonnet only). */
  useFallbacks: boolean;
  /** Optional API base URL (proxy / gateway). Empty means the official endpoint. */
  baseURL: string;
  targetLang: string;
  sourceLang: string;
  translateSfx: boolean;
  /** Free-form instructions and glossary appended to the prompt. */
  customInstructions: string;
  fontFamily: FontChoice;
  customFont: string;
  fontScale: number;
  overlayOpacity: number;
  /** Rendered size (CSS px) both sides of an image must reach to be considered manga. */
  minImageSize: number;
  /** Longest edge (px) of each image slice sent to Claude. */
  maxImageEdge: number;
  concurrency: number;
  showHoverButton: boolean;
  /** Hostnames where every manga image is translated automatically while scrolling. */
  autoSites: string[];
  /** Hostnames where the extension stays completely inactive. */
  disabledSites: string[];
  /** Reader: send the previous page's dialogue as context. */
  useContext: boolean;
  cacheEnabled: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  /** Whether the model accepts `fallbacks: "default"`. */
  fallbacks: boolean;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best quality', fallbacks: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — faster, cheaper', fallbacks: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest', fallbacks: false },
];

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'low',
  useFallbacks: true,
  baseURL: '',
  targetLang: 'en',
  sourceLang: 'auto',
  translateSfx: false,
  customInstructions: '',
  fontFamily: 'comic',
  customFont: '',
  fontScale: 1,
  overlayOpacity: 1,
  minImageSize: 200,
  maxImageEdge: 2048,
  concurrency: 3,
  showHoverButton: true,
  autoSites: [],
  disabledSites: [],
  useContext: true,
  cacheEnabled: true,
};

const SETTINGS_KEY = 'settings';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Fill in defaults and coerce out-of-range values from older or hand-edited storage. */
export function normalizeSettings(raw: Partial<Settings> | undefined | null): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  s.fontScale = clamp(num(s.fontScale, 1), 0.5, 2);
  s.overlayOpacity = clamp(num(s.overlayOpacity, 1), 0.3, 1);
  s.minImageSize = clamp(Math.round(num(s.minImageSize, 200)), 50, 2000);
  s.maxImageEdge = clamp(Math.round(num(s.maxImageEdge, 2048)), 768, 2576);
  s.concurrency = clamp(Math.round(num(s.concurrency, 3)), 1, 8);
  if (!['low', 'medium', 'high'].includes(s.effort)) s.effort = DEFAULT_SETTINGS.effort;
  if (!['comic', 'sans', 'serif', 'custom'].includes(s.fontFamily)) s.fontFamily = 'comic';
  s.autoSites = Array.isArray(s.autoSites) ? s.autoSites.filter((x) => typeof x === 'string') : [];
  s.disabledSites = Array.isArray(s.disabledSites) ? s.disabledSites.filter((x) => typeof x === 'string') : [];
  s.model = (s.model || DEFAULT_SETTINGS.model).trim();
  s.apiKey = (s.apiKey || '').trim();
  s.baseURL = (s.baseURL || '').trim().replace(/\/+$/, '');
  return s;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      cb(normalizeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings>));
    }
  });
}

export function modelSupportsFallbacks(model: string): boolean {
  return MODEL_OPTIONS.find((m) => m.id === model)?.fallbacks ?? false;
}

/** CSS font-family stack for the overlay text. */
export function fontStack(s: Pick<Settings, 'fontFamily' | 'customFont'>): string {
  switch (s.fontFamily) {
    case 'sans':
      return "'Helvetica Neue', Arial, 'Noto Sans', 'Noto Sans CJK JP', sans-serif";
    case 'serif':
      return "Georgia, 'Times New Roman', 'Noto Serif', serif";
    case 'custom':
      return `${s.customFont ? `'${s.customFont.replace(/'/g, '')}', ` : ''}'MangaTranslatorComic', sans-serif`;
    default:
      return "'MangaTranslatorComic', 'Comic Neue', 'Comic Sans MS', 'Noto Sans', sans-serif";
  }
}

/** Hostname helper that tolerates odd URLs (file://, about:blank, ...). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
