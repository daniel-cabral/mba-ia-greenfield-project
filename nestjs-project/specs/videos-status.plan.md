---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: nestjs-project/test/videos-status.e2e-spec.ts
---

# GET /videos/:id Test Plan

## Application Overview

Owner-only status read: the only way an owner sees a video that is not yet `ready`, including the failure reason. Non-owners and unknown ids get the same 404.

## Test Scenarios

### 1. Consultar status do vídeo

**Setup:** truncate test DB tables in `beforeEach`; bootstrap `AppModule` with the `main.ts` global config; owner and another user with access tokens; videos inserted directly in the database in each status; PostgreSQL from Compose.

#### 1.1. owner-reads-status

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/:id as the owner for a `draft` video
    - expect: status 200
    - expect: body has `id`, `slug`, `title`, `status: "draft"`, `durationSeconds: null`, `failureReason: null` and `createdAt`

#### 1.2. owner-sees-failure-reason

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/:id as the owner for a video with `status = error` and a stored `failure_reason`
    - expect: status 200
    - expect: body `status` equals `error` and `failureReason` equals the stored text

#### 1.3. hide-video-from-non-owner-and-unknown-id

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/:id as the other user
    - expect: status 404 with `error` equal to `VIDEO_NOT_FOUND`
  2. GET /videos/00000000-0000-0000-0000-000000000000 as the owner
    - expect: status 404 with `error` equal to `VIDEO_NOT_FOUND`

#### 1.4. require-authentication

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/:id without an Authorization header
    - expect: status 401
