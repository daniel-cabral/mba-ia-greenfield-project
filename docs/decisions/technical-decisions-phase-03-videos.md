---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-19
scope_description: "Video upload and processing foundation: job queue, S3-compatible object storage, 10GB upload strategy, completion trigger, bucket/key layout, streaming and download delivery, unique video URL identifier, background worker, media extraction (metadata + thumbnail), status lifecycle with failure handling, authorization, data model, storage/queue config and bootstrap, test topology, and API contract details."
---

# Technical Decisions: Phase 03 Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` - backend that owns the videos module (upload session, completion, streaming/download URLs), the queue producer, and the worker entrypoint that consumes the queue.
- `next-frontend/` - out of scope for this phase (the video UI is not part of Fase 03). No TD here. Upload and playback contracts are fixed on the API side so the future UI can consume them.
- Repo-wide - `nestjs-project/compose.yaml` gains storage (TD-02), Redis (TD-01) and worker (TD-08) services.

Pre-aligned directions validated by this research (not assumed): BullMQ, S3 multipart with presigned URLs, presigned GET with Range for streaming, separate worker container, status `draft -> processing -> ready | error`. Two of the pre-aligned directions are **challenged** below: the MinIO image (TD-02) and `nanoid` (TD-07).

Inherited and not reopened: PostgreSQL 17 + TypeORM migrations, global JWT guard, domain exceptions filter, Joi-validated namespaced config, Docker Compose service names as hosts (`docs/decisions/technical-decisions-phase-01-configuracao-base.md`, `technical-decisions-phase-02-auth.md`).

---

## TD-01: Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and `docs/diagrams/software-arch.mermaid` leave the queue as "TBD". The API publishes one job per uploaded video; a separate worker consumes it. This is the main stack decision of the phase. Compose gains one new service whichever option is chosen, except pg-boss.

**Options:**

### Option A: BullMQ on Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed queue. `@nestjs/bullmq` provides `BullModule.registerQueue`, `@Processor` and `WorkerHost`; a rejected `process()` marks the job failed and is retried per `attempts`/`backoff`.
- **Pros:** first-class NestJS integration; retries, exponential backoff, stalled-job recovery and job ids (idempotency) built in; one small container; testable against a real Redis in Compose.
- **Cons:** Redis needs manual durability config (BullMQ docs recommend AOF and `maxmemory-policy=noeviction`); adds Redis as a new runtime dependency; worker must be Node (acceptable, FFmpeg is spawned as a process).

### Option B: pg-boss (queue inside PostgreSQL)
- Queue tables in the existing PostgreSQL 17 using `SKIP LOCKED`. No new container.
- **Pros:** zero new infra; transactional enqueue with the video row; durable by default.
- **Cons:** no official NestJS module; no separate queue service in Compose, which risks failing the challenge rule "fila, worker e storage reais subindo no Compose"; queue load shares the primary database.

### Option C: RabbitMQ
- AMQP broker with acks, DLQs and routing; `@nestjs/microservices` has an RMQ transport.
- **Pros:** language-agnostic, durable, mature DLQ model.
- **Cons:** heavier setup (exchanges, queues, bindings); retry with backoff is manual (TTL + DLX); more code and config for one job type.

### Option D: SQS emulated locally (ElasticMQ)
- Same API as AWS SQS, pairs with the S3 story in production.
- **Pros:** parity with a future AWS deployment.
- **Cons:** emulator less common in the Node/Nest ecosystem; no NestJS module; visibility-timeout and retry handling written by hand.

**Recommendation:** Option A (BullMQ on Redis) - BullMQ with @nestjs/bullmq on a Redis Compose service: retries, exponential backoff and stalled-job recovery are built in, so it needs the least code in a NestJS 11 project and runs as a real queue service. Redis runs with AOF (`--appendonly yes`) and `maxmemory-policy noeviction` per the BullMQ production guide, with a named volume. One queue for video processing; its name comes from config.

**Decision:** A
**Libraries:** `bullmq`, `@nestjs/bullmq`

---

## TD-02: S3-Compatible Storage Service for Compose

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The enunciado fixes "S3 compatible, MinIO locally", so the storage API is not in question. What is open is **which image** runs it. Checked in this session: `quay.io/minio/minio:latest` and `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` have no manifest, `minio/minio` on Docker Hub is denied, and the MinIO GitHub repository is reported as archived with source-only distribution (see sources). A plain `image: minio/minio` in `compose.yaml` would not start. Sources: [MinIO repository](https://github.com/minio/minio), [Chainguard MinIO announcement](https://www.chainguard.dev/unchained/secure-and-free-minio-chainguard-containers); dates in third-party posts conflict, so the local `docker manifest inspect` results are the evidence used. Images that do resolve today: `cgr.dev/chainguard/minio`, `chrislusf/seaweedfs`, `dxflrs/garage` (v1.0.1, v2.0.0), `rustfs/rustfs` (alpha tags).

**Options:**

### Option A: Chainguard MinIO image, pinned by digest
- Same MinIO server and S3 API the enunciado names, from `cgr.dev/chainguard/minio`, pinned by `@sha256:` digest.
- **Pros:** exact MinIO behavior (multipart, presigned, Range, server-wide CORS); no code change if the enunciado's "MinIO" wording is audited; image manifest resolves today.
- **Cons:** free Chainguard images are generally `latest`-only, so the digest pin is mandatory for reproducibility; supply source is a third party; MinIO community edition is unmaintained upstream.

### Option B: SeaweedFS (`chrislusf/seaweedfs`)
- Actively maintained distributed store with an S3 gateway (`weed server -s3`).
- **Pros:** maintained, tagged releases, multipart supported.
- **Cons:** S3 compatibility has edge cases (presigned multipart, CORS) that must be proven by tests; more moving parts (master, volume, filer, s3).

### Option C: Garage (`dxflrs/garage`)
- Lightweight S3-compatible store with versioned tags.
- **Pros:** maintained, single binary, small footprint.
- **Cons:** needs cluster layout bootstrapping before first use (awkward for a one-command Compose); less common S3 feature coverage to validate.

**Recommendation:** Option A (Chainguard MinIO pinned by digest) - Run MinIO from `cgr.dev/chainguard/minio` pinned by `@sha256:` digest, because the official MinIO images no longer resolve; this keeps exact MinIO S3 behavior for multipart, presigned URLs, Range and server-wide CORS. A mandatory integration smoke test (create bucket, multipart presigned upload, ListParts, Range GET, browser-origin CORS headers) detects any image swap, with SeaweedFS as fallback. The pull and the digest must be re-verified at plan-resolve because registry state is volatile.

**Decision:** A
**Libraries:** —

**Revisions:**
- 2026-10-19 - Pinned digest recorded: `cgr.dev/chainguard/minio@sha256:2915cb406f38ed6ff9634de0a3e4a9423e2dda06a6f1aca18f8c968aa37a01f6` (OCI index, linux/amd64 and linux/arm64, verified by registry inspection). Image facts from the manifest config: entrypoint `/usr/bin/minio`, user 65532, no shell. The Docker daemon was off during this check, so the real pull and the write permission of user 65532 on the data volume are verified by the storage smoke test during implementation; if the volume is not writable the Compose service sets `user: root`, and if the image fails entirely SeaweedFS is the fallback. Rationale: close OQ-1.

---

## TD-03: Large-File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Passing 10GB through the API is an automatic fail criterion. YouTube's resumable protocol (a POST opens a session and returns a unique upload URL, then PUTs carry `Content-Range`, resumable after a 308 status query) keeps the API out of the byte path ([source](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol?hl=en)). Presigning uses `@aws-sdk/s3-request-presigner` `getSignedUrl` (AWS SDK v3 docs via Context7). The S3 analogue must fit the existing storage API. S3 limits: 5 MiB minimum part (except the last), 10,000 parts maximum, so 10GB fits comfortably (for example 64 MiB parts give about 160 parts; the part size is a client choice within the limits, not a requirement). Presigned part URLs are signed with the **public** endpoint (TD-06) because the browser uploads to them.

**Options:**

### Option A: S3 multipart with presigned `UploadPart` URLs
- `POST /videos` creates the draft row and calls `CreateMultipartUpload`; the API returns an `uploadId` and presigned URLs per part (or on demand per part). The client PUTs parts straight to storage; at completion the API reads the uploaded parts itself with `ListParts` (TD-04), so the client does not have to read or return ETags.
- **Pros:** API never touches bytes; resumable (re-list parts with `ListParts`) and parallel; no 5GB single-PUT limit; native in S3 and the chosen emulator.
- **Cons:** client must implement part slicing; more API endpoints (init, sign part, complete); CORS must allow the uploading origin (MinIO enables CORS on all buckets by default and restricts origins via `MINIO_API_CORS_ALLOW_ORIGIN`; `PutBucketCors` is not supported by MinIO).

### Option B: Single presigned PUT
- One presigned URL per file.
- **Pros:** simplest contract.
- **Cons:** S3 caps a single PUT at 5GB, so it cannot satisfy 10GB; no resume.

### Option C: tus resumable protocol
- Open protocol, needs a tus server in front of storage (tusd) or in the API.
- **Pros:** standard resumable client libraries.
- **Cons:** extra service or code; tusd-to-S3 adds a hop; duplicates what S3 multipart already gives.

### Option D: Upload streamed through the API
- API receives the stream and pipes it to storage.
- **Pros:** one endpoint.
- **Cons:** holds connections and bandwidth for the whole transfer; this is the explicit auto-fail case.

**Recommendation:** Option A (S3 multipart with presigned parts) - `POST /videos` creates the draft row and calls CreateMultipartUpload; the client uploads parts directly to storage through presigned UploadPart URLs, so the API never touches the bytes. This is the S3 equivalent of the YouTube resumable model, is resumable and parallel, and stays within S3 limits (5 MiB minimum part, 10,000 parts). The API enforces the 10GB cap at init (declared size and part count) and re-verifies the real object size at completion.

**Decision:** A
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

---

## TD-04: Upload Completion Trigger and Job Contract

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** After the last part is uploaded, something must finalize the multipart upload and enqueue the processing job. The job payload is a contract between producer (API) and consumer (worker), so it must stay consistent in two places. This decision also fixes when `draft -> processing` happens.

**Options:**

### Option A: Explicit `POST /videos/:id/complete` from the client
- Client calls the endpoint with no part list. API lists the parts with `ListParts` (paginated), calls `CompleteMultipartUpload`, checks `HeadObject` size against the 10GB cap, sets status `processing` and enqueues `{ videoId }` with job id = videoId, in that order.
- **Pros:** deterministic and testable with supertest; API validates ownership and size at the moment of completion; no extra infra.
- **Cons:** relies on the client calling it; a client that never calls it leaves a draft (handled by TD-10 cleanup).

### Option B: Storage event notification (webhook or queue) triggers the job
- Bucket notifications call the API when the object is created.
- **Pros:** works even if the client disappears after the last part.
- **Cons:** notification support and config differ per S3 emulator; harder to test; still needs a completion call for multipart; adds a moving part.

### Option C: Worker polls storage for finished uploads
- **Pros:** no client contract.
- **Cons:** polling load, latency, and the worker needs to know which uploads are done; effectively reinvents a queue.

**Recommendation:** Option A (explicit complete endpoint) - `POST /videos/:id/complete` on a `draft` video lists the uploaded parts with ListParts (paginated), calls CompleteMultipartUpload, checks the HeadObject size against the 10GB cap, sets status `processing` and enqueues the job, in that order. Crash safety: if the row is still `draft` but ListParts fails with NoSuchUpload (the upload was completed before a crash), the service runs HeadObject on the original key and, if the object exists, continues with the status write and the enqueue; if it does not exist the call fails with a domain error. On a video already `processing`, only the enqueue is repeated and the S3 steps are skipped. Events/Messages: job name `video.process` on the queue named by `VIDEO_QUEUE_NAME`, payload `{ videoId }` (the worker reads object key and owner from PostgreSQL, so the message cannot drift from the database), producer `VideosService`, consumer `VideoProcessor` running only in the worker entrypoint, delivery at-least-once with an idempotent consumer (TD-10). Job id = `videoId`: a duplicate id is ignored while the previous job still exists.

**Decision:** A
**Libraries:** —

---

## TD-05: Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The enunciado says what is decided here is "como usar" the storage: buckets and keys. The layout is cited by the video entity (storage-key columns), the upload service, the worker, the Joi schema and Compose bucket bootstrap, so it is a cross-component contract.

**Options:**

### Option A: One bucket, per-video prefix: `videos/{videoId}/original`, `videos/{videoId}/thumbnail.jpg`
- Keys use the immutable database id, not the user filename or the public slug.
- **Pros:** one bucket to configure (CORS, lifecycle); all assets of a video share a prefix (delete by prefix); keys are not guessable from user input and never collide.
- **Cons:** videos and thumbnails share lifecycle and access rules.

### Option B: Two buckets (`videos`, `thumbnails`)
- **Pros:** separate policies (for example public thumbnails later); clear separation.
- **Cons:** two buckets to bootstrap and keep consistent; no requirement in this phase needs different policies.

### Option C: Key by public slug
- **Pros:** readable keys.
- **Cons:** couples storage keys to the public identifier (TD-07); a slug change or collision retry would orphan objects.

**Recommendation:** Option A (one bucket, per-video prefix) - One bucket named by config (`S3_BUCKET`) with keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`, built from the immutable database id (not the filename or the public slug). Original keys are written once and never renamed; the extension is not part of the key (content type is stored on the object and in the video row). Abandoned multipart uploads are expired by the storage service (see TD-10).

**Decision:** A
**Libraries:** —

---

## TD-06: Streaming Delivery

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** The architecture diagram shows the frontend streaming from object storage, not through the API. Streaming needs HTTP Range (206 Partial Content). A Docker-specific constraint applies: a presigned URL is bound to the host that signed it, so the API (inside Compose, talking to `minio` or equivalent) must sign with a **public** endpoint reachable by the browser, while internal calls use the Compose service name. That means two endpoint settings in config, `.env.example` and Compose. Roles: upload part URLs and stream URLs are signed with the public endpoint (the browser reaches them); the API's own storage calls (`CreateMultipartUpload`, `ListParts`, `CompleteMultipartUpload`, `HeadObject`) and the worker reads (TD-09) use the internal endpoint. Tests run inside `nestjs-api` (`docker compose exec nestjs-api npm test`), where a URL signed for `localhost` is unreachable.

**Options:**

### Option A: API returns short-lived presigned GET URLs; storage serves Range natively
- `GET /videos/:slug/stream` authorizes, then returns (or 302 to) a presigned GET. Config has `S3_ENDPOINT` (internal) and `S3_PUBLIC_ENDPOINT` (for signing). In real-infra tests the signing endpoint is overridden to the internal one, so the test process can follow the signed URLs; one assertion checks that the production config signs with the public host.
- **Pros:** API off the byte path; Range/206 handled by storage; scales with storage; matches the architecture diagram.
- **Cons:** two endpoint settings; URLs expire (player must re-request); needs CORS for browser playback (default-on in MinIO).

### Option B: API proxies bytes and implements Range itself
- Controller reads the `Range` header, requests the same range from storage and pipes it with 206.
- **Pros:** single origin, no CORS or public endpoint; access checks on every byte request.
- **Cons:** API in the data path again (bandwidth and connections); Range logic to write and test; contradicts the "no impact on API" goal.

### Option C: Public bucket read, unguessable keys
- **Pros:** simplest.
- **Cons:** no authorization; breaks future visibility rules (Fase 04); unlisted/private videos would leak.

**Recommendation:** Option A (presigned GET) - `GET /videos/:slug/stream` authorizes, checks the status, then answers a 302 redirect (TD-16) to a short-lived presigned GET, so storage serves Range (206) directly and the API stays off the byte path. Signing uses `S3_PUBLIC_ENDPOINT`; the API's own storage calls use `S3_ENDPOINT`. In real-infra tests the signing endpoint is overridden to the internal one, and one assertion checks that the production config signs with the public host. Expiry is a few minutes.

**Decision:** A
**Libraries:** —

**Revisions:**
- 2026-10-19 - Wording corrected: the route resolves the slug and requires status `ready` before answering the 302; it performs no authentication because it is `@Public()` (TD-12, TD-16). Rationale: public routes carry no authenticated user.

---

## TD-07: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public identifier that is unique and unguessable enough that it cannot be enumerated. The project is CommonJS NestJS tested with Jest. `nanoid` v4+ is ESM-only, which needs extra Jest/ts-jest transform configuration in a CJS project; v3 is the last CJS line.

**Options:**

### Option A: `crypto.randomBytes` encoded as base64url (11 characters), unique index, retry on collision
- Node built-in, no dependency. 8 random bytes give 64 bits, enough for this scale.
- **Pros:** no new dependency or ESM/CJS friction; same shape as nanoid; collision handled by the unique constraint plus retry.
- **Cons:** tiny helper to write and test; alphabet is fixed to base64url.

### Option B: `nanoid` (v3 CJS line)
- **Pros:** well-known API, custom alphabets.
- **Cons:** pins an old major to stay CJS-compatible, or needs ESM transform config for Jest on newer majors; extra dependency for a one-line need.

### Option C: UUIDv4 as the public id
- **Pros:** built in (`crypto.randomUUID`), no helper.
- **Cons:** 36-character URLs, less shareable; exposes the primary key if reused as id.

**Recommendation:** Option A (crypto.randomBytes base64url) - Generate 8 random bytes encoded as an 11-character base64url slug with `crypto.randomBytes`, stored in a unique-indexed `slug` column and retried on collision. It avoids the ESM-only `nanoid` friction with Jest in this CommonJS project. The slug is a separate column: not the primary key and not part of storage keys (TD-05).

**Decision:** A
**Libraries:** —

---

## TD-08: Worker Runtime and Topology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The worker must run as its own container, consume the queue, reach storage and PostgreSQL, and have FFmpeg installed. Today `Dockerfile.dev` is `node:25.6.0-slim` without FFmpeg. The worker updates video rows and storage, per the architecture diagram.

**Options:**

### Option A: Same codebase and image family, second entrypoint (`src/worker.ts`) booting a Nest standalone application context; separate Compose service with FFmpeg installed
- Reuses entities, repositories, config and `@nestjs/bullmq` processors; Compose runs `nestjs-worker` from the same build context with a different command.
- **Pros:** no duplicated entities or config; one test setup; consistent conventions; FFmpeg installed once in the shared dev image.
- **Cons:** the worker image carries API dependencies; entrypoint must not start the HTTP server.

### Option B: Separate package or repo folder (`video-worker/`) with its own `package.json`
- **Pros:** clean isolation and independent scaling/deploy.
- **Cons:** duplicates entity definitions or needs a shared package (monorepo tooling this project does not have); two dependency trees.

### Option C: Run the processor inside the API process
- **Pros:** least infra.
- **Cons:** CPU-heavy FFmpeg shares the API process and violates the architecture diagram's separate "Video Worker" container.

**Recommendation:** Option A (second Nest entrypoint, separate service) - The worker is a Nest standalone application context started from a second entrypoint (`src/worker.ts`) by a `start:worker` script (`nest start --entryFile worker` in dev), in a Compose service `nestjs-worker` built from the same code and image, so entities, repositories and config are reused. The `VideoProcessor` is registered only in the worker's module, never in the API's `VideosModule`. The service sets `command: npm run start:worker`, `depends_on` db, redis and storage, and a restart policy; dependencies must already be installed (`docker compose exec nestjs-api npm install`, same as the API). Starting the worker is the documented exception to the project rule of not starting the Nest app unprompted, because Compose runs it as a service. FFmpeg is installed once in the shared dev image (see TD-15).

**Decision:** A
**Libraries:** —

---

## TD-09: Media Extraction (Metadata and Thumbnail)

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker needs duration and metadata (via ffprobe) and one thumbnail frame (via ffmpeg) from a file that may be 10GB. Two choices are coupled: how FFmpeg is invoked, and how it reads the input. The `fluent-ffmpeg` npm package is deprecated ([npm](https://npmjs.com/package/fluent-ffmpeg)). The worker reads through the internal storage endpoint (TD-06).

**Options:**

### Option A: Spawn `ffprobe`/`ffmpeg` with `child_process`, reading the input from a presigned GET URL
- ffprobe returns JSON (`-print_format json -show_format -show_streams`); the thumbnail is one frame (`-ss <t> -i <url> -frames:v 1`), uploaded to the thumbnail key.
- **Pros:** no 10GB download or disk copy; FFmpeg HTTP input uses Range requests; no wrapper dependency; exact control of flags and exit codes.
- **Cons:** MP4 files with the index (`moov`) at the end cost extra range reads; command-line handling and error parsing written by hand.

### Option B: `fluent-ffmpeg` wrapper, input downloaded to a temp file first
- **Pros:** fluent API.
- **Cons:** the npm package is deprecated and unmaintained; downloading up to 10GB per job needs large ephemeral disk and time.

### Option C: Spawn FFmpeg but download the object to temp disk first
- **Pros:** most robust seeking and error behavior on any container.
- **Cons:** disk and time proportional to file size; cleanup on failure.

**Recommendation:** Option A (spawn ffprobe/ffmpeg on a signed URL) - The worker spawns `ffprobe` (JSON output) and `ffmpeg` with `child_process`, reading the input over HTTP from a URL signed with the internal endpoint, so a 10GB file is not downloaded; one frame is extracted and uploaded to the thumbnail key. Downloading to temp disk first is the documented fallback if HTTP input proves flaky in integration tests. The frame-selection rule (a fixed offset or a proportion of the duration, clamped for short videos) is a plan-build detail. A file with no video stream is a permanent failure and ends in `error`.

**Decision:** A
**Libraries:** —

---

## TD-10: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The enunciado requires the cycle draft -> processing -> ready | error reflected in the database and a defined behavior on processing failure. Failure sources: FFmpeg error, unreadable or non-video file, worker crash mid-job, upload abandoned before completion. The status values and the failure fields are read by the API, the worker and (later) Fase 04.

**Options:**

### Option A: Linear states, BullMQ retries, terminal `error` with a reason column
- States: `draft` (row created at init), `processing` (set at completion, TD-04), `ready` (worker success), `error` (worker exhausted retries or hit a permanent failure). Queue `attempts: 3` with exponential backoff; the worker writes `error` plus `failure_reason` on the final failed attempt. Stalled jobs are recovered by BullMQ. Abandoned drafts: incomplete multipart uploads are expired by the storage service (MinIO: `MINIO_API_STALE_UPLOADS_EXPIRY`, default 24h; AWS S3: lifecycle `AbortIncompleteMultipartUpload`); draft rows stay `draft`.
- **Pros:** matches the enunciado's cycle exactly; transient failures retried automatically; permanent failures visible and diagnosable; minimal moving parts.
- **Cons:** a terminal `error` has no retry endpoint in this phase (Fase 04 can add one); stale `draft` rows need a later cleanup job.

### Option B: No retries, fail on first error
- **Pros:** simplest.
- **Cons:** transient storage or network hiccups turn into permanent errors.

### Option C: Retries plus a dead-letter queue and a reprocess endpoint
- **Pros:** operator tooling for failed jobs.
- **Cons:** extra queue, endpoint and authorization rules not required by the phase capabilities.

**Recommendation:** Option A (retries, terminal error with reason) - Statuses: `draft` (row created at init), `processing` (set at completion), `ready` (worker success), `error` (final failure). The queue uses `attempts: 3` with exponential backoff; permanent failures (for example no video stream) skip retries via BullMQ `UnrecoverableError`. `error` plus `failure_reason` is written by the worker `failed` listener when the last attempt fails or an `UnrecoverableError` is raised, so jobs that fail by stalling past `maxStalledCount` also end in `error`, not only exceptions thrown inside the processor. Job options: `removeOnComplete: true` and `removeOnFail` kept by age so failures stay inspectable. Transitions are guarded in the service. The consumer is idempotent: a job that finds the video already `ready` exits. Stale multipart uploads expire in storage (MinIO `MINIO_API_STALE_UPLOADS_EXPIRY`, default 24h; AWS lifecycle `AbortIncompleteMultipartUpload`).

**Decision:** A
**Libraries:** —

---

## TD-11: Download Delivery

**Scope:** Backend

**Capability:** Download do vídeo pelo usuário

**Context:** Download must serve the original file as an attachment without loading the API with the transfer. It shares signing and endpoint rules with streaming (TD-06) but differs in response headers and expiry.

**Options:**

### Option A: Presigned GET with `ResponseContentDisposition=attachment`
- `GET /videos/:slug/download` authorizes and returns (or 302 to) a presigned GET that forces a download filename.
- **Pros:** API off the byte path; same signing code as streaming; nothing to proxy.
- **Cons:** the filename comes from the signed header, so the API must sanitize the title used for it.

### Option B: API proxies the download
- **Pros:** full control of headers and per-download accounting.
- **Cons:** the API carries up to 10GB per request; contradicts the phase goal.

**Recommendation:** Option A (presigned GET with attachment) - `GET /videos/:slug/download` applies the same slug and status checks as streaming and answers a 302 redirect to a presigned GET with `ResponseContentDisposition=attachment` and a sanitized filename, with a longer expiry than the stream URL.

**Decision:** A
**Libraries:** —

**Revisions:**
- 2026-10-19 - Wording corrected: the route resolves the slug and requires status `ready` before answering the 302; it performs no authentication because it is `@Public()` (TD-12, TD-16). Rationale: public routes carry no authenticated user.

---

## TD-12: Authorization and Video Visibility

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The plan requires an Authorization Matrix, and no earlier TD defines who may create, finish, see or fetch a video. The project allows anonymous viewing (`docs/project-plan.md`), uploads need an authenticated owner, the JWT guard is global (opt-out with `@Public()`), and each user has exactly one channel (1:1). Public/unlisted visibility is Fase 04.

**Options:**

### Option A: Owner-only mutations, public read of `ready` videos, 404 for everyone else
- Init, sign parts, complete and the detail/status read are owner-only (owner = the authenticated user's channel, resolved through the channels module). Stream and download are `@Public()` but only for `ready` videos. Videos in `draft`, `processing` or `error` are visible only to the owner; any other caller gets 404.
- **Pros:** matches anonymous viewing; no information leak about unfinished videos; simple to test.
- **Cons:** 404 instead of 403 hides existence but makes debugging slightly harder.

### Option B: Any authenticated user can read any status
- **Pros:** simplest.
- **Cons:** leaks drafts and failures of other channels.

### Option C: Owner-only reads for all states, authenticated only
- **Pros:** strictest.
- **Cons:** breaks anonymous watching, a stated product rule.

**Recommendation:** Option A (owner-only mutations, public ready) - Owner-only for init, parts, complete and detail; `@Public()` stream/download only for `ready`; non-owners and unknown ids get 404; the owner is resolved from user to channel through the channels module (single responsibility). Visibility settings (public/unlisted) are out of scope until Fase 04.

**Decision:** A
**Libraries:** —

---

## TD-13: Video Data Model

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The enunciado fixes the minimum persistence: identification, owner channel, title, status, storage keys (file and thumbnail), duration and metadata, and the unique URL identifier. The exact model is cited by the entity, the migration, the service, the worker and the API contracts.

**Options:**

### Option A: Typed columns for known fields plus one `jsonb` for the rest of the ffprobe metadata
- Table `videos`: `id` uuid PK; `channel_id` FK to channels (`ON DELETE RESTRICT`, since no channel-deletion flow exists and it avoids orphaned objects); `title` (optional at init, defaults to the sanitized original filename); `slug` unique; `status` (`draft | processing | ready | error`); `upload_id`; `original_key`; `thumbnail_key` nullable; `size_bytes` bigint; `mime_type`; `duration_seconds` nullable numeric; `metadata` nullable jsonb; `failure_reason` nullable; timestamps.
- **Pros:** queryable core fields, flexible metadata, matches the enunciado list.
- **Cons:** jsonb shape is not enforced by the database.

### Option B: Fully normalized metadata table (streams as rows)
- **Pros:** strict schema.
- **Cons:** over-engineered for this phase.

### Option C: Single `jsonb` blob for all processing output
- **Pros:** least migration churn.
- **Cons:** duration cannot be indexed or sorted without extraction.

**Recommendation:** Option A (typed columns plus jsonb) - Table `videos`: `id` uuid PK; `channel_id` FK to channels (`ON DELETE RESTRICT`, no channel-deletion flow exists and it avoids orphaned objects); `title` (optional at init, defaults to the sanitized original filename); `slug` with a unique index; `status` as a database enum (`draft | processing | ready | error`); `upload_id`; `original_key`; `thumbnail_key` nullable; `size_bytes` bigint; `mime_type`; `duration_seconds` nullable numeric; `metadata` nullable jsonb (rest of the ffprobe output); `failure_reason` nullable; timestamps. `channel_id` is resolved through the channels module rather than a direct query on another domain's table.

**Decision:** A
**Libraries:** —

---

## TD-14: Storage and Queue Configuration and Bootstrap

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage and queue add runtime configuration cited in several places at once (Joi schema, `.env.example`, `compose.yaml`, tests): endpoints, credentials, bucket, limits, expiries and Redis. A one-command `docker compose up` must also leave a usable bucket. The image entrypoint of the pinned MinIO build decides which healthcheck is possible, and that is checked at plan-resolve.

**Options:**

### Option A: Namespaced `storage.config.ts` and `queue.config.ts`, with the app ensuring the bucket at startup
- Keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `UPLOAD_MAX_BYTES`, presign expiries for part, stream and download, `REDIS_HOST` (Compose service name), `REDIS_PORT`, `VIDEO_QUEUE_NAME`, validated by Joi. A storage module calls HeadBucket then CreateBucket on startup (idempotent).
- **Pros:** follows the Phase 01 config convention; no extra container; works on a fresh clone.
- **Cons:** the app needs bucket-create permission on the storage credentials.

### Option B: A one-shot init container (`mc`) creates the bucket
- **Pros:** keeps app credentials narrower.
- **Cons:** extra image and ordering in Compose; harder to run in tests.

### Option C: Manual bucket creation documented in the README
- **Pros:** nothing to build.
- **Cons:** breaks one-command startup and automated tests.

**Recommendation:** Option A (namespaced config, app ensures bucket) - Add `storage.config.ts` and `queue.config.ts` registered like the existing namespaces, validated by Joi and listed in `.env.example`. Storage keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `UPLOAD_MAX_BYTES` (10 GiB = 10737418240), presign expiries for part, stream, download and the worker's internal read, and `MINIO_API_CORS_ALLOW_ORIGIN` on the storage service. Queue keys: `REDIS_HOST` (Compose service name), `REDIS_PORT`, `VIDEO_QUEUE_NAME`. Redis image `redis:7` (BullMQ needs 6.2 or newer). A storage module ensures the bucket idempotently at startup (HeadBucket then CreateBucket). The published storage port that `S3_PUBLIC_ENDPOINT` points at, the MinIO digest and the Compose healthchecks for storage and Redis are settled at plan-resolve after checking the image entrypoint and user.

**Decision:** A
**Libraries:** —

**Revisions:**
- 2026-10-19 - Compose details resolved: Redis service `redis:7` with healthcheck `redis-cli ping`; the MinIO service has no healthcheck (the pinned image has no shell or curl), so dependents use `depends_on` with `service_started` and the bucket-ensure step retries until storage answers. Published ports: 9000 (S3 API, `S3_PUBLIC_ENDPOINT=http://localhost:9000`) and 9001 (console). The MinIO command is `server /data --console-address ":9001"`. Rationale: close OQ-2.

---

## TD-15: Test Topology for the Worker and Real Infrastructure

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The challenge requires real queue, storage and worker exercised by tests ("não mocke o que dá para testar de verdade"). Tests run inside `nestjs-api` (`docker compose exec nestjs-api npm test`), whose dev image (`node:25.6.0-slim`) has no FFmpeg, and a live worker container would consume jobs that tests enqueue.

**Options:**

### Option A: FFmpeg in the shared dev image; tests use their own queue name and run the processor in-process
- Install FFmpeg in `Dockerfile.dev` (used by both services). Tests set a dedicated `VIDEO_QUEUE_NAME`, so the worker container never takes test jobs, and boot the processor inside the Jest process against the real Redis and storage. The test video is generated with `ffmpeg -f lavfi -i testsrc` at test setup.
- **Pros:** real FFmpeg, queue and storage in tests; no dependence on the worker container; no fixture file to commit.
- **Cons:** FFmpeg increases the dev image size.

### Option B: Tests rely on the running worker container and poll the database
- **Pros:** closest to production topology.
- **Cons:** flaky timing; ties the suite to container state; job collisions with dev data.

### Option C: Mock the FFmpeg and storage calls
- **Pros:** fast, no extra tooling.
- **Cons:** violates the real-infrastructure testing rule.

**Recommendation:** Option A (shared FFmpeg image, isolated test queue) - Install the `ffmpeg` apt package in `Dockerfile.dev`, used by both services. Tests isolate themselves with a Jest setup file that sets `process.env.VIDEO_QUEUE_NAME` (and `S3_PUBLIC_ENDPOINT` for the signing override of TD-06) before the app modules load; dotenv does not override variables that are already set, so the worker container keeps its own `.env` values and never takes test jobs. Integration tests run the `VideoProcessor` in-process against the real Redis, storage and PostgreSQL, and generate the sample video with `ffmpeg -f lavfi -i testsrc`; the producer is exercised through e2e of the complete endpoint. Integration and e2e runs stay `--runInBand`.

**Decision:** A
**Libraries:** —

---

## TD-16: Upload and Playback API Contract Details

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Earlier TDs left forks that change the API Contracts and Error Catalog: when part URLs are signed, whether stream/download answer with a redirect or JSON, route identifiers, a status endpoint, and what a repeated `complete` does. A 10GB upload can outlive URLs that expire in minutes, and the enqueue is not atomic with the status update.

**Options:**

### Option A: Parts signed on demand, 302 for stream/download, idempotent complete, owner status endpoint
- `POST /videos/:id/parts` signs the requested part numbers on demand. Stream and download answer 302 to the presigned GET so a `<video src>` works directly. `POST /videos/:id/complete` on a video already `processing` re-enqueues (safe, job id = `videoId`) and returns 200; on `ready` or `error` it returns 409. `GET /videos/:id` (owner only) returns status and failure reason. Owner endpoints use `:id`; public endpoints use `:slug`. BullMQ keeps removal policies (`removeOnComplete`, `removeOnFail`) so a re-enqueue is accepted.
- **Pros:** URLs never expire mid-upload; recoverable if enqueue fails; direct playback.
- **Cons:** one more endpoint and a few more error cases.

### Option B: All part URLs signed at init, JSON responses with URLs
- **Pros:** fewer round trips.
- **Cons:** URLs can expire before the last part of a 10GB upload; the player needs an extra request.

### Option C: Long-lived URLs
- **Pros:** simplest client.
- **Cons:** longer window for leaked URLs.

**Recommendation:** Option A (on-demand parts, redirects, idempotent complete) - `POST /videos/:id/parts` signs the requested part numbers on demand (draft videos only). Stream and download answer 302 to the presigned GET so a `<video src>` works directly; these public routes carry no authenticated user, so a non-`ready` video is 404 for everyone including its owner, who reads status through `GET /videos/:id` (owner only, returns status and failure reason). `POST /videos/:id/complete` follows TD-04: on `processing` it only re-enqueues and returns 200; on `ready` or `error` it returns 409. Owner endpoints use `:id`; public endpoints use `:slug`. Error Catalog codes: `VIDEO_NOT_FOUND` (404: unknown id/slug, non-owner, or non-ready on public routes), `VIDEO_UPLOAD_TOO_LARGE` (400: declared size above 10 GiB), `VIDEO_INVALID_PART` (400: invalid part number or count), `VIDEO_UPLOAD_INCOMPLETE` (400: zero parts or part count differing from the declared one), `VIDEO_NOT_DRAFT` (409: parts requested on a non-draft video), `VIDEO_UPLOAD_EXPIRED` (409: NoSuchUpload and no object in storage), `VIDEO_ALREADY_FINALIZED` (409: complete on a `ready` or `error` video). The new endpoints are documented with `@nestjs/swagger` (302 responses included) and `openapi.json` is regenerated.

**Decision:** A
**Libraries:** —

---

## TD-17: Rate Limiting for Video Routes

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The Phase 02 throttler is registered as an `APP_GUARD` with a default of 10 requests per 60 seconds, which applies to every route in the application (the inherited phase-02-auth/TD-08 text says it is scoped to `AuthModule`, but an `APP_GUARD` is application-wide). A 10GB upload signs one URL batch per group of parts and the player re-requests stream URLs, so the default limit would answer 429 during a normal upload or playback.

**Options:**

### Option A: Skip the throttler on the high-frequency video routes, keep it on the write-once routes
- `@SkipThrottle()` on `POST /videos/:id/parts`, `GET /videos/:slug/stream` and `GET /videos/:slug/download`; the global limit stays on `POST /videos` and `POST /videos/:id/complete`.
- **Pros:** uploads and playback are not limited by the auth-oriented budget; abuse of the create and complete routes is still bounded.
- **Cons:** the part-signing route is unthrottled, so it relies on JWT auth and ownership checks.

### Option B: A named throttler with a higher limit for video routes
- **Pros:** every route keeps some limit.
- **Cons:** needs a per-route name and a chosen number that this phase has no evidence for.

### Option C: Leave the global limit
- **Pros:** no change.
- **Cons:** breaks large uploads and playback.

**Recommendation:** Option A (skip on high-frequency routes) - Apply `@SkipThrottle()` to the parts, stream and download routes and keep the global throttler on init and complete. Record the correction against phase-02-auth/TD-08: the throttler is application-wide, not scoped to the auth module.

**Decision:** A
**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Job Queue Technology | Option A (BullMQ on Redis, AOF + noeviction) | A |
| TD-02 | Repo-wide | S3-Compatible Storage Service for Compose | Option A (Chainguard MinIO pinned by digest, smoke-tested) | A |
| TD-03 | Backend | Large-File Upload Strategy (up to 10GB) | Option A (S3 multipart with presigned parts) | A |
| TD-04 | Backend | Upload Completion Trigger and Job Contract | Option A (explicit complete endpoint, `{ videoId }` payload) | A |
| TD-05 | Backend | Bucket and Object Key Layout | Option A (one bucket, `videos/{videoId}/...`) | A |
| TD-06 | Backend | Streaming Delivery | Option A (presigned GET, public endpoint for signing) | A |
| TD-07 | Backend | Unique Video URL Identifier | Option A (`crypto.randomBytes` base64url, unique index) | A |
| TD-08 | Backend | Worker Runtime and Topology | Option A (second Nest entrypoint, separate Compose service) | A |
| TD-09 | Backend | Media Extraction (Metadata and Thumbnail) | Option A (spawn ffprobe/ffmpeg on presigned URL) | A |
| TD-10 | Backend | Video Status Lifecycle and Failure Handling | Option A (retries, terminal `error` with reason) | A |
| TD-11 | Backend | Download Delivery | Option A (presigned GET with attachment disposition) | A |
| TD-12 | Backend | Authorization and Video Visibility | Option A (owner-only mutations, public ready, 404 otherwise) | A |
| TD-13 | Backend | Video Data Model | Option A (typed columns plus jsonb) | A |
| TD-14 | Backend | Storage and Queue Configuration and Bootstrap | Option A (namespaced config, app ensures bucket) | A |
| TD-15 | Backend | Test Topology for the Worker and Real Infrastructure | Option A (shared FFmpeg image, isolated test queue) | A |
| TD-16 | Backend | Upload and Playback API Contract Details | Option A (on-demand parts, redirects, idempotent complete) | A |
| TD-17 | Backend | Rate Limiting for Video Routes | Option A (skip on high-frequency routes) | A |
