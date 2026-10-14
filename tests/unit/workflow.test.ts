import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../src/background/translator';
import { inpaint, rectMask } from '../../src/shared/inpaint';
import { layoutBlock, letterText, roleOf, variantOf } from '../../src/shared/layout';
import { extractJson, parseEditorOutput } from '../../src/shared/parse';
import { buildEditorPrompt, buildEditorUserText } from '../../src/shared/prompt';
import { balloonCapacity, runQc } from '../../src/shared/qc';
import { normalizeSettings } from '../../src/shared/settings';
import { BASE_FONT_SIZE, balanceLines, fitText, wrapText } from '../../src/shared/textfit';
import type { TranslatedBlock } from '../../src/shared/types';

const measure = (s: string) => s.length * BASE_FONT_SIZE * 0.5;

const block = (over: Partial<TranslatedBlock> = {}): TranslatedBlock => ({
  textRect: { x: 0.45, y: 0.1, w: 0.1, h: 0.15 },
  bubbleRect: { x: 0.35, y: 0.06, w: 0.3, h: 0.24 },
  original: '待ってくれ！',
  translation: 'Wait for me!',
  kind: 'speech',
  bg: '#ffffff',
  fg: '#111111',
  emphasis: 'normal',
  note: '',
  ...over,
});

describe('step 1 & 2 — editor prompt and script', () => {
  it('briefs the editor on accuracy, flow, consistency, adaptation and fit', () => {
    const p = buildEditorPrompt({ targetLang: 'en', sourceLang: 'ja', sfxStyle: 'subtitle', adaptation: 'notes', customInstructions: 'ユウ = Yuu' });
    for (const word of ['Accuracy', 'Flow', 'Consistency', 'Fit', 'Proofread', "translator's note", 'ユウ = Yuu']) {
      expect(p).toContain(word);
    }
  });

  it('sends every line with its budget, plus QC findings and context', () => {
    const t = buildEditorUserText(
      [{ id: 0, kind: 'speech', original: 'あ', translation: 'Ah', emphasis: 'normal', note: '', capacity: 42 }],
      'prev => line',
      ['Line 1 is too long.'],
    );
    expect(t).toContain('prev => line');
    expect(t).toContain('- Line 1 is too long.');
    expect(JSON.parse(t.split('\n').at(-1)!)).toEqual({
      id: 0,
      kind: 'speech',
      original: 'あ',
      draft: 'Ah',
      emphasis: 'normal',
      note: '',
      budget_chars: 42,
    });
  });

  it('applies edits by id and keeps drafts the editor dropped', () => {
    const blocks = [block({ translation: 'Wait for me' }), block({ translation: 'Hm' })];
    const out = applyEdits(blocks, [{ id: 0, translation: ' Wait up! ', emphasis: 'shout', note: 'n' }, { id: 7, translation: 'x', emphasis: 'normal', note: '' }]);
    expect(out[0]).toMatchObject({ translation: 'Wait up!', emphasis: 'shout', note: 'n' });
    expect(out[1].translation).toBe('Hm');
  });

  it('repairs sloppy editor JSON', () => {
    const out = parseEditorOutput(extractJson('```json\n[{"index":1,"revised":"Yo","emphasis":"loud"}]\n```'));
    expect(out.blocks).toEqual([{ id: 1, translation: 'Yo', emphasis: 'normal', note: '' }]);
  });
});

describe('step 3 — image cleaning (inpainting)', () => {
  it('rebuilds a flat background behind lettering', () => {
    const w = 20;
    const h = 20;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set([200, 40, 40, 255], i * 4);
    for (let y = 8; y < 12; y++) for (let x = 6; x < 14; x++) d.set([0, 0, 0, 255], (y * w + x) * 4);
    inpaint(d, w, h, rectMask(w, h, 6, 8, 14, 12, 1));
    for (let i = 0; i < w * h; i++) expect([...d.slice(i * 4, i * 4 + 3)].map(Math.round)).toEqual([200, 40, 40]);
  });

  it('continues a gradient smoothly and leaves unmasked pixels alone', () => {
    const w = 30;
    const h = 10;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([x * 8, 0, 0, 255], (y * w + x) * 4);
    const before = d.slice();
    for (let y = 3; y < 7; y++) for (let x = 12; x < 18; x++) d.set([255, 255, 255, 255], (y * w + x) * 4);
    const mask = rectMask(w, h, 12, 3, 18, 7);
    inpaint(d, w, h, mask);
    for (let i = 0; i < w * h; i++) {
      if (!mask[i]) expect(d[i * 4]).toBe(before[i * 4]);
      else expect(Math.abs(d[i * 4] - before[i * 4])).toBeLessThan(24);
    }
  });
});

describe('step 4 — typesetting', () => {
  it('balances line lengths without adding lines', () => {
    const text = 'you can read this right now';
    const greedy = wrapText(text, 120, 10, measure)!;
    const balanced = balanceLines(text, greedy.length, 120, 10, measure);
    expect(balanced.length).toBe(greedy.length);
    const spread = (ls: string[]) => Math.max(...ls.map((l) => l.length)) - Math.min(...ls.map((l) => l.length));
    expect(spread(balanced)).toBeLessThanOrEqual(spread(greedy));
    expect(balanced.join(' ')).toBe(text);
    expect(fitText(text, 120, 200, measure, { minSize: 5, maxSize: 10, lineHeight: 1, balance: true }).lines).toEqual(balanced);
  });

  it('letters in capitals by default and honours sentence case', () => {
    const b = block({ translation: 'i will win' });
    expect(letterText(b, 'balloon', {})).toBe('I WILL WIN');
    expect(letterText(b, 'balloon', { letteringCase: 'sentence' })).toBe('i will win');
    expect(letterText(b, 'sfx', { letteringCase: 'sentence' })).toBe('I WILL WIN');
    expect(letterText(block({ translation: 'straße' }), 'balloon', { lang: 'de' })).toBe('STRASSE');
  });

  it('chooses lettering by delivery: shouts are bigger, whispers smaller, thoughts italic', () => {
    const text = 'No';
    const roomy = { bubbleRect: { x: 0.2, y: 0.05, w: 0.6, h: 0.4 }, translation: text };
    const size = (b: TranslatedBlock) => layoutBlock(b, 800, 1200, measure, { fontScale: 1 }).fontSize;
    const normal = size(block(roomy));
    expect(size(block({ ...roomy, emphasis: 'shout' }))).toBeGreaterThan(normal);
    expect(size(block({ ...roomy, emphasis: 'whisper' }))).toBeLessThan(normal);
    expect(roleOf(block({ kind: 'thought' }), 'balloon')).toBe('thought');
    expect(roleOf(block({ emphasis: 'shout' }), 'balloon')).toBe('shout');
  });

  it('outlines text over cleaned artwork instead of painting a box', () => {
    const b = block({ clean: { rect: { x: 0.4, y: 0.08, w: 0.2, h: 0.2 }, image: 'data:image/webp;base64,AA' } });
    const L = layoutBlock(b, 800, 1200, measure, { fontScale: 1 });
    expect(L.variant).toBe('overprint');
    expect(L.fill).toBeNull();
    expect(L.stroke).toBeGreaterThan(0);
    const want = { x0: 320, y0: 96, x1: 480, y1: 336 };
    for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(L.patch!.box[k]).toBeCloseTo(want[k], 6);
  });
});

describe('step 5 — SFX styles', () => {
  const sfx = block({ kind: 'sfx', translation: 'slam', ink: '#cc0000', textRect: { x: 0.1, y: 0.4, w: 0.2, h: 0.1 } });

  it('subtitles sit beside the untouched effect in a small caption', () => {
    expect(variantOf(sfx, { sfxStyle: 'subtitle' })).toBe('subtitle');
    const L = layoutBlock(sfx, 800, 1200, measure, { fontScale: 1, sfxStyle: 'subtitle' });
    expect(L.box.y0).toBeGreaterThanOrEqual(0.5 * 1200); // below the effect
    expect(L.fontSize).toBeLessThanOrEqual(800 * 0.022);
    expect(L.patch).toBeUndefined();
  });

  it('replacement redraws the effect in its own colour, big, over the cleaned art', () => {
    const L = layoutBlock(sfx, 800, 1200, measure, { fontScale: 1, sfxStyle: 'replace' });
    expect(L.variant).toBe('sfx');
    expect(L.role).toBe('sfx');
    expect(L.color).toBe('#cc0000');
    expect(L.lines).toEqual(['SLAM']);
    expect(L.fontSize).toBeGreaterThan(30);
  });

  it('migrates the old on/off SFX switch', () => {
    expect(normalizeSettings({ translateSfx: false }).sfxStyle).toBe('none');
    expect(normalizeSettings({ translateSfx: true }).sfxStyle).toBe('subtitle');
    expect(normalizeSettings({ translateSfx: false, sfxStyle: 'replace' }).sfxStyle).toBe('replace');
  });
});

describe('step 6 — quality control', () => {
  it('flags leftover source text, untranslated lines and overlong lines', () => {
    const issues = runQc(
      [
        block({ translation: 'Wait 待って' }),
        block({ original: 'OK', translation: 'ok' }),
        block({ translation: 'This is a ridiculously long line that will never fit inside such a tiny little balloon at all, honestly.', bubbleRect: { x: 0.45, y: 0.1, w: 0.1, h: 0.15 } }),
        block(),
      ],
      800,
      1200,
      'en',
    );
    expect(issues.map((i) => [i.block, i.kind])).toEqual([
      [0, 'leftover-source'],
      [1, 'untranslated'],
      [2, 'too-long'],
    ]);
  });

  it('allows CJK text when translating into a CJK language', () => {
    expect(runQc([block({ translation: '待って' })], 800, 1200, 'ja')).toEqual([]);
  });

  it('estimates a bigger budget for a bigger balloon', () => {
    const small = balloonCapacity(block({ bubbleRect: { x: 0.45, y: 0.1, w: 0.1, h: 0.15 } }), 800, 1200);
    const big = balloonCapacity(block({ bubbleRect: { x: 0.2, y: 0.05, w: 0.6, h: 0.4 } }), 800, 1200);
    expect(big).toBeGreaterThan(small * 3);
  });
});
