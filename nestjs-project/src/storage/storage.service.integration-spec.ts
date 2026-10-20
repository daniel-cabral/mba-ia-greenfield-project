import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const FIVE_MIB = 5 * 1024 * 1024;

const putPart = async (url: string, body: Buffer): Promise<string> => {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  expect(response.status).toBe(200);
  return response.headers.get('etag')!;
};

describe('StorageService (integration)', () => {
  let storage: StorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init();
    storage = module.get(StorageService);
  });

  it('should upload a multipart object through presigned URLs and serve it back', async () => {
    const key = `test/${randomUUID()}/original`;
    const partOne = Buffer.alloc(FIVE_MIB, 1);
    const partTwo = Buffer.alloc(1024, 2);

    // Bucket creation is idempotent: a second ensure must not fail.
    await expect(storage.ensureBucket()).resolves.toBeUndefined();

    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const etagOne = await putPart(
      await storage.presignUploadPart(key, uploadId, 1),
      partOne,
    );
    const etagTwo = await putPart(
      await storage.presignUploadPart(key, uploadId, 2),
      partTwo,
    );

    const parts = await storage.listParts(key, uploadId);
    expect(parts).toEqual([
      { partNumber: 1, etag: etagOne, size: FIVE_MIB },
      { partNumber: 2, etag: etagTwo, size: 1024 },
    ]);

    expect(await storage.headObject(key)).toBeNull();
    await storage.completeMultipartUpload(key, uploadId, parts);
    expect(await storage.headObject(key)).toEqual({
      size: FIVE_MIB + 1024,
      contentType: 'video/mp4',
    });

    const readUrl = await storage.presignGet(key, 60);
    const ranged = await fetch(readUrl, { headers: { Range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-99/${FIVE_MIB + 1024}`,
    );

    const cors = await fetch(readUrl, {
      headers: { Origin: 'http://localhost:3001' },
    });
    expect(cors.headers.get('access-control-allow-origin')).toBeTruthy();

    const downloadUrl = await storage.presignGet(
      key,
      60,
      'attachment; filename="clip.mp4"',
    );
    expect(downloadUrl).toContain('response-content-disposition=attachment');
    const download = await fetch(downloadUrl, {
      headers: { Range: 'bytes=0-9' },
    });
    expect(download.headers.get('content-disposition')).toBe(
      'attachment; filename="clip.mp4"',
    );

    const thumbnailKey = `test/${randomUUID()}/thumbnail.jpg`;
    await storage.putObject(thumbnailKey, Buffer.from('jpeg'), 'image/jpeg');
    expect(await storage.headObject(thumbnailKey)).toEqual({
      size: 4,
      contentType: 'image/jpeg',
    });
  });

  it('should sign browser URLs with the public host and worker reads with the internal host', async () => {
    const config = storageConfig();
    const signer = new StorageService({
      ...config,
      publicEndpoint: 'http://public.example:9000',
    });
    const key = `test/${randomUUID()}/original`;

    expect(new URL(await signer.presignUploadPart(key, 'id', 1)).host).toBe(
      'public.example:9000',
    );
    expect(new URL(await signer.presignGet(key, 60)).host).toBe(
      'public.example:9000',
    );
    expect(new URL(await signer.presignInternalRead(key)).host).toBe(
      new URL(config.endpoint).host,
    );
  });
});
