/**
 * Small, dependency-free inpainting used to "clean" lettering off artwork.
 *
 * Masked pixels are filled from the outside in (onion peel): each ring takes the
 * weighted average of its already-known neighbours, then a few smoothing passes remove
 * streaks. Flat colours and gradients are reconstructed cleanly; detailed art comes back
 * softened, much like a quick clone/heal pass by a scanlation cleaner.
 */
export function inpaint(data: Uint8ClampedArray, w: number, h: number, mask: Uint8Array, smoothPasses = 3): void {
  const known = new Uint8Array(w * h);
  let missing = 0;
  for (let i = 0; i < w * h; i++) {
    known[i] = mask[i] ? 0 : 1;
    if (mask[i]) missing++;
  }
  if (!missing) return;

  const NB = [
    [-1, 0, 1],
    [1, 0, 1],
    [0, -1, 1],
    [0, 1, 1],
    [-1, -1, 0.7],
    [1, -1, 0.7],
    [-1, 1, 0.7],
    [1, 1, 0.7],
  ] as const;

  const queued = new Uint8Array(w * h);
  let frontier: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      for (const [dx, dy] of NB) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && known[ny * w + nx]) {
          frontier.push(i);
          queued[i] = 1;
          break;
        }
      }
    }
  }

  const vals = new Float32Array(4);
  while (frontier.length) {
    const fills = new Float32Array(frontier.length * 4);
    frontier.forEach((i, k) => {
      const x = i % w;
      const y = (i - x) / w;
      vals.fill(0);
      let wsum = 0;
      for (const [dx, dy, wt] of NB) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!known[j]) continue;
        for (let c = 0; c < 4; c++) vals[c] += data[j * 4 + c] * wt;
        wsum += wt;
      }
      for (let c = 0; c < 4; c++) fills[k * 4 + c] = wsum ? vals[c] / wsum : 255;
    });
    const next: number[] = [];
    frontier.forEach((i, k) => {
      for (let c = 0; c < 4; c++) data[i * 4 + c] = fills[k * 4 + c];
      known[i] = 1;
    });
    for (const i of frontier) {
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of NB) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!known[j] && !queued[j]) {
          queued[j] = 1;
          next.push(j);
        }
      }
    }
    frontier = next;
  }

  // Nothing known anywhere (whole region masked): leave it white.
  for (let i = 0; i < w * h; i++) {
    if (!known[i]) data.set([255, 255, 255, 255], i * 4);
  }

  // Smooth only the filled area.
  const tmp = new Float32Array(w * h * 4);
  for (let pass = 0; pass < smoothPasses; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        vals.fill(0);
        let wsum = 0;
        for (const [dx, dy, wt] of NB) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          for (let c = 0; c < 4; c++) vals[c] += data[j * 4 + c] * wt;
          wsum += wt;
        }
        for (let c = 0; c < 4; c++) tmp[i * 4 + c] = vals[c] / wsum;
      }
    }
    for (let i = 0; i < w * h; i++) {
      if (mask[i]) for (let c = 0; c < 4; c++) data[i * 4 + c] = tmp[i * 4 + c];
    }
  }
}

/** Mask of a rectangle (inclusive-exclusive) grown by `grow` pixels, clipped to w × h. */
export function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number, grow = 0): Uint8Array {
  const m = new Uint8Array(w * h);
  const ax = Math.max(0, Math.floor(x0 - grow));
  const ay = Math.max(0, Math.floor(y0 - grow));
  const bx = Math.min(w, Math.ceil(x1 + grow));
  const by = Math.min(h, Math.ceil(y1 + grow));
  for (let y = ay; y < by; y++) m.fill(1, y * w + ax, y * w + bx);
  return m;
}
