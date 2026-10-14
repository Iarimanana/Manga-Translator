/**
 * Local stand-in for both a manga website and the Claude Messages API, so the extension
 * can be exercised end to end without network access or an API key.
 */
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface MockServer {
  /** http://127.0.0.1:port */
  origin: string;
  /** Same server under a different origin (http://localhost:port) for cross-origin tests. */
  altOrigin: string;
  apiRequests: RecordedRequest[];
  imageRequests: RecordedRequest[];
  close(): Promise<void>;
}

export const MOCK_TRANSLATION = 'Hello from the mock translator!';

const PAGES: Record<string, (alt: string) => string> = {
  'basic.html': () => `
    <h1>Chapter 1</h1>
    <img id="icon" src="/img/icon.png" width="64" height="64">
    <div><img id="p1" src="/img/page1.png" style="width:600px"></div>
    <div><img id="p2" src="/img/page2.png" style="width:600px"></div>`,
  'protected.html': () => `<img id="p1" src="/protected/page1.png" style="width:600px">`,
  'canvas.html': () => `
    <canvas id="c" width="800" height="1200" style="width:500px"></canvas>
    <script>
      const img = new Image();
      img.onload = () => document.getElementById('c').getContext('2d').drawImage(img, 0, 0);
      img.src = '/img/page1.png';
    </script>`,
  'tainted.html': (alt) => `
    <canvas id="c" width="800" height="1200" style="width:400px;height:600px"></canvas>
    <script>
      const img = new Image();
      img.onload = () => document.getElementById('c').getContext('2d').drawImage(img, 0, 0);
      img.src = '${alt}/img/page1.png';
    </script>`,
  'strip.html': () => `<img id="strip" src="/img/strip.png" style="width:600px">`,
  'swap.html': () => `
    <img id="p1" src="/img/page1.png" style="width:600px">
    <button id="next" onclick="document.getElementById('p1').src='/img/page2.png'">next</button>`,
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
  });
  res.end(JSON.stringify(body));
}

/** Respond like Claude would: one balloon near the top centre of whatever image was sent. */
function messagesResponse(body: any): unknown {
  const text: string =
    body.messages?.[0]?.content?.find((c: any) => c.type === 'text')?.text ?? 'The image is 1000×1000 pixels.';
  const m = text.match(/(\d+)×(\d+) pixels/);
  const w = m ? Number(m[1]) : 1000;
  const h = m ? Number(m[2]) : 1000;
  const box = (x0: number, y0: number, x1: number, y1: number) => ({
    x_min: Math.round(x0 * w),
    y_min: Math.round(y0 * h),
    x_max: Math.round(x1 * w),
    y_max: Math.round(y1 * h),
  });
  const output = {
    blocks: [
      {
        kind: 'speech',
        text_box: box(0.42, 0.12, 0.58, 0.3),
        bubble_box: box(0.32, 0.07, 0.68, 0.35),
        original: '待ってくれ！',
        translation: MOCK_TRANSLATION,
      },
    ],
  };
  return {
    id: `msg_mock_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text: JSON.stringify(output) }],
    stop_reason: 'end_turn',
    stop_details: null,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

export async function startMockServer(): Promise<MockServer> {
  const apiRequests: RecordedRequest[] = [];
  const imageRequests: RecordedRequest[] = [];
  let origin = '';
  let altOrigin = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');

    if (req.method === 'OPTIONS') return json(res, 204, {});

    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      const body = JSON.parse(raw);
      apiRequests.push({ path: url.pathname + url.search, headers: req.headers, body });
      if (req.headers['x-api-key'] === 'bad-key') {
        return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      }
      return json(res, 200, messagesResponse(body));
    }
    const model = url.pathname.match(/^\/v1\/models\/(.+)$/);
    if (model) {
      if (req.headers['x-api-key'] === 'bad-key') {
        return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      }
      return json(res, 200, { type: 'model', id: model[1], display_name: 'Mock Claude', created_at: '2026-01-01T00:00:00Z' });
    }

    const page = url.pathname.match(/^\/pages\/(.+)$/);
    if (page && PAGES[page[1]]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><body style="margin:0;padding:20px">${PAGES[page[1]](altOrigin)}</body></html>`);
    }

    const img = url.pathname.match(/^\/(img|protected)\/([\w.-]+)$/);
    if (img) {
      imageRequests.push({ path: url.pathname, headers: req.headers, body: null });
      const referer = String(req.headers.referer ?? '');
      if (img[1] === 'protected' && !referer.startsWith(`${origin}/pages/`)) {
        res.writeHead(403);
        return res.end('hotlinking not allowed');
      }
      try {
        const data = await readFile(path.join(FIXTURES, img[2]));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return res.end(data);
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  altOrigin = `http://localhost:${port}`;
  return {
    origin,
    altOrigin,
    apiRequests,
    imageRequests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // The browser keeps connections alive; don't wait for it to let go.
        server.closeAllConnections();
      }),
  };
}
