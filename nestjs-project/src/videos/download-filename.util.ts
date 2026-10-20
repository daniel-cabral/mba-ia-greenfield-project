import { sanitizeFilename } from './filename.util';

const EXTENSION_BY_SUBTYPE: Record<string, string> = {
  quicktime: 'mov',
  'x-matroska': 'mkv',
  'x-msvideo': 'avi',
  'x-ms-wmv': 'wmv',
  'x-flv': 'flv',
};

function extensionFor(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0].trim().toLowerCase();
  if (!subtype) return '';
  return EXTENSION_BY_SUBTYPE[subtype] ?? subtype.replace(/[^a-z0-9]/g, '');
}

/** Content-Disposition value that forces a download with a safe file name. */
export function attachmentDisposition(title: string, mimeType: string): string {
  const extension = extensionFor(mimeType);
  const base = sanitizeFilename(title);
  const name =
    extension && !base.toLowerCase().endsWith(`.${extension}`)
      ? `${base}.${extension}`
      : base;
  const asciiFallback = name.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
