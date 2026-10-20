# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (BullMQ on Redis) → video processing job queue (`video.process`)
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos (Phase 03, backend)

Videos are uploaded by the browser straight to object storage with an S3 multipart upload; the API only coordinates and never carries file bytes. The code lives in:

- `nestjs-project/src/videos/` - `videos.controller.ts` (routes), `videos.service.ts` (upload session, ownership, completion, playback URLs, status transitions), `entities/video.entity.ts`, `dto/`, `video.processor.ts` (queue consumer), `media-extraction.service.ts` (ffprobe/ffmpeg over a signed URL), `slug.util.ts`, `filename.util.ts`, `download-filename.util.ts`, `frame-time.util.ts`.
- `nestjs-project/src/storage/` - `StorageService`: two S3 clients (internal endpoint for API/worker calls, public endpoint only to sign browser URLs), multipart operations, bucket ensure at startup.
- `nestjs-project/src/queue/` - `QueueModule` (BullMQ), job name `video.process`, payload `{ videoId }`, `jobId` = video id, 3 attempts with exponential backoff.
- `nestjs-project/src/worker.ts` and `nestjs-project/src/worker.module.ts` - the worker entrypoint (standalone Nest context, no HTTP); the `VideoProcessor` is registered only here. Runs as the `nestjs-worker` Compose service.
- `nestjs-project/src/config/root-modules.ts` - config and database root modules shared by `AppModule` and `WorkerModule`.
- `nestjs-project/src/database/migrations/1792489888882-CreateVideos.ts` - the `videos` table and `video_status` enum.
- `nestjs-project/test/videos-flow.e2e-spec.ts` (and the other `nestjs-project/test/videos-*.e2e-spec.ts`) with the test plans in `nestjs-project/specs/`.

Endpoints (contract in `nestjs-project/openapi.json`):

| Route | Access | Behavior |
|-------|--------|----------|
| `POST /videos` | authenticated | Creates a `draft` in the caller's channel and opens the multipart upload |
| `POST /videos/:id/parts` | owner | Signs part URLs on demand; `@SkipThrottle()` |
| `POST /videos/:id/complete` | owner | ListParts, CompleteMultipartUpload, size check, `processing`, enqueue; crash-safe and repeatable |
| `GET /videos/:id` | owner | Status, duration and `failureReason` |
| `GET /videos/:slug/stream` | public, `ready` only | `302` to a presigned GET (Range served by storage); `@SkipThrottle()` |
| `GET /videos/:slug/download` | public, `ready` only | `302` to a presigned GET with an attachment disposition; `@SkipThrottle()` |

Rules to keep:

- Status flow is `draft` -> `processing` -> `ready` | `error`, written with guarded updates (`WHERE status = 'processing'`). Non-owners and unknown ids get `404 VIDEO_NOT_FOUND`; non-`ready` videos are `404` on public routes, even for the owner.
- Storage keys are `videos/{id}/original` and `videos/{id}/thumbnail.jpg`, built from the database id, never from the file name or slug.
- Presigned URLs bind to the host that signed them: browser URLs use `S3_PUBLIC_ENDPOINT`, worker reads use `S3_ENDPOINT`.
- `@nestjs/bullmq` is pinned to 11.x because 12.x is ESM-only and the project (and Jest) is CommonJS; `ioredis` is a direct dependency (bullmq 6 does not bundle it).
- Decisions for this phase are in `docs/decisions/technical-decisions-phase-03-videos.md`; plan and progress are in `docs/phases/phase-03-videos/`.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.