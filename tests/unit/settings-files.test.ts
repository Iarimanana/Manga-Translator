import { describe, expect, it } from 'vitest';
import { fileKind, isPageEntry, naturalCompare } from '../../src/shared/files';
import { DEFAULT_SETTINGS, fontStack, hostOf, modelSupportsFallbacks, normalizeSettings } from '../../src/shared/settings';

describe('normalizeSettings', () => {
  it('fills defaults', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps and repairs bad values', () => {
    const s = normalizeSettings({
      concurrency: 99,
      fontScale: -3,
      maxImageEdge: 99999,
      effort: 'ultra' as never,
      autoSites: ['a.com', 5 as never],
      apiKey: '  sk-ant-x  ',
      baseURL: 'https://proxy.example.com///',
      model: '',
    });
    expect(s.concurrency).toBe(8);
    expect(s.fontScale).toBe(0.5);
    expect(s.maxImageEdge).toBe(2576);
    expect(s.effort).toBe('low');
    expect(s.autoSites).toEqual(['a.com']);
    expect(s.apiKey).toBe('sk-ant-x');
    expect(s.baseURL).toBe('https://proxy.example.com');
    expect(s.model).toBe(DEFAULT_SETTINGS.model);
  });

  it('knows which models take server-side fallbacks', () => {
    expect(modelSupportsFallbacks('claude-opus-5-5')).toBe(true);
    expect(modelSupportsFallbacks('claude-sonnet-5-5')).toBe(true);
    expect(modelSupportsFallbacks('claude-haiku-5-5')).toBe(false);
    expect(modelSupportsFallbacks('something-else')).toBe(false);
  });

  it('builds font stacks', () => {
    expect(fontStack({ fontFamily: 'comic', customFont: '' })).toContain('MangaTranslatorComic');
    expect(fontStack({ fontFamily: 'custom', customFont: "Wild Words'" })).toMatch(/^'Wild Words'/);
  });

  it('parses hostnames safely', () => {
    expect(hostOf('https://manga.example.org/ch/1')).toBe('manga.example.org');
    expect(hostOf('not a url')).toBe('');
  });
});

describe('files', () => {
  it('sorts pages naturally', () => {
    expect(['p10.jpg', 'p2.jpg', 'p1.jpg', 'P3.png'].sort(naturalCompare)).toEqual(['p1.jpg', 'p2.jpg', 'P3.png', 'p10.jpg']);
  });

  it('filters archive entries to real pages', () => {
    expect(isPageEntry('vol1/001.jpg')).toBe(true);
    expect(isPageEntry('__MACOSX/vol1/._001.jpg')).toBe(false);
    expect(isPageEntry('vol1/.thumb.png')).toBe(false);
    expect(isPageEntry('vol1/info.txt')).toBe(false);
  });

  it('detects file kinds', () => {
    expect(fileKind('a.PDF', '')).toBe('pdf');
    expect(fileKind('a.cbz', '')).toBe('zip');
    expect(fileKind('scan', 'image/webp')).toBe('image');
    expect(fileKind('notes.txt', 'text/plain')).toBe('unknown');
  });
});
