import { unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, overlayTexts, test } from './fixtures';
import { MOCK_EDITED, MOCK_NOTE, isEditorRequest } from './mock-server';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const FULL = { workflow: 'full', letteringCase: 'upper', cleaning: 'auto' } as const;

/** Height of a baseline/progressive JPEG, read from its SOF marker. */
function jpegHeight(b: Uint8Array): number {
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker >= 0xc0 && marker <= 0xc2) return (b[i + 5] << 8) | b[i + 6];
    i += 2 + len;
  }
  return 0;
}

test('full workflow: translator draft → editor/proofreader → QC → capitals, shout lettering and notes', async ({
  context,
  mock,
  configure,
  command,
}) => {
  await configure(FULL);
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/basic.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  const edited = MOCK_EDITED.toUpperCase();
  await expect.poll(() => overlayTexts(page)).toEqual([edited, edited]);

  // Two pages × (translation pass with the image + text-only editor pass).
  expect(mock.apiRequests).toHaveLength(4);
  const editor = mock.apiRequests.filter((r) => isEditorRequest(r.body.messages[0].content));
  expect(editor).toHaveLength(2);
  const script = editor[0].body.messages[0].content[0].text as string;
  expect(script).toContain('Page script:');
  expect(script).toContain('"budget_chars"');
  expect(editor[0].body.system).toContain('editor and proofreader');

  const styles = await page.evaluate(() => {
    const root = document.querySelector('manga-translator-root')!.shadowRoot!;
    return {
      fonts: [...root.querySelectorAll<HTMLElement>('.mt-block')].map((b) => b.style.fontFamily),
      notes: [...root.querySelectorAll<HTMLElement>('.mt-note')].map((n) => n.title),
    };
  });
  // The editor marked the lines as shouted → heavy display lettering.
  for (const f of styles.fonts) expect(f).toContain('MangaTranslatorShout');
  expect(styles.notes).toEqual([`Translator's note: ${MOCK_NOTE}`, `Translator's note: ${MOCK_NOTE}`]);
});

test('image cleaning: lettering over artwork is inpainted and the translation is outlined', async ({
  context,
  mock,
  configure,
  command,
}) => {
  await configure(FULL);
  const page = await context.newPage();
  await page.goto(`${mock.origin}/pages/art.html`);
  await page.waitForLoadState('load');
  await command(page, { type: 'translatePage' });
  await expect.poll(() => overlayTexts(page)).toEqual([MOCK_EDITED.toUpperCase()]);
  const info = await page.evaluate(() => {
    const root = document.querySelector('manga-translator-root')!.shadowRoot!;
    const patch = root.querySelector<HTMLElement>('.mt-patch');
    const block = root.querySelector<HTMLElement>('.mt-block')!;
    return {
      patch: patch?.style.backgroundImage.slice(0, 30),
      variant: block.className,
      background: block.style.background,
      shadow: block.style.textShadow,
    };
  });
  expect(info.patch).toContain('data:image/webp;base64');
  expect(info.variant).toContain('mt-overprint');
  expect(info.background).toBe('transparent');
  expect(info.shadow).not.toBe('');
});

test('reader: shows workflow and QC status, exports pages with translator-note footnotes', async ({
  context,
  extensionId,
  configure,
}) => {
  await configure({ ...FULL, useContext: false });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/reader.html`);
  await page.setInputFiles('#file-input', path.join(FIXTURES, 'chapter.cbz'));
  await page.click('#translate-all');
  await expect(page.locator('#progress')).toHaveText('2 / 2 translated');
  await expect(page.locator('.page .state').first()).toContainText('edited & proofread');
  await expect(page.locator('.page .state').first()).toContainText('QC passed');

  const download = page.waitForEvent('download');
  await page.click('#export');
  const entries = unzipSync(new Uint8Array(await readFile(await (await download).path())));
  for (const data of Object.values(entries)) {
    // 1200 px page + a footnote strip for the translator's note.
    expect(jpegHeight(data)).toBeGreaterThan(1200);
  }
});
