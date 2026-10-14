import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../shared/languages';
import type { Stats } from '../shared/messages';
import { ensureFont } from '../shared/render';
import { MODEL_OPTIONS, fontStack, loadSettings, saveSettings, type Settings } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

let settings: Settings;
let savedTimer: number | undefined;

function flashSaved(): void {
  const el = $('saved');
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => el.classList.remove('show'), 1400);
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await saveSettings(patch);
  flashSaved();
  updatePreview();
}

function readField(el: Field): unknown {
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked;
  if (el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'range')) return Number(el.value);
  if (el.hasAttribute('data-list')) {
    return el.value
      .split(/[\n,]+/)
      .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
  }
  return el.value;
}

function writeField(el: Field, value: unknown): void {
  if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
  else if (Array.isArray(value)) el.value = value.join('\n');
  else el.value = String(value ?? '');
}

function updateOutputs(): void {
  $('fontScale-out').textContent = `${Math.round(settings.fontScale * 100)}%`;
  $('overlayOpacity-out').textContent = `${Math.round(settings.overlayOpacity * 100)}%`;
  $('custom-font-row').classList.toggle('hidden', settings.fontFamily !== 'custom');
}

function updatePreview(): void {
  const bubble = document.querySelector<HTMLElement>('.bubble')!;
  bubble.style.fontFamily = fontStack(settings);
  bubble.style.fontSize = `${15 * settings.fontScale}px`;
  bubble.style.opacity = String(settings.overlayOpacity);
  updateOutputs();
}

function setupModel(): void {
  const select = $<HTMLSelectElement>('model-select');
  for (const m of MODEL_OPTIONS) select.add(new Option(m.label, m.id));
  select.add(new Option('Other model ID…', '__custom'));
  const custom = $<HTMLInputElement>('custom-model');
  const known = MODEL_OPTIONS.some((m) => m.id === settings.model);
  select.value = known ? settings.model : '__custom';
  custom.value = known ? '' : settings.model;
  $('custom-model-row').classList.toggle('hidden', known);
  select.addEventListener('change', () => {
    const isCustom = select.value === '__custom';
    $('custom-model-row').classList.toggle('hidden', !isCustom);
    if (!isCustom) void save({ model: select.value });
    else custom.focus();
  });
  custom.addEventListener('change', () => {
    if (custom.value.trim()) void save({ model: custom.value.trim() });
  });
}

async function refreshStats(): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: 'getStats' })) as { ok: boolean; stats: Stats };
  if (!res?.ok) return;
  const s = res.stats;
  $('stats').textContent =
    `${s.pagesTranslated.toLocaleString()} pages translated · ${s.cacheHits.toLocaleString()} served from cache · ` +
    `${s.usage.inputTokens.toLocaleString()} input / ${s.usage.outputTokens.toLocaleString()} output tokens · ` +
    `${s.cacheEntries.toLocaleString()} cached pages`;
}

async function main(): Promise<void> {
  settings = await loadSettings();
  await ensureFont();

  for (const l of TARGET_LANGUAGES) $<HTMLSelectElement>('targetLang').add(new Option(l.label, l.code));
  for (const l of SOURCE_LANGUAGES) $<HTMLSelectElement>('sourceLang').add(new Option(l.label, l.code));
  setupModel();

  for (const el of document.querySelectorAll<Field>('[data-key]')) {
    const key = el.dataset.key as keyof Settings;
    writeField(el, settings[key]);
    const event = el instanceof HTMLInputElement && el.type === 'range' ? 'input' : 'change';
    el.addEventListener(event, () => void save({ [key]: readField(el) } as Partial<Settings>));
  }
  updatePreview();

  $('toggle-key').addEventListener('click', () => {
    const input = $<HTMLInputElement>('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('toggle-key').textContent = input.type === 'password' ? 'Show' : 'Hide';
  });

  $('test').addEventListener('click', async () => {
    const out = $('test-result');
    out.className = 'muted';
    out.textContent = 'Checking…';
    const res = (await chrome.runtime.sendMessage({ type: 'testConnection' })) as
      | { ok: true; name: string }
      | { ok: false; error: string };
    out.className = res.ok ? 'ok' : 'err';
    out.textContent = res.ok ? `Connected — ${res.name} is ready.` : res.error;
  });

  $('clear-cache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearCache' });
    await refreshStats();
  });

  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  await refreshStats();
}

void main();
