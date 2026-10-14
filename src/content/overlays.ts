import type { CaptureResponse, ContentStatus, ErrorCode, TranslateResponse } from '../shared/messages';
import { ensureFont, overlayStyleFrom, renderBlocksDom, togglePeek, type OverlayStyle } from '../shared/render';
import type { Settings } from '../shared/settings';
import type { PageTranslation, Rect, ViewportRect } from '../shared/types';
import {
  clippingAncestors,
  contentRect,
  findCandidates,
  nextFrame,
  readPixels,
  sourceKey,
  visibleRect,
  type MangaElement,
  type ViewRect,
} from './dom';
import { button, getUi, setUiHidden } from './ui';

export type EntryState = 'idle' | 'queued' | 'pending' | 'done' | 'error';

export interface Entry {
  el: MangaElement;
  srcKey: string;
  state: EntryState;
  force: boolean;
  result?: PageTranslation;
  /** Part of the image (normalised) the result covers; less than all of it for partial screenshots. */
  region: Rect;
  error?: { message: string; code?: ErrorCode };
  layer?: HTMLElement;
  blocks?: HTMLElement;
  status?: HTMLElement;
  statusTimer?: number;
  clips: Element[];
  lastSize: string;
  /** Per-image "show original". */
  showOriginal: boolean;
}

export class TranslateFailure extends Error {
  constructor(
    message: string,
    readonly code?: ErrorCode,
  ) {
    super(message);
  }
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

export function overlayStyle(s: Settings): OverlayStyle {
  return overlayStyleFrom(s);
}

export async function requestTranslation(
  source: { kind: 'url'; url: string; pageUrl?: string } | { kind: 'dataUrl'; dataUrl: string },
  force: boolean,
): Promise<PageTranslation> {
  const res = (await chrome.runtime.sendMessage({ type: 'translate', source, force })) as TranslateResponse | undefined;
  if (!res) throw new TranslateFailure('The extension was updated or reloaded — refresh the page.');
  if (!res.ok) throw new TranslateFailure(res.error, res.code);
  return res.result;
}

/** Screenshot a viewport rectangle with the extension UI hidden. */
export async function captureViewport(rect: ViewportRect): Promise<string> {
  setUiHidden(true);
  try {
    await nextFrame();
    await nextFrame();
    const res = (await chrome.runtime.sendMessage({
      type: 'captureViewport',
      rect,
      viewportW: window.innerWidth,
    })) as CaptureResponse | undefined;
    if (!res) throw new TranslateFailure('The extension was updated or reloaded — refresh the page.');
    if (!res.ok) throw new TranslateFailure(res.error, res.code);
    return res.dataUrl;
  } finally {
    setUiHidden(false);
  }
}

function intersectViewport(r: ViewRect): ViewRect {
  const x0 = Math.max(0, r.left);
  const y0 = Math.max(0, r.top);
  const x1 = Math.min(window.innerWidth, r.left + r.width);
  const y1 = Math.min(window.innerHeight, r.top + r.height);
  return { left: x0, top: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

export class OverlayManager {
  readonly entries = new Map<MangaElement, Entry>();
  private queue: Entry[] = [];
  private running = 0;
  private globalVisible = true;
  private onChange: () => void = () => {};
  private onSourceChange: (el: MangaElement) => void = () => {};

  constructor(public settings: Settings) {}

  setChangeListener(fn: () => void): void {
    this.onChange = fn;
  }

  /** Called when a tracked element starts showing a different image (in-place page turns). */
  setSourceChangeListener(fn: (el: MangaElement) => void): void {
    this.onSourceChange = fn;
  }

  get visible(): boolean {
    return this.globalVisible;
  }

  entry(el: MangaElement): Entry {
    let e = this.entries.get(el);
    if (!e) {
      e = {
        el,
        srcKey: sourceKey(el),
        state: 'idle',
        force: false,
        region: FULL,
        clips: clippingAncestors(el),
        lastSize: '',
        showOriginal: false,
      };
      this.entries.set(el, e);
    }
    return e;
  }

  translate(el: MangaElement, force = false): void {
    const e = this.entry(el);
    if (e.state === 'queued' || e.state === 'pending') return;
    if (e.state === 'done' && !force) {
      this.setShowOriginal(e, false);
      return;
    }
    e.state = 'queued';
    e.force = force;
    e.error = undefined;
    this.queue.push(e);
    this.setStatus(e, 'Queued…', { spinner: true });
    this.onChange();
    this.pump();
  }

  translateAll(): number {
    const els = findCandidates(this.settings.minImageSize);
    for (const el of els) this.translate(el);
    return els.length;
  }

  private pump(): void {
    const limit = this.settings.concurrency + 1;
    while (this.running < limit && this.queue.length) {
      // Work on whatever is closest to what the reader is looking at.
      let bestIdx = 0;
      let bestDist = Infinity;
      this.queue.forEach((e, i) => {
        const r = e.el.getBoundingClientRect();
        const dist = r.bottom < 0 ? -r.bottom + 1 : r.top > innerHeight ? r.top - innerHeight + 1 : 0;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      });
      const [e] = this.queue.splice(bestIdx, 1);
      this.running++;
      void this.process(e).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async process(e: Entry): Promise<void> {
    if (!e.el.isConnected) {
      this.remove(e);
      return;
    }
    e.state = 'pending';
    this.setStatus(e, 'Translating…', { spinner: true });
    const key = sourceKey(e.el);
    e.srcKey = key;
    try {
      const { result, region } = await this.acquire(e);
      if (sourceKey(e.el) !== key) return this.sourceChanged(e); // the reader swapped the page meanwhile
      await ensureFont();
      e.result = result;
      e.region = region;
      e.state = 'done';
      e.lastSize = '';
      e.showOriginal = false;
      this.update(e);
      if (result.blocks.length === 0) this.setStatus(e, 'No text found', { ttl: 2500 });
      else this.clearStatus(e);
    } catch (err) {
      if (sourceKey(e.el) !== key) return this.sourceChanged(e);
      const f = err instanceof TranslateFailure ? err : new TranslateFailure((err as Error).message);
      e.state = 'error';
      e.error = { message: f.message, code: f.code };
      this.showError(e);
    } finally {
      this.onChange();
    }
  }

  /** Get pixels for an element by the cheapest method that works, then translate them. */
  private async acquire(e: Entry): Promise<{ result: PageTranslation; region: Rect }> {
    const el = e.el;
    if (el instanceof HTMLImageElement) {
      const src = el.currentSrc || el.src;
      if (/^https?:/i.test(src)) {
        try {
          return {
            result: await requestTranslation({ kind: 'url', url: src, pageUrl: location.href }, e.force),
            region: FULL,
          };
        } catch (err) {
          if (!(err instanceof TranslateFailure) || err.code !== 'image') throw err;
        }
      }
    }
    const dataUrl = await readPixels(el);
    if (dataUrl) return { result: await requestTranslation({ kind: 'dataUrl', dataUrl }, e.force), region: FULL };
    return this.acquireByScreenshot(e);
  }

  /** Last resort for protected images and canvases: screenshot the visible part. */
  private async acquireByScreenshot(e: Entry): Promise<{ result: PageTranslation; region: Rect }> {
    const cr = contentRect(e.el);
    const vis = intersectViewport(visibleRect(e.el, e.clips));
    const shown = {
      left: Math.max(cr.left, vis.left),
      top: Math.max(cr.top, vis.top),
      right: Math.min(cr.left + cr.width, vis.left + vis.width),
      bottom: Math.min(cr.top + cr.height, vis.top + vis.height),
    };
    const w = shown.right - shown.left;
    const h = shown.bottom - shown.top;
    if (w < 64 || h < 64 || w * h < cr.width * cr.height * 0.25) {
      throw new TranslateFailure('This image is protected; scroll it fully into view and try again.', 'image');
    }
    const dataUrl = await captureViewport({ x: shown.left, y: shown.top, w, h });
    const result = await requestTranslation({ kind: 'dataUrl', dataUrl }, e.force);
    return {
      result,
      region: { x: (shown.left - cr.left) / cr.width, y: (shown.top - cr.top) / cr.height, w: w / cr.width, h: h / cr.height },
    };
  }

  private ensureLayer(e: Entry): HTMLElement {
    if (!e.layer) {
      const layer = document.createElement('div');
      layer.className = 'mt-layer';
      const blocks = document.createElement('div');
      blocks.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%';
      blocks.addEventListener('click', (ev) => {
        if (togglePeek(ev.target)) ev.stopPropagation();
      });
      for (const type of ['mousedown', 'pointerdown', 'mouseup', 'pointerup']) {
        blocks.addEventListener(type, (ev) => {
          if ((ev.target as Element).closest('.mt-block')) ev.stopPropagation();
        });
      }
      layer.appendChild(blocks);
      getUi().layers.appendChild(layer);
      e.layer = layer;
      e.blocks = blocks;
    }
    return e.layer;
  }

  /** Reposition (and re-layout on resize) one entry's overlay. */
  update(e: Entry): void {
    if (!e.el.isConnected) {
      this.remove(e);
      return;
    }
    if (sourceKey(e.el) !== e.srcKey && e.state !== 'queued' && e.state !== 'pending') {
      this.sourceChanged(e);
      return;
    }
    if (!e.layer) return;
    const layer = e.layer;
    const cr = contentRect(e.el);
    const rx = cr.left + e.region.x * cr.width;
    const ry = cr.top + e.region.y * cr.height;
    const rw = e.region.w * cr.width;
    const rh = e.region.h * cr.height;
    const vis = visibleRect(e.el, e.clips);
    const hiddenEntirely = rw < 1 || rh < 1 || vis.width < 1 || vis.height < 1;
    layer.style.display = hiddenEntirely ? 'none' : '';
    if (hiddenEntirely) return;
    layer.style.left = `${rx + window.scrollX}px`;
    layer.style.top = `${ry + window.scrollY}px`;
    layer.style.width = `${rw}px`;
    layer.style.height = `${rh}px`;
    const insetTop = Math.max(0, vis.top - ry);
    const insetLeft = Math.max(0, vis.left - rx);
    const insetRight = Math.max(0, rx + rw - (vis.left + vis.width));
    const insetBottom = Math.max(0, ry + rh - (vis.top + vis.height));
    layer.style.clipPath =
      insetTop || insetLeft || insetRight || insetBottom
        ? `inset(${insetTop}px ${insetRight}px ${insetBottom}px ${insetLeft}px)`
        : '';

    if (e.status) {
      // Keep the badge in the visible part of tall images.
      const top = Math.max(insetTop, Math.min(rh - 40, -ry)) + 8;
      e.status.style.top = `${Math.max(8, top)}px`;
      e.status.style.right = `${insetRight + 8}px`;
    }

    if (e.result && e.blocks) {
      const size = `${Math.round(rw)}x${Math.round(rh)}`;
      if (size !== e.lastSize) {
        renderBlocksDom(e.blocks, e.result, rw, rh, overlayStyle(this.settings));
        e.lastSize = size;
      }
      e.blocks.style.display = e.showOriginal ? 'none' : '';
    }
  }

  updateAll(): void {
    for (const e of [...this.entries.values()]) this.update(e);
  }

  /** Force a re-render of every overlay (font or style settings changed). */
  rerenderAll(): void {
    for (const e of this.entries.values()) e.lastSize = '';
    this.updateAll();
  }

  setShowOriginal(e: Entry, value: boolean): void {
    e.showOriginal = value;
    this.update(e);
    this.onChange();
  }

  setVisible(visible: boolean): void {
    this.globalVisible = visible;
    getUi().layers.classList.toggle('mt-hidden', !visible);
    this.onChange();
  }

  private setStatus(e: Entry, text: string, opts: { spinner?: boolean; ttl?: number; error?: boolean } = {}): HTMLElement {
    this.ensureLayer(e);
    clearTimeout(e.statusTimer);
    if (!e.status) {
      e.status = document.createElement('div');
      e.layer!.appendChild(e.status);
    }
    const s = e.status;
    s.className = `mt-status${opts.error ? ' mt-error' : ''}`;
    s.replaceChildren();
    if (opts.spinner) {
      const sp = document.createElement('span');
      sp.className = 'mt-spinner';
      s.appendChild(sp);
    }
    const label = document.createElement('span');
    label.textContent = text;
    s.appendChild(label);
    if (opts.ttl) e.statusTimer = window.setTimeout(() => this.clearStatus(e), opts.ttl);
    this.update(e);
    return s;
  }

  private clearStatus(e: Entry): void {
    clearTimeout(e.statusTimer);
    e.status?.remove();
    e.status = undefined;
  }

  private showError(e: Entry): void {
    const s = this.setStatus(e, e.error?.message ?? 'Translation failed', { error: true });
    if (e.error?.code === 'no_api_key' || e.error?.code === 'auth') {
      s.appendChild(button('Open settings', () => chrome.runtime.sendMessage({ type: 'openOptions' })));
    } else {
      s.appendChild(button('Retry', () => this.translate(e.el, true)));
    }
    s.appendChild(button('✕', () => this.clearStatus(e)));
    for (const b of s.querySelectorAll('button')) b.className = '';
  }

  private sourceChanged(e: Entry): void {
    this.reset(e);
    this.onSourceChange(e.el);
  }

  reset(e: Entry): void {
    this.clearStatus(e);
    e.layer?.remove();
    e.layer = e.blocks = undefined;
    e.result = undefined;
    e.state = 'idle';
    e.error = undefined;
    e.region = FULL;
    e.lastSize = '';
    e.srcKey = sourceKey(e.el);
    e.clips = clippingAncestors(e.el);
    this.onChange();
  }

  remove(e: Entry): void {
    this.clearStatus(e);
    e.layer?.remove();
    this.entries.delete(e.el);
    this.queue = this.queue.filter((q) => q !== e);
    this.onChange();
  }

  clearAll(): void {
    this.queue = [];
    for (const e of [...this.entries.values()]) this.remove(e);
  }

  status(auto: boolean): ContentStatus {
    let translated = 0;
    let pending = 0;
    let failed = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'done') translated++;
      else if (e.state === 'pending' || e.state === 'queued') pending++;
      else if (e.state === 'error') failed++;
    }
    return {
      images: findCandidates(this.settings.minImageSize).length,
      translated,
      pending,
      failed,
      overlaysVisible: this.globalVisible,
      auto,
    };
  }
}
