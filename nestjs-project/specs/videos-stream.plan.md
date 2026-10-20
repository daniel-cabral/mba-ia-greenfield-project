---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: nestjs-project/test/videos-stream.e2e-spec.ts
---

# GET /videos/:slug/stream Test Plan

## Application Overview

Public streaming entrypoint: for a `ready` video the API answers a 302 to a short-lived presigned GET, so storage serves the bytes with Range (206). Any other status, and unknown slugs, answer 404 for everyone, including the owner. The route is excluded from the global throttler.

## Test Scenarios

### 1. Redirecionar para a URL assinada de streaming

**Setup:** truncate test DB tables in `beforeEach`; bootstrap `AppModule` with the `main.ts` global config; a `ready` video whose original object exists in real storage (small generated file) and videos in `draft`, `processing` and `error`; signing endpoint overridden to the internal storage endpoint so the test process can follow the URL.

#### 1.1. ready-video-redirects-to-presigned-url

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/:slug/stream without authentication for the `ready` video, without following redirects
    - expect: status 302
    - expect: `Location` is a presigned storage URL for `videos/{id}/original`

#### 1.2. presigned-url-serves-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET the `Location` URL with header `Range: bytes=0-99`
    - expect: status 206
    - expect: header `Content-Range` is present

#### 1.3. non-ready-video-is-not-found-even-for-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/:slug/stream for the `draft`, `processing` and `error` videos, once anonymously and once with the owner's token
    - expect: every response has status 404
    - expect: body `error` equals `VIDEO_NOT_FOUND`

#### 1.4. unknown-slug-is-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/unknownslug/stream
    - expect: status 404
    - expect: body `error` equals `VIDEO_NOT_FOUND`

#### 1.5. stream-route-not-throttled

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/:slug/stream for the `ready` video 12 times within 60 seconds
    - expect: none of the responses has status 429
