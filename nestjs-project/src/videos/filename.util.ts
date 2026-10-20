const FALLBACK_NAME = 'video';
const MAX_LENGTH = 255;

/**
 * Makes a client-supplied name safe to store and to place in a
 * Content-Disposition header: no path separators, quotes or control characters.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\"<>:|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_LENGTH)
    .trim();
  return cleaned || FALLBACK_NAME;
}
