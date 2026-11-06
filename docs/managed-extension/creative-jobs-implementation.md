# Creative jobs: image, video and clipping for managed organizations (design)

Status: design only. Nothing here has run. Grounded in this checkout (pin `bd8353f`
plus the managed extension). Every provider fact below cites the file it was read
from. Anything the source does not show is marked **unverified** and must not be
relied on until a later step proves it.

## 1. Boundaries that stay as they are

- `MediaService.generateImage`, `generateVideo`, `startGenerateVideo`,
  `videoFunction` and `ClippingService.startClipping` plus every paid clipping
  step keep calling `refuseManagedEffect` / throwing `ClippingStop(MANAGED_CLIPPING_REFUSED)`.
  None of these are relaxed or wrapped with `runAsManagedWriter`. The agent tools
  (`generateImageTool`, `generateVideoTool`, `videoFunctionTool`, `clippingTool`)
  are not used for managed orgs. Managed work is never handed to a user chat.
- The worker has no Prisma, no Temporal and no `DatabaseModule`. It writes no
  `Media`, `Post`, `Clipping` or credit rows. `managedWriteFence` stays the shared
  write boundary.
- Results reach Postiz only this way: W&W ingest retains the bytes, runs its
  content checks, and then sends them through `POST /managed/v1/media/uploads`
  (`media:upload`, ≤ 20 MiB, image types or `video/mp4`). After that they become
  DRAFT media through `/managed/v1/posts`. The clipping `integrations` and
  `createDrafts` path is not available to managed orgs.
- W&W owns the durable operation queue, human confirmation, budget reservations
  and immutable result assets. The worker owns the provider credentials and keeps
  only short-lived scratch objects.
- The current scope is `TEST-001` / `ww.test.acc` only, DRAFT-only, and 200
  managed requests per hour per org. There is no production, publishing,
  scheduling, deletion, reconnection or spend until the owner approves a live
  qualification (§8).

## 2. Provider inventory (exact, from source)

| Capability | Code reused | Outbound calls | Env (exact names) |
| --- | --- | --- | --- |
| Image | `OpenaiService.generateImage(prompt, isVertical)` (`openai/openai.service.ts:78`). Optional prompt rewrite: `generatePromptForPicture` (gpt-4.1) | `openai.images.generate({ model: 'chatgpt-image-latest', size: '1024x1536' \| '1024x1024' })`, returns `b64_json` (PNG, per `generate.image.tool.ts:65`) | `OPENAI_API_KEY` |
| Video `seedance` | `Seedance` (`videos/seedance/seedance.ts`). DTO `{ prompt: string; images: {id,path}[] ≤3 }` | `POST https://api.evolink.ai/v1/videos/generations` (model `seedance-2.0-fast-text-to-video` or `…-reference-to-video`, `aspect_ratio` 16:9/9:16, `duration: 8`, `quality: '720p'`, `generate_audio: true`), then `GET /v1/tasks/:id` until `completed` → `results[0]` | `EVOLINK_API_KEY` (gates `available`) |
| Video `image-text-slides` | `ImagesSlides` (`videos/images-slides/images.slides.ts`). DTO `{ voice: string; prompt: string }`. `trial: true` | gpt-4.1 `generateSlidesFromText`; per slide FAL `ideogram/v2` (`fal.run`, synchronous, 300 s) and ElevenLabs TTS (`eleven_multilingual_v2`, 60 s); a storage upload of each mp3; Transloadit `createAssembly({ waitForCompletion: true, timeout: 30 min })` → `results.subtitled[0].url` | `ELEVENSLABS_API_KEY` (spelling as in source), `TRANSLOADIT_AUTH`, `TRANSLOADIT_SECRET`, `OPENAI_API_KEY`, `FAL_KEY`, plus storage env |
| Video function | `@ExposeVideoFunction` `ImagesSlides.loadVoices`, the only one in source | `GET https://api.elevenlabs.io/v2/voices?page_size=40&category=premade` → `{ voices: [{ id, name, preview_url }] }` | `ELEVENSLABS_API_KEY` |
| Clipping | `IMediaProcessor` / `RunPodMediaProcessor` (`upload/runpod.media.processor.ts`), the `IngestJob`/`ClipJob` contract (`upload/clipping.processor.interface.ts`), `DeepgramService.transcribeUrl` (nova-3, 10 min), `OpenaiService.pickClips` (gpt-4.1) | RunPod `POST /v2/{endpoint}/run`, `GET /status/{id}` (30 s timeout). The ingest uses `via: 'oxylabs'`, and those credentials live in the uploader worker, not in Postiz | `STORAGE_PROVIDER=cloudflare` + `CLOUDFLARE_*` (signed URLs), `RUNPOD_API_KEY`, `RUNPOD_INGEST_ENDPOINT_ID`, `RUNPOD_CLIPPER_ENDPOINT_ID`, `DEEPGRAM_API_KEY`, `OPENAI_API_KEY` (`UploadFactory.clippingEnabled`) |

Video "available options" are whatever `VideoManager.getAllVideos()` returns:
classes whose `available` env check passed when the module was imported. The
options shape comes from `generate.video.options.tool.ts`:
`{ type, output: 'vertical|horizontal', tools, customParams: getValidationSchemas()[dto.name] }`.

## 3. Retry, unknown-outcome, cancel and idempotency evidence

| Call | Retry-safe? | Unknown outcome | Cancel | Idempotency evidence |
| --- | --- | --- | --- | --- |
| OpenAI image | No (billed per call) | Timeout or network error after send | None (synchronous) | None in source. **Hidden retries:** the module-level `new OpenAI({ apiKey })` sets no `maxRetries`, so the SDK default applies. The installed SDK's default and its retry-header behavior are **unverified** and must be read from `node_modules/openai` in T1 |
| Evolink submit | No | 30 s abort or non-JSON reply → task may exist, id unknown | None in source | None in source |
| Evolink `GET /v1/tasks/:id` | Yes (read) | No | None | Not applicable |
| `ImagesSlides.process` | No (spends on 4 providers, partial spend possible) | Any crash mid-way. No handle is exposed (no assembly id is returned) | None | None; not resumable |
| `loadVoices` | Yes (read) | No | Not applicable | Not applicable. Whether it costs anything is **unverified** |
| RunPod `/run` | No | 30 s abort → job may exist | `IMediaProcessor` has no cancel. A RunPod cancel route is **unverified** in this source, so v1 offers none | None in source (`submit` sends only `{ input }`) |
| RunPod `/status` | Yes (read) | No. `FAILED`/`CANCELLED`/`TIMED_OUT` → `failed` | n/a | n/a |
| Deepgram `transcribeUrl` | No (billed per audio) | 10 min abort | None | None in source |
| `pickClips` (gpt-4.1) | Cheap, but subject to the same SDK default retries | Timeout | None | None |

The rules that follow from this table:

- A provider submit is attempted **at most once** for each W&W operation attempt.
- W&W persists `SUBMITTING` before the worker is called.
- If the worker reports the submit as ambiguous, or the worker dies holding an
  in-process job, the operation becomes `OUTCOME_UNKNOWN`. That state is
  terminal unless a human acts. The budget reservation stays consumed, and
  nothing re-submits automatically.
- Status reads retry with backoff.
- "Cancel" in v1 only stops polling and the downstream ingest
  (`CANCELLED_LOCAL`). It is reported as `providerCancel: 'unavailable'`, and the
  reservation is not released.

## 4. Worker HTTP contract (`ww.creative.v1`)

The worker is a new isolated process at `apps/backend/src/managed-creative/`. It
follows the `managed-runtime` pattern (own `main.ts`/module/config, never imports
`AppModule`/`DatabaseModule`).

- **Auth:** `Authorization: Bearer` worker token, compared by SHA-256 with
  `timingSafeEqual` (same as `managed.mode.ts`).
- **Request bounds:** JSON ≤ 100 kB. Every DTO uses class-validator
  (DTO → Controller → Service). There is no `any` and no generic handler.
  `customParams` is validated per identifier by the provider's own `dto` through
  `VideoAbstract.processAndValidate`, then sent to a typed union.
- **Allowlist:** the worker refuses (`403 CREATIVE_ACCOUNT_REFUSED`) unless
  `accountRef` exactly matches `WW_CREATIVE_ALLOWED_ACCOUNTS` (proposed env;
  today `ww.test.acc`).
- **Live mode:** the worker refuses every paid start (`409 CREATIVE_LIVE_DISABLED`)
  unless `WW_CREATIVE_LIVE=enabled`.

Common envelope on every start:

```ts
interface CreativeStartV1 {
  version: 'ww.creative.v1';
  operationKey: string;          // ^[A-Za-z0-9._:-]{8,128}$, W&W durable key
  accountRef: string;            // 'ww.test.acc'
  requestSha256: string;         // sha256 of canonical JSON of `request`
  confirmation: { id: string; confirmedBy: string; confirmedAt: string; requestSha256: string };
  budget: { reservationId: string; ceilingUnits: number; unit: 'image' | 'video' | 'clipping_minute' };
}
```

The worker recomputes `requestSha256`. Both the envelope value and
`confirmation.requestSha256` must match it exactly. A mismatch returns
`409 CONFIRMATION_MISMATCH`, so a confirmation always covers exactly one set of
parameters.

Operation keys are deduplicated in memory per process. A repeated start with the
same key and hash returns the existing handle. The same key with a different hash
returns `409`. Durable deduplication is W&W's job (§5).

| Route | Request (`request` body) | Response |
| --- | --- | --- |
| `GET /creative/v1/capabilities` | none | `{ version, image: { model: 'chatgpt-image-latest', orientations: ['square','vertical'], promptRewrite: boolean }, video: [{ type, title, description, output: ['vertical','horizontal'], trial, tools: [{ functionName, output }], customParams: JSONSchema, resumable: boolean, providerCancel: 'unavailable' }], clipping: { enabled, sources: ['youtube'], fits: ['blur','crop'], clips: { min: 1, max: 10, default: 5 }, clipSeconds: { min: 10, max: 90 }, maxSourceMinutes: 180 }, live: boolean }` |
| `POST /creative/v1/video/functions` | `{ version, accountRef, identifier, functionName }` | `{ identifier, functionName, result: { voices: { id, name, preview_url }[] } }`. Allowed only where `checkAvailableVideoFunction` returns false (has `@ExposeVideoFunction`) |
| `POST /creative/v1/images` | `CreativeStartV1 & { request: { prompt: string(1..4000), orientation: 'square' \| 'vertical', promptRewrite: boolean } }` | `{ operationKey, status: 'completed', artifacts: [Artifact] }`, or `{ status: 'failed', code }`, or `{ status: 'outcome_unknown' }` |
| `POST /creative/v1/videos` | `CreativeStartV1 & { request: { identifier: 'seedance', output, params: SeedanceParams } \| { identifier: 'image-text-slides', output, params: ImagesSlidesParams } }` | `{ operationKey, handle: { kind: 'evolink', taskId } \| { kind: 'in_process', jobId } }` |
| `GET /creative/v1/videos/:operationKey?handle=…` | none | `{ status: 'pending' \| 'completed' \| 'failed' \| 'outcome_unknown', artifacts?, code? }` |
| `POST /creative/v1/clippings` | `CreativeStartV1 & { request: { url: string(youtube only), fit: 'blur' \| 'crop', clips: 1..10 } }`. No `integrations` field | `{ operationKey, state: ClippingStateV1 }` |
| `POST /creative/v1/clippings/:operationKey/advance` | `{ state: ClippingStateV1 }` | `{ state: ClippingStateV1 }`. W&W stores it before it calls again |

```ts
interface Artifact {                       // what W&W ingestion receives
  artifactId: string; role: 'image' | 'video' | 'clip' | 'clip_thumbnail';
  source: { kind: 'inline_base64'; mimeType: 'image/png'; data: string }      // image only
        | { kind: 'url'; url: string; expiresAt?: string; host: string };     // provider or scratch
  declared: { byteLength?: number; title?: string; content?: string };        // untrusted
}
type ClipStep = 'analysing' | 'transcribing' | 'picking' | 'fetching' | 'captioning' | 'rendering' | 'done';
interface ClippingStateV1 {
  version: 'ww.clipping-state.v1'; operationKey: string; step: ClipStep;
  url: string; fit: 'blur' | 'crop'; maxClips: number;
  analyseJobId?: string; audioOnly: boolean; durationSeconds?: number; title?: string;
  clips: { ref: string; title: string; content: string; start: number; end: number;
           fetchJobId?: string; trimStart?: number; renderJobId?: string;
           status: 'pending' | 'completed' | 'failed'; failureCode?: string }[];
  outcome?: 'completed' | 'failed' | 'outcome_unknown'; failureCode?: string;
}
```

- **Scratch keys:** the worker derives them from `sha256(operationKey)`, never
  from the state it is sent (`ww-clip-<h>-transcript.json`, `…-audio.ogg`,
  `ww-clip-<h>-<ref>-{source.mp4,words.json,output.mp4,thumb.jpg}`). A forged
  state cannot point at another object.
- **Step order** mirrors `ClippingService`: analyse (captions first, audio-only
  retry when `origin !== 'auto_generated'`), Deepgram, `pickClips` plus the same
  selection rules, window fetch (`max_height` 1080 crop / 720 blur, ±2 s
  padding), caption words, render (frame 1080×1920).
- **Unknown outcomes:** an `advance` that loses a submit outcome sets
  `outcome: 'outcome_unknown'`.
- **Results:** completed clips return two `url` artifacts, video and thumbnail,
  with short `signDownloadUrl` links on the worker's scratch bucket.
  `title`/`content` are model output from someone else's video, so they are
  untrusted content.

Image orientation adds `'vertical'` because `generateImage(prompt, isVertical)`
supports it. The agent tool only ever produces square images.

## 5. W&W durable state (owned by W&W, other worktree)

`CreativeOperation { operationKey PK, accountRef, kind: image|video|clipping,
contractVersion, request (canonical JSON), requestSha256, confirmationId,
budgetReservationId, state, handle JSON, clippingState JSON, attempts,
lastPolledAt, failureCode, resultAssetIds[], createdAt, updatedAt }`.

State machine:

```
REQUESTED → AWAITING_CONFIRMATION → CONFIRMED (reservation held) → SUBMITTING → RUNNING → INGESTING → COMPLETED
                                                                    ↘ FAILED | OUTCOME_UNKNOWN | CANCELLED_LOCAL
```

- `FAILED` before submit releases the reservation.
- `FAILED` after a provider job existed, `OUTCOME_UNKNOWN` and `CANCELLED_LOCAL`
  keep it consumed until a human settles it.
- `COMPLETED` settles to the observed units: 1 image, 1 video, or
  `ceil(duration/60)` clipping minutes, the same unit as `checkAnalyse`.

Result assets are immutable. They are keyed by sha256, retained by W&W ingest,
and only then reserved-uploaded into Postiz. A rejected artifact (type, size,
content) is recorded as such, and the operation still ends `COMPLETED` with the
rejected artifacts listed.

## 6. Ceilings (worker-enforced, bounded constants, not raisable by request)

| Limit | Value |
| --- | --- |
| Clipping (from `clipping.service.ts`) | 1 concurrent; 20 starts per 24 h; 180 source minutes; 10–90 s clips; ≤ 10 clips |
| Video | 1 concurrent per account; seedance polling every 10 s, ≤ 180 polls (from `seedance.ts`); `in_process` jobs ≤ 30 min (Transloadit timeout) |
| Image | 2 concurrent; `prompt` ≤ 4000 characters |
| Per-operation ceiling | `budget.ceilingUnits` must be ≥ the worst case before submit (clipping: 180 minutes, or W&W's lower cap passed as `limits.max_duration_seconds`) |

The managed API's 200 req/h per org also applies to the reserved uploads.

**Known gap:** a 90 s 1080×1920 clip or an 8 s seedance video can exceed the
20 MiB W&W/reserved-upload bound. The source has no bitrate or size control for
outputs (`ClipJob.limits` covers only input), and output sizes are
**unverified**. Oversized results are rejected at ingest, kept in scratch, and
reported. There is no re-encode in v1.

## 7. Implementation tasks

Owned files are listed per task. Nothing else is touched.

**T1 — split providers into submit and status (shared library, behavior-preserving)**

Files: `videos/seedance/seedance.ts`, `openai/openai.service.ts` and their new
specs.

- `Seedance.submit(output, params): Promise<{ taskId }>` and
  `Seedance.status(taskId): Promise<{ status: 'pending' | 'completed' | 'failed'; url?; error? }>`.
  `process()` becomes a loop over these two with the same body, timeouts, 10 s
  interval and 180 polls.
- `OpenaiService.generateImage(prompt, isVertical = false, requestOptions?: { maxRetries?: number; timeout?: number })`
  passes the options as the SDK's second argument. Existing callers are unchanged.
- First record the installed `openai` version, and that its per-request
  `maxRetries` option exists and what its default is.
- Acceptance tests (fake `fetch` / fake `openai`):
  - The Evolink request body is byte-identical to the current one.
  - `process()` still returns `results[0]` and still times out after 180 polls.
  - `requestOptions` reaches `images.generate`.
  - No existing caller changes its arguments.

**T2 — clipping pure helpers (shared, behavior-preserving)**

File: `database/prisma/clipping/clipping.service.ts` only, plus a spec.

- Export the existing in-file logic as functions in the same file:
  `buildAnalyseJob`, `selectClips(segments, picked, maxClips)`,
  `buildClipFetchJob`, `buildClipRenderJob`, `analyseOutcome`.
- `ClippingService` calls them. Managed guards and the credit order stay where
  they are.
- Acceptance tests:
  - Golden JSON equality of the submitted jobs before and after the change.
  - Selection golden cases: overrun trimming, overlap, the 10/90 s bounds.
  - The managed refusals still throw.

**T3 — worker package (new)**

Files: `apps/backend/src/managed-creative/{main.ts, creative.module.ts, creative.config.ts, creative.auth.guard.ts, creative.controller.ts, creative.service.ts, dtos/*.dto.ts, adapters/{image,video,clipping}.adapter.ts, __tests__/*}`, plus a
`Dockerfile.ww-managed-creative` stub that is not built.

- The module provides `OpenaiService`, `FalService`, `DeepgramService`,
  `Seedance`, `ImagesSlides` and `VideoManager`, plus the processors from
  `UploadFactory`.
- Acceptance tests (all fakes, no env keys):
  - Importing the module never loads `@prisma/client`, Temporal,
    `MediaService` or `ClippingService`.
  - Bearer auth, the allowlist, `WW_CREATIVE_LIVE` refusal, hash/confirmation
    mismatch, the deduplication rules and DTO rejection of unknown
    identifiers or functions.
  - The image path returns an inline PNG artifact and makes exactly one
    provider call.
  - A seedance submit timeout gives `outcome_unknown` and no second submit.
  - Status maps `pending`/`processing`/`completed`/other.
  - `image-text-slides` after a simulated restart gives `outcome_unknown`.
  - The clipping step machine is driven through every `IngestResult`/`ClipResult`
    branch (retryable, `DURATION_TOO_LONG`, uploader captions → audio-only, no
    speech, partial render), and keys are derived from `operationKey` even when
    the state is tampered with.
  - Capabilities reflect only the providers whose `available` is true.

**T4 — W&W side (Codex, other worktree)**

- The `CreativeOperation` store, the confirmation UI, budget reservations, the
  poll scheduler, and feeding artifacts through the retained ingestion and
  content checks into `/managed/v1/media/uploads`.
- MCP parity mapping: `generateImageTool` → images, `generateVideoOptions` →
  capabilities, `videoFunctionTool` → video/functions, `generateVideoTool` and
  `videoStatusTool` → videos, `clippingTool` and `clippingStatusTool` →
  clippings. Every start needs a human confirmation in W&W.
- Acceptance tests:
  - A worker fake checks the state transitions, that `OUTCOME_UNKNOWN` never
    auto-resubmits, the reservation release/settle rules, and that ingest
    rejects off-allowlist hosts, wrong types and oversized files.

**T5 — docs**

- Add a "Creative worker" section to `README.md` and `deployment.md` once T3
  lands.

## 8. Qualification

**Zero-spend local (now):**

- T1 to T4 run with jest fakes only. There are no provider keys, no
  `WW_CREATIVE_LIVE`, no subscription minutes and no hosting.
- This proves the contracts, guards, deduplication, unknown-outcome handling and
  ingest refusal. It does **not** prove that the providers behave as assumed,
  what outputs cost, or how large outputs are.

**Future owner-funded live qualification.** Each item needs the owner to act
before anything runs:

1. Choose which capabilities to qualify, and set a spend cap per provider.
2. Put worker-only keys in the worker host's secret store. The keys involved are
   `OPENAI_API_KEY`, `EVOLINK_API_KEY` and, for slides, `ELEVENSLABS_API_KEY`,
   `FAL_KEY`, `TRANSLOADIT_AUTH` and `TRANSLOADIT_SECRET`.
3. For clipping, approve new hosting: an R2 scratch bucket with signed URLs, and
   RunPod ingest and clipper endpoints running the postiz-uploader schema v1
   image with its own Oxylabs credentials. Then provide `RUNPOD_*` and
   `DEEPGRAM_API_KEY`.
4. For slides, approve publicly reachable scratch storage, because Transloadit
   imports the mp3 by URL.
5. Add the provider result hosts and the scratch host to W&W ingest's allowlist.
6. Run one operation per capability against `ww.test.acc`, DRAFT only. Record
   the cost, output sizes, the real retry/idempotency behavior and whether
   cancel works.
