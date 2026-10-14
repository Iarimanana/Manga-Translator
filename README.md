<p align="center"><img src="src/assets/icons/icon128.png" width="96" alt=""></p>

# Manga Translator 🍓

A Chrome extension that translates manga, manhwa and manhua **in place**, on any website, and also translates PDF, ZIP/CBZ and image files. It is an open-source rebuild of the features of the *Manga Translator 🍓 / Ichigo Reader* extension. Text detection, OCR and translation are done by **Claude** through your own Anthropic API key, so there is no account or subscription.

| Ichigo feature | This extension |
| --- | --- |
| Translate manga pages on a website | ✅ Hover a page and click **🍓 Translate**, or translate every page at once (`Alt+Shift+M`) |
| "Translation panel" that works on *every* site | ✅ **Translate a selected area** (`Alt+Shift+S`): drag a frame over anything on screen (canvas readers, protected images, video). The frame can be moved, resized and re-translated |
| Japanese / Korean / Chinese → English | ✅ Plus 34 other target languages, and English comics into other languages |
| Upload PDF, ZIP and images | ✅ The **file translator** handles PDF, ZIP/CBZ and JPG/PNG/WebP/AVIF/GIF, and can **export a translated ZIP** |
| Full context on PDFs/ZIPs | ✅ Each page is sent with the previous page's dialogue so names and terms stay consistent |
| Subscription / free trial | Bring your own Anthropic API key; you pay Anthropic only for what you translate |

## Features

- **On-page overlays.** The original lettering is covered with the balloon's own paper colour (sampled from the page). The translation is set in a comic font and sized to fit the balloon. Click a bubble to peek at the original; hover the page for *Show original / ↻ re-translate*.
- **Auto-translate per site.** Pages translate as you scroll. Infinite-scroll readers and readers that swap the page image in place are handled.
- **Works with awkward sites.** Hotlink-protected CDNs are fetched with the page as `Referer`, and canvas readers are read from the canvas. Protected canvases fall back to a screenshot of the visible area.
- **Long webtoon strips** are cut into overlapping slices so small text stays legible. The results are merged back without duplicates.
- **Cache.** Translations are cached by image content, so revisiting a chapter is instant and costs nothing.
- **Customisable:** target and source language, a glossary or custom instructions, whether to translate SFX, font (bundled Comic Neue, sans, serif, or any installed font), text size, overlay opacity, model, effort and concurrency.
- **Context menu, keyboard shortcuts, popup.** Right-click an image and choose *Translate this image*, or use the toolbar popup.

## Install (from source)

```bash
npm install
npm run build          # outputs the unpacked extension to dist/
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `dist/` folder.
2. The settings page opens. Paste an [Anthropic API key](https://console.anthropic.com/settings/keys) and click **Test connection**.
3. Open a manga page and hover an image, or press `Alt+Shift+M`.

`npm run package` writes `release/manga-translator-<version>.zip`, ready for the Chrome Web Store. Works in Chrome, Edge, Brave and other Chromium browsers (Chrome 120+).

## Using it

| Action | How |
| --- | --- |
| Translate one page | Hover it, click **🍓 Translate** (or right-click → *Translate this image*) |
| Translate every page on the tab | `Alt+Shift+M`, or popup → *Translate this page* |
| Translate an area of the screen | `Alt+Shift+S`, then drag a box. Move or resize the frame and press **↻ Translate** to translate what's under it now |
| Show / hide translations | `Alt+Shift+O`, popup, or the hover button. Click a single bubble to peek |
| Auto-translate a site | Popup → *Auto-translate on <site>* |
| Translate files | Popup → *Translate files*. Drop PDFs, ZIP/CBZ archives or images, then **Translate all** and **Export ZIP** |

Shortcuts can be changed at `chrome://extensions/shortcuts`.

## Cost, models and privacy

- **Model.** Default is **Claude Opus 5.5** at *low* effort, chosen for quality and responsiveness. Sonnet 5.5 and Haiku 5.5 are cheaper and faster options in settings, and any model ID can be entered. Raise *effort* for difficult pages.
- **Cost.** A typical page is roughly 3–5k input tokens (mostly the image, at the default 2048 px resolution) and a few hundred output tokens. Lowering *Image resolution sent to Claude* reduces input tokens. Every page is cached, so you only pay once per page. Settings → *Cache & usage* shows your token totals.
- **Declined pages.** Claude's safety classifiers occasionally decline a page. With Opus and Sonnet, the extension opts into Anthropic's server-side fallback (`fallbacks: "default"`) so the page is retried on the recommended fallback model instead of failing. You can turn this off in settings.
- **Privacy.** Your API key is stored only in this browser (`chrome.storage.local`). Page images go only to the Claude API, or to the base URL you configure. Nothing is collected by the extension.

## How it works

```
content script                     service worker                               Claude API
──────────────                     ──────────────                               ──────────
find <img>/<canvas>  ── url ──▶   fetch image (cookies + Referer via DNR rule)
  or canvas pixels   ── data ─▶   hash → cache hit? ──────────────▶ return
  or screenshot crop              slice tall strips, downscale each slice
                                  messages.parse(image + prompt,             ──▶ structured JSON:
                                    output_config.format = JSON schema,           text_box, bubble_box,
                                    effort, fallbacks)                       ◀──  original, translation
                                  map boxes back, drop slice-overlap duplicates,
                                  sample balloon colour, cache
draw overlay  ◀──────────────────  PageTranslation (normalised boxes)
(fit text to balloon, track scroll/resize/clipping)
```

- `src/background/` — service worker. The Claude call uses the official `@anthropic-ai/sdk` with structured outputs. Also image loading, tiling, cache (IndexedDB), context menu and shortcuts.
- `src/content/` — on-page UI in a shadow DOM: hover button, overlays, area selection frames, auto-translate observers.
- `src/reader/` — file translator (pdf.js, fflate) and export.
- `src/shared/` — pure logic shared by all of the above: geometry and slicing, text fitting and layout, colour sampling, prompt, settings.

## Development

```bash
npm run watch       # rebuild on change (reload the extension in chrome://extensions)
npm run typecheck
npm test            # unit tests (vitest)
npm run test:e2e    # builds, then drives the real extension in Chromium against a mock Claude API
```

The end-to-end tests (`tests/e2e`) load the built extension into Chromium with Playwright. A local server plays both a manga website and the Claude Messages API. The tests cover:

- hover and translate-all, auto-translate, and in-place page swaps
- caching
- hotlink-protected images, canvas readers, the screenshot fallback, and webtoon slicing
- area selection and API errors
- the file translator (CBZ, PDF and ZIP export) and the settings page

## Third-party licenses

The bundled Comic Neue font is under the SIL Open Font License (shipped as `fonts/OFL-LICENSE.txt`). pdf.js is Apache-2.0, fflate is MIT, and the Anthropic SDK and zod are MIT.
