import { assembleBlocks, finalizeBlocks, type TileResult } from '../shared/assemble';
import { planTiles } from '../shared/geometry';
import type { Stats } from '../shared/messages';
import {
  PROMPT_VERSION,
  buildEditorPrompt,
  buildEditorUserText,
  buildSystemPrompt,
  buildUserText,
  type ScriptLine,
} from '../shared/prompt';
import { balloonCapacity, runQc } from '../shared/qc';
import { toHex } from '../shared/colors';
import { toPixelBox } from '../shared/geometry';
import { activeModel, isConfigured, loadSettings, missingKeyMessage, type Settings } from '../shared/settings';
import type { ImageSource, PageTranslation, QcIssue, TranslatedBlock, Usage } from '../shared/types';
import { cacheCount, cacheGet, cachePut } from './cache';
import {
  editWithClaude,
  translateWithClaude,
  type EditRequest,
  type EditResponse,
  type PageRequest,
  type PageResponse,
} from './claude';
import { cleanBlock } from './clean';
import { editWithGemini, translateWithGemini } from './gemini';
import { editWithLocal, translateWithLocal } from './local';
import { TranslateError, toTranslateError } from './errors';
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
    s.sfxStyle,
    s.workflow,
    s.adaptation,
    s.cleaning,
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

/** Engine-specific calls for the two model steps of the workflow. */
function engine(settings: Settings) {
  switch (settings.provider) {
    case 'local':
      return {
        translate: (r: PageRequest) => translateWithLocal(settings, r),
        edit: (r: EditRequest) => editWithLocal(settings, r),
      };
    case 'gemini':
      return {
        translate: (r: PageRequest) => translateWithGemini(settings, r),
        edit: (r: EditRequest) => editWithGemini(settings, r),
      };
    default:
      return {
        translate: (r: PageRequest) => translateWithClaude(settings, r),
        edit: (r: EditRequest) => editWithClaude(settings, r),
      };
  }
}

/** QC findings worth sending back to the editor. */
const FIXABLE = new Set<QcIssue['kind']>(['leftover-source', 'untranslated', 'too-long']);

/**
 * The localisation workflow for one page:
 *  1. translation & adaptation (vision model reads and translates the page)
 *  2. editing & proofreading (text-only editor pass over the whole page script)
 *  3. image cleaning (flat fill for plain balloons, inpainting over artwork)
 *  4. typesetting and 5. SFX handling happen at render time from the data produced here
 *  6. quality control (automatic checks; fixable problems go back to the editor once)
 */
async function runPipeline(blob: Blob, settings: Settings, context: string): Promise<PageTranslation> {
  const bitmap = await decodeImage(blob);
  try {
    const { width, height } = bitmap;
    if (width < 16 || height < 16) throw new TranslateError('image', 'The image is too small to translate.');
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const steps: string[] = [];
    let model = activeModel(settings);
    const { translate, edit } = engine(settings);
    const count = (r: { usage: Usage; model: string }) => {
      usage.inputTokens += r.usage.inputTokens;
      usage.outputTokens += r.usage.outputTokens;
      model = r.model;
    };

    // 1. Translation and adaptation.
    const tiles = planTiles(width, height);
    const system = buildSystemPrompt(settings);
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
        count(res);
        return { tile, sentW: encoded.width, sentH: encoded.height, blocks: res.output.blocks };
      }),
    );
    let blocks = finalizeBlocks(assembleBlocks(results), width, height, backgroundSampler(bitmap));
    steps.push('translate');
    if (settings.sfxStyle === 'none') blocks = blocks.filter((b) => b.kind !== 'sfx');

    // 2. Editing and proofreading, and 6. quality control with one fix round.
    let qc: QcIssue[] = [];
    if (blocks.length && settings.workflow === 'full') {
      const editorSystem = buildEditorPrompt(settings);
      const runEditor = async (issues?: string[]) => {
        const lines: ScriptLine[] = blocks.map((b, id) => ({
          id,
          kind: b.kind,
          original: b.original,
          translation: b.translation,
          emphasis: b.emphasis ?? 'normal',
          note: b.note ?? '',
          capacity: balloonCapacity(b, width, height),
        }));
        const res: EditResponse = await semaphore.run(() =>
          edit({ system: editorSystem, userText: buildEditorUserText(lines, context, issues) }),
        );
        count(res);
        blocks = applyEdits(blocks, res.output.blocks);
      };
      try {
        await runEditor();
        steps.push('edit');
        qc = runQc(blocks, width, height, settings.targetLang);
        const fixable = qc.filter((i) => FIXABLE.has(i.kind));
        if (fixable.length) {
          await runEditor(fixable.map((i) => i.message));
          qc = runQc(blocks, width, height, settings.targetLang);
        }
      } catch (err) {
        // A failed editing pass keeps the draft translation instead of failing the page.
        const e = toTranslateError(err);
        qc = [...runQc(blocks, width, height, settings.targetLang), { block: -1, kind: 'editor', message: `Editing pass skipped: ${e.message}` }];
      }
    } else {
      qc = runQc(blocks, width, height, settings.targetLang);
    }
    steps.push('qc');

    // 3. Image cleaning (and the ink colour used to redraw replaced SFX).
    if (settings.cleaning === 'auto') {
      blocks = await Promise.all(
        blocks.map(async (b) => {
          if (b.kind === 'sfx' && settings.sfxStyle !== 'replace') return b;
          const res = await cleanBlock(bitmap, toPixelBox(b.textRect, width, height), b.kind === 'sfx').catch(() => null);
          if (!res) return b;
          return { ...b, ink: toHex(res.ink), ...(res.patch ? { clean: res.patch } : {}) };
        }),
      );
      steps.push('clean');
    }

    return { width, height, blocks, model, targetLang: settings.targetLang, createdAt: Date.now(), usage, qc, steps };
  } finally {
    bitmap.close();
  }
}

/** Merge the editor's revisions into the blocks (matched by id = position). */
export function applyEdits(
  blocks: TranslatedBlock[],
  edits: { id: number; translation: string; emphasis: TranslatedBlock['emphasis']; note: string }[],
): TranslatedBlock[] {
  const byId = new Map(edits.map((e) => [e.id, e]));
  return blocks.map((b, i) => {
    const e = byId.get(i);
    if (!e || !e.translation.trim()) return b;
    return { ...b, translation: e.translation.trim(), emphasis: e.emphasis ?? b.emphasis, note: e.note?.trim() ?? b.note };
  });
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
