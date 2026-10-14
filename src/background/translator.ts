import { assembleBlocks, finalizeBlocks, type TileResult } from '../shared/assemble';
import { planTiles } from '../shared/geometry';
import type { Stats } from '../shared/messages';
import { PROMPT_VERSION, buildSystemPrompt, buildUserText } from '../shared/prompt';
import { activeModel, isConfigured, loadSettings, missingKeyMessage, type Settings } from '../shared/settings';
import type { ImageSource, PageTranslation, Usage } from '../shared/types';
import { cacheCount, cacheGet, cachePut } from './cache';
import { translateWithClaude, type PageRequest, type PageResponse } from './claude';
import { translateWithGemini } from './gemini';
import { translateWithLocal } from './local';
import { TranslateError } from './errors';
import { backgroundSampler, decodeImage, encodeTile, loadImageBlob, sha256Hex } from './image';

/** Limits how many Claude requests run at once across all tabs. */
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(public limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      // The releasing task hands its slot over directly, so `active` is not incremented here.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.active <= this.limit ? this.queue.shift() : undefined;
      if (next) next();
      else this.active--;
    }
  }
}

const semaphore = new Semaphore(3);
const inFlight = new Map<string, Promise<PageTranslation>>();

export async function cacheKeyFor(imageHash: string, s: Settings, context: string): Promise<string> {
  const settingsPart = [
    PROMPT_VERSION,
    activeModel(s),
    s.targetLang,
    s.sourceLang,
    s.translateSfx ? 1 : 0,
    s.maxImageEdge,
    s.customInstructions.trim(),
    context.trim(),
  ].join('\u0000');
  return `${imageHash}:${await sha256Hex(settingsPart)}`;
}

export interface TranslateOptions {
  source: ImageSource;
  context?: string;
  force?: boolean;
}

export async function translateImage(opts: TranslateOptions): Promise<PageTranslation> {
  const settings = await loadSettings();
  if (!isConfigured(settings)) {
    throw new TranslateError('no_api_key', missingKeyMessage(settings));
  }
  // A local GPU handles one page at a time; Gemini's free tier allows ~10 requests a minute.
  semaphore.limit =
    settings.provider === 'local' ? 1 : settings.provider === 'gemini' ? Math.min(2, settings.concurrency) : settings.concurrency;

  const blob = await loadImageBlob(opts.source);
  const bytes = await blob.arrayBuffer();
  const key = await cacheKeyFor(await sha256Hex(bytes), settings, opts.context ?? '');

  if (settings.cacheEnabled && !opts.force) {
    const hit = await cacheGet(key).catch(() => undefined);
    if (hit) {
      await bumpStats({ cacheHits: 1 });
      return { ...hit, cached: true };
    }
  }

  let job = inFlight.get(key);
  if (!job) {
    job = runPipeline(blob, settings, opts.context ?? '')
      .then(async (page) => {
        if (settings.cacheEnabled) await cachePut(key, page).catch((e) => console.warn('cache write failed', e));
        await bumpStats({ pagesTranslated: 1, usage: page.usage });
        return page;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return job;
}

async function runPipeline(blob: Blob, settings: Settings, context: string): Promise<PageTranslation> {
  const bitmap = await decodeImage(blob);
  try {
    const { width, height } = bitmap;
    if (width < 16 || height < 16) throw new TranslateError('image', 'The image is too small to translate.');
    const tiles = planTiles(width, height);
    const system = buildSystemPrompt(settings);
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let model = activeModel(settings);
    const translate = (req: PageRequest): Promise<PageResponse> =>
      settings.provider === 'local'
        ? translateWithLocal(settings, req)
        : settings.provider === 'gemini'
          ? translateWithGemini(settings, req)
          : translateWithClaude(settings, req);

    const results: TileResult[] = await Promise.all(
      tiles.map(async (tile, i) => {
        const encoded = await encodeTile(bitmap, tile, settings.maxImageEdge);
        const userText = buildUserText({
          width: encoded.width,
          height: encoded.height,
          tileIndex: i,
          tileCount: tiles.length,
          context: i === 0 ? context : undefined,
          coords: settings.provider === 'gemini' ? 'normalized' : 'pixels',
        });
        const res = await semaphore.run(() =>
          translate({
            width: encoded.width,
            height: encoded.height,
            system,
            userText,
            imageBase64: encoded.base64,
            mediaType: encoded.mediaType,
          }),
        );
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;
        model = res.model;
        return { tile, sentW: encoded.width, sentH: encoded.height, blocks: res.output.blocks };
      }),
    );

    const blocks = finalizeBlocks(assembleBlocks(results), width, height, backgroundSampler(bitmap));
    return { width, height, blocks, model, targetLang: settings.targetLang, createdAt: Date.now(), usage };
  } finally {
    bitmap.close();
  }
}

const STATS_KEY = 'stats';
const EMPTY_STATS = { pagesTranslated: 0, cacheHits: 0, usage: { inputTokens: 0, outputTokens: 0 } };
let statsWrite: Promise<void> = Promise.resolve();

function bumpStats(delta: { pagesTranslated?: number; cacheHits?: number; usage?: Usage }): Promise<void> {
  // Serialise read-modify-write cycles so concurrent pages don't lose updates.
  statsWrite = statsWrite.then(async () => {
    const cur = { ...EMPTY_STATS, ...((await chrome.storage.local.get(STATS_KEY))[STATS_KEY] ?? {}) };
    await chrome.storage.local.set({
      [STATS_KEY]: {
        pagesTranslated: cur.pagesTranslated + (delta.pagesTranslated ?? 0),
        cacheHits: cur.cacheHits + (delta.cacheHits ?? 0),
        usage: {
          inputTokens: cur.usage.inputTokens + (delta.usage?.inputTokens ?? 0),
          outputTokens: cur.usage.outputTokens + (delta.usage?.outputTokens ?? 0),
        },
      },
    });
  });
  return statsWrite.catch(() => {});
}

export async function getStats(): Promise<Stats> {
  const cur = { ...EMPTY_STATS, ...((await chrome.storage.local.get(STATS_KEY))[STATS_KEY] ?? {}) };
  return { ...cur, cacheEntries: await cacheCount().catch(() => 0) };
}

export async function resetStats(): Promise<void> {
  await chrome.storage.local.remove(STATS_KEY);
}
