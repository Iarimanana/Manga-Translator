import { TARGET_LANGUAGES } from '../shared/languages';
import type { ContentCommand, ContentStatus, Stats } from '../shared/messages';
import { MODEL_OPTIONS, hostOf, isConfigured, loadSettings, saveSettings } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function scriptable(url: string | undefined): boolean {
  if (!url) return false;
  if (!/^(https?|file):/.test(url)) return false;
  return !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url);
}

async function send(tabId: number, msg: ContentCommand): Promise<ContentStatus | undefined> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })) as ContentStatus;
  } catch {
    // Tab opened before the extension was installed: inject the content script and retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return (await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })) as ContentStatus;
    } catch {
      return undefined;
    }
  }
}

function describe(s: ContentStatus): string {
  if (s.pending) return `Translating… ${s.translated} done, ${s.pending} in progress${s.failed ? `, ${s.failed} failed` : ''}`;
  if (s.translated) return `${s.translated} page${s.translated === 1 ? '' : 's'} translated${s.failed ? ` · ${s.failed} failed` : ''}`;
  if (s.failed) return `${s.failed} page${s.failed === 1 ? '' : 's'} failed — hover a page to retry`;
  if (s.images) return `${s.images} manga page${s.images === 1 ? '' : 's'} found`;
  return 'No manga pages detected — try “Translate a selected area”.';
}

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  const tab = await activeTab();
  const tabId = tab?.id;
  const host = hostOf(tab?.url ?? '');

  $('no-key').classList.toggle('hidden', isConfigured(settings));
  const openSettings = () => {
    chrome.runtime.openOptionsPage();
    window.close();
  };
  $('open-settings').addEventListener('click', openSettings);
  $('add-key').addEventListener('click', openSettings);
  $('open-reader').addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('reader.html') });
    window.close();
  });

  const select = $<HTMLSelectElement>('target-lang');
  for (const l of TARGET_LANGUAGES) select.add(new Option(l.label, l.code, false, l.code === settings.targetLang));
  select.addEventListener('change', () => void saveSettings({ targetLang: select.value }));

  const model = MODEL_OPTIONS.find((m) => m.id === settings.model);
  $('model').textContent =
    settings.provider === 'local' ? `Local: ${settings.localModel}` : model ? model.label.split(' — ')[0] : settings.model;
  chrome.runtime.sendMessage({ type: 'getStats' }).then((res: { ok: boolean; stats: Stats }) => {
    if (res?.ok) {
      const u = res.stats.usage;
      $('usage').textContent = `${res.stats.pagesTranslated} pages · ${fmt(u.inputTokens + u.outputTokens)} tokens`;
    }
  });

  if (!tabId || !scriptable(tab?.url)) {
    $('page-tools').classList.add('hidden');
    $('unsupported').classList.remove('hidden');
    return;
  }
  $('host').textContent = host || 'this site';

  let status: ContentStatus | undefined;
  const render = (s: ContentStatus | undefined) => {
    if (!s) {
      $('status').textContent = 'Reload the page to use Manga Translator here.';
      return;
    }
    status = s;
    $('status').textContent = describe(s);
    $('toggle-overlays').textContent = s.overlaysVisible ? 'Show originals' : 'Show translations';
    $<HTMLInputElement>('auto-site').checked = s.auto;
  };

  const run = async (msg: ContentCommand, close = false) => {
    render(await send(tabId, msg));
    if (close) window.close();
  };

  $('translate-page').addEventListener('click', () => void run({ type: 'translatePage' }));
  $('select-region').addEventListener('click', () => void run({ type: 'startRegion' }, true));
  $('toggle-overlays').addEventListener('click', () => void run({ type: 'toggleOverlays' }));
  $('clear-overlays').addEventListener('click', () => void run({ type: 'clearOverlays' }));
  $<HTMLInputElement>('auto-site').addEventListener('change', (e) => {
    void run({ type: 'setAuto', enabled: (e.target as HTMLInputElement).checked });
  });

  await run({ type: 'getStatus' });
  // Live progress while the popup is open.
  setInterval(async () => {
    if (status) render(await send(tabId, { type: 'getStatus' }));
  }, 1000);
}

void main();
