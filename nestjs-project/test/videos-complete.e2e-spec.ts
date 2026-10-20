import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import storageConfig from '../src/config/storage.config';
import { VIDEO_QUEUE_NAME } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  createE2eApp,
  E2eContext,
  registerConfirmedUser,
  TestUser,
} from './helpers/e2e-app';

describe('POST /videos/:id/complete (e2e)', () => {
  let context: E2eContext;
  let owner: TestUser;
  let other: TestUser;
  let queue: Queue;
  let s3: S3Client;
  let video: { id: string; uploadId: string };

  beforeAll(async () => {
    context = await createE2eApp();
    queue = context.app.get(getQueueToken(VIDEO_QUEUE_NAME));
    const config = storageConfig();
    s3 = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await context.app.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(context.dataSource);
    context.throttlerStorage.storage.clear();
    owner = await registerConfirmedUser(context, 'owner@example.com');
    other = await registerConfirmedUser(context, 'other@example.com');
    context.throttlerStorage.storage.clear();

    const created = await request(context.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ filename: 'clip.mp4', size: 1024, contentType: 'video/mp4' })
      .expect(201);
    video = created.body as { id: string; uploadId: string };
  });

  const asOwner = (path: string, body: object = {}) =>
    request(context.app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(body);

  const uploadPart = async (): Promise<void> => {
    const signed = await asOwner(`/videos/${video.id}/parts`, {
      partNumbers: [1],
    }).expect(200);
    const [part] = (signed.body as { parts: { url: string }[] }).parts;
    const put = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(1024),
    });
    expect(put.status).toBe(200);
  };

  const row = () =>
    context.dataSource.getRepository(Video).findOneByOrFail({ id: video.id });

  it('should move the video to processing and enqueue a single job, even when repeated', async () => {
    await uploadPart();

    const first = await asOwner(`/videos/${video.id}/complete`).expect(200);
    expect(first.body).toEqual({ id: video.id, status: 'processing' });
    expect((await row()).status).toBe(VideoStatus.PROCESSING);

    const jobs = await queue.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('video.process');
    expect(jobs[0].id).toBe(video.id);
    expect(jobs[0].data).toEqual({ videoId: video.id });

    await asOwner(`/videos/${video.id}/complete`).expect(200);
    expect(await queue.getJobs(['waiting'])).toHaveLength(1);
  });

  it.each([VideoStatus.READY, VideoStatus.ERROR])(
    'should reject complete on a video in %s',
    async (status) => {
      await context.dataSource
        .getRepository(Video)
        .update({ id: video.id }, { status });

      const res = await asOwner(`/videos/${video.id}/complete`).expect(409);

      expect((res.body as { error: string }).error).toBe(
        'VIDEO_ALREADY_FINALIZED',
      );
    },
  );

  it('should reject complete when no part was uploaded', async () => {
    const res = await asOwner(`/videos/${video.id}/complete`).expect(400);

    expect((res.body as { error: string }).error).toBe(
      'VIDEO_UPLOAD_INCOMPLETE',
    );
  });

  it('should recover when storage was completed but the row is still a draft', async () => {
    await uploadPart();
    const key = `videos/${video.id}/original`;
    const listed = await s3.send(
      new ListPartsCommand({
        Bucket: storageConfig().bucket,
        Key: key,
        UploadId: video.uploadId,
      }),
    );
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: storageConfig().bucket,
        Key: key,
        UploadId: video.uploadId,
        MultipartUpload: {
          Parts: [{ PartNumber: 1, ETag: listed.Parts![0].ETag }],
        },
      }),
    );
    expect((await row()).status).toBe(VideoStatus.DRAFT);

    await asOwner(`/videos/${video.id}/complete`).expect(200);

    expect((await row()).status).toBe(VideoStatus.PROCESSING);
    expect(await queue.getJobs(['waiting'])).toHaveLength(1);
  });

  it('should report an expired upload when it no longer exists in storage', async () => {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: storageConfig().bucket,
        Key: `videos/${video.id}/original`,
        UploadId: video.uploadId,
      }),
    );

    const res = await asOwner(`/videos/${video.id}/complete`).expect(409);

    expect((res.body as { error: string }).error).toBe('VIDEO_UPLOAD_EXPIRED');
  });

  it('should hide the video from other users', async () => {
    const res = await request(context.app.getHttpServer())
      .post(`/videos/${video.id}/complete`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });
});
