import request from 'supertest';
import { VideoStatus, Video } from '../src/videos/entities/video.entity';
import storageConfig from '../src/config/storage.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createE2eApp,
  E2eContext,
  registerConfirmedUser,
  TestUser,
} from './helpers/e2e-app';

describe('POST /videos/:id/parts (e2e)', () => {
  let context: E2eContext;
  let owner: TestUser;
  let other: TestUser;
  let videoId: string;

  beforeAll(async () => {
    context = await createE2eApp();
  });

  afterAll(async () => {
    await context.app.close();
  });

  beforeEach(async () => {
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
    videoId = (created.body as { id: string }).id;
  });

  const signParts = (
    id: string,
    partNumbers: number[],
    token: string = owner.accessToken,
  ) =>
    request(context.app.getHttpServer())
      .post(`/videos/${id}/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers });

  it('should return presigned part URLs signed with the public host', async () => {
    const res = await signParts(videoId, [1]).expect(200);

    const parts = (res.body as { parts: { partNumber: number; url: string }[] })
      .parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].partNumber).toBe(1);
    expect(new URL(parts[0].url).host).toBe(
      new URL(storageConfig().publicEndpoint).host,
    );

    const put = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(1024),
    });
    expect(put.headers.get('etag')).toBeTruthy();
  });

  it('should hide the video from other users and unknown ids', async () => {
    const asOther = await signParts(videoId, [1], other.accessToken).expect(
      404,
    );
    expect((asOther.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');

    const unknown = await signParts(
      '00000000-0000-0000-0000-000000000000',
      [1],
    ).expect(404);
    expect((unknown.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });

  it('should reject parts for a video that is not a draft', async () => {
    await context.dataSource
      .getRepository(Video)
      .update({ id: videoId }, { status: VideoStatus.PROCESSING });

    const res = await signParts(videoId, [1]).expect(409);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_DRAFT');
  });

  it('should reject an empty list and a part number above the part count', async () => {
    const empty = await signParts(videoId, []).expect(400);
    expect((empty.body as { error: string }).error).toBe('VIDEO_INVALID_PART');

    const tooHigh = await signParts(videoId, [2]).expect(400);
    expect((tooHigh.body as { error: string }).error).toBe(
      'VIDEO_INVALID_PART',
    );
  });

  it('should not rate limit the parts route', async () => {
    for (let i = 0; i < 12; i++) {
      const res = await signParts(videoId, [1]);
      expect(res.status).not.toBe(429);
    }
  });
});
