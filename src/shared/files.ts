const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif|bmp)$/i;

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      avif: 'image/avif',
      gif: 'image/gif',
      bmp: 'image/bmp',
    }[ext] ?? 'application/octet-stream'
  );
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** "page2.jpg" before "page10.jpg"; folders group together. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Archive entries that are real pages (skips macOS metadata and hidden files). */
export function isPageEntry(path: string): boolean {
  if (!isImageName(path)) return false;
  const parts = path.split('/');
  return !parts.some((p) => p === '__MACOSX' || p.startsWith('.'));
}

export type FileKind = 'pdf' | 'zip' | 'image' | 'unknown';

export function fileKind(name: string, type: string): FileKind {
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (/\.(zip|cbz)$/i.test(name) || type === 'application/zip' || type === 'application/x-zip-compressed') return 'zip';
  if (type.startsWith('image/') || isImageName(name)) return 'image';
  return 'unknown';
}
