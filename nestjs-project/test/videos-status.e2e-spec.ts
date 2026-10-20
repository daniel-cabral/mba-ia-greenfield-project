import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Channel } from '../src/channels/entities/channel.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  createE2eApp,
  E2eContext,
  registerConfirmedUser,
  TestUser,
} from './helpers/e2e-app';

describe('GET /videos/:id (e2e)', () => {
  let context: E2eContext;
  let owner: TestUser;
  let other: TestUser;
  let channel: Channel;

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
    channel = await context.dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: owner.id });
  });

  const insertVideo = (fields: Partial<Video> = {}) =>
    context.dataSource.getRepository(Video).save({
      channel_id: channel.id,
      title: 'My video',
      slug: Math.random().toString(36).slice(2, 13).padEnd(11, 'x'),
      upload_id: 'upload',
      original_key: 'videos/x/original',
      size_bytes: 1024,
      mime_type: 'video/mp4',
      ...fields,
    });

  const get = (id: string, token: string | null = owner.accessToken) => {
    const req = request(context.app.getHttpServer()).get(`/videos/${id}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('should return the status fields of an unprocessed video to its owner', async () => {
    const video = await insertVideo();

    const res = await get(video.id).expect(200);

    expect(res.body).toMatchObject({
      id: video.id,
      slug: video.slug,
      title: 'My video',
      status: 'draft',
      durationSeconds: null,
      failureReason: null,
    });
    expect(typeof (res.body as { createdAt: string }).createdAt).toBe('string');
  });

  it('should expose the failure reason of a video in error', async () => {
    const video = await insertVideo({
      status: VideoStatus.ERROR,
      failure_reason: 'No video stream found',
    });

    const res = await get(video.id).expect(200);

    expect(res.body).toMatchObject({
      status: 'error',
      failureReason: 'No video stream found',
    });
  });

  it('should hide the video from other users and unknown ids', async () => {
    const video = await insertVideo();

    const asOther = await get(video.id, other.accessToken).expect(404);
    expect((asOther.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');

    const unknown = await get('00000000-0000-0000-0000-000000000000').expect(
      404,
    );
    expect((unknown.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });

  it('should require authentication', async () => {
    const video = await insertVideo();

    await get(video.id, null).expect(401);
  });
});
