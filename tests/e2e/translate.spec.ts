import { MOCK_TRANSLATION } from './mock-server';
import { expect, overlayBoxes, overlayTexts, statusTexts, test } from './fixtures';

test('hover button translates a single page and draws the translation over the balloon', async ({
  context,
  mock,
  configure,
}) => {
  await configure();
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  const img = page.locator('#p1');
  await img.hover();
  const button = page.locator('manga-translator-root .mt-hover .mt-btn', { hasText: 'Translate' });
  await expect(button).toBeVisible();
  await button.click();

  await expect.poll(() => overlayTexts(page)).toEqual([MOCK_TRANSLATION]);
  expect(mock.apiRequests).toHaveLength(1);

  // The bubble sits where the mock said the balloon is: top-centre of the displayed image.
  const imgBox = (await img.boundingBox())!;
  const [box] = await overlayBoxes(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  expect(cx).toBeGreaterThan(imgBox.x + imgBox.width * 0.4);
  expect(cx).toBeLessThan(imgBox.x + imgBox.width * 0.6);
  expect(cy).toBeGreaterThan(imgBox.y + imgBox.height * 0.1);
  expect(cy).toBeLessThan(imgBox.y + imgBox.height * 0.32);

  // Hover label switches to the original/translation toggle.
  await img.hover({ position: { x: 20, y: 400 } });
  await expect(page.locator('manga-translator-root .mt-hover .mt-btn', { hasText: 'Show original' })).toBeVisible();
});

test('“Translate this page” translates every manga page and skips small images', async ({ context, mock, configure, command }) => {
  await configure();
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  await page.waitForLoadState('load');
  const status = (await command(page, { type: 'translatePage' })) as { images: number; pending: number };
  expect(status.images).toBe(2);
  await expect.poll(() => overlayTexts(page)).toEqual([MOCK_TRANSLATION, MOCK_TRANSLATION]);
  expect(mock.apiRequests).toHaveLength(2);

  const final = (await command(page, { type: 'getStatus' })) as { translated: number; pending: number };
  expect(final).toMatchObject({ translated: 2, pending: 0 });

  // Toggle hides every bubble; toggling again restores them.
  await command(page, { type: 'toggleOverlays' });
  await expect.poll(async () => (await overlayBoxes(page)).filter((b) => b.width > 0).length).toBe(0);
  await command(page, { type: 'toggleOverlays' });
  await expect.poll(async () => (await overlayBoxes(page)).filter((b) => b.width > 0).length).toBe(2);
});

test('translations are cached: revisiting a page costs no API calls', async ({ context, mock, configure, command }) => {
  await configure();
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  await expect.poll(() => overlayTexts(page)).toHaveLength(2);
  expect(mock.apiRequests).toHaveLength(2);

  await page.reload();
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  await expect.poll(() => overlayTexts(page)).toHaveLength(2);
  expect(mock.apiRequests).toHaveLength(2);
});

test('hotlink-protected images are fetched with the page as Referer', async ({ context, mock, configure, command }) => {
  await configure();
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/protected.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  await expect.poll(() => overlayTexts(page)).toEqual([MOCK_TRANSLATION]);
  const protectedFetches = mock.imageRequests.filter((r) => r.path === '/protected/page1.png');
  // One load by the page, one by the extension — both allowed thanks to the Referer.
  expect(protectedFetches.length).toBeGreaterThanOrEqual(2);
  expect(protectedFetches.every((r) => String(r.headers.referer).startsWith(`${mock.origin}/pages/`))).toBe(true);
});

test('canvas-based readers are translated from the canvas pixels', async ({ context, mock, configure, command }) => {
  await configure();
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/canvas.html`);
  await page.waitForTimeout(300);
  await command(page, { type: 'translatePage' });
  await expect.poll(() => overlayTexts(page)).toEqual([MOCK_TRANSLATION]);
  const sent = mock.apiRequests[0].body.messages[0].content[1].text as string;
  expect(sent).toContain('800×1200 pixels');
});

test('protected canvases fall back to a screenshot of the visible page', async ({ context, mock, configure, command }) => {
  await configure();
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/tainted.html`);
  await page.waitForTimeout(300);
  await command(page, { type: 'translatePage' });
  await expect.poll(() => overlayTexts(page)).toEqual([MOCK_TRANSLATION]);
  // The screenshot crop is 400×600 CSS px (the canvas' displayed size).
  const sent = mock.apiRequests[0].body.messages[0].content[1].text as string;
  expect(sent).toMatch(/The image is (400|800)×(600|1200) pixels/);
});

test('long webtoon strips are sliced, translated per slice and merged', async ({ context, mock, configure, command }) => {
  await configure();
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/strip.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  // 600×3600 → slices of 900 px with ≥15% overlap → 5 slices.
  const n = 5;
  await expect.poll(() => mock.apiRequests.length).toBe(n);
  for (const r of mock.apiRequests) expect(r.body.messages[0].content[1].text).toMatch(/slice \d+ of \d+/);
  await expect.poll(async () => (await overlayTexts(page)).length).toBe(n);
  const boxes = await overlayBoxes(page);
  const tops = boxes.map((b) => b.y).sort((a, b) => a - b);
  for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeGreaterThan(100);
});

test('auto-translate translates pages without any clicks', async ({ context, mock, configure }) => {
  await configure({ autoSites: ['127.0.0.1'] });
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  await expect.poll(() => overlayTexts(page)).toEqual([MOCK_TRANSLATION, MOCK_TRANSLATION]);
});

test('readers that swap the page image in place get a fresh translation', async ({ context, mock, configure }) => {
  await configure({ autoSites: ['127.0.0.1'] });
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/swap.html`);
  await expect.poll(() => overlayTexts(page)).toHaveLength(1);
  expect(mock.apiRequests).toHaveLength(1);
  await page.click('#next');
  await expect.poll(() => mock.apiRequests.length).toBe(2);
  await expect.poll(() => overlayTexts(page)).toHaveLength(1);
});

test('selecting an area translates whatever is on screen there', async ({ context, mock, configure, command }) => {
  await configure();
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'startRegion' });
  const mask = page.locator('manga-translator-root .mt-select-mask');
  await expect(mask).toBeVisible();
  await page.mouse.move(120, 150);
  await page.mouse.down();
  await page.mouse.move(500, 500, { steps: 5 });
  await page.mouse.up();
  await expect(mask).toHaveCount(0);
  await expect.poll(() => overlayTexts(page)).toEqual([MOCK_TRANSLATION]);
  const sent = mock.apiRequests[0].body.messages[0].content[1].text as string;
  expect(sent).toContain('380×350 pixels');
  await expect(page.locator('manga-translator-root .mt-panel')).toHaveCount(1);
  await page.locator('manga-translator-root .mt-panel-bar .mt-btn', { hasText: '✕' }).click();
  await expect(page.locator('manga-translator-root .mt-panel')).toHaveCount(0);
});

test('API errors are shown on the image with a way to fix them', async ({ context, mock, configure, command }) => {
  await configure({ apiKey: 'bad-key' });
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  await expect.poll(() => statusTexts(page)).toContainEqual(expect.stringContaining('rejected the API key'));
  expect(await overlayTexts(page)).toEqual([]);
  await expect(page.locator('manga-translator-root .mt-status button', { hasText: 'Open settings' }).first()).toBeVisible();
});

test('a missing API key asks the user to add one', async ({ context, mock, configure, command }) => {
  await configure({ apiKey: '' });
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  await expect.poll(() => statusTexts(page)).toContainEqual(expect.stringContaining('Add your Anthropic API key'));
  expect(mock.apiRequests).toHaveLength(0);
});
