import { expect, overlayBoxes, overlayTexts, test } from './fixtures';
import { MOCK_TRANSLATION } from './mock-server';

test('gemini: translates pages with a free AI Studio key and places bubbles from 0–1000 boxes', async ({
  context,
  mock,
  configure,
  command,
}) => {
  await configure({
    provider: 'gemini',
    apiKey: '',
    geminiApiKey: 'AIza-test',
    geminiModel: 'gemini-flash-latest',
    geminiBaseURL: `${mock.origin}/gemini/v1beta`,
  });
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  await expect.poll(() => overlayTexts(page)).toEqual([MOCK_TRANSLATION, MOCK_TRANSLATION]);
  expect(mock.apiRequests.map((r) => r.path)).toEqual([
    '/gemini/v1beta/models/gemini-flash-latest:generateContent',
    '/gemini/v1beta/models/gemini-flash-latest:generateContent',
  ]);
  expect(mock.apiRequests[0].body.contents[0].parts[1].text).toContain('0 to 1000');

  // Bubble sits at the top-centre of the first page, as the normalised box says.
  const img = (await page.locator('#p1').boundingBox())!;
  const box = (await overlayBoxes(page)).sort((a, b) => a.y - b.y)[0];
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  expect(cx).toBeGreaterThan(img.x + img.width * 0.4);
  expect(cx).toBeLessThan(img.x + img.width * 0.6);
  expect(cy).toBeGreaterThan(img.y + img.height * 0.1);
  expect(cy).toBeLessThan(img.y + img.height * 0.32);
});

test('gemini: settings page sets up the key, loads models and tests the connection', async ({
  context,
  extensionId,
  mock,
  configure,
  sw,
}) => {
  await configure({ apiKey: '', geminiBaseURL: `${mock.origin}/gemini/v1beta` });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('#gemini')).toBeHidden();
  await page.check('input[name=provider][value=gemini]');
  await expect(page.locator('#gemini')).toBeVisible();

  await page.fill('#geminiApiKey', 'wrong');
  await page.locator('#geminiApiKey').blur();
  await page.locator('#gemini button.test').click();
  await expect(page.locator('#gemini .test-result')).toContainText('rejected the Gemini API key');

  await page.fill('#geminiApiKey', 'AIza-test');
  await page.locator('#geminiApiKey').blur();
  await page.locator('#gemini button.test').click();
  await expect(page.locator('#gemini .test-result')).toHaveText('Connected — Gemini Mock Flash is ready.');
  await page.click('#load-gemini-models');
  await expect(page.locator('#gemini .test-result')).toContainText('2 models available');

  const saved = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings as Record<string, unknown>);
  expect(saved).toMatchObject({ provider: 'gemini', geminiApiKey: 'AIza-test' });
});
