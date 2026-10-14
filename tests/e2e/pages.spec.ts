import { unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { MOCK_TRANSLATION } from './mock-server';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

const readerTexts = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.page')].map((p) =>
      [...p.querySelectorAll('.mt-block .mt-text')].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ')),
    ),
  );

test('reader opens a CBZ in natural page order, translates with context and exports a ZIP', async ({
  context,
  extensionId,
  mock,
  configure,
}) => {
  await configure({ useContext: true });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/reader.html`);
  await page.setInputFiles('#file-input', path.join(FIXTURES, 'chapter.cbz'));
  await expect(page.locator('.page')).toHaveCount(2);
  await expect(page.locator('.page .name')).toHaveText(['chapter.cbz — 002.png', 'chapter.cbz — 010.png']);
  await expect(page.locator('#doc-info')).toContainText('2 pages');

  await page.click('#translate-all');
  await expect.poll(() => readerTexts(page)).toEqual([[MOCK_TRANSLATION], [MOCK_TRANSLATION]]);
  await expect(page.locator('#progress')).toHaveText('2 / 2 translated');
  expect(mock.apiRequests).toHaveLength(2);
  // Page 2 was sent the dialogue from page 1 for consistency.
  const second = mock.apiRequests[1].body.messages[0].content[1].text as string;
  expect(second).toContain('previous page');
  expect(second).toContain(MOCK_TRANSLATION);

  const download = page.waitForEvent('download');
  await page.click('#export');
  const file = await (await download).path();
  const entries = unzipSync(new Uint8Array(await readFile(file)));
  expect(Object.keys(entries).sort()).toEqual(['001_chapter.cbz — 002.jpg', '002_chapter.cbz — 010.jpg']);
  // JPEG magic bytes.
  for (const data of Object.values(entries)) expect([...data.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
});

test('reader renders PDF pages and translates them', async ({ context, extensionId, mock, configure }) => {
  await configure({ useContext: false });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/reader.html`);
  await page.setInputFiles('#file-input', path.join(FIXTURES, 'volume.pdf'));
  await expect(page.locator('.page')).toHaveCount(2);
  await page.click('#translate-all');
  await expect.poll(() => readerTexts(page)).toEqual([[MOCK_TRANSLATION], [MOCK_TRANSLATION]]);
  // PDF pages render at 1600×2400, then get capped at the 2048 px long-edge setting.
  const sent = mock.apiRequests[0].body.messages[0].content[1].text as string;
  expect(sent).toContain('1365×2048 pixels');

  // Original / translation toggle.
  await page.click('#toggle');
  await expect.poll(() => readerTexts(page)).toEqual([[], []]);
});

test('settings page saves changes and tests the connection', async ({ context, extensionId, configure, sw }) => {
  await configure();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('#apiKey')).toHaveValue('test-key');

  await page.click('#test');
  await expect(page.locator('#test-result')).toHaveText('Connected — Mock Claude is ready.');

  await page.selectOption('#targetLang', 'es');
  await page.selectOption('#model-select', 'claude-haiku-5-5');
  await page.fill('textarea[data-key=autoSites]', 'https://manga.example.com/read/1\nother.example.org');
  await page.locator('textarea[data-key=autoSites]').blur();
  await expect
    .poll(() =>
      sw.evaluate(async () => {
        const { settings } = (await chrome.storage.local.get('settings')) as {
          settings: { targetLang: string; model: string; autoSites: string[] };
        };
        return [settings.targetLang, settings.model, settings.autoSites];
      }),
    )
    .toEqual(['es', 'claude-haiku-5-5', ['manga.example.com', 'other.example.org']]);

  await page.fill('#apiKey', 'bad-key');
  await page.locator('#apiKey').blur();
  await page.click('#test');
  await expect(page.locator('#test-result')).toContainText('rejected the API key');
});

test('popup renders and offers file translation on pages it cannot script', async ({ context, extensionId, configure }) => {
  await configure();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  // The active tab is the popup itself (an extension page), so page tools are hidden.
  await expect(page.locator('#unsupported')).toBeVisible();
  await expect(page.locator('#open-reader')).toBeVisible();
  await expect(page.locator('#target-lang')).toHaveValue('en');
  await expect(page.locator('#no-key')).toBeHidden();
});
