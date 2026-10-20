const FRAME_RATIO = 0.1;
const MIN_FRAME_SECONDS = 1;

/**
 * Instant of the thumbnail frame: 10% into the video, at least 1 s, but never
 * past the middle of a video shorter than that.
 */
export function frameTime(durationSeconds: number): number {
  const target = Math.max(durationSeconds * FRAME_RATIO, MIN_FRAME_SECONDS);
  return Math.min(target, durationSeconds / 2);
}
