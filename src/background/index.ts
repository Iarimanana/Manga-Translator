import type { BackgroundRequest, CaptureResponse, ContentCommand, TranslateResponse } from '../shared/messages';
import { isConfigured, loadSettings } from '../shared/settings';
import { cacheClear } from './cache';
import { testConnection } from './claude';
import { testLocal } from './local';
import { toTranslateError } from './errors';
import { blobToDataUrl, cropScreenshot } from './image';
import { getStats, translateImage } from './translator';

const MENU = {
  image: 'mt-translate-image',
  page: 'mt-translate-page',
  region: 'mt-select-region',
  toggle: 'mt-toggle',
  reader: 'mt-open-reader',
} as const;

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU.image, title: 'Translate this image', contexts: ['image'] });
  chrome.contextMenus.create({ id: MENU.page, title: 'Translate all manga images on this page', contexts: ['page'] });
  chrome.contextMenus.create({ id: MENU.region, title: 'Translate a selected area…', contexts: ['page', 'image'] });
  chrome.contextMenus.create({ id: MENU.toggle, title: 'Show / hide translations', contexts: ['page', 'image'] });
  chrome.contextMenus.create({
    id: MENU.reader,
    title: 'Translate files (PDF, ZIP/CBZ, images)…',
    contexts: ['action'],
  });
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    const settings = await loadSettings();
    if (!isConfigured(settings)) chrome.runtime.openOptionsPage();
  }
});

/**
 * Send a command to the content script of a tab, injecting the script first when the tab
 * was opened before the extension was installed or updated.
 */
async function sendToTab(tabId: number, msg: ContentCommand): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU.reader) {
    void openReader();
    return;
  }
  if (!tab?.id) return;
  const commands: Record<string, ContentCommand | undefined> = {
    [MENU.image]: info.srcUrl ? { type: 'translateImage', srcUrl: info.srcUrl } : undefined,
    [MENU.page]: { type: 'translatePage' },
    [MENU.region]: { type: 'startRegion' },
    [MENU.toggle]: { type: 'toggleOverlays' },
  };
  const cmd = commands[String(info.menuItemId)];
  if (cmd) sendToTab(tab.id, cmd).catch((e) => console.warn('[Manga Translator]', e));
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!tabId) return;
  const map: Record<string, ContentCommand> = {
    'translate-page': { type: 'translatePage' },
    'select-region': { type: 'startRegion' },
    'toggle-overlays': { type: 'toggleOverlays' },
  };
  const cmd = map[command];
  if (cmd) sendToTab(tabId, cmd).catch((e) => console.warn('[Manga Translator]', e));
});

async function openReader(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('reader.html') });
}

// captureVisibleTab is limited to two calls per second; space captures out.
let lastCapture = 0;
async function captureTab(windowId: number): Promise<string> {
  const wait = lastCapture + 600 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCapture = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

async function handle(msg: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'translate': {
      const result = await translateImage({ source: msg.source, context: msg.context, force: msg.force });
      return { ok: true, result } satisfies TranslateResponse;
    }
    case 'captureViewport': {
      const windowId = sender.tab?.windowId;
      if (windowId === undefined) throw new Error('Area translation only works inside a browser tab.');
      const shot = await captureTab(windowId);
      const blob = await cropScreenshot(shot, msg.rect, msg.viewportW);
      return { ok: true, dataUrl: await blobToDataUrl(blob) } satisfies CaptureResponse;
    }
    case 'testConnection': {
      const settings = await loadSettings();
      const name = settings.provider === 'local' ? await testLocal(settings) : await testConnection(settings);
      return { ok: true, name };
    }
    case 'clearCache':
      await cacheClear();
      return { ok: true };
    case 'getStats':
      return { ok: true, stats: await getStats() };
    case 'openReader':
      await openReader();
      return { ok: true };
    case 'openOptions':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg: BackgroundRequest, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (err) => {
    const e = toTranslateError(err);
    if (e.code !== 'no_api_key') console.warn('[Manga Translator]', e.code, e.message);
    sendResponse({ ok: false, error: e.message, code: e.code });
  });
  return true;
});
