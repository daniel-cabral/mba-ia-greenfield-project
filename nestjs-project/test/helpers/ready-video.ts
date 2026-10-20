import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Channel } from '../../src/channels/entities/channel.entity';
import { StorageService } from '../../src/storage/storage.service';
import { Video, VideoStatus } from '../../src/videos/entities/video.entity';

/** Inserts a video row and, when asked, its original object in real storage. */
export async function insertVideo(
  dataSource: DataSource,
  storage: StorageService,
  ownerUserId: string,
  fields: Partial<Video> & { withObject?: boolean } = {},
): Promise<Video> {
  const { withObject = false, ...rest } = fields;
  const channel = await dataSource
    .getRepository(Channel)
    .findOneByOrFail({ user_id: ownerUserId });
  const id = randomUUID();
  const video = await dataSource.getRepository(Video).save({
    id,
    channel_id: channel.id,
    title: 'My video',
    slug: id.replace(/-/g, '').slice(0, 11),
    status: VideoStatus.READY,
    upload_id: 'upload',
    original_key: `videos/${id}/original`,
    size_bytes: 1000,
    mime_type: 'video/mp4',
    ...rest,
  });
  if (withObject) {
    await storage.putObject(
      video.original_key,
      Buffer.alloc(1000, 5),
      'video/mp4',
    );
  }
  return video;
}
