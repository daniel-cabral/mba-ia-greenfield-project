---
libs:
  "bullmq":
    version: "^6.3.17"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-19T23:25:00-03:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-19T23:25:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1153.0"
    context7_id: "/websites/aws_amazon_sdk-for-javascript_v3_developer-guide"
    fetched_at: "2026-10-19T23:25:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1153.0"
    context7_id: "/websites/aws_amazon_sdk-for-javascript_v3_developer-guide"
    fetched_at: "2026-10-19T23:25:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-videos.md: "2026-10-19T23:17:55.845650500-03:00"
---

# Library references: phase-03-videos

Versions are the latest published on npm at planning time (`npm view`, 2026-10-19). `@nestjs/bullmq@12` declares peer dependencies `bullmq ^3 || ^4 || ^5 || ^6` and `@nestjs/core ^10 || ^11 || ^12`, so it fits the installed NestJS 11. Excerpts below come from Context7; items marked "verify at implementation" were not in the fetched excerpts.

### bullmq

- `Queue.add(name, data, opts)`: `opts.jobId` makes duplicates idempotent. A second `add` with the same `jobId` is ignored while the first job still exists; if `removeOnComplete` or `removeOnFail` has removed it, the id is accepted again. This is the basis of videos/TD-04 (job id = `videoId`) and TD-10.
- Retries: `attempts: 3, backoff: { type: 'exponential', delay: <ms> }` (a number is also accepted as a fixed delay). The delay value is a plan-build choice.
- `removeOnComplete: true` removes finished jobs; `removeOnFail` accepts a count or an age/count object (keep failures inspectable), as used in videos/TD-10.
- `UnrecoverableError` (exported by `bullmq`): throwing it in the processor moves the job to failed without retries, overriding `attempts`.
- Stalled jobs: a job that stalls more than `maxStalledCount` (default 1) is failed permanently with "job stalled more than allowable limit". Such jobs never reach the processor's catch block, so `error` status must be written from the worker `failed` event (videos/TD-10).
- Redis requirements: `maxmemory-policy=noeviction`; persistence must be configured manually (AOF recommended). Redis 6.2 or newer.

### @nestjs/bullmq

- Root config: `BullModule.forRoot({ connection: { host, port } })` or `forRootAsync({ useFactory, inject })` (use the async form with the namespaced `queue.config.ts`, videos/TD-14).
- Queue: `BullModule.registerQueue({ name, defaultJobOptions })`; inject with `@InjectQueue(name)` (`Queue` type from `bullmq`) in the producer (`VideosService`).
- Consumer: `@Processor(name, { concurrency })` on a class extending `WorkerHost` with `async process(job)`; a rejected promise marks the job failed and honors `attempts`/`backoff`. Register it only in the worker's module (videos/TD-08).
- Worker events: `@OnWorkerEvent('failed')` inside the `@Processor` class receives `(job, err)`; use it to write `error` plus `failure_reason` on the last attempt or on `UnrecoverableError` (videos/TD-10). Also available: `'completed'`, `'stalled'`, `'error'`.
- Verify at implementation: running `NestFactory.createApplicationContext` with `BullModule` so the worker starts without an HTTP server (standard Nest standalone application; the Context7 excerpt did not show an example).

### @aws-sdk/client-s3

- Client for MinIO: `new S3Client({ region, endpoint: S3_ENDPOINT, credentials, forcePathStyle: true })`. In SDK v3 the option is `forcePathStyle` (renamed from v2 `s3ForcePathStyle`). One client with the internal endpoint for API/worker calls, and a second client built with `S3_PUBLIC_ENDPOINT` for presigning (videos/TD-06, TD-14).
- Commands used: `CreateMultipartUploadCommand`, `UploadPartCommand` (presigned only), `ListPartsCommand`, `CompleteMultipartUploadCommand`, `HeadObjectCommand`, `HeadBucketCommand`, `CreateBucketCommand`, `GetObjectCommand`, `PutObjectCommand` (thumbnail upload by the worker).
- Verify at implementation: `ListPartsCommand` pagination (`PartNumberMarker`, `NextPartNumberMarker`, `IsTruncated`, up to 1000 parts per page) and the shape of `Parts[].ETag`/`PartNumber` required by `CompleteMultipartUploadCommand` (`MultipartUpload: { Parts: [...] }`); these were not in the fetched excerpts.

### @aws-sdk/s3-request-presigner

- `getSignedUrl(client, command, { expiresIn })` returns a presigned URL for any command. Upload parts: `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn })`. Stream/download: `new GetObjectCommand({ Bucket, Key })`; download adds `ResponseContentDisposition: 'attachment; filename="..."'` (videos/TD-11).
- The signature binds the host used by the signing client, which is why signing uses the public endpoint and why tests override it (videos/TD-06, TD-15).
