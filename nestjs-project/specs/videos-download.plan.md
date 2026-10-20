---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: nestjs-project/test/videos-download.e2e-spec.ts
---

# GET /videos/:slug/download Test Plan

## Application Overview

Public download entrypoint: for a `ready` video the API answers a 302 to a presigned GET that forces an attachment with a sanitized filename. Other statuses and unknown slugs answer 404. The route is excluded from the global throttler.

## Test Scenarios

### 1. Redirecionar para a URL assinada de download

**Setup:** truncate test DB tables in `beforeEach`; bootstrap `AppModule` with the `main.ts` global config; a `ready` video whose original object exists in real storage, a second `ready` video with an unsafe title, and videos in other statuses; signing endpoint overridden to the internal storage endpoint so the test process can follow the URL.

#### 1.1. ready-video-redirects-with-attachment-disposition

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/:slug/download without authentication for the `ready` video, without following redirects
    - expect: status 302
    - expect: `Location` contains `response-content-disposition`

#### 1.2. presigned-url-returns-attachment

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET the `Location` URL
    - expect: status 200
    - expect: header `Content-Disposition` starts with `attachment`

#### 1.3. unsafe-title-is-sanitized

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/:slug/download for the video whose title contains slashes and double quotes, then GET the `Location` URL
    - expect: the `Content-Disposition` filename contains no `/`, `\` or `"` characters

#### 1.4. non-ready-or-unknown-is-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-20T02:30:30Z

**Steps:**
  1. GET /videos/:slug/download for a `draft` video and for an unknown slug
    - expect: status 404 for both
    - expect: body `error` equals `VIDEO_NOT_FOUND`
