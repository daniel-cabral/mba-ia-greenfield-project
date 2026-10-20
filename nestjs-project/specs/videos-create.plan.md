---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

Authenticated owner starts an upload: the API creates a `draft` video in the caller's channel and opens an S3 multipart upload, without carrying any bytes. Error bodies follow `{ statusCode, error, message }`.

## Test Scenarios

### 1. Criar rascunho e abrir upload

**Setup:** truncate test DB tables (`videos`, `channels`, `users`, `auth_tokens`) in `beforeEach`; bootstrap `AppModule` with the `main.ts` global config (ValidationPipe, filters); register and log in a confirmed user to obtain an access token; real storage and Redis from Compose.

#### 1.1. create-draft-returns-upload-session

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos with the access token and body `{ filename: "clip.mp4", size: 10485760, contentType: "video/mp4" }`
    - expect: status 201
    - expect: body has `id` (uuid), `slug` of 11 characters, `status: "draft"`, `uploadId`, `partSize` equal to `UPLOAD_PART_SIZE_BYTES` and `partCount` equal to `ceil(size / partSize)`
    - expect: the `videos` table has one row for `id` with `status = draft` and `channel_id` equal to the caller's channel
    - expect: the storage lists an open multipart upload for key `videos/{id}/original`

#### 1.2. title-defaults-to-filename

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos with the access token and body `{ filename: "my clip.mp4", size: 1024, contentType: "video/mp4" }` without `title`
    - expect: status 201
    - expect: the stored row has `title` equal to the sanitized filename

#### 1.3. reject-size-above-cap

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos with `size: 10737418241`
    - expect: status 400
    - expect: body `error` equals `VIDEO_UPLOAD_TOO_LARGE`
    - expect: no row is created in `videos`

#### 1.4. reject-non-video-content-type

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos with `contentType: "image/png"`
    - expect: status 400
    - expect: body `error` equals `VALIDATION_ERROR`

#### 1.5. require-authentication

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos without an Authorization header
    - expect: status 401
