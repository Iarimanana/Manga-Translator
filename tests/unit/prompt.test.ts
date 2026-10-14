import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildUserText, pageContext } from '../../src/shared/prompt';
import type { PageTranslation } from '../../src/shared/types';

describe('buildSystemPrompt', () => {
  it('names the target and source languages', () => {
    const p = buildSystemPrompt({ targetLang: 'pt-BR', sourceLang: 'ko', sfxStyle: 'none', adaptation: 'localize', customInstructions: '' });
    expect(p).toContain('into Brazilian Portuguese');
    expect(p).toContain('Source language: Korean.');
    expect(p).toContain('skip them entirely');
    expect(p).not.toContain('Additional instructions');
  });

  it('includes SFX handling and the reader glossary when set', () => {
    const p = buildSystemPrompt({
      targetLang: 'en',
      sourceLang: 'auto',
      sfxStyle: 'subtitle',
      adaptation: 'notes',
      customInstructions: '  ユウ = Yuu  ',
    });
    expect(p).toContain('Include sound effects');
    expect(p).toContain("translator's note");
    expect(p).toContain('Additional instructions and glossary from the reader');
    expect(p.trimEnd().endsWith('ユウ = Yuu')).toBe(true);
  });

  it('falls back to English for unknown codes', () => {
    expect(
      buildSystemPrompt({ targetLang: 'xx', sourceLang: 'yy', sfxStyle: 'none', adaptation: 'localize', customInstructions: '' }),
    ).toContain(
      'into English',
    );
  });
});

describe('buildUserText', () => {
  it('states the image size and slice position', () => {
    const t = buildUserText({ width: 800, height: 1200, tileIndex: 1, tileCount: 3 });
    expect(t).toContain('800×1200 pixels');
    expect(t).toContain('pixel coordinates');
    expect(t).toContain('slice 2 of 3');
  });

  it('adds previous-page context when provided', () => {
    const t = buildUserText({ width: 10, height: 10, tileIndex: 0, tileCount: 1, context: 'あ => Ah' });
    expect(t).toContain('previous page');
    expect(t).toContain('あ => Ah');
    expect(buildUserText({ width: 10, height: 10, tileIndex: 0, tileCount: 1 })).not.toContain('previous page');
  });
});

describe('pageContext', () => {
  it('summarises the last blocks on one line each', () => {
    const page = {
      blocks: [
        { original: 'おはよう\nございます', translation: 'Good\nmorning' },
        { original: '行くぞ', translation: "Let's go" },
      ],
    } as unknown as PageTranslation;
    expect(pageContext(page)).toBe("おはよう ございます => Good morning\n行くぞ => Let's go");
    expect(pageContext(page, 1)).toBe("行くぞ => Let's go");
  });
});
