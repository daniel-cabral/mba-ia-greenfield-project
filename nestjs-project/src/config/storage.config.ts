import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT!,
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT!,
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  bucket: process.env.S3_BUCKET!,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  uploadMaxBytes: parseInt(process.env.UPLOAD_MAX_BYTES || '10737418240', 10),
  uploadPartSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES || '67108864',
    10,
  ),
  partUrlExpiresSeconds: parseInt(
    process.env.S3_PART_URL_EXPIRES_SECONDS || '3600',
    10,
  ),
  streamUrlExpiresSeconds: parseInt(
    process.env.S3_STREAM_URL_EXPIRES_SECONDS || '300',
    10,
  ),
  downloadUrlExpiresSeconds: parseInt(
    process.env.S3_DOWNLOAD_URL_EXPIRES_SECONDS || '900',
    10,
  ),
  workerReadUrlExpiresSeconds: parseInt(
    process.env.S3_WORKER_READ_URL_EXPIRES_SECONDS || '3600',
    10,
  ),
}));
