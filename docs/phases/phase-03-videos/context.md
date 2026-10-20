---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-19T22:00:00.161861200-03:00"
  docs/decisions/technical-decisions-videos.md: "2026-10-19T23:17:55.845650500-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-19T23:19:19.750558200-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-19T22:22:22.045042800-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-19T22:22:22.048078800-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-19T22:22:22.053079200-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-19T22:22:22.049079300-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-19T22:00:00.010143600-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None explicitly mentioned in this phase._

**Deferred subprojects:** _None._

**Sequencing notes:** "Depende de: Fase 01, Fase 02"

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta. Depende de: Fase 01.
- **Phase 04:** Gerenciamento de Vídeos e Canal. Depende de: Fase 02, Fase 03.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| videos/TD-01 | phase | Backend | Job Queue Technology | decided | A | bullmq, @nestjs/bullmq |
| videos/TD-02 | phase | Repo-wide | S3-Compatible Storage Service for Compose | decided | A | — |
|     └─ Last revision: 2026-10-19 - Pinned digest recorded: cgr.dev/chainguard/minio@sha256:2915cb406f38ed6ff… | | | | | | |
| videos/TD-03 | phase | Backend | Large-File Upload Strategy (up to 10GB) | decided | A | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| videos/TD-04 | phase | Backend | Upload Completion Trigger and Job Contract | decided | A | — |
| videos/TD-05 | phase | Backend | Bucket and Object Key Layout | decided | A | — |
| videos/TD-06 | phase | Backend | Streaming Delivery | decided | A | — |
|     └─ Last revision: 2026-10-19 - Wording corrected: the route resolves the slug and requires status ready before… | | | | | | |
| videos/TD-07 | phase | Backend | Unique Video URL Identifier | decided | A | — |
| videos/TD-08 | phase | Backend | Worker Runtime and Topology | decided | A | — |
| videos/TD-09 | phase | Backend | Media Extraction (Metadata and Thumbnail) | decided | A | — |
| videos/TD-10 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A | — |
| videos/TD-11 | phase | Backend | Download Delivery | decided | A | — |
|     └─ Last revision: 2026-10-19 - Wording corrected: the route resolves the slug and requires status ready before… | | | | | | |
| videos/TD-12 | phase | Backend | Authorization and Video Visibility | decided | A | — |
| videos/TD-13 | phase | Backend | Video Data Model | decided | A | — |
| videos/TD-14 | phase | Backend | Storage and Queue Configuration and Bootstrap | decided | A | — |
|     └─ Last revision: 2026-10-19 - Compose details resolved: Redis service redis:7 with healthcheck redis-cli ping;… | | | | | | |
| videos/TD-15 | phase | Backend | Test Topology for the Worker and Real Infrastructure | decided | A | — |
| videos/TD-16 | phase | Backend | Upload and Playback API Contract Details | decided | A | — |
| videos/TD-17 | phase | Backend | Rate Limiting for Video Routes | decided | A | — |

_Source files:_

- videos — `docs/decisions/technical-decisions-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | videos/TD-02, videos/TD-05, videos/TD-14 |
| Serviço de processamento em segundo plano (filas) | videos/TD-01, videos/TD-08, videos/TD-15 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | videos/TD-03, videos/TD-16, videos/TD-17 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | videos/TD-10, videos/TD-12, videos/TD-13 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | videos/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | videos/TD-09 |
| URL única por vídeo, sem conflito com outros vídeos | videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | videos/TD-06 |
| Download do vídeo pelo usuário | videos/TD-11 |

## Decisions Detail

### videos/TD-01

**Recommendation:** BullMQ with @nestjs/bullmq on a Redis Compose service: retries, exponential backoff and stalled-job recovery are built in, so it needs the least code in a NestJS 11 project and runs as a real queue service. Redis runs with AOF (`--appendonly yes`) and `maxmemory-policy noeviction` per the BullMQ production guide, with a named volume. One queue for video processing; its name comes from config.
**Libraries:** `bullmq`, `@nestjs/bullmq`

### videos/TD-02

**Recommendation:** Run MinIO from `cgr.dev/chainguard/minio` pinned by `@sha256:` digest, because the official MinIO images no longer resolve; this keeps exact MinIO S3 behavior for multipart, presigned URLs, Range and server-wide CORS. A mandatory integration smoke test (create bucket, multipart presigned upload, ListParts, Range GET, browser-origin CORS headers) detects any image swap, with SeaweedFS as fallback. The pull and the digest must be re-verified at plan-resolve because registry state is volatile.
**Libraries:** —

**Revisions:**
- 2026-10-19 - Pinned digest recorded: `cgr.dev/chainguard/minio@sha256:2915cb406f38ed6ff9634de0a3e4a9423e2dda06a6f1aca18f8c968aa37a01f6` (OCI index, linux/amd64 and linux/arm64, verified by registry inspection). Image facts from the manifest config: entrypoint `/usr/bin/minio`, user 65532, no shell. The Docker daemon was off during this check, so the real pull and the write permission of user 65532 on the data volume are verified by the storage smoke test during implementation; if the volume is not writable the Compose service sets `user: root`, and if the image fails entirely SeaweedFS is the fallback. Rationale: close OQ-1.

### videos/TD-03

**Recommendation:** `POST /videos` creates the draft row and calls CreateMultipartUpload; the client uploads parts directly to storage through presigned UploadPart URLs, so the API never touches the bytes. This is the S3 equivalent of the YouTube resumable model, is resumable and parallel, and stays within S3 limits (5 MiB minimum part, 10,000 parts). The API enforces the 10GB cap at init (declared size and part count) and re-verifies the real object size at completion.
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### videos/TD-04

**Recommendation:** `POST /videos/:id/complete` on a `draft` video lists the uploaded parts with ListParts (paginated), calls CompleteMultipartUpload, checks the HeadObject size against the 10GB cap, sets status `processing` and enqueues the job, in that order. Crash safety: if the row is still `draft` but ListParts fails with NoSuchUpload (the upload was completed before a crash), the service runs HeadObject on the original key and, if the object exists, continues with the status write and the enqueue; if it does not exist the call fails with a domain error. On a video already `processing`, only the enqueue is repeated and the S3 steps are skipped. Events/Messages: job name `video.process` on the queue named by `VIDEO_QUEUE_NAME`, payload `{ videoId }` (the worker reads object key and owner from PostgreSQL, so the message cannot drift from the database), producer `VideosService`, consumer `VideoProcessor` running only in the worker entrypoint, delivery at-least-once with an idempotent consumer (TD-10). Job id = `videoId`: a duplicate id is ignored while the previous job still exists.
**Libraries:** —

### videos/TD-05

**Recommendation:** One bucket named by config (`S3_BUCKET`) with keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`, built from the immutable database id (not the filename or the public slug). Original keys are written once and never renamed; the extension is not part of the key (content type is stored on the object and in the video row). Abandoned multipart uploads are expired by the storage service (see TD-10).
**Libraries:** —

### videos/TD-06

**Recommendation:** `GET /videos/:slug/stream` authorizes, checks the status, then answers a 302 redirect (TD-16) to a short-lived presigned GET, so storage serves Range (206) directly and the API stays off the byte path. Signing uses `S3_PUBLIC_ENDPOINT`; the API's own storage calls use `S3_ENDPOINT`. In real-infra tests the signing endpoint is overridden to the internal one, and one assertion checks that the production config signs with the public host. Expiry is a few minutes.
**Libraries:** —

**Revisions:**
- 2026-10-19 - Wording corrected: the route resolves the slug and requires status `ready` before answering the 302; it performs no authentication because it is `@Public()` (TD-12, TD-16). Rationale: public routes carry no authenticated user.

### videos/TD-07

**Recommendation:** Generate 8 random bytes encoded as an 11-character base64url slug with `crypto.randomBytes`, stored in a unique-indexed `slug` column and retried on collision. It avoids the ESM-only `nanoid` friction with Jest in this CommonJS project. The slug is a separate column: not the primary key and not part of storage keys (TD-05).
**Libraries:** —

### videos/TD-08

**Recommendation:** The worker is a Nest standalone application context started from a second entrypoint (`src/worker.ts`) by a `start:worker` script (`nest start --entryFile worker` in dev), in a Compose service `nestjs-worker` built from the same code and image, so entities, repositories and config are reused. The `VideoProcessor` is registered only in the worker's module, never in the API's `VideosModule`. The service sets `command: npm run start:worker`, `depends_on` db, redis and storage, and a restart policy; dependencies must already be installed (`docker compose exec nestjs-api npm install`, same as the API). Starting the worker is the documented exception to the project rule of not starting the Nest app unprompted, because Compose runs it as a service. FFmpeg is installed once in the shared dev image (see TD-15).
**Libraries:** —

### videos/TD-09

**Recommendation:** The worker spawns `ffprobe` (JSON output) and `ffmpeg` with `child_process`, reading the input over HTTP from a URL signed with the internal endpoint, so a 10GB file is not downloaded; one frame is extracted and uploaded to the thumbnail key. Downloading to temp disk first is the documented fallback if HTTP input proves flaky in integration tests. The frame-selection rule (a fixed offset or a proportion of the duration, clamped for short videos) is a plan-build detail. A file with no video stream is a permanent failure and ends in `error`.
**Libraries:** —

### videos/TD-10

**Recommendation:** Statuses: `draft` (row created at init), `processing` (set at completion), `ready` (worker success), `error` (final failure). The queue uses `attempts: 3` with exponential backoff; permanent failures (for example no video stream) skip retries via BullMQ `UnrecoverableError`. `error` plus `failure_reason` is written by the worker `failed` listener when the last attempt fails or an `UnrecoverableError` is raised, so jobs that fail by stalling past `maxStalledCount` also end in `error`, not only exceptions thrown inside the processor. Job options: `removeOnComplete: true` and `removeOnFail` kept by age so failures stay inspectable. Transitions are guarded in the service. The consumer is idempotent: a job that finds the video already `ready` exits. Stale multipart uploads expire in storage (MinIO `MINIO_API_STALE_UPLOADS_EXPIRY`, default 24h; AWS lifecycle `AbortIncompleteMultipartUpload`).
**Libraries:** —

### videos/TD-11

**Recommendation:** `GET /videos/:slug/download` applies the same slug and status checks as streaming and answers a 302 redirect to a presigned GET with `ResponseContentDisposition=attachment` and a sanitized filename, with a longer expiry than the stream URL.
**Libraries:** —

**Revisions:**
- 2026-10-19 - Wording corrected: the route resolves the slug and requires status `ready` before answering the 302; it performs no authentication because it is `@Public()` (TD-12, TD-16). Rationale: public routes carry no authenticated user.

### videos/TD-12

**Recommendation:** Owner-only for init, parts, complete and detail; `@Public()` stream/download only for `ready`; non-owners and unknown ids get 404; the owner is resolved from user to channel through the channels module (single responsibility). Visibility settings (public/unlisted) are out of scope until Fase 04.
**Libraries:** —

### videos/TD-13

**Recommendation:** Table `videos`: `id` uuid PK; `channel_id` FK to channels (`ON DELETE RESTRICT`, no channel-deletion flow exists and it avoids orphaned objects); `title` (optional at init, defaults to the sanitized original filename); `slug` with a unique index; `status` as a database enum (`draft | processing | ready | error`); `upload_id`; `original_key`; `thumbnail_key` nullable; `size_bytes` bigint; `mime_type`; `duration_seconds` nullable numeric; `metadata` nullable jsonb (rest of the ffprobe output); `failure_reason` nullable; timestamps. `channel_id` is resolved through the channels module rather than a direct query on another domain's table.
**Libraries:** —

### videos/TD-14

**Recommendation:** Add `storage.config.ts` and `queue.config.ts` registered like the existing namespaces, validated by Joi and listed in `.env.example`. Storage keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `UPLOAD_MAX_BYTES` (10 GiB = 10737418240), presign expiries for part, stream, download and the worker's internal read, and `MINIO_API_CORS_ALLOW_ORIGIN` on the storage service. Queue keys: `REDIS_HOST` (Compose service name), `REDIS_PORT`, `VIDEO_QUEUE_NAME`. Redis image `redis:7` (BullMQ needs 6.2 or newer). A storage module ensures the bucket idempotently at startup (HeadBucket then CreateBucket). The published storage port that `S3_PUBLIC_ENDPOINT` points at, the MinIO digest and the Compose healthchecks for storage and Redis are settled at plan-resolve after checking the image entrypoint and user.
**Libraries:** —

**Revisions:**
- 2026-10-19 - Compose details resolved: Redis service `redis:7` with healthcheck `redis-cli ping`; the MinIO service has no healthcheck (the pinned image has no shell or curl), so dependents use `depends_on` with `service_started` and the bucket-ensure step retries until storage answers. Published ports: 9000 (S3 API, `S3_PUBLIC_ENDPOINT=http://localhost:9000`) and 9001 (console). The MinIO command is `server /data --console-address ":9001"`. Rationale: close OQ-2.

### videos/TD-15

**Recommendation:** Install the `ffmpeg` apt package in `Dockerfile.dev`, used by both services. Tests isolate themselves with a Jest setup file that sets `process.env.VIDEO_QUEUE_NAME` (and `S3_PUBLIC_ENDPOINT` for the signing override of TD-06) before the app modules load; dotenv does not override variables that are already set, so the worker container keeps its own `.env` values and never takes test jobs. Integration tests run the `VideoProcessor` in-process against the real Redis, storage and PostgreSQL, and generate the sample video with `ffmpeg -f lavfi -i testsrc`; the producer is exercised through e2e of the complete endpoint. Integration and e2e runs stay `--runInBand`.
**Libraries:** —

### videos/TD-16

**Recommendation:** `POST /videos/:id/parts` signs the requested part numbers on demand (draft videos only). Stream and download answer 302 to the presigned GET so a `<video src>` works directly; these public routes carry no authenticated user, so a non-`ready` video is 404 for everyone including its owner, who reads status through `GET /videos/:id` (owner only, returns status and failure reason). `POST /videos/:id/complete` follows TD-04: on `processing` it only re-enqueues and returns 200; on `ready` or `error` it returns 409. Owner endpoints use `:id`; public endpoints use `:slug`. Error Catalog codes: `VIDEO_NOT_FOUND` (404: unknown id/slug, non-owner, or non-ready on public routes), `VIDEO_UPLOAD_TOO_LARGE` (400: declared size above 10 GiB), `VIDEO_INVALID_PART` (400: invalid part number or count), `VIDEO_UPLOAD_INCOMPLETE` (400: zero parts or part count differing from the declared one), `VIDEO_NOT_DRAFT` (409: parts requested on a non-draft video), `VIDEO_UPLOAD_EXPIRED` (409: NoSuchUpload and no object in storage), `VIDEO_ALREADY_FINALIZED` (409: complete on a `ready` or `error` video). The new endpoints are documented with `@nestjs/swagger` (302 responses included) and `openapi.json` is regenerated.
**Libraries:** —

### videos/TD-17

**Recommendation:** Apply `@SkipThrottle()` to the parts, stream and download routes and keep the global throttler on init and complete. Record the correction against phase-02-auth/TD-08: the throttler is application-wide, not scoped to the auth module.
**Libraries:** —

## Inherited Decisions Detail

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) - Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) - First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable - env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) - The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) - Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id - For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) - The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation - custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) - Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) - Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) - Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) - This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) - Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low - two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) - Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) - Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation - JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A - The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority - Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** - `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip - Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one - tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) - adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** - works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** - the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** - `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** - `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** - Phase 02 sets the precedent for Phases 03-07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes - A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** - the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** - the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** - the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** - confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) - both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories - one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOpt... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI conte... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory - never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase - UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase - logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase - `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada - the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only (no unit tests) |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
