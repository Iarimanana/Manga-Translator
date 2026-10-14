import { ensureFont, renderBlocksDom, togglePeek } from '../shared/render';
import type { PageTranslation } from '../shared/types';
import { captureViewport, overlayStyle, requestTranslation, TranslateFailure, type OverlayManager } from './overlays';
import { button, getUi, toast } from './ui';

interface DocRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let selecting = false;

/** Let the user drag out a rectangle on the viewport. Resolves to null when cancelled. */
export function selectRegion(): Promise<DocRect | null> {
  if (selecting) return Promise.resolve(null);
  selecting = true;
  const ui = getUi();
  const mask = document.createElement('div');
  mask.className = 'mt-select-mask';
  const hint = document.createElement('div');
  hint.className = 'mt-select-hint';
  hint.textContent = 'Drag over the text you want translated · Esc to cancel';
  const rectEl = document.createElement('div');
  rectEl.className = 'mt-select-rect';
  rectEl.style.display = 'none';
  ui.fixed.append(mask, hint, rectEl);

  return new Promise((resolve) => {
    let start: { x: number; y: number } | null = null;
    let current = { x: 0, y: 0, w: 0, h: 0 };
    const finish = (result: DocRect | null) => {
      selecting = false;
      mask.remove();
      hint.remove();
      rectEl.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    mask.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      mask.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY };
      mask.style.background = 'transparent';
    });
    mask.addEventListener('pointermove', (e) => {
      if (!start) return;
      current = {
        x: Math.min(start.x, e.clientX),
        y: Math.min(start.y, e.clientY),
        w: Math.abs(e.clientX - start.x),
        h: Math.abs(e.clientY - start.y),
      };
      Object.assign(rectEl.style, {
        display: 'block',
        left: `${current.x}px`,
        top: `${current.y}px`,
        width: `${current.w}px`,
        height: `${current.h}px`,
      });
    });
    mask.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      if (!start) return;
      start = null;
      if (current.w < 24 || current.h < 24) {
        toast('Area too small — drag a larger box around the text.');
        finish(null);
        return;
      }
      finish({ x: current.x + window.scrollX, y: current.y + window.scrollY, w: current.w, h: current.h });
    });
  });
}

const panels = new Set<RegionPanel>();

/**
 * A movable, resizable frame that translates whatever is drawn beneath it (works for
 * canvas readers, protected images and anything else that can be screenshotted).
 */
export class RegionPanel {
  private el: HTMLElement;
  private blocks: HTMLElement;
  private status: HTMLElement | null = null;
  private result: PageTranslation | null = null;
  private showOriginal = false;
  private busy = false;

  constructor(
    private rect: DocRect,
    private manager: OverlayManager,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'mt-panel';
    const layer = document.createElement('div');
    layer.className = 'mt-layer';
    layer.style.width = '100%';
    layer.style.height = '100%';
    this.blocks = document.createElement('div');
    this.blocks.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%';
    this.blocks.addEventListener('click', (ev) => {
      togglePeek(ev.target);
    });
    layer.appendChild(this.blocks);

    const bar = document.createElement('div');
    bar.className = 'mt-panel-bar';
    const redo = button('↻ Translate', () => void this.translate(true), 'mt-primary');
    redo.title = 'Translate what is under this frame now';
    const toggle = button('Original', () => {
      this.showOriginal = !this.showOriginal;
      this.blocks.style.display = this.showOriginal ? 'none' : '';
      toggle.textContent = this.showOriginal ? 'Translation' : 'Original';
    });
    const close = button('✕', () => this.destroy(), 'mt-icon');
    close.title = 'Close this frame';
    bar.append(redo, toggle, close);
    this.enableDrag(bar, (dx, dy, base) => ({ ...base, x: base.x + dx, y: base.y + dy }));

    const handle = document.createElement('div');
    handle.className = 'mt-panel-resize';
    handle.title = 'Resize';
    this.enableDrag(handle, (dx, dy, base) => ({ ...base, w: Math.max(40, base.w + dx), h: Math.max(40, base.h + dy) }));

    this.el.append(layer, bar, handle);
    getUi().layers.appendChild(this.el);
    panels.add(this);
    this.place();
  }

  private enableDrag(handle: HTMLElement, apply: (dx: number, dy: number, base: DocRect) => DocRect): void {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const sx = e.clientX;
      const sy = e.clientY;
      const base = { ...this.rect };
      const move = (ev: PointerEvent) => {
        this.rect = apply(ev.clientX - sx, ev.clientY - sy, base);
        this.place();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        if (this.rect.x !== base.x || this.rect.y !== base.y || this.rect.w !== base.w || this.rect.h !== base.h) {
          // The frame now covers something else; old translations would be misplaced.
          this.result = null;
          this.blocks.replaceChildren();
          this.setStatus('Press ↻ Translate to translate this area');
        }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  private place(): void {
    Object.assign(this.el.style, {
      left: `${this.rect.x}px`,
      top: `${this.rect.y}px`,
      width: `${this.rect.w}px`,
      height: `${this.rect.h}px`,
    });
    if (this.result) this.render();
  }

  private render(): void {
    if (!this.result) return;
    renderBlocksDom(this.blocks, this.result, this.rect.w, this.rect.h, overlayStyle(this.manager.settings));
  }

  rerender(): void {
    this.render();
  }

  private setStatus(text: string, opts: { spinner?: boolean; error?: boolean } = {}): void {
    this.status?.remove();
    const s = document.createElement('div');
    s.className = `mt-status${opts.error ? ' mt-error' : ''}`;
    if (opts.spinner) {
      const sp = document.createElement('span');
      sp.className = 'mt-spinner';
      s.appendChild(sp);
    }
    s.append(text);
    this.el.appendChild(s);
    this.status = s;
  }

  private clearStatus(): void {
    this.status?.remove();
    this.status = null;
  }

  async translate(force = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const vx = this.rect.x - window.scrollX;
      const vy = this.rect.y - window.scrollY;
      if (vx < 0 || vy < 0 || vx + this.rect.w > window.innerWidth + 1 || vy + this.rect.h > window.innerHeight + 1) {
        throw new TranslateFailure('Scroll so the whole frame is visible, then press ↻ Translate.');
      }
      this.blocks.replaceChildren();
      this.result = null;
      this.clearStatus();
      const dataUrl = await captureViewport({ x: vx, y: vy, w: this.rect.w, h: this.rect.h });
      this.setStatus('Translating…', { spinner: true });
      const result = await requestTranslation({ kind: 'dataUrl', dataUrl }, force);
      await ensureFont();
      this.result = result;
      this.showOriginal = false;
      this.blocks.style.display = '';
      this.render();
      if (result.blocks.length === 0) this.setStatus('No text found in this area');
      else this.clearStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus(message, { error: true });
    } finally {
      this.busy = false;
    }
  }

  destroy(): void {
    this.el.remove();
    panels.delete(this);
  }

  static rerenderAll(): void {
    for (const p of panels) p.rerender();
  }

  static destroyAll(): void {
    for (const p of [...panels]) p.destroy();
  }

  static get count(): number {
    return panels.size;
  }
}
