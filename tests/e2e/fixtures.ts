import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Settings } from '../../src/shared/settings';
import { startMockServer, type MockServer } from './mock-server';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');

interface Fixtures {
  mock: MockServer;
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  /** Write settings straight into extension storage. */
  configure: (patch?: Partial<Settings>) => Promise<void>;
  /** Send a command to the content script of a page, as the popup or a shortcut would. */
  command: (page: Page, msg: Record<string, unknown>) => Promise<unknown>;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  mock: async ({}, use) => {
    const mock = await startMockServer();
    await use(mock);
    await mock.close();
  },
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1200, height: 900 },
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker');
    // Extension APIs are bound shortly after the worker starts.
    await expect
      .poll(() => sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage?.local), { timeout: 10_000 })
      .toBe(true);
    await use(sw);
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
  configure: async ({ sw, mock }, use) => {
    await use(async (patch = {}) => {
      await sw.evaluate(
        async (settings) => {
          await chrome.storage.local.set({ settings });
        },
        { apiKey: 'test-key', baseURL: mock.origin, model: 'claude-opus-5-5', ...patch },
      );
    });
  },
  command: async ({ sw }, use) => {
    await use(async (page, msg) => {
      const url = page.url();
      return sw.evaluate(
        async ({ url, msg }) => {
          const [tab] = await chrome.tabs.query({ url });
          return chrome.tabs.sendMessage(tab.id!, msg, { frameId: 0 });
        },
        { url, msg },
      );
    });
  },
});


/** Text of every translated bubble the content script has drawn on a page. */
export { expect };

export async function overlayTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('manga-translator-root')?.shadowRoot;
    return [...(root?.querySelectorAll('.mt-block .mt-text') ?? [])].map((e) =>
      (e.textContent ?? '').replace(/\s+/g, ' '),
    );
  });
}

export async function overlayBoxes(page: Page): Promise<DOMRect[]> {
  return page.evaluate(() => {
    const root = document.querySelector('manga-translator-root')?.shadowRoot;
    return [...(root?.querySelectorAll('.mt-block') ?? [])].map((e) => e.getBoundingClientRect().toJSON());
  });
}

export async function statusTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('manga-translator-root')?.shadowRoot;
    return [...(root?.querySelectorAll('.mt-status') ?? [])].map((e) => e.textContent ?? '');
  });
}
