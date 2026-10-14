import { blockArea } from './layout';
import type { QcIssue, TranslatedBlock } from './types';

/** Targets written in scripts that legitimately contain CJK characters. */
const CJK_TARGETS = ['ja', 'ko', 'zh-CN', 'zh-TW'];
const SOURCE_SCRIPT = /[぀-ヿ㐀-䶿一-鿿가-힯ᄀ-ᇿ]/;

/**
 * Roughly how many characters fit in a block's balloon at comfortable reading size
 * (lettering about 2.6% of the page width). Used to brief the editor and to flag
 * lines that will have to be lettered uncomfortably small.
 */
export function balloonCapacity(block: TranslatedBlock, pageW: number, pageH: number): number {
  const refW = 800;
  const refH = (pageH / pageW) * refW;
  const { box, padding } = blockArea(block, refW, refH);
  const fs = refW * 0.026;
  const cols = Math.max(1, Math.floor((box.x1 - box.x0 - 2 * padding) / (fs * 0.6)));
  const rows = Math.max(1, Math.floor((box.y1 - box.y0 - 2 * padding) / (fs * 1.12)));
  return Math.max(4, Math.floor(cols * rows * 0.8));
}

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** Automatic quality control of a translated page. */
export function runQc(blocks: TranslatedBlock[], pageW: number, pageH: number, targetLang: string): QcIssue[] {
  const issues: QcIssue[] = [];
  blocks.forEach((b, i) => {
    const n = i + 1;
    if (!CJK_TARGETS.includes(targetLang) && SOURCE_SCRIPT.test(b.translation)) {
      issues.push({ block: i, kind: 'leftover-source', message: `Line ${n} still contains untranslated source-language text.` });
    } else if (b.original && norm(b.translation) === norm(b.original) && /\p{L}/u.test(b.original)) {
      issues.push({ block: i, kind: 'untranslated', message: `Line ${n} is identical to the original.` });
    }
    if (b.kind !== 'sfx') {
      const cap = balloonCapacity(b, pageW, pageH);
      const len = b.translation.length;
      if (len > cap * 1.35) {
        issues.push({
          block: i,
          kind: 'too-long',
          message: `Line ${n} is ${len} characters for a balloon that comfortably fits about ${cap}; it will be lettered very small.`,
        });
      }
    }
  });
  return issues;
}
