# phase-03-videos — Progress

**Status:** completed
**SIs:** 16/16 completed

### SI-03.1 — Preparar infraestrutura Docker (Infra)
- **Status:** completed
- **Tests:** no tests (baseline suite 144 passing)
- **Observations:**
  - Baseline: `migrations.integration-spec.ts` failed whenever another suite left `verification_tokens_type_enum` behind (pre-existing order dependence). Added a `DROP TYPE IF EXISTS` to its `beforeAll`; suite stable green over two runs.
  - A `npm test` run hung for hours without `--forceExit` (open handles in an existing suite); pre-existing, not investigated.
  - `.env.example` `MAIL_FROM` is unquoted and breaks Compose parsing (pre-existing, only the local `.env` was fixed).
  - Local-only `compose.override.yaml` (db port 5433 because 5432 is taken by an unrelated container; named `node_modules` volume because npm install fails on the Windows bind mount).
  - The MinIO volume is writable by the image user, so `user: root` was not needed.

### SI-03.2 — Instalar libs, configs e ambiente de teste (Infra)
- **Status:** completed
- **Tests:** 13 passing in `src/config` (env.validation.integration-spec.ts)
- **Observations:**
  - Installed bullmq 6.3.18, @nestjs/bullmq 12.0.0, @aws-sdk/client-s3 and s3-request-presigner ^3.1153.0.
  - Existing `requiredEnv` in the spec gained the new required keys (S3_ENDPOINT, S3_PUBLIC_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, VIDEO_QUEUE_NAME).
  - Jest setup file is `src/test/jest-setup.ts`: queue name gets a `-test` suffix and `S3_PUBLIC_ENDPOINT` is forced to `S3_ENDPOINT`.
  - `UPLOAD_PART_SIZE_BYTES` is validated with a 5 MiB minimum (S3 rule); not in the plan, added as a guard.
  - Baseline `npm run lint` is red (156 errors in untouched files, mostly no-unsafe-* on `any`); new code adds no lint errors. Not fixed (out of scope). Running lint/prettier also rewrote line endings of unrelated files locally, but `git diff` shows no content change there.

### SI-03.3 — Criar módulo de storage S3
- **Status:** completed
- **Tests:** 3 passing (storage.service.integration-spec.ts 2, storage.module.spec.ts 1); full suite 153 passing
- **Observations:**
  - `headObject` returns null for a missing object; `listParts` lets NoSuchUpload propagate so SI-03.8 can fall back to headObject.
  - `StorageModule`, `storageConfig` and `queueConfig` registered in `AppModule`; the API now fails fast at startup if storage stays unreachable after 30 retries.

### SI-03.4 — Criar entidade Video, migration, slug e exceções de domínio
- **Status:** completed
- **Tests:** video.entity.integration-spec.ts 4, slug.util.spec.ts 1, migrations.integration-spec.ts 2 (updated); full suite 158 passing
- **Observations:**
  - Migration `1792489888882-CreateVideos.ts` was generated with the TypeORM CLI (entity rule) and prettier-formatted.
  - Adding `Channel.videos` (OneToMany, entity rule: both sides) forced `Video` into every test entity list that includes `Channel` (11 specs) and `DELETE FROM "videos"` into `cleanAllTables` (FK RESTRICT).
  - The migrations spec now covers 3 migrations; its second test reverts videos then tokens, and also drops the `video_status` type before running.
  - `size_bytes` and `duration_seconds` use column transformers so the pg driver's string output becomes a number.
  - `VideosModule` only has `TypeOrmModule.forFeature([Video])` for now; controller and service arrive in later SIs.
  - Follow-up fix after the phase commit: the migrations spec dropped tables with `Promise.all`; with `videos` in the FK graph the concurrent `DROP ... CASCADE` calls deadlocked once in a full run. They now run sequentially (4 consecutive full runs green).
  - Lint (after user decision "fix in a separate commit"): `npm run lint` was red with 150 pre-existing errors, all in files this phase did not change. Fixed in a `chore: lint` commit: untyped-by-nature rules (`no-unsafe-*`, `unbound-method`, `require-await`) turned off for `*.spec.ts`, `*.integration-spec.ts` and `*.e2e-spec.ts` in `eslint.config.mjs`; the real defects fixed in code (`any` in `channels.service.ts`, `Function` type in `create-test-data-source.ts`, two unused variables/imports). Lint now exits 0 (40 `no-unsafe-argument` warnings remain, already configured as warnings).

### SI-03.5 — Criar rascunho e abrir upload (POST /videos)
- **Status:** completed
- **Tests:** videos.service.spec 5 + filename.util.spec 8, videos.service.integration-spec 1, videos.module.spec 1, channels.service.integration findByUserId 1, e2e videos-create 5 passing
- **Observations:**
  - Added `src/videos/filename.util.ts` (`sanitizeFilename`, reused later for the download filename) and the shared e2e bootstrap `test/helpers/e2e-app.ts` (app with main.ts global config, `registerConfirmedUser`).
  - The size cap is enforced in the service (VIDEO_UPLOAD_TOO_LARGE), not by a DTO `@Max`, so the error code matches the contract.
  - MinIO `ListMultipartUploads` with a prefix returned nothing in the tests; the open upload is asserted with `ListParts` on the key and upload id instead.
  - The multipart upload is created before the row is saved; a failed save leaves an orphan upload that storage expiry cleans (TD-10).

### SI-03.6 — Assinar partes do upload (POST /videos/:id/parts)
- **Status:** completed
- **Tests:** videos unit+integration 28 passing (signParts: 6 unit cases, 1 integration), e2e videos-parts 5 passing
- **Observations:**
  - Ownership lookup (`findOwnedVideo`) validates the id with `isUUID` and answers 404 for a malformed id instead of letting Postgres raise a 500; it is private to `VideosService` and will be reused by complete/status.
  - `SignPartsDto` accepts an empty array on purpose: the empty list is rejected by the service as `VIDEO_INVALID_PART`, as the AC states.

### SI-03.7 — Criar módulo de fila BullMQ
- **Status:** completed
- **Tests:** queue.module.spec 1, queue.integration-spec 3 passing; videos suites still green (32 total in src/queue + src/videos)
- **Observations:**
  - Plan deviation: `library-refs.md` pinned `@nestjs/bullmq ^12`, but v12 and `@nestjs/bull-shared` 12 are ESM-only and Jest (CommonJS ts-jest) cannot load them. Installed `@nestjs/bullmq@11.0.5` (CJS, peer `bullmq ^6` accepted, Nest 11 compatible). Revisit if the project moves to ESM.
  - bullmq 6 no longer bundles `ioredis`; added `ioredis` as a dependency.
  - The queue name is a module-level constant read at import (`queue.constants.ts` imports `dotenv/config` first) because `registerQueue`/`@InjectQueue` need a static name before `ConfigModule` runs; the Jest setup file renames it before any import.
  - `QueueModule` is imported by both `AppModule` and `VideosModule`; it is a singleton so there is one Redis connection per process.

### SI-03.8 — Finalizar upload e enfileirar processamento (POST /videos/:id/complete)
- **Status:** completed
- **Tests:** videos.service.spec 22 (completeUpload: 9 cases incl. crash with/without object, processing, ready/error, zero/partial parts, size cap), videos.service.integration-spec 7 (5 for complete), e2e videos-complete 7 passing
- **Observations:**
  - The part-count check also rejects a count different from the declared one (`ceil(size / partSize)`), as the Error Catalog says.
  - `size_bytes` is overwritten with the stored object's real size when the video moves to `processing` (re-verification at completion).
  - `finishMultipartUpload` intentionally swallows only `NoSuchUpload` from ListParts/Complete to resume after a crash; every other error propagates.
  - Integration and e2e specs obliterate the isolated test queue before each test and close the Nest module so Jest exits without `--forceExit`.

### SI-03.9 — Consultar status do vídeo (GET /videos/:id)
- **Status:** completed
- **Tests:** videos.service.spec 24, videos.service.integration-spec 8, e2e videos-status 4 passing
- **Observations:**
  - `VideosService.getOwned` returns the entity; the controller maps it with `VideoStatusResponseDto.from()` (a static mapper, no business rule).

### SI-03.10 — Criar entrypoint do worker e serviço no Compose
- **Status:** completed
- **Tests:** worker.module.spec 1 passing; related suites 13 passing (67 tests)
- **Observations:**
  - Extracted the ConfigModule and TypeORM root setup from `AppModule` into `src/config/root-modules.ts` (`configRootModule`, `databaseRootModule`) so the API and the worker share one environment validation and DB config; `AppModule` behavior is unchanged.
  - `WorkerModule` also imports `UsersModule`: with `autoLoadEntities` the `User` entity must be registered for `Channel#user` (and so `Video`) to resolve; without it TypeORM looped on "Entity metadata for Channel#user was not found".
  - `nestjs-worker` boots and logs "Video worker started, waiting for jobs"; it publishes no ports. Separate `dist-worker` outDir (ignored by git and excluded in `tsconfig.build.json`) keeps the two watchers from deleting each other's output.
  - Local `compose.override.yaml` gained the same `node_modules` named volume for `nestjs-worker` (Windows bind-mount workaround, not committed).
  - Manually verified: `docker compose ps` shows `nestjs-worker` running without published ports, the boot line is in its logs, and the real container consumed a job injected into Redis. Also verified after the user asked to run the app: with `start:dev` running in `nestjs-api` the API answered 200 and the worker kept its start time with 0 restarts; restarting `nestjs-worker` left the API answering 200. The two watchers use separate output directories (`dist` and `dist-worker`).

### SI-03.11 — Extrair metadados e thumbnail com FFmpeg
- **Status:** completed
- **Tests:** media-extraction.service.integration-spec 3, frame-time.util.spec 7 passing
- **Observations:**
  - `frameTime` = 10% of the duration, at least 1 s, capped at half the duration for videos shorter than 1 s (so the frame is always inside the video).
  - Registered in `WorkerModule` together with `VideoProcessor` (SI-03.12), not in `VideosModule`.

### SI-03.12 — Implementar o VideoProcessor e o tratamento de falha
- **Status:** completed
- **Tests:** video.processor.integration-spec 4 (success, already ready, no video stream with 1 attempt, 3 failed attempts), videos.service.spec 30 (transitions) passing
- **Observations:**
  - The integration module hosts the real `VideoProcessor`, so the BullMQ worker of the isolated test queue consumes the jobs; retries use a 50 ms fixed backoff passed as job options.
  - `markReady`/`markError` update with `WHERE status = 'processing'` and throw `InvalidVideoTransitionError` (plain Error, background context) when no row matched; the `failed` handler logs instead of rethrowing.
  - A failure counts as final for `UnrecoverableError`, a stalled-job message, or `attemptsMade >= attempts`.
  - `VideosService.findById` is an unscoped lookup used only by the processor.
  - Manually verified with the real container: with `nestjs-worker` stopped a `video.process` job stays `waiting` in Redis; after starting it, the worker consumed the job (it failed as expected, the video did not exist). The test job and queue were cleaned afterwards.

### SI-03.13 — Reproduzir vídeo por streaming (GET /videos/:slug/stream)
- **Status:** completed
- **Tests:** videos.service.spec getPlaybackUrl 5 cases, videos.service.integration-spec (Range 206), e2e videos-stream 6 passing
- **Observations:**
  - `getPlaybackUrl(slug, mode)` serves both stream and download; the controller returns `{ url, statusCode: 302 }` with `@Redirect()`.
  - Shared e2e fixture `test/helpers/ready-video.ts` inserts a video row (and optionally its object in real storage).

### SI-03.14 — Baixar vídeo (GET /videos/:slug/download)
- **Status:** completed
- **Tests:** download-filename.util.spec 7, videos.service.spec download case, videos.service.integration-spec (attachment header), e2e videos-download 3 passing
- **Observations:**
  - File name = sanitized title + extension from the mime type (`video/quicktime` -> `.mov`, etc.), with an ASCII `filename` fallback and an RFC 5987 `filename*` for accented titles (`src/videos/download-filename.util.ts`).

### SI-03.15 — Validar o fluxo completo de upload ponta a ponta
- **Status:** completed
- **Tests:** e2e videos-flow 2 passing; full e2e suite 84 passing (10 suites); full unit+integration suite 240 passing (38 suites), exits without `--forceExit`
- **Observations:**
  - `UPLOAD_PART_SIZE_BYTES` is set to 5 MiB inside the test before the app is built, so the 4 s / 16 Mbit generated video (>5 MiB, `test/helpers/media.ts`) uploads as 2+ parts.
  - `createE2eApp({ withProcessor: true })` runs the real `VideoProcessor` in the test process on the isolated test queue.
  - The status poll clears the throttler storage on each iteration because `GET /videos/:id` is under the global limit.
  - `npm run test:e2e` now passes `--runInBand` (package.json): with several e2e suites sharing one database, the parallel default produced 35 failures. The root `CLAUDE.md` already says e2e must run in band.

### SI-03.16 — Atualizar OpenAPI e documentação de IA
- **Status:** completed
- **Tests:** no tests (documentation and generated artifact); checked by script that `openapi.json` has the 6 video paths and that every `nestjs-project/...` path cited in the root `CLAUDE.md` exists
- **Observations:**
  - `openapi.json` regenerated with `npm run openapi:export`. Request DTO schemas (including the existing `RegisterDto`) come out with empty `properties`, because the ts-node export does not run the `@nestjs/swagger` CLI plugin that fills them at `nest build`; pre-existing limitation of the export script, not changed here. Response DTOs (explicit `@ApiProperty`) and the `302` responses are complete.
  - Updated: `nestjs-project/CLAUDE.md` (services, ports, env keys, `start:worker`, worker exception, e2e in band), root `CLAUDE.md` (Videos section), root `README.md` (architecture, how to run, endpoints, structure, phase table, stack). `nestjs-project/README.md` is the untouched Nest boilerplate.
  - `library-refs.md` got an implementation note about the `@nestjs/bullmq` 11 pin.

