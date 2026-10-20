import request from 'supertest';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VideoStatus } from '../src/videos/entities/video.entity';
import {
  createE2eApp,
  E2eContext,
  registerConfirmedUser,
  TestUser,
} from './helpers/e2e-app';
import { insertVideo } from './helpers/ready-video';

describe('GET /videos/:slug/download (e2e)', () => {
  let context: E2eContext;
  let storage: StorageService;
  let owner: TestUser;

  beforeAll(async () => {
    context = await createE2eApp();
    storage = context.app.get(StorageService);
  });

  afterAll(async () => {
    await context.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(context.dataSource);
    context.throttlerStorage.storage.clear();
    owner = await registerConfirmedUser(context, 'owner@example.com');
    context.throttlerStorage.storage.clear();
  });

  const download = (slug: string) =>
    request(context.app.getHttpServer())
      .get(`/videos/${slug}/download`)
      .redirects(0);

  it('should redirect to a presigned URL that answers as an attachment', async () => {
    const video = await insertVideo(context.dataSource, storage, owner.id, {
      withObject: true,
      title: 'Holiday',
    });

    const res = await download(video.slug).expect(302);

    const location = res.headers.location;
    expect(location).toContain('response-content-disposition');
    const file = await fetch(location);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(file.headers.get('content-disposition')).toContain(
      'filename="Holiday.mp4"',
    );
  });

  it('should sanitize slashes and quotes in the title', async () => {
    const video = await insertVideo(context.dataSource, storage, owner.id, {
      withObject: true,
      title: 'My "best"/clip\\final',
    });

    const res = await download(video.slug).expect(302);

    const file = await fetch(res.headers.location);
    const disposition = file.headers.get('content-disposition')!;
    const filename = disposition.match(/filename="([^"]*)"/)![1];
    expect(filename).not.toMatch(/[/\\"]/);
    expect(filename).toBe('My _best__clip_final.mp4');
  });

  it('should answer 404 for a video that is not ready and for an unknown slug', async () => {
    const draft = await insertVideo(context.dataSource, storage, owner.id, {
      status: VideoStatus.DRAFT,
    });

    for (const slug of [draft.slug, 'unknownslug']) {
      const res = await download(slug).expect(404);
      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    }
  });
});
