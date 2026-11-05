# Owned creative runtime (W&W `CreativeProviderRuntime` over HTTP)

Status: implemented. It has run against FAKE providers only: no live call, no paid call and no hosted storage. No kind is qualified, and every kind is **OFF** by default. This document does not claim qualification.

The runtime is the server side of the `CreativeProviderRuntime` port in `.design-preview/ww-creative-worker-contract/creative-job-worker.ts`. W&W (0119) owns the job, the ledger, confirmation, authority, spend and scheduling. This side owns four things:

- the provider keys
- a private scratch bucket
- one durable row per W&W call key, which makes sure a call is sent at most once
- the retained intermediate and final bytes

There is no queue, no Temporal workflow and no scheduler here. Nothing in this runtime calls the next stage.

## Files

| File | Role |
| --- | --- |
| `libraries/nestjs-libraries/src/database/prisma/managed/managed.creative.contracts.ts` | Pure. Holds the closed `ww.creative-job.v1` input (zod, mirrors W&W), the stage map, item rules, call keys, handle parsing, answer shapes, qualification and exceptions. |
| `libraries/nestjs-libraries/src/managed-creative/creative.scratch.ts` | The private R2 scratch bucket: path-style, create-only, no ACL, signs by key only. Also the scratch key set. |
| `libraries/nestjs-libraries/src/managed-creative/creative.runtime.ts` | Composes the existing adapters: `prepare` / `send`, `poll`, `readArtifact`, `retainSource`, `voices`, the strict transcript reader and the env factory. Has no Prisma. |
| `libraries/nestjs-libraries/src/database/prisma/managed/managed.creative.repository.ts` | Prisma only. Every query is scoped to the organization. Rows leave `DISPATCHING` only through conditional updates. |
| `libraries/nestjs-libraries/src/database/prisma/managed/managed.creative.service.ts` | Runs the call gate, job binding, polls, artifact reads, source transfer and voices. |
| `libraries/nestjs-libraries/src/dtos/managed/managed.creative.dto.ts` | Request DTOs. |
| `apps/backend/src/managed-api/managed.creative.controller.ts` | The routes below. |
| `schema.prisma` | `ManagedCreativeJob`, `ManagedCreativeCall`, `ManagedCreativeObject` (additive). |
| Specs | `managed-creative/__tests__/creative.runtime.spec.ts`, `prisma/managed/__tests__/managed.creative.service.spec.ts`, fakes in `managed-creative/__tests__/fakes/creative.runtime.fakes.ts` |

Integration edits:

- `creative:run` is appended to `MANAGED_SCOPES`.
- `ManagedCreativeController`, `ManagedCreativeRepository`, `ManagedCreativeService` and `...managedCreativeProviders` are added to `managed.api.module.ts`.

No provider adapter, workflow or existing route was changed.

## Access

Every condition is read on every request. The defaults (all unset) enable nothing.

- Requests go through the same `ThrottlerManagedCredentialGuard` / `ManagedScopeGuard` and the shared 200 requests per hour per organization as every other managed route.
- The credential must hold **exactly** `creative:run`. A credential that holds any other scope as well is refused (`403 CREATIVE_CREDENTIAL_NOT_DEDICATED`), and nothing is recorded for it.
- `POSTIZ_MANAGED_CREATIVE_ORGANIZATIONS` must list the credential's organization (comma-separated). The organization must also be a managed organization.
- `POSTIZ_MANAGED_CREATIVE_EXPIRES_AT` is required. It must not be later than `2026-11-10T23:00:00.000Z`, and the end is exclusive.
- `POSTIZ_MANAGED_CREATIVE_KINDS` lists the live kinds: any of `image`, `video.seedance`, `video.image_text_slides`, `clipping`. It is empty by default.

## HTTP contract (`ww.creative-runtime.v1`)

All routes are under `/managed/v1/creative` and use `Authorization: Bearer <creative credential>`. JSON bodies use the DTOs with `whitelist` and `forbidNonWhitelisted`. Every response sets `Cache-Control: no-store`. Refusals have the body `{ code, msg }`.

### `PUT /jobs/:jobId` binds a job

```jsonc
// request
{ "version": "ww.creative-runtime.v1", "tenantId": "<uuid>", "workspaceId": "<uuid>", "input": <CreativeJobInput> }
// 200
{ "jobId": "<uuid>", "kind": "image|video.seedance|video.image_text_slides|clipping", "inputSha256": "<64 hex>" }
```

- The first request that names `(organization, jobId)` binds the W&W tenant, the workspace and the canonical input. Those can never change afterwards.
- Repeating the same binding answers the same.
- A different binding gets `409 CREATIVE_JOB_BINDING_MISMATCH`. An input outside the closed schema gets `400 CREATIVE_INPUT_INVALID`.
- Calls bind implicitly in the same way. This route is only needed before a source transfer.

### `PUT /jobs/:jobId/sources/:assetId/versions/:version` transfers a Seedance source

- Headers: `Content-Type: application/octet-stream`, `Content-Length` (1 to 20 MiB) and `X-WW-Source-Sha256: <64 hex>`. The body is the exact bytes.
- The job must be bound and of kind `video.seedance`. `(assetId, version, sha256)` must be one of the input's `sourceAssets`. Otherwise the answer is `422 CREATIVE_SOURCE_NOT_DECLARED`.
- The bytes must hash to the declared digest (`422 CREATIVE_SOURCE_DIGEST_MISMATCH`). They must be PNG, JPEG or WebP by signature (`422 CREATIVE_SOURCE_INVALID`).
- The bytes are stored create-only at `ww-<op>-source-<slot>.<ext>` and pinned (asset id, version, digest).
- `200 { jobId, assetId, version, sha256, byteLength, contentType }`. Once a source is retained, the same request answers the same receipt without reading the body.
- `video.submit` stays `not_sent SOURCE_NOT_RETAINED` until every declared source has been transferred.
- **Asset ids are never resolved to URLs.** Only these transferred bytes reach Evolink, through signed scratch URLs.

### `POST /calls` makes one billable call (one W&W ledger row)

```jsonc
// request = W&W CreativeCall + the binding fields
{ "version": "ww.creative-runtime.v1", "jobId": "<uuid>", "tenantId": "<uuid>", "workspaceId": "<uuid>",
  "input": <CreativeJobInput>, "stage": "<W&W stage>", "item": 0..10, "attempt": 1|2,
  "callKey": "<jobId>:<stage>:<item>:<attempt>",
  "assemblyId": "<32 hex>"            // slides.assemble only, and required there
}
// 200, exactly the W&W runtime port shapes:
{ "outcome": "completed", "result": null | { "slides": n } | { "clips": n } }      // sync stages
{ "outcome": "accepted", "handle": { "kind": "evolink", "taskId": "…" } }         // video.submit
{ "outcome": "accepted", "handle": { "kind": "runpod", "jobId": "…" } }           // clip.analyse / fetch / render
{ "outcome": "accepted" }                                                         // slides.assemble
{ "outcome": "not_sent" | "rejected" | "unknown", "code": "<A-Z0-9_>" }
```

Every outcome of a call that reached the handler, whether a refusal, a provider answer or an unknown, is a **200** in this shape. Only these never reach the gate and never send:

- `400`: DTO failure, or `callKey` is not `<jobId>:<stage>:<item>:<attempt>`
- `403`: the credential is not dedicated
- `409 CREATIVE_CALL_KEY_CONFLICT`: the same call key was recorded for a different request
- guard `401` / `403 SCOPE_MISSING` / `429`

`not_sent` is only answered when this side proves the request never left: a refusal before the gate, or an adapter's local refusal.

### `POST /polls` reads an owned handle

```jsonc
{ "version": "ww.creative-runtime.v1", "handle": <evolink|runpod|transloadit handle>,
  "call": { "stage": "clip.analyse|clip.fetch|clip.render", "item": n, "attempt": 1|2 } }   // RunPod only
// 200
{ "status": "running" } | { "status": "completed", "result": null | { "durationSeconds": n, "transcript": "auto|none|untrusted" } }
| { "status": "failed", "code": "…" } | { "status": "not_found" }
```

- The handle is looked up by `(organization, handleKey)`. A handle that no call of this organization recorded gets `404 CREATIVE_HANDLE_NOT_OWNED`. It is never sent to a provider.
- For RunPod, `call` must equal the recorded call, and the RunPod endpoint is the recorded one. A mismatch gets `400 CREATIVE_HANDLE_INVALID`.
- `completed` and `failed` are stored once and answered again without reading the provider.
- Evolink and Transloadit results are fetched from the configured result hosts and retained before `completed` is answered. A fetch that fails is reported as `running`, so the next poll tries again. A result over 20 MiB, or not an MP4, is `completed` with its artifact recorded as missing.

### `POST /artifacts/read` reads the final bytes

```jsonc
{ "version": "ww.creative-runtime.v1", "jobId": "<uuid>", "stage": "<final stage>", "item": n, "handle": <handle> | null }
```

- `200` with the bytes. `Content-Type` is `image/png`, `image/jpeg` or `video/mp4`, decided by signature. `X-WW-Artifact-Sha256` carries the digest.
- Or `200` JSON `{ "kind": "missing", "code": "…" }`. A JSON content type always means missing.
- The final stage is `image.generate`, `video.status`, `slides.assemble` or `clip.render`. Item 0, or the clip index for clipping (1 to 10).
- A handle must belong to this job.
- Only retained, digest-pinned scratch bytes up to 20 MiB are served. A rendered clip is pinned by its first read, and a changed object is missing. No URL and no provider payload is ever returned.

### `GET /voices`

`200 { "voices": [{ "id", "label" }] }`. This is ImagesSlides' fixed premade-voice read through `ElevenLabsVoicesAdapter`. It needs `video.image_text_slides` enabled. A failure gets `502 CREATIVE_VOICES_UNAVAILABLE`, and nothing is retried.

## Stage map (W&W → owned adapter stage)

| W&W stage | Owned stage | Provider request | Item | Result / handle | Prerequisite (else `not_sent`) |
| --- | --- | --- | --- | --- | --- |
| `image.generate` | `image.generate` | OpenAI images (no retries) | 0 | `completed null` + PNG retained | none |
| `video.submit` | `video.submit` | Evolink generation | 0 | `accepted {evolink}` | every source transferred (`SOURCE_NOT_RETAINED`) |
| `video.status` | (poll) | none, not callable | 0 | `STAGE_NOT_CALLABLE` on `/calls`; polled via `/polls` | n/a |
| `slides.script` | `slides.script` | OpenAI, once | 0 | `completed {slides 1..5}`; script kept private | none |
| `slides.image` | `slides.image` | Fal `ideogram/v2` | 1..n | `completed null`; image retained | script slide n (`SLIDE_NOT_SCRIPTED`) |
| `slides.speech` | `slides.speech` | ElevenLabs TTS | 1..n | `completed null`; mp3 + length retained | as above |
| `slides.assemble` | `slides.assemble` | Transloadit, under W&W's assembly id | 0 | `accepted` (handle recorded **before** sending) | every slide image + voice (`SLIDE_NOT_RETAINED`) |
| `clip.analyse` | `clipping.analyse` | RunPod ingest | 0, attempt 1/2 | `accepted {runpod}` → poll `{durationSeconds, transcript}` | attempt 2 only after `untrusted` (`ANALYSE_RETRY_NOT_DUE`); attempt 2 is audio-only |
| `clip.transcribe` | `clipping.transcribe` | Deepgram on the retained audio | 0 | `completed null`; transcript retained | latest analysis `none` (`TRANSCRIBE_NOT_DUE`) |
| `clip.pick` | `clipping.pick` | OpenAI `pickClips` | 0 | `completed {clips 0..clips}`; picks kept private | a usable, word-timed pinned transcript (`TRANSCRIPT_*`, `CAPTION_TIMING_UNAVAILABLE`) |
| `clip.fetch` | `clipping.clip_fetch` | RunPod ingest (clip window) | 1..clips | `accepted {runpod}` → poll `completed null` (`trimStart` kept) | picked clip n (`CLIP_NOT_PICKED`) |
| `clip.render` | `clipping.clip_render` | RunPod clipper | 1..clips | `accepted {runpod}` → poll `completed null` | fetched clip n (`CLIP_NOT_FETCHED`), pinned transcript unchanged and word-timed (`CAPTION_TIMING_UNAVAILABLE`) |

Notes:

- W&W items are 1-based. The owned slide and clip indexes are `item - 1`.
- The owned `clipping.clip_caption` (a Deepgram call per clip when captions are only timed by line) has **no W&W stage**, so it is never made. Instead, line-timed captions never get past the analysis. Burned-in captions always come from a word-timed transcript of the whole source: YouTube's own word-timed captions, or Deepgram on the audio. This differs from `ClippingService`, which selects on line-timed captions and transcribes each clip window.
- The analysis result is frozen as W&W validates it:
  - `durationSeconds = ceil(source seconds)`, within `1..maxSourceMinutes*60`. Otherwise the call fails with `DURATION_TOO_LONG`. The bound is checked first, so nothing is read for a source that is refused.
  - `auto` means the caption file RunPod wrote was read back from scratch and is the strict `ClippingTranscript` with `origin: 'auto_generated'` and `word_level: true`. That exact file is pinned (key, SHA-256, byte length) with the completed poll, so the selection and every render read the same bytes or refuse with `TRANSCRIPT_OBJECT_CHANGED`.
  - `none` means audio only, so transcribe next.
  - `untrusted` means analyse again for the audio alone. It covers the uploader's captions, and also automatic captions whose file is line-timed, absent, too large, not UTF-8 JSON, not the strict shape, or of another origin than RunPod reported. This uses the existing attempt 2 and `clip.transcribe`, so no extra paid stage and no per-clip call. Attempt 2 can only end `none`.
  - If the scratch bucket cannot be read (`read_failed`, or the read throws), the poll answers `running` and records nothing, so the next poll reads it again.
- `clip.render` refuses with `not_sent CAPTION_TIMING_UNAVAILABLE` when the pinned transcript is not word-timed. This can only happen with a transcript pinned before this check existed. A clip is never silently rendered without captions. A word-timed transcript with no words inside the clip is a span with no speech: it renders without captions, and the private intermediate records `captions: 'silent'` (otherwise `'words'`). `clip.pick` refuses the same line-timed transcript before the OpenAI call, so no selection is paid for clips that could not be captioned.
  - A RunPod "retryable" failure is recorded as `failed` (`ANALYSE_RETRYABLE`, `CLIP_FETCH_RETRYABLE`, `CLIP_RENDER_RETRYABLE`). W&W never sends a call again.
- `clip.pick` applies `ClippingService`'s selection rules (`selectClips`) and then the job's `clipSeconds` range. Zero kept clips is `completed {clips: 0}`.

## At most one send per call key

Per call, in this order:

1. Refuse anything that can never be sent: kind, stage, item, attempt, access, assembly id.
2. Bind the job.
3. Prepare every local input. This covers prerequisites, configuration, reading and validating retained transcripts and sources, and signing scratch URLs.
4. **Create the call row as `DISPATCHING`.** The unique key is `(organizationId, callKey)`. This is the only gate: only the request that created the row sends.
5. Make exactly one provider request.
6. Settle the row once (a conditional update from `DISPATCHING`) with the exact answer, the owned handle, private intermediates and the pinned objects, in one transaction.

What a replay or a failure gets:

| Situation | Answer |
| --- | --- |
| Replay of a settled call (same request hash) | The stored answer, exactly |
| Replay while the row is `DISPATCHING` (in flight, or the sender died or restarted) | `unknown CALL_OUTCOME_UNRECORDED` forever. Never re-sent. |
| Concurrent duplicate | Loses the create and gets the replay answer |
| The answer could not be settled | `unknown CALL_NOT_RECORDED`. The row stays `DISPATCHING`, so every replay agrees. |
| A thrown or lost provider answer | `unknown` |
| An output the runtime cannot use (bad PNG, too many slides, nothing usable) | `rejected` (held) |
| A paid output that could not be retained | `unknown OUTPUT_NOT_RETAINED` |
| Every refusal before the gate | Recorded as a `NOT_SENT` row, so a later replay can never turn into a send, even after the configuration changes |
| Same call key, different request | `409`, nothing sent |

- Under this policy, both source failures and transport failures count as ambiguous and sent unless they were proven local before sending.
- The Transloadit assembly id is recorded with `DISPATCHING`, so an assembly whose answer was lost is still polled by its id.
- The provider dispatch is not tied to the client connection: a call runs to its own deadline and is recorded, so a replay can learn the real answer.
- The rows hold no URL, signed URL, key or provider payload. They do hold provider-derived private text: the slide script, the picked clip titles and posts, and the source title.

## Private scratch storage

This uses its own R2 bucket and credentials. It is never the public `CLOUDFLARE_*` upload bucket: `CloudflareStorage.createObjectAt` writes `ACL: public-read`, so it was not reused.

- Writes are `PutObject` with `If-None-Match: *` and no ACL. An existing key is only adopted when its bytes are identical.
- Signed URLs (3 h, like `ClippingService`) are path-style on `<account>.r2.cloudflarestorage.com`. They are minted only for these keys of the job's own namespace (`op` = the job row id without dashes, so the same W&W job id in two organizations never shares keys):
  - `ww-<op>-transcript.json`, `-audio.ogg`, `-clip-<i>-source.mp4`, `-clip-<i>.mp4`, `-clip-<i>.jpg` (`managedScratchKeys`)
  - `ww-<op>-slide-<i>.jpg|.mp3` (`slideScratchKeys`)
  - `ww-<op>-image.png`, `-video.mp4`, `-slides.mp4`, `-transcribed.json`, `-source-<n>.<ext>`
- The adapters additionally refuse any URL that is not the signed URL of the exact expected key (`isScratchUrl`).
- Provider result URLs (Evolink video, Fal image, Transloadit video) are fetched only from the configured result hosts (`resultUrl`: HTTPS, default port, no IP or local name). They are never stored or returned.
- Nothing is deleted. Scratch objects persist until an operator removes them.

## Configuration (names only; secrets never in the repository)

| Variable | Needed for |
| --- | --- |
| `POSTIZ_MANAGED_CREATIVE_ORGANIZATIONS`, `POSTIZ_MANAGED_CREATIVE_KINDS`, `POSTIZ_MANAGED_CREATIVE_EXPIRES_AT` | Access (above) |
| `POSTIZ_MANAGED_CREATIVE_SCRATCH_ACCOUNT_ID` (32 hex), `_ACCESS_KEY`, `_SECRET_ACCESS_KEY`, `_BUCKET`, `_REGION` (default `auto`) | Every kind. Without it, every call is `not_sent SCRATCH_NOT_CONFIGURED`. |
| `OPENAI_API_KEY` | image, slides script, clip pick. Without it, no OpenAI adapter is built, because `OpenaiService` would otherwise send a placeholder key. |
| `EVOLINK_API_KEY` + `POSTIZ_MANAGED_CREATIVE_EVOLINK_RESULT_HOSTS` | Seedance |
| `FAL_KEY`, `ELEVENSLABS_API_KEY` (upstream spelling), `TRANSLOADIT_AUTH`, `TRANSLOADIT_SECRET`, `POSTIZ_MANAGED_CREATIVE_FAL_RESULT_HOSTS`, `POSTIZ_MANAGED_CREATIVE_TRANSLOADIT_RESULT_HOSTS` | Slides. `ELEVENSLABS_API_KEY` alone enables voices. |
| `RUNPOD_API_KEY`, `RUNPOD_INGEST_ENDPOINT_ID`, `RUNPOD_CLIPPER_ENDPOINT_ID`, `DEEPGRAM_API_KEY` | Clipping |

- An adapter is only built when everything it needs is present. Otherwise its calls are `not_sent *_NOT_CONFIGURED` before any row is `DISPATCHING`.
- Adapters are built directly: no `IntegrationManager`, `VideoManager`, `MediaService` or `ClippingService`.
- With creative enabled, the runtime needs outbound HTTPS to those providers and to R2. `deployment.md` ("Outbound network: none") describes the default, creative-off runtime.

## Not proven / open edge contracts

- **Not proven, not qualified:**
  - Provider pricing, idempotency and output sizes.
  - Whether R2 honours `If-None-Match` on PUT.
  - The postiz-uploader scratch protocol, specifically: that the caption file RunPod writes is exactly `ClippingTranscript` (it is read strictly at the analysis poll, so any extra key turns the captions `untrusted` and the job pays for the audio-only path), and that a fetch window or render lands at the signed key. Only `clipping.processor.interface.ts` grounds these.
- **The 200 requests per hour budget against polling.** W&W's poll bound (10 s, up to 180 polls) is 360 requests per hour for one job. That alone exceeds the shared 200 per hour per organization. Polls then get `429` from the guard, W&W counts them as failed reads, and the job ends `PROVIDER_POLL_DEADLINE`/unknown. Either the W&W poll interval or the budget must change. This side did not change the existing guard.
- **Mapping of `429` and `401` from the guards.** These happen before the handler and never send, but the client cannot tell them apart from transport failures unless it reads the `{ code }`. The root client decides whether to map them to `not_sent`. The conservative mapping is unknown.
- **`MEDIA_INGEST_LIMITS.bytesMax`** is assumed to be 20 MiB (the managed reserved-upload bound). If W&W's limit differs, `CREATIVE_ARTIFACT_MAX_BYTES` must follow it.
- **W&W `canonicalJson`** was not available. This side's `inputSha256` uses sorted-key JSON and is never compared with W&W's.
- **Clip titles and posts** from `clip.pick` are kept private and not returned. W&W's contract has no field for them. A typed read would be a separate data-exposure decision.
- **Line-timed automatic captions** cost one more RunPod analysis and one Deepgram transcription than `ClippingService` would spend. Both are stages W&W already budgets for the untrusted path. How often YouTube's automatic captions arrive line-timed is not measured.
- **Transient scratch reads before the gate.** A pinned transcript that fails to read at `clip.pick` / `clip.render` is a recorded `not_sent TRANSCRIPT_OBJECT_READ_FAILED`. Only the analysis poll retries a read.
- **`managed.creative.contracts.ts`** (not owned here) still has a comment saying a line-timed clip renders without burned-in captions. That comment is stale.
- **Slide images** are stored under `.jpg` keys whatever their sniffed type. Transloadit's import detects the type by content, which is unverified.
- **Schema.** `ManagedCreativeJob`, `ManagedCreativeCall` and `ManagedCreativeObject` need `prisma generate` and a reviewed regenerated `scripts/managed-runtime-baseline.sql` (root). The isolated runtime's startup projection reads every `Managed*` model, so **an old baseline makes the runtime refuse to start** until the baseline is regenerated and applied to a new, empty database.

## Tests (FAKE providers only)

```sh
pnpm exec jest -c jest.managed.config.js --testMatch '**/managed-creative/__tests__/creative.runtime.spec.ts' '**/prisma/managed/__tests__/managed.creative.service.spec.ts'
```

These were written without being run here. They cover:

- **Send-once rules:** a replay, a concurrent duplicate, a dead sender, a lost record, a lost provider answer, a call-key conflict, and recorded refusals across a configuration change.
- **Access and binding:** access refusals, organization scoping of jobs and handles, and DTO strictness.
- **Seedance:** source transfer with digest verification and signed-scratch-only submits.
- **Slides:** the full flow, plus an assembly whose answer was lost and is polled by its recorded id.
- **Clipping:**
  - the untrusted path, analysing again for the audio alone and then Deepgram
  - the caption path through two rendered and pinned clips
  - word-timed automatic captions pinned at the analysis; line-timed, malformed, absent or wrong-origin caption files turned into `untrusted`; an unreadable bucket keeps polling; the source bound checked before any read
  - line-timed captions through the audio-only analysis, one Deepgram transcription, pick, fetch and a render with burned-in words, with no per-clip transcription
  - a line-timed pinned transcript refused at pick and render (`CAPTION_TIMING_UNAVAILABLE`), and a silent span rendered as `captions: 'silent'`
  - a render refused when the pinned transcript changed
  - the strict transcript parser, endpoint-bound RunPod polls, retention-before-completed, and no URL or signature in any answer or row

Root still owns the following:

- the real PostgreSQL / Nest round trip
- the W&W HTTP client
- `tsc` type-checking
- schema generation and the baseline
