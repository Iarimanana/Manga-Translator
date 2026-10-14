import { expect, overlayTexts, test } from './fixtures';
import { MOCK_TRANSLATION } from './mock-server';

test('local model: translates pages through an OpenAI-compatible server with no API key', async ({
  context,
  mock,
  configure,
  command,
}) => {
  await configure({ provider: 'local', apiKey: '', localBaseURL: `${mock.origin}/v1`, localModel: 'qwen2.5vl:7b' });
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  await expect.poll(() => overlayTexts(page)).toEqual([MOCK_TRANSLATION, MOCK_TRANSLATION]);
  expect(mock.apiRequests.map((r) => r.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
  const body = mock.apiRequests[0].body;
  expect(body.model).toBe('qwen2.5vl:7b');
  expect(body.messages[1].content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
});

test('local model: settings page switches engine and tests the server', async ({ context, extensionId, mock, configure, sw }) => {
  await configure({ apiKey: '' });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('#local')).toBeHidden();
  await page.check('input[name=provider][value=local]');
  await expect(page.locator('#local')).toBeVisible();
  await expect(page.locator('#api')).toBeHidden();
  await page.fill('#localBaseURL', `${mock.origin}/v1`);
  await page.locator('#localBaseURL').blur();
  await page.locator('#local button.test').click();
  await expect(page.locator('#local .test-result')).toHaveText('Connected — qwen2.5vl:7b (local) is ready.');

  await page.fill('#localModel', 'llava:13b');
  await page.locator('#localModel').blur();
  await page.locator('#local button.test').click();
  await expect(page.locator('#local .test-result')).toContainText('ollama pull llava:13b');

  const saved = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings as Record<string, unknown>);
  expect(saved).toMatchObject({ provider: 'local', localBaseURL: `${mock.origin}/v1`, localModel: 'llava:13b' });
});

test('local model: a server that is not running gives a clear message', async ({ context, mock, configure, command }) => {
  await configure({ provider: 'local', apiKey: '', localBaseURL: 'http://127.0.0.1:9/v1' });
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...(document.querySelector('manga-translator-root')?.shadowRoot?.querySelectorAll('.mt-status') ?? [])].map(
          (e) => e.textContent ?? '',
        ),
      ),
    )
    .toContainEqual(expect.stringContaining('Is Ollama / LM Studio running?'));
});
