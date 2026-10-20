---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos-complete.e2e-spec.ts
---

# POST /videos/:id/complete Test Plan

## Application Overview

The owner finalizes the multipart upload: the API lists the parts, completes the upload in storage, checks the size, moves the video to `processing` and enqueues `video.process`. The route is safe against a crash between storage completion and the status write, and repeatable.

## Test Scenarios

### 1. Finalizar upload e enfileirar

**Setup:** truncate test DB tables in `beforeEach`; bootstrap `AppModule` with the `main.ts` global config; isolated test queue name from the Jest setup file; owner and another user with access tokens; owner creates a draft and uploads parts through presigned URLs; real storage, Redis and PostgreSQL from Compose; no worker consuming the test queue.

#### 1.1. complete-moves-to-processing-and-enqueues

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. Upload all parts of a small file (single part is enough) to the presigned URLs
  2. POST /videos/:id/complete as the owner
    - expect: status 200
    - expect: body `{ id, status: "processing" }`
    - expect: the row has `status = processing`
    - expect: the test queue holds a `video.process` job with `jobId` equal to the video id and payload `{ videoId }`

#### 1.2. repeated-complete-is-idempotent

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos/:id/complete as the owner twice in a row
    - expect: both responses have status 200
    - expect: the queue still holds exactly one job for that video id

#### 1.3. reject-complete-on-finalized-video

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. Set the video row to `ready` (then to `error`) directly in the database
  2. POST /videos/:id/complete as the owner
    - expect: status 409
    - expect: body `error` equals `VIDEO_ALREADY_FINALIZED`

#### 1.4. reject-complete-without-parts

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. Create a draft and upload no part
  2. POST /videos/:id/complete as the owner
    - expect: status 400
    - expect: body `error` equals `VIDEO_UPLOAD_INCOMPLETE`

#### 1.5. recover-from-crash-after-storage-complete

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. Upload parts and complete the multipart upload directly in storage, leaving the video row in `draft`
  2. POST /videos/:id/complete as the owner
    - expect: status 200
    - expect: the row moves to `processing` and the job is enqueued

#### 1.6. expired-upload-without-object

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. Abort the multipart upload directly in storage so no upload and no object exist; leave the row in `draft`
  2. POST /videos/:id/complete as the owner
    - expect: status 409
    - expect: body `error` equals `VIDEO_UPLOAD_EXPIRED`

#### 1.7. hide-video-from-non-owner

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos/:id/complete as the other user
    - expect: status 404
    - expect: body `error` equals `VIDEO_NOT_FOUND`
