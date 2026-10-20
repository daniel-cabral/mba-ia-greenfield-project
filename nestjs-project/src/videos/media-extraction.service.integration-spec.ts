import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  MediaExtractionService,
  NoVideoStreamError,
} from './media-extraction.service';

describe('MediaExtractionService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const media = new MediaExtractionService();
  const workDir = mkdtempSync(join(tmpdir(), 'media-'));

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init();
    storage = module.get(StorageService);
  }, 30000);

  afterAll(async () => {
    rmSync(workDir, { recursive: true, force: true });
    await module.close();
  });

  /** Generates a file with ffmpeg, uploads it and returns a readable URL. */
  const storedUrl = async (
    name: string,
    inputArgs: string[],
    contentType: string,
  ): Promise<string> => {
    const file = join(workDir, name);
    execFileSync('ffmpeg', ['-v', 'error', ...inputArgs, '-y', file]);
    const key = `test/${randomUUID()}/${name}`;
    await storage.putObject(key, readFileSync(file), contentType);
    return storage.presignInternalRead(key);
  };

  it('should read duration and a JPEG frame from a storage URL', async () => {
    const url = await storedUrl(
      'five.mp4',
      ['-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=10'],
      'video/mp4',
    );

    const probed = await media.probe(url);
    expect(probed.durationSeconds).toBeCloseTo(5, 0);
    expect(probed.formatName).toContain('mp4');
    expect(probed.metadata.streams).toBeDefined();

    const thumbnail = await media.extractThumbnail(url, probed.durationSeconds);
    expect(thumbnail.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('should extract a frame from a video shorter than one second', async () => {
    const url = await storedUrl(
      'short.mp4',
      ['-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=160x120:rate=10'],
      'video/mp4',
    );

    const probed = await media.probe(url);
    const thumbnail = await media.extractThumbnail(url, probed.durationSeconds);

    expect(thumbnail.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('should fail permanently for a file without a video stream', async () => {
    const url = await storedUrl(
      'audio.mp3',
      ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'],
      'audio/mpeg',
    );

    await expect(media.probe(url)).rejects.toBeInstanceOf(NoVideoStreamError);
  });
});
