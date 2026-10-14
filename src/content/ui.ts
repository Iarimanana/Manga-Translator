import { OVERLAY_CSS } from '../shared/render';

const UI_CSS = `
:host { all: initial; }
.mt-layers { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.mt-layer { position: absolute; pointer-events: none; }
.mt-status {
  position: absolute; display: flex; align-items: center; gap: 6px; max-width: calc(100% - 16px);
  padding: 5px 9px; border-radius: 999px; pointer-events: auto;
  font: 600 12px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #fff;
  background: rgba(20, 20, 24, .82); box-shadow: 0 2px 10px rgba(0,0,0,.25);
}
.mt-status.mt-error { background: #c62839; }
.mt-status button, .mt-status a {
  all: unset; cursor: pointer; text-decoration: underline; font-weight: 700; color: #fff;
}
.mt-spinner {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: mt-spin .8s linear infinite;
}
@keyframes mt-spin { to { transform: rotate(360deg); } }

.mt-hover { position: fixed; display: flex; gap: 4px; pointer-events: auto; z-index: 3; }
.mt-btn {
  all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
  padding: 6px 11px; border-radius: 999px; background: #fff; color: #1d1d22;
  font: 650 12.5px/1 system-ui, -apple-system, 'Segoe UI', sans-serif;
  box-shadow: 0 1px 2px rgba(0,0,0,.18), 0 4px 14px rgba(0,0,0,.18); border: 1px solid rgba(0,0,0,.08);
  white-space: nowrap; user-select: none;
}
.mt-btn:hover { background: #fff1f3; }
.mt-btn.mt-primary { background: #e63950; color: #fff; border-color: transparent; }
.mt-btn.mt-primary:hover { background: #d22c43; }
.mt-btn.mt-icon { padding: 6px 8px; }

.mt-toast {
  position: fixed; right: 16px; bottom: 16px; max-width: min(380px, calc(100vw - 32px)); z-index: 6;
  padding: 10px 14px; border-radius: 10px; pointer-events: auto;
  font: 500 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #fff;
  background: rgba(20, 20, 24, .92); box-shadow: 0 6px 24px rgba(0,0,0,.3);
  opacity: 0; transform: translateY(8px); transition: opacity .18s ease, transform .18s ease;
}
.mt-toast.mt-show { opacity: 1; transform: none; }
.mt-toast a { color: #ffb3c0; cursor: pointer; text-decoration: underline; }

.mt-select-mask { position: fixed; inset: 0; z-index: 5; cursor: crosshair; pointer-events: auto; background: rgba(0,0,0,.28); }
.mt-select-hint {
  position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 6; pointer-events: none;
  padding: 8px 14px; border-radius: 999px; color: #fff; background: rgba(20,20,24,.9);
  font: 600 13px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif;
}
.mt-select-rect {
  position: fixed; z-index: 6; pointer-events: none; border: 2px solid #ff4d6d;
  background: rgba(255,77,109,.08); box-shadow: 0 0 0 9999px rgba(0,0,0,.28);
}

.mt-panel { position: absolute; pointer-events: none; outline: 2px dashed #ff4d6d; outline-offset: 1px; }
.mt-panel .mt-layer { left: 0; top: 0; }
.mt-panel-bar {
  position: absolute; left: -3px; bottom: calc(100% + 4px); display: flex; gap: 4px; pointer-events: auto;
  cursor: move; align-items: center;
}
.mt-panel-resize {
  position: absolute; right: -8px; bottom: -8px; width: 14px; height: 14px; pointer-events: auto;
  cursor: nwse-resize; background: #ff4d6d; border-radius: 4px; border: 2px solid #fff;
}
.mt-panel .mt-status { left: 6px; top: 6px; }
${OVERLAY_CSS}
`;

export interface UiRoot {
  host: HTMLElement;
  shadow: ShadowRoot;
  /** Container for per-image overlay layers and area panels (document coordinates). */
  layers: HTMLElement;
  /** Container for fixed-position UI (hover button, selection mask, toasts). */
  fixed: HTMLElement;
}

let root: UiRoot | null = null;

export function getUi(): UiRoot {
  if (root?.host.isConnected) return root;
  const host = document.createElement('manga-translator-root');
  const set = (k: string, v: string) => host.style.setProperty(k, v, 'important');
  set('position', 'absolute');
  set('top', '0');
  set('left', '0');
  set('width', '0');
  set('height', '0');
  set('overflow', 'visible');
  set('z-index', '2147483647');
  set('pointer-events', 'none');
  set('display', 'block');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = UI_CSS;
  const layers = document.createElement('div');
  layers.className = 'mt-layers';
  const fixed = document.createElement('div');
  shadow.append(style, layers, fixed);
  document.documentElement.appendChild(host);
  root = { host, shadow, layers, fixed };
  return root;
}

/** Temporarily hide all extension UI (so screenshots don't include it). */
export function setUiHidden(hidden: boolean): void {
  if (root) root.host.style.setProperty('visibility', hidden ? 'hidden' : 'visible', 'important');
}

let toastTimer: number | undefined;

export function toast(message: string, opts: { action?: { label: string; run: () => void }; ms?: number } = {}): void {
  const ui = getUi();
  let el = ui.fixed.querySelector<HTMLElement>('.mt-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'mt-toast';
    ui.fixed.appendChild(el);
  }
  el.replaceChildren(document.createTextNode(message));
  if (opts.action) {
    const a = document.createElement('a');
    a.textContent = opts.action.label;
    a.addEventListener('click', opts.action.run);
    el.append(' ', a);
  }
  requestAnimationFrame(() => el!.classList.add('mt-show'));
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('mt-show'), opts.ms ?? 4000);
}

export function button(label: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `mt-btn ${cls}`.trim();
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(e);
  });
  // Keep page handlers (page-turn on mousedown, drag-to-scroll) from reacting to our buttons.
  for (const type of ['mousedown', 'pointerdown', 'mouseup', 'pointerup']) {
    b.addEventListener(type, (e) => e.stopPropagation());
  }
  return b;
}
