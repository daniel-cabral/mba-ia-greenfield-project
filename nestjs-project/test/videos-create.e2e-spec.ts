import { ListPartsCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import storageConfig from '../src/config/storage.config';
import { Channel } from '../src/channels/entities/channel.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createE2eApp,
  E2eContext,
  registerConfirmedUser,
  TestUser,
} from './helpers/e2e-app';

describe('POST /videos (e2e)', () => {
  let context: E2eContext;
  let owner: TestUser;
  let s3: S3Client;

  beforeAll(async () => {
    context = await createE2eApp();
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
    await context.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(context.dataSource);
    context.throttlerStorage.storage.clear();
    owner = await registerConfirmedUser(context, 'owner@example.com');
  });

  const post = (body: object, token: string | null = owner.accessToken) => {
    const req = request(context.app.getHttpServer()).post('/videos');
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
  };

  it('should create a draft and open the multipart upload', async () => {
    const size = 10485760;

    const res = await post({
      filename: 'clip.mp4',
      size,
      contentType: 'video/mp4',
    }).expect(201);

    const body = res.body as Record<string, unknown>;
    const partSize = storageConfig().uploadPartSizeBytes;
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(typeof body.uploadId).toBe('string');
    expect(body).toMatchObject({
      status: 'draft',
      partSize,
      partCount: Math.ceil(size / partSize),
    });

    const row = await context.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: body.id as string });
    const channel = await context.dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: owner.id });
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.channel_id).toBe(channel.id);

    const parts = await s3.send(
      new ListPartsCommand({
        Bucket: storageConfig().bucket,
        Key: `videos/${body.id as string}/original`,
        UploadId: body.uploadId as string,
      }),
    );
    expect(parts.Parts ?? []).toHaveLength(0);
  });

  it('should default the title to the sanitized filename', async () => {
    const res = await post({
      filename: 'my clip.mp4',
      size: 1024,
      contentType: 'video/mp4',
    }).expect(201);

    const row = await context.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: (res.body as { id: string }).id });
    expect(row.title).toBe('my clip.mp4');
  });

  it('should reject a size above the cap and create nothing', async () => {
    const res = await post({
      filename: 'big.mp4',
      size: 10737418241,
      contentType: 'video/mp4',
    }).expect(400);

    expect((res.body as { error: string }).error).toBe(
      'VIDEO_UPLOAD_TOO_LARGE',
    );
    expect(await context.dataSource.getRepository(Video).count()).toBe(0);
  });

  it('should reject a non-video content type', async () => {
    const res = await post({
      filename: 'pic.png',
      size: 1024,
      contentType: 'image/png',
    }).expect(400);

    expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
  });

  it('should require authentication', async () => {
    await post(
      { filename: 'clip.mp4', size: 1024, contentType: 'video/mp4' },
      null,
    ).expect(401);
  });
});
