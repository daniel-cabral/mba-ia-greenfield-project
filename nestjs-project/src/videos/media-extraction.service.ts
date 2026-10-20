import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';
import { frameTime } from './frame-time.util';

export class NoVideoStreamError extends Error {
  constructor() {
    super('File has no video stream');
    this.name = 'NoVideoStreamError';
  }
}

export interface ProbeResult {
  durationSeconds: number;
  formatName: string;
  /** Raw ffprobe output, stored as the video metadata. */
  metadata: Record<string, unknown>;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string };
  streams?: { codec_type?: string }[];
}

interface ProcessResult {
  stdout: Buffer;
  stderr: string;
}

function runProcess(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout), stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
      }
    });
  });
}

/** Reads video facts straight from a (presigned) URL, without downloading. */
@Injectable()
export class MediaExtractionService {
  async probe(url: string): Promise<ProbeResult> {
    const { stdout } = await runProcess('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);
    const output = JSON.parse(stdout.toString()) as FfprobeOutput;

    if (!output.streams?.some((s) => s.codec_type === 'video')) {
      throw new NoVideoStreamError();
    }
    return {
      durationSeconds: Number(output.format?.duration ?? 0),
      formatName: output.format?.format_name ?? 'unknown',
      metadata: output as Record<string, unknown>,
    };
  }

  /** Returns one JPEG frame as bytes. */
  async extractThumbnail(
    url: string,
    durationSeconds: number,
  ): Promise<Buffer> {
    const { stdout } = await runProcess('ffmpeg', [
      '-v',
      'error',
      '-ss',
      frameTime(durationSeconds).toFixed(3),
      '-i',
      url,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    return stdout;
  }
}
