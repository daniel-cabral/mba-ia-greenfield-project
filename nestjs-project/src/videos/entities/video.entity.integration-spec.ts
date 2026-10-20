import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generateSlug } from '../slug.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: 'video-owner@example.com',
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner Channel',
      nickname: 'owner',
      user_id: user.id,
    });
  });

  const buildVideo = (overrides: Partial<Video> = {}): Partial<Video> => {
    const slug = generateSlug();
    return {
      channel_id: channel.id,
      title: 'My video',
      slug,
      upload_id: 'upload-id',
      original_key: `videos/${slug}/original`,
      size_bytes: 10737418240,
      mime_type: 'video/mp4',
      ...overrides,
    };
  };

  it('should persist defaults and expose numeric columns as numbers', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.size_bytes).toBe(10737418240);
    expect(found.duration_seconds).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.failure_reason).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
  });

  it('should reject a duplicate slug', async () => {
    await videoRepository.save(buildVideo({ slug: 'AAAAAAAAAAA' }));

    await expect(
      videoRepository.save(buildVideo({ slug: 'AAAAAAAAAAA' })),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('should reject a status outside the enum', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO videos (channel_id, title, slug, status, upload_id, original_key, size_bytes, mime_type)
         VALUES ($1, 't', 'BBBBBBBBBBB', 'bogus', 'u', 'k', 1, 'video/mp4')`,
        [channel.id],
      ),
    ).rejects.toMatchObject({ code: '22P02' });
  });

  it('should block deleting a channel that has videos', async () => {
    await videoRepository.save(buildVideo());

    await expect(
      dataSource.getRepository(Channel).delete({ id: channel.id }),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
