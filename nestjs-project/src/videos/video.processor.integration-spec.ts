import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Job, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_QUEUE_NAME,
  type VideoProcessJobData,
} from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { MediaExtractionService } from './media-extraction.service';
import { VideoProcessor } from './video.processor';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const RETRY_OPTIONS = {
  attempts: 3,
  backoff: { type: 'fixed', delay: 50 },
};

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let queue: Queue<VideoProcessJobData>;
  let storage: StorageService;
  let processor: VideoProcessor;
  let channel: Channel;
  const workDir = mkdtempSync(join(tmpdir(), 'processor-'));

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        StorageModule,
        QueueModule,
        VideosModule,
      ],
      providers: [MediaExtractionService, VideoProcessor],
    }).compile();
    await module.init();

    dataSource = module.get(getDataSourceToken());
    queue = module.get(getQueueToken(VIDEO_QUEUE_NAME));
    storage = module.get(StorageService);
    processor = module.get(VideoProcessor);
  }, 30000);

  afterAll(async () => {
    rmSync(workDir, { recursive: true, force: true });
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hashed' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Owner', nickname: 'owner', user_id: user.id });
  });

  const insertProcessing = async (
    fields: Partial<Video> = {},
  ): Promise<Video> => {
    const id = randomUUID();
    return dataSource.getRepository(Video).save({
      id,
      channel_id: channel.id,
      title: 'Clip',
      slug: id.replace(/-/g, '').slice(0, 11),
      status: VideoStatus.PROCESSING,
      upload_id: 'upload',
      original_key: `videos/${id}/original`,
      size_bytes: 1000,
      mime_type: 'video/mp4',
      ...fields,
    });
  };

  const storeMedia = async (
    key: string,
    inputArgs: string[],
    extension: string,
  ): Promise<void> => {
    const file = join(workDir, `${randomUUID()}.${extension}`);
    execFileSync('ffmpeg', ['-v', 'error', ...inputArgs, '-y', file]);
    await storage.putObject(
      key,
      readFileSync(file),
      'application/octet-stream',
    );
  };

  const enqueue = (videoId: string, opts = {}) =>
    queue.add(VIDEO_PROCESS_JOB, { videoId }, { jobId: videoId, ...opts });

  const waitForStatus = async (
    id: string,
    status: VideoStatus,
  ): Promise<Video> => {
    for (let i = 0; i < 100; i++) {
      const row = await dataSource.getRepository(Video).findOneByOrFail({ id });
      if (row.status === status) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Video ${id} did not reach ${status}`);
  };

  it('should turn a processing video into ready with duration, metadata and thumbnail', async () => {
    const video = await insertProcessing();
    await storeMedia(
      video.original_key,
      ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10'],
      'mp4',
    );

    await enqueue(video.id);
    const ready = await waitForStatus(video.id, VideoStatus.READY);

    expect(ready.duration_seconds).toBeCloseTo(3, 0);
    expect(ready.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(ready.metadata).toHaveProperty('streams');
    expect(await storage.headObject(ready.thumbnail_key!)).toMatchObject({
      contentType: 'image/jpeg',
    });
  }, 30000);

  it('should leave an already ready video untouched', async () => {
    const video = await insertProcessing({
      status: VideoStatus.READY,
      duration_seconds: 9,
    });
    const before = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });

    await processor.process({
      data: { videoId: video.id },
    } as Job<VideoProcessJobData>);

    const after = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.thumbnail_key).toBeNull();
  });

  it('should fail a file without a video stream at once, without retries', async () => {
    const video = await insertProcessing();
    await storeMedia(
      video.original_key,
      ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'],
      'mp3',
    );

    await enqueue(video.id, RETRY_OPTIONS);
    const failed = await waitForStatus(video.id, VideoStatus.ERROR);

    expect(failed.failure_reason).toContain('no video stream');
    const job = await queue.getJob(video.id);
    expect(job?.attemptsMade).toBe(1);
  }, 30000);

  it('should mark the video as error after every attempt fails', async () => {
    const video = await insertProcessing();
    // No object in storage: reading it fails on every attempt.

    await enqueue(video.id, RETRY_OPTIONS);
    const failed = await waitForStatus(video.id, VideoStatus.ERROR);

    expect(failed.failure_reason).toBeTruthy();
    const job = await queue.getJob(video.id);
    expect(job?.attemptsMade).toBe(3);
  }, 30000);
});
