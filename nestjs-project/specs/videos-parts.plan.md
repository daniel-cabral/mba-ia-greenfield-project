---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-parts.e2e-spec.ts
---

# POST /videos/:id/parts Test Plan

## Application Overview

The owner of a `draft` video asks for presigned `UploadPart` URLs for specific part numbers; the API signs on demand with the public storage endpoint. The route is excluded from the global throttler.

## Test Scenarios

### 1. Assinar partes sob demanda

**Setup:** truncate test DB tables in `beforeEach`; bootstrap `AppModule` with the `main.ts` global config; two confirmed users (owner and another user) with access tokens; owner creates a draft via POST /videos; real storage from Compose.

#### 1.1. owner-gets-presigned-part-urls

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos/:id/parts as the owner with `{ partNumbers: [1, 2] }`
    - expect: status 200
    - expect: body `parts` has two entries with `partNumber` 1 and 2 and a `url` whose host is the host of `S3_PUBLIC_ENDPOINT`
  2. PUT a small body to the first returned URL
    - expect: the response has an `ETag` header

#### 1.2. hide-video-from-non-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos/:id/parts as the other user
    - expect: status 404
    - expect: body `error` equals `VIDEO_NOT_FOUND`
  2. POST /videos/00000000-0000-0000-0000-000000000000/parts as the owner
    - expect: status 404 with `error` equal to `VIDEO_NOT_FOUND`

#### 1.3. reject-parts-for-non-draft

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. Set the video row to `processing` directly in the database
  2. POST /videos/:id/parts as the owner with `{ partNumbers: [1] }`
    - expect: status 409
    - expect: body `error` equals `VIDEO_NOT_DRAFT`

#### 1.4. reject-invalid-part-numbers

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos/:id/parts as the owner with `{ partNumbers: [] }`
    - expect: status 400 with `error` equal to `VIDEO_INVALID_PART` or `VALIDATION_ERROR`
  2. POST /videos/:id/parts as the owner with a part number greater than `partCount`
    - expect: status 400
    - expect: body `error` equals `VIDEO_INVALID_PART`

#### 1.5. parts-route-not-throttled

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. POST /videos/:id/parts as the owner 12 times within 60 seconds with `{ partNumbers: [1] }`
    - expect: none of the responses has status 429
