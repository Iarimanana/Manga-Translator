import { zipSync, unzipSync } from 'fflate';
// The legacy build carries polyfills (e.g. Map.getOrInsertComputed) for Chrome versions
// that predate them.
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileKind, isPageEntry, mimeFromName, naturalCompare } from '../shared/files';
import { TARGET_LANGUAGES, isRtl } from '../shared/languages';
import type { TranslateResponse } from '../shared/messages';
import { pageContext } from '../shared/prompt';
import { OVERLAY_CSS, drawBlocksCanvas, ensureFont, renderBlocksDom, type OverlayStyle } from '../shared/render';
import { fontStack, isConfigured, loadSettings, onSettingsChanged, saveSettings, type Settings } from '../shared/settings';
import type { PageTranslation } from '../shared/types';

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type PageState = 'idle' | 'pending' | 'done' | 'error';

interface Page {
  index: number;
  name: string;
  /** Produces the page image; PDFs render lazily on first use. */
  load: () => Promise<Blob>;
  blob?: Blob;
  url?: string;
  result?: PageTranslation;
  state: PageState;
  showOriginal: boolean;
  el: HTMLElement;
  img: HTMLImageElement;
  layer: HTMLElement;
  stateEl: HTMLElement;
  actionBtn: HTMLButtonElement;
  toggleBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
}

let settings: Settings;
let pages: Page[] = [];
let showOriginals = false;
let stopRequested = false;
let running = false;

const style = (): OverlayStyle => ({
  fontStack: fontStack(settings),
  fontScale: settings.fontScale,
  opacity: settings.overlayOpacity,
  rtl: isRtl(settings.targetLang),
});

// ---------------------------------------------------------------- loading files

/** PDF pages are rendered at this width; plenty for OCR while keeping memory in check. */
const PDF_RENDER_WIDTH = 1600;

async function pdfPages(file: File): Promise<{ name: string; load: () => Promise<Blob> }[]> {
  const base = chrome.runtime.getURL('pdfjs/');
  const doc = await getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: `${base}cmaps/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    out.push({
      name: `${file.name} — page ${i}`,
      load: async () => {
        const page = await doc.getPage(i);
        const base1 = page.getViewport({ scale: 1 });
        const scale = Math.min(PDF_RENDER_WIDTH / base1.width, 12000 / base1.height, 4);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvas, viewport }).promise;
        page.cleanup();
        return new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render PDF page'))), 'image/jpeg', 0.92),
        );
      },
    });
  }
  return out;
}

async function zipPages(file: File): Promise<{ name: string; load: () => Promise<Blob> }[]> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => isPageEntry(f.name) });
  return Object.keys(entries)
    .sort(naturalCompare)
    .map((path) => {
      const blob = new Blob([entries[path]], { type: mimeFromName(path) });
      return { name: `${file.name} — ${path.split('/').pop()}`, load: async () => blob };
    });
}

async function openFiles(fileList: FileList | File[]): Promise<void> {
  const files = [...fileList].sort((a, b) => naturalCompare(a.name, b.name));
  if (!files.length) return;
  $('doc-info').textContent = 'Opening…';
  const loaded: { name: string; load: () => Promise<Blob> }[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    try {
      switch (fileKind(file.name, file.type)) {
        case 'pdf':
          loaded.push(...(await pdfPages(file)));
          break;
        case 'zip':
          loaded.push(...(await zipPages(file)));
          break;
        case 'image':
          loaded.push({ name: file.name, load: async () => file });
          break;
        default:
          skipped.push(file.name);
      }
    } catch (err) {
      console.error(err);
      skipped.push(`${file.name} (${(err as Error).message})`);
    }
  }
  if (skipped.length) alert(`Could not open:\n${skipped.join('\n')}`);
  if (!loaded.length) {
    $('doc-info').textContent = '';
    return;
  }
  stopRequested = true;
  for (const p of pages) if (p.url) URL.revokeObjectURL(p.url);
  pages = loaded.map((l, index) => createPage(index, l.name, l.load));
  $('pages').replaceChildren(...pages.map((p) => p.el));
  $('drop').classList.add('hidden');
  const title = files.length === 1 ? files[0].name : `${files.length} files`;
  $('doc-info').textContent = `${title} · ${pages.length} page${pages.length === 1 ? '' : 's'}`;
  document.title = `${title} — Manga Translator`;
  for (const id of ['translate-all', 'toggle', 'export']) $<HTMLButtonElement>(id).disabled = false;
  updateProgress();
}

// ---------------------------------------------------------------- page UI

const lazyLoader = new IntersectionObserver(
  (records) => {
    for (const r of records) {
      if (!r.isIntersecting) continue;
      const page = pages.find((p) => p.el === r.target);
      if (page) void ensureImage(page);
    }
  },
  { rootMargin: '1200px 0px' },
);

const resizeObserver = new ResizeObserver((records) => {
  for (const r of records) {
    const page = pages.find((p) => p.img === r.target);
    if (page) renderOverlay(page);
  }
});

function createPage(index: number, name: string, load: () => Promise<Blob>): Page {
  const el = document.createElement('article');
  el.className = 'page';
  el.innerHTML = `
    <div class="page-head">
      <strong>${index + 1}</strong>
      <span class="name"></span>
      <span class="state muted"></span>
      <button data-act="translate">Translate</button>
      <button data-act="toggle" class="hidden">Original</button>
      <button data-act="save" class="hidden" title="Download this page with the translation">⬇</button>
    </div>
    <div class="frame"><img alt="" /><div class="layer"></div></div>`;
  el.querySelector('.name')!.textContent = name;
  const page: Page = {
    index,
    name,
    load,
    state: 'idle',
    showOriginal: false,
    el,
    img: el.querySelector('img')!,
    layer: el.querySelector('.layer')!,
    stateEl: el.querySelector('.state')!,
    actionBtn: el.querySelector('[data-act=translate]')!,
    toggleBtn: el.querySelector('[data-act=toggle]')!,
    saveBtn: el.querySelector('[data-act=save]')!,
  };
  page.img.style.minHeight = '400px';
  page.actionBtn.addEventListener('click', () => void translatePage(page, page.state === 'done' || page.state === 'error'));
  page.toggleBtn.addEventListener('click', () => {
    page.showOriginal = !page.showOriginal;
    renderOverlay(page);
  });
  page.saveBtn.addEventListener('click', () => void downloadPage(page));
  page.layer.addEventListener('click', (e) => (e.target as Element).closest('.mt-block')?.classList.toggle('mt-peek'));
  lazyLoader.observe(el);
  resizeObserver.observe(page.img);
  return page;
}

async function ensureImage(page: Page): Promise<Blob> {
  if (!page.blob) {
    page.blob = await page.load();
    page.url = URL.createObjectURL(page.blob);
    page.img.src = page.url;
    await page.img.decode().catch(() => {});
    page.img.style.minHeight = '';
  }
  return page.blob;
}

function setState(page: Page, state: PageState, text: string, cls = ''): void {
  page.state = state;
  page.stateEl.className = `state ${cls || 'muted'}`;
  page.stateEl.innerHTML = state === 'pending' ? '<span class="spin"></span> ' : '';
  page.stateEl.append(text);
  page.actionBtn.textContent = state === 'done' ? '↻' : state === 'error' ? 'Retry' : 'Translate';
  page.actionBtn.title = state === 'done' ? 'Translate again (skip the cache)' : '';
  page.actionBtn.disabled = state === 'pending';
  page.toggleBtn.classList.toggle('hidden', state !== 'done');
  page.saveBtn.classList.toggle('hidden', state !== 'done');
}

function renderOverlay(page: Page): void {
  const w = page.img.clientWidth;
  const h = page.img.clientHeight;
  page.toggleBtn.textContent = page.showOriginal ? 'Translation' : 'Original';
  if (!page.result || !w || !h || page.showOriginal || showOriginals) {
    page.layer.replaceChildren();
    return;
  }
  renderBlocksDom(page.layer, page.result, w, h, style());
}

function renderAll(): void {
  for (const p of pages) renderOverlay(p);
}

function updateProgress(): void {
  const done = pages.filter((p) => p.state === 'done').length;
  const failed = pages.filter((p) => p.state === 'error').length;
  $('progress').textContent = pages.length
    ? `${done} / ${pages.length} translated${failed ? ` · ${failed} failed` : ''}`
    : '';
}

// ---------------------------------------------------------------- translation

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Very wide or huge scans are shrunk before messaging them to the service worker. */
async function prepareForUpload(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const maxW = 2600;
  if (bmp.width <= maxW && blob.size < 8 * 1024 * 1024) {
    bmp.close();
    return blob;
  }
  const scale = Math.min(1, maxW / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? blob), 'image/jpeg', 0.92));
}

async function translatePage(page: Page, force = false, context?: string): Promise<void> {
  if (page.state === 'pending') return;
  setState(page, 'pending', 'Translating…');
  updateProgress();
  try {
    const blob = await prepareForUpload(await ensureImage(page));
    const res = (await chrome.runtime.sendMessage({
      type: 'translate',
      source: { kind: 'dataUrl', dataUrl: await blobToDataUrl(blob) },
      context,
      force,
    })) as TranslateResponse;
    if (!res.ok) throw new Error(res.error);
    await ensureFont();
    page.result = res.result;
    page.showOriginal = false;
    const n = res.result.blocks.length;
    setState(page, 'done', n ? `${n} bubble${n === 1 ? '' : 's'}${res.result.cached ? ' · cached' : ''}` : 'No text found', 'ok');
    renderOverlay(page);
  } catch (err) {
    setState(page, 'error', (err as Error).message, 'err');
  } finally {
    updateProgress();
  }
}

async function translateAll(): Promise<void> {
  if (running) return;
  running = true;
  stopRequested = false;
  $('translate-all').classList.add('hidden');
  $('stop').classList.remove('hidden');
  const todo = pages.filter((p) => p.state !== 'done');
  try {
    if (settings.useContext) {
      // One page at a time so each page sees the dialogue that came before it.
      for (const p of todo) {
        if (stopRequested) break;
        const prev = pages[p.index - 1]?.result;
        await translatePage(p, false, prev ? pageContext(prev) : undefined);
      }
    } else {
      const queue = [...todo];
      const worker = async () => {
        while (queue.length && !stopRequested) await translatePage(queue.shift()!);
      };
      await Promise.all(Array.from({ length: settings.concurrency }, worker));
    }
  } finally {
    running = false;
    $('translate-all').classList.remove('hidden');
    $('stop').classList.add('hidden');
  }
}

// ---------------------------------------------------------------- export

async function renderTranslated(page: Page): Promise<Blob> {
  const bmp = await createImageBitmap(await ensureImage(page));
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  if (page.result) {
    await ensureFont();
    drawBlocksCanvas(ctx, page.result, canvas.width, canvas.height, style());
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), 'image/jpeg', 0.93),
  );
}

function saveBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const pageFileName = (p: Page) =>
  `${String(p.index + 1).padStart(3, '0')}_${p.name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[a-z0-9]+$/i, '')}.jpg`;

async function downloadPage(page: Page): Promise<void> {
  saveBlob(await renderTranslated(page), pageFileName(page));
}

async function exportZip(): Promise<void> {
  const btn = $<HTMLButtonElement>('export');
  btn.disabled = true;
  try {
    const files: Record<string, Uint8Array> = {};
    for (const p of pages) {
      btn.textContent = `Exporting ${p.index + 1}/${pages.length}…`;
      files[pageFileName(p)] = new Uint8Array(await (await renderTranslated(p)).arrayBuffer());
    }
    // JPEGs are already compressed; store them as-is.
    const zip = zipSync(files, { level: 0 });
    const base = (pages[0]?.name.split(' — ')[0] ?? 'manga').replace(/\.[a-z0-9]+$/i, '');
    saveBlob(new Blob([zip], { type: 'application/zip' }), `${base} (${settings.targetLang}).zip`);
  } catch (err) {
    alert(`Export failed: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ Export ZIP';
  }
}

// ---------------------------------------------------------------- wiring

async function main(): Promise<void> {
  settings = await loadSettings();
  const css = document.createElement('style');
  css.textContent = OVERLAY_CSS;
  document.head.appendChild(css);
  void ensureFont();

  $('no-key').classList.toggle('hidden', isConfigured(settings));
  const select = $<HTMLSelectElement>('target-lang');
  for (const l of TARGET_LANGUAGES) select.add(new Option(l.label, l.code, false, l.code === settings.targetLang));
  select.addEventListener('change', () => void saveSettings({ targetLang: select.value }));

  onSettingsChanged((next) => {
    settings = next;
    select.value = next.targetLang;
    $('no-key').classList.toggle('hidden', isConfigured(next));
    renderAll();
  });

  for (const id of ['file-input', 'file-input-2']) {
    $<HTMLInputElement>(id).addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.files) void openFiles(input.files);
      input.value = '';
    });
  }
  $('translate-all').addEventListener('click', () => void translateAll());
  $('stop').addEventListener('click', () => {
    stopRequested = true;
  });
  $('toggle').addEventListener('click', () => {
    showOriginals = !showOriginals;
    $('toggle').textContent = showOriginals ? 'Show translations' : 'Show originals';
    renderAll();
  });
  $('export').addEventListener('click', () => void exportZip());

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('drag-hint').classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) $('drag-hint').classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drag-hint').classList.add('hidden');
    if (e.dataTransfer?.files.length) void openFiles(e.dataTransfer.files);
  });
}

void main();
