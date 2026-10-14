import type { ContentCommand } from '../shared/messages';
import { loadSettings, onSettingsChanged, saveSettings } from '../shared/settings';
import { isCandidate, isMangaElement, type MangaElement } from './dom';
import { HoverButton } from './hover';
import { OverlayManager } from './overlays';
import { RegionPanel, selectRegion } from './region';
import { toast } from './ui';

declare global {
  interface Window {
    __mangaTranslatorLoaded?: boolean;
  }
}

type CommandHandler = (msg: ContentCommand) => unknown;

async function main(): Promise<CommandHandler> {
  let settings = await loadSettings();
  const host = location.hostname;
  const manager = new OverlayManager(settings);
  const hover = new HoverButton(manager);
  manager.setChangeListener(() => hover.refresh());

  const siteDisabled = () => settings.disabledSites.includes(host);
  const autoEnabled = () => !siteDisabled() && settings.autoSites.includes(host);
  hover.enabled = settings.showHoverButton && !siteDisabled();

  // --- Auto-translate: translate pages as they approach the viewport -----------------
  const observed = new WeakSet<Element>();
  const io = new IntersectionObserver(
    (records) => {
      if (!autoEnabled()) return;
      for (const r of records) {
        if (!r.isIntersecting || !isMangaElement(r.target)) continue;
        const el = r.target as MangaElement;
        const e = manager.entries.get(el);
        if ((!e || e.state === 'idle') && isCandidate(el, settings.minImageSize)) manager.translate(el);
      }
    },
    { rootMargin: '150% 0px 150% 0px' },
  );

  function scan(): void {
    for (const el of document.querySelectorAll<MangaElement>('img, canvas')) {
      if (el instanceof HTMLImageElement && !el.complete) {
        el.addEventListener('load', scheduleScan, { once: true });
        continue;
      }
      if (!observed.has(el)) {
        observed.add(el);
        io.observe(el);
      }
    }
  }

  function startAuto(): void {
    scan();
    // Re-check elements already in view (IntersectionObserver only reports changes).
    for (const el of document.querySelectorAll<MangaElement>('img, canvas')) {
      if (observed.has(el)) {
        io.unobserve(el);
        io.observe(el);
      }
    }
  }

  let scanTimer: number | undefined;
  function scheduleScan(): void {
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      if (autoEnabled()) scan();
      manager.updateAll();
    }, 250);
  }

  // Readers that swap pages in place, infinite scroll, lazy loading.
  const whenLoaded = (el: MangaElement, fn: () => void) => {
    if (el instanceof HTMLImageElement && !el.complete) {
      el.addEventListener('load', fn, { once: true });
      el.addEventListener('error', fn, { once: true });
    } else {
      requestAnimationFrame(fn);
    }
  };
  manager.setSourceChangeListener((el) => {
    if (!autoEnabled()) return;
    whenLoaded(el, () => {
      if (isCandidate(el, settings.minImageSize)) manager.translate(el);
    });
  });
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== 'attributes' || !isMangaElement(m.target as Element)) continue;
      const e = manager.entries.get(m.target as MangaElement);
      // currentSrc only changes once the new image loads; check again then.
      if (e) whenLoaded(e.el, () => manager.update(e));
    }
    scheduleScan();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'width', 'height'],
  });

  if (autoEnabled()) startAuto();

  // --- Keep overlays glued to their images --------------------------------------------
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      manager.updateAll();
    });
  };
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  // Catch layout shifts that don't fire scroll/resize (images loading above, sidebars).
  setInterval(() => {
    if (manager.entries.size) manager.updateAll();
  }, 700);

  onSettingsChanged((next) => {
    const styleChanged =
      next.fontFamily !== settings.fontFamily ||
      next.customFont !== settings.customFont ||
      next.fontScale !== settings.fontScale ||
      next.overlayOpacity !== settings.overlayOpacity ||
      next.targetLang !== settings.targetLang ||
      next.letteringCase !== settings.letteringCase ||
      next.sfxStyle !== settings.sfxStyle ||
      next.showNotes !== settings.showNotes;
    const wasAuto = autoEnabled();
    settings = next;
    manager.settings = next;
    hover.enabled = next.showHoverButton && !siteDisabled();
    if (!hover.enabled) hover.hide();
    if (styleChanged) {
      manager.rerenderAll();
      RegionPanel.rerenderAll();
    }
    if (!wasAuto && autoEnabled()) startAuto();
  });

  async function setAuto(enabled: boolean): Promise<void> {
    const sites = new Set(settings.autoSites);
    if (enabled) sites.add(host);
    else sites.delete(host);
    await saveSettings({ autoSites: [...sites] });
  }

  function translatePage(): void {
    const n = manager.translateAll();
    if (n === 0) {
      toast('No manga pages found here. Use “Translate a selected area” for canvas readers or unusual layouts.', {
        action: { label: 'Select area', run: () => void startRegion() },
        ms: 6000,
      });
    }
  }

  async function startRegion(): Promise<void> {
    hover.hide();
    const rect = await selectRegion();
    if (!rect) return;
    const panel = new RegionPanel(rect, manager);
    await panel.translate();
  }

  function translateBySrc(srcUrl: string): void {
    const matches = [...document.querySelectorAll<HTMLImageElement>('img')].filter(
      (img) => img.currentSrc === srcUrl || img.src === srcUrl,
    );
    if (!matches.length) {
      toast('Could not find that image on the page — try “Translate a selected area”.');
      return;
    }
    const visible = matches.find((m) => {
      const r = m.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && r.width > 0;
    });
    manager.translate(visible ?? matches[0]);
  }

  return (msg: ContentCommand) => {
    switch (msg.type) {
      case 'translatePage':
        translatePage();
        break;
      case 'translateImage':
        translateBySrc(msg.srcUrl);
        break;
      case 'startRegion':
        void startRegion();
        break;
      case 'toggleOverlays':
        manager.setVisible(!manager.visible);
        toast(manager.visible ? 'Showing translations' : 'Showing originals', { ms: 1500 });
        break;
      case 'clearOverlays':
        manager.clearAll();
        RegionPanel.destroyAll();
        break;
      case 'setAuto':
        return setAuto(msg.enabled).then(() => {
          if (msg.enabled) startAuto();
          return manager.status(autoEnabled());
        });
      case 'getStatus':
        break;
    }
    return manager.status(autoEnabled());
  };
}

if (!window.__mangaTranslatorLoaded) {
  window.__mangaTranslatorLoaded = true;
  const ready = main();
  // Registered synchronously so commands sent right after injection are not lost.
  chrome.runtime.onMessage.addListener((msg: ContentCommand, _sender, sendResponse) => {
    ready
      .then(async (handle) => sendResponse(await handle(msg)))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  });
}
