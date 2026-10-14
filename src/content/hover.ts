import { contentRect, mangaElementAt, type MangaElement } from './dom';
import type { OverlayManager } from './overlays';
import { button, getUi } from './ui';

/** Floating "Translate" button that appears over manga images under the pointer. */
export class HoverButton {
  private el: HTMLElement | null = null;
  private target: MangaElement | null = null;
  private hideTimer: number | undefined;
  private frame = 0;
  private lastX = -1;
  private lastY = -1;
  enabled = true;

  constructor(private manager: OverlayManager) {
    document.addEventListener('mousemove', (e) => this.onMove(e), { capture: true, passive: true });
    window.addEventListener('scroll', () => this.reposition(), { capture: true, passive: true });
    window.addEventListener('blur', () => this.hide());
  }

  private onMove(e: MouseEvent): void {
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.check();
    });
  }

  private check(): void {
    if (!this.enabled) return this.hide();
    if (this.el?.matches(':hover')) return;
    const found = mangaElementAt(this.lastX, this.lastY, this.manager.settings.minImageSize);
    if (found) {
      clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
      if (found !== this.target) {
        this.target = found;
        this.render();
      }
      this.reposition();
    } else if (this.target && this.hideTimer === undefined) {
      this.hideTimer = window.setTimeout(() => this.hide(), 350);
    }
  }

  /** Re-draw the button for the current state of the hovered image. */
  render(): void {
    const t = this.target;
    if (!t) return;
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'mt-hover';
      this.el.addEventListener('mouseleave', () => {
        this.hideTimer = window.setTimeout(() => this.hide(), 350);
      });
      this.el.addEventListener('mouseenter', () => clearTimeout(this.hideTimer));
      getUi().fixed.appendChild(this.el);
    }
    const entry = this.manager.entries.get(t);
    const state = entry?.state ?? 'idle';
    const buttons: HTMLElement[] = [];
    if (state === 'queued' || state === 'pending') {
      buttons.push(button('Translating…', () => {}, 'mt-primary'));
    } else if (state === 'done' && entry) {
      buttons.push(
        button(entry.showOriginal || !this.manager.visible ? 'Show translation' : 'Show original', () => {
          if (!this.manager.visible) this.manager.setVisible(true);
          else this.manager.setShowOriginal(entry, !entry.showOriginal);
          this.render();
        }),
      );
      const redo = button('↻', () => this.manager.translate(t, true), 'mt-icon');
      redo.title = 'Translate again (skip the cache)';
      buttons.push(redo);
    } else {
      const go = button('🍓 Translate', () => this.manager.translate(t, state === 'error'), 'mt-primary');
      go.title = 'Translate this page (Alt+Shift+M translates every page)';
      buttons.push(go);
    }
    this.el.replaceChildren(...buttons);
    this.el.style.display = '';
  }

  reposition(): void {
    if (!this.el || !this.target) return;
    if (!this.target.isConnected) return this.hide();
    const r = contentRect(this.target);
    const top = Math.max(r.top, 0) + 10;
    const right = Math.min(r.left + r.width, window.innerWidth) - 10;
    if (top > r.top + r.height - 30 || right < r.left + 60) return this.hide();
    this.el.style.top = `${top}px`;
    this.el.style.left = `${right - this.el.offsetWidth}px`;
  }

  /** Called when the manager's state changes so the label follows the hovered image. */
  refresh(): void {
    if (this.target && this.el?.style.display !== 'none') {
      this.render();
      this.reposition();
    }
  }

  hide(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.target = null;
    if (this.el) this.el.style.display = 'none';
  }
}
