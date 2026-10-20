import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const FIVE_MIB = 5 * 1024 * 1024;

function generate(name: string, args: string[]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-media-'));
  try {
    const file = join(dir, name);
    execFileSync('ffmpeg', ['-v', 'error', ...args, '-y', file]);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A short, noisy, constant high-bitrate MP4 larger than 5 MiB, so a 5 MiB part
 * size forces a non-final part (S3 rejects non-final parts below 5 MiB).
 */
export function generateLargeVideo(): Buffer {
  const video = generate('large.mp4', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=4:size=1280x720:rate=30',
    '-b:v',
    '16M',
    '-minrate',
    '16M',
    '-maxrate',
    '16M',
    '-bufsize',
    '16M',
    '-pix_fmt',
    'yuv420p',
  ]);
  if (video.length <= FIVE_MIB) {
    throw new Error(`Generated video is only ${video.length} bytes`);
  }
  return video;
}

/** An audio-only file: valid media, but with no video stream. */
export function generateAudioOnly(): Buffer {
  return generate('audio.mp3', [
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
  ]);
}
