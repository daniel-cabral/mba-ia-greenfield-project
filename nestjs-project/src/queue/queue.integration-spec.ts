import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue, Worker } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_QUEUE_NAME,
  VideoProcessJobData,
} from './queue.constants';
import { QueueModule } from './queue.module';

describe('Video queue (integration)', () => {
  let module: TestingModule;
  let queue: Queue<VideoProcessJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    queue = module.get(getQueueToken(VIDEO_QUEUE_NAME));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should use the isolated test queue, not the dev queue', () => {
    expect(VIDEO_QUEUE_NAME).toMatch(/-test$/);
  });

  it('should keep a single job for a repeated jobId, with the default options', async () => {
    await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId: 'video-1' },
      { jobId: 'video-1' },
    );
    await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId: 'video-1' },
      { jobId: 'video-1' },
    );

    const waiting = await queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].name).toBe(VIDEO_PROCESS_JOB);
    expect(waiting[0].data).toEqual({ videoId: 'video-1' });
    expect(waiting[0].opts.attempts).toBe(3);
    expect(waiting[0].opts.backoff).toEqual({
      type: 'exponential',
      delay: 5000,
    });
  });

  it('should remove a job from Redis once it completes', async () => {
    await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId: 'video-2' },
      { jobId: 'video-2' },
    );

    const worker = new Worker<VideoProcessJobData>(
      VIDEO_QUEUE_NAME,
      () => Promise.resolve(),
      { connection: { host: queueConfig().host, port: queueConfig().port } },
    );
    await new Promise<void>((resolve, reject) => {
      worker.on('completed', () => resolve());
      worker.on('failed', (_job, error) => reject(error));
    });
    await worker.close();

    expect(await queue.getJob('video-2')).toBeUndefined();
  });
});
