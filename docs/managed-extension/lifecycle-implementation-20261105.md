# Managed post lifecycle: implementation plan (schedule, publish now, cancel, delete)

Status: PLAN ONLY, 2026-11-05. No schema, code, test or baseline change is made by this document.

Authority: the user has authorized building full lifecycle parity, with tests that use isolated fakes. The historical non-goals in `README.md` describe the DRAFT checkpoint and do not override that authorization. Live effects stay forbidden. Every new flag defaults to OFF. No hosting, provider connection or spend is part of this work. "Built" means real production code that is composed into the runtime behind a closed qualification gate. A disconnected fake module does not count.

Source read for this plan (at `595cd05`):

- `prisma/managed/managed.service.ts`: draft gates, `canonicalJson`/`fingerprint`, `rowFingerprint`, `MANAGED_CAPABILITIES` v2, `commitRevision`, `replay`
- `prisma/managed/managed.repository.ts`: `mutate` (the org row lock plus `nextSequence`), `read` (RepeatableRead), credential-safe selects
- `apps/backend/src/managed-api/routes/v1/managed.controller.ts`
- `managed-runtime/managed-runtime.module.ts`: no Temporal, no social providers
- `apps/orchestrator/src/activities/post.activity.ts` (managed guards)
- `post.workflow.v1.1.2.ts`
- `PostsService.deletePost` / `startWorkflow`
- `helpers/utils/strip.html.validation.ts`

---

## 1. Architecture decision

**A separate managed dispatcher, inside the isolated managed runtime, with an explicit and closed provider adapter registry. The upstream Temporal path is not used and not changed.**

Why the upstream Temporal path was rejected:

1. **Hosting.** The minimal owned runtime has only PostgreSQL, Redis and a private volume. `postWorkflowV112` needs a Temporal server, its persistence and a worker per provider task queue. That is a new hosted dependency that was never qualified, and this plan does not introduce it.
2. **Fences.** Running managed posts through `postWorkflowV112` would mean removing the managed refusals in `PostActivity.getPost`, `getPostsList`, `postSocial*`, `postComment`, `checkPostStatus` and `finalizePost`. Those refusals are the live guard for every frozen workflow version and must stay unconditional. Workflow files and activity signatures cannot change. A new workflow version would still go through the same guarded activities.
3. **Semantics we cannot prove.**
   - Upstream cancels and deletes with `workflow.terminate()`. A terminate during `postSocialPending` leaves the result unknown and records nothing.
   - Repeats are `startChild(..., ABANDON)` with random ids. They can only be found again through a visibility query.
   - The automatic token refresh is refused for managed organizations.
   - The workflow sends webhooks, notifications, the streak and plugs, which W&W does not want.
   - There is no final-call admission against the revision, the binding, the release hash or current media.

What the managed dispatcher is:

- **Where it runs.** `ManagedDispatcher` is a Nest provider registered only by `ManagedRuntimeModule`. It runs in the same process and under the same Redis single-instance lease as the managed API. `AppModule` (the upstream backend) never registers it.
- **Writes.** It writes only through `ManagedRepository.mutate`, which is `runAsManagedWriter` under the org row lock. The Prisma fence is therefore used, not bypassed. Every Post row transition is a managed write, gets a dense sequence and appears in the feed.
- **Provider calls.** It reaches a provider only through `ManagedPublishAdapter`, a closed registry following the pattern of `managed.connection.provider.ts` and `managed.helper.provider.ts`. Each adapter composes the existing upstream `SocialProvider` class for one `providerIdentifier`. Generic code reads `adapter.editor` and `adapter.capabilities` and never branches on a provider name. The registry is empty unless an operator enables it (see §2).
- **Database-driven.** There is no Temporal and no queue. Due work is selected from `ManagedDispatch` rows. Every provider mutation gets a durable `ManagedDispatchCall` row in `DISPATCHING` state, committed **before** the request leaves, which is the same at-most-once gate as `ManagedCreativeCall`. A call that is lost becomes `UNKNOWN` and goes to review. It is never sent again automatically.

What stays exactly as it is:

- `POST /posts` and `PUT /posts/:id`, including their gates and payload hashes.
- `MANAGED_CAPABILITIES` v2, which W&W pins.
- Every refusal in `PostActivity`, `refuseManagedEffect`, `ManagedEffectGuard`, `RefreshIntegrationService`, the missed-post sweep and the `$use` fence.
- No workflow or activity file is edited.
- `editDraft` still refuses non-DRAFT rows (`POST_NOT_DRAFT`). To edit a scheduled post, W&W cancels it, edits it and schedules it again.

---

## 2. Gates (all default OFF, read on every request and on every dispatcher tick)

| Gate | Default | Effect when closed |
| --- | --- | --- |
| `POSTIZ_MANAGED_LIFECYCLE_ORGANIZATIONS` (exact ids, must also be managed) | empty | lifecycle writes `403 LIFECYCLE_NOT_ENABLED`; due dispatches `NOT_SENT LIFECYCLE_GATE_CLOSED` |
| `POSTIZ_MANAGED_LIFECYCLE_PROVIDERS` (exact `providerIdentifier`s, ∩ adapter registry) | empty | schedule/publish `422 PROVIDER_NOT_QUALIFIED`; due dispatches `NOT_SENT PROVIDER_NOT_QUALIFIED` |
| `POSTIZ_MANAGED_LIFECYCLE_EXPIRES_AT` (required, ≤ `2026-11-10T23:00:00.000Z`, exclusive) | unset = closed | as above, `WINDOW_CLOSED` |
| `POSTIZ_MANAGED_DISPATCHER` = exactly `enabled` | unset | dispatcher loop not started; lifecycle writes `409 LIFECYCLE_NOT_AVAILABLE` (nothing would ever dispatch) |
| DI token `MANAGED_DISPATCHER_PRESENT` (provided only by `ManagedRuntimeModule`) | absent in `AppModule` | lifecycle writes `409 LIFECYCLE_NOT_AVAILABLE` on the upstream backend |
| Scopes `posts:schedule` (schedule, cancel, delete) and `posts:publish` (publish-now, resolve) appended to `MANAGED_SCOPES` | not granted | `403` from `ManagedScopeGuard` |

A closed gate refuses **before** any row is written. The one exception is the due-time `NOT_SENT`, which is a recorded refusal. Startup validates the new variables the way `managed-runtime.config.ts` validates the existing ones. An invalid value refuses startup, and the refusal never echoes the value.

---

## 3. Durable schema (additive only)

No existing column changes meaning. New columns are nullable or have defaults, so existing rows read exactly as they do today. `scripts/managed-runtime-baseline.sql` and its SHA256 in `deployment.md` must be regenerated by root after schema review. Existing managed databases need a reviewed additive diff, and this plan does not provide one (see the blockers).

### 3.1 Changes to existing managed models (additive columns)

```prisma
model ManagedPost {
  // ...existing...
  scheduleGeneration Int     @default(0)       // +1 on schedule, publish-now, cancel(SERIES|REMAINING), delete
  lifecycle          String  @default("DRAFT") // DRAFT | SCHEDULED | DISPATCHING | PUBLISHED | FAILED | REVIEW | DELETED
  deletedOperationKey String?
}

model ManagedOperation {
  // ...existing...
  result String?   // lifecycle kinds only: the exact JSON answered, replayed verbatim. null for CREATE_DRAFT/EDIT_DRAFT (their replay stays snapshot-based)
}
```

### 3.2 New models

```prisma
// One per accepted schedule / publish-now. At most one ACTIVE per post.
// ACTIVE -> COMPLETED | CANCELLED | HALTED | SUPERSEDED_BY_DELETE. Never deleted.
model ManagedSchedule {
  id                 String    @id @default(uuid())
  organizationId     String
  managedPostId      String
  scheduleGeneration Int
  mode               String              // AT | NOW
  status             String    @default("ACTIVE")
  revision           Int                 // bound revision
  bindingGeneration  Int
  identityFingerprint String
  releaseHash        String              // sha256:… (§5)
  codec              String              // ww-plain-escape-v1 | ww-plain-paragraph-escape-v1
  anchorAt           DateTime            // first due time (NOW: server time at accept)
  intervalDays       Int?                // repeat; null = once
  maxOccurrences     Int?                // repeat bound, null = until cancelled/window
  maxLatenessMs      Int                 // 0..3_600_000, default 900_000
  operationKey       String
  credentialId       String
  endedAt            DateTime?
  endedReason        String?
  endedOperationKey  String?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  @@unique([managedPostId, scheduleGeneration])
  @@index([organizationId, status])
}

// One per occurrence. Occurrence n+1 is materialized only when occurrence n
// is PUBLISHED (upstream parity: a failed run never schedules its repeat).
// PENDING -> CANCELLED | EXPIRED | NOT_SENT | ADMITTED
// ADMITTED -> PUBLISHED | REJECTED | PARTIAL | UNKNOWN
// UNKNOWN | PARTIAL -> RESOLVED_PUBLISHED | RESOLVED_NOT_PUBLISHED | RESOLVED_ABANDONED
model ManagedDispatch {
  id                 String    @id @default(uuid())
  organizationId     String
  scheduleId         String
  managedPostId      String
  occurrence         Int
  dueAt              DateTime
  status             String    @default("PENDING")
  version            Int       @default(1)   // +1 on every transition; expectedDispatchVersion
  revision           Int
  bindingGeneration  Int
  scheduleGeneration Int
  releaseHash        String
  leaseHolder        String?               // runtime instance uuid
  leaseExpiresAt     DateTime?
  code               String?               // NOT_SENT / REJECTED / UNKNOWN reason
  // per member: { position, postId, callId, status, releaseId?, releaseURL? }; never tokens or pendingData
  members            String    @default("[]")
  resolution         String?               // JSON of the review decision
  admittedAt         DateTime?
  settledAt          DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  @@unique([scheduleId, occurrence])
  @@index([organizationId, status, dueAt])
}

// One per provider mutation (post, comment, finalize), created DISPATCHING in a
// committed transaction before the request leaves; leaves DISPATCHING once.
// Read-only status checks are not mutations and get no row.
model ManagedDispatchCall {
  id             String   @id @default(uuid())
  organizationId String
  dispatchId     String
  member         Int
  step           String             // POST | COMMENT | FINALIZE
  attempt        Int                // only >1 after a provable NOT_SENT (never after UNKNOWN)
  status         String             // DISPATCHING | OK | PENDING_PROVIDER | REJECTED | UNKNOWN | NOT_SENT
  code           String?
  requestHash    String             // sha256 of the exact adapter input (text, media digests, settings)
  pendingData    String?            // server-private provider continuation, never returned
  answer         String?            // { releaseId, releaseURL } only
  leaseHolder    String
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([dispatchId, member, step, attempt])
  @@index([organizationId, status])
}
```

`ManagedChangeEvent` takes the following new `kind` values. The model itself does not change.

- `POST_SCHEDULED`
- `POST_PUBLISH_REQUESTED`
- `POST_SCHEDULE_CANCELLED`
- `POST_OCCURRENCE_CANCELLED`
- `POST_DELETED`
- `DISPATCH_ADMITTED`
- `DISPATCH_NOT_SENT`
- `DISPATCH_PUBLISHED`
- `DISPATCH_REJECTED`
- `DISPATCH_PARTIAL`
- `DISPATCH_OUTCOME_UNKNOWN`
- `DISPATCH_RESOLVED`
- `OCCURRENCE_MATERIALIZED`

`entityType` is `MANAGED_POST` or `MANAGED_DISPATCH`. `data` carries the public view only.

The `Post` rows themselves are never deleted. Their transitions all happen in managed transactions and each one updates `ManagedPost.rowFingerprint`, so drift detection keeps working:

- `DRAFT -> QUEUE` on schedule
- `QUEUE -> PUBLISHED` (with `releaseId` / `releaseURL`), or `-> ERROR` (with `error`)
- `QUEUE | ERROR -> DRAFT` on cancel
- `deletedAt` on delete

---

## 4. Routes and types (`ww.managed-lifecycle.v1`)

All lifecycle routes sit in a new `ManagedLifecycleController` mounted by `ManagedApiModule`. They use the same `ThrottlerManagedCredentialGuard` and `ManagedScopeGuard` as the other routes. Every write body carries `"version": "ww.managed-lifecycle.v1"`. DTOs use `whitelist` and `forbidNonWhitelisted`. Errors take the form `{ code, msg }`. Responses set `Cache-Control: no-store`.

| Method / path | Scope | Purpose |
| --- | --- | --- |
| `GET /managed/v1/lifecycle/capabilities` | posts:read | `{ version, gates: { enabled, providers[], expiresAt, dispatcher }, codecs[], repeat: { minIntervalDays: 1, maxIntervalDays: 365, maxOccurrences: 1000 }, maxLatenessMs, publication: { qualified: false until an adapter is qualified } }`. `/capabilities` v2 is unchanged. |
| `POST /managed/v1/posts/:managedPostId/schedule` | posts:schedule | `ScheduleBody` |
| `POST /managed/v1/posts/:managedPostId/publish-now` | posts:publish | `PublishNowBody` |
| `POST /managed/v1/posts/:managedPostId/cancel` | posts:schedule | `CancelBody` |
| `POST /managed/v1/posts/:managedPostId/delete` | posts:schedule | `DeleteBody` (POST, because it carries a body) |
| `GET /managed/v1/posts/:managedPostId/lifecycle` | posts:read | `LifecycleView` (DB read) |
| `GET /managed/v1/dispatches/:dispatchId` | posts:read | `DispatchView` |
| `POST /managed/v1/dispatches/:dispatchId/resolve` | posts:publish | `ResolveBody` |
| `GET /managed/v1/lifecycle/release-preview/:managedPostId?revision=&codec=` | posts:read | `{ releaseHash, members: [{ position, text, media[] }] }`. Exactly what would be sent, computed by the server codec, so W&W can verify its own hash. |

```ts
type Codec = 'ww-plain-escape-v1' | 'ww-plain-paragraph-escape-v1';

interface ScheduleBody {
  version: 'ww.managed-lifecycle.v1';
  operationKey: string;                 // ^[A-Za-z0-9._:-]{8,128}$, org-wide namespace shared with drafts
  expectedRevision: number;
  expectedBindingGeneration: number;
  expectedScheduleGeneration: number;   // ManagedPost.scheduleGeneration as last read
  releaseHash: string;                  // sha256:<64 hex>, §5
  codec: Codec;
  publishAt: string;                    // ISO UTC, >= now + 60 s, < gate expiry
  repeat?: { intervalDays: number; maxOccurrences?: number };
  maxLatenessMs?: number;               // default 900000
}
type PublishNowBody = Omit<ScheduleBody, 'publishAt' | 'repeat' | 'maxLatenessMs'>;

interface CancelBody {
  version: 'ww.managed-lifecycle.v1';
  operationKey: string;
  expectedScheduleGeneration: number;
  // OCCURRENCE: the named PENDING occurrence only; the series continues
  //   (the next one is materialized from anchor + (n+1)·interval).
  // REMAINING: every not-yet-admitted occurrence from `fromOccurrence` on
  //   (the series ends after an in-flight one settles).
  // SERIES: the whole schedule ends; rows return to DRAFT unless PUBLISHED.
  scope: 'OCCURRENCE' | 'REMAINING' | 'SERIES';
  occurrence?: number;                  // required for OCCURRENCE / REMAINING
  expectedDispatchVersion?: number;     // required for OCCURRENCE
}

interface DeleteBody {
  version: 'ww.managed-lifecycle.v1';
  operationKey: string;
  expectedRevision: number;
  expectedScheduleGeneration: number;
}

interface ResolveBody {
  version: 'ww.managed-lifecycle.v1';
  operationKey: string;
  expectedDispatchVersion: number;
  resolution: 'RESOLVED_PUBLISHED' | 'RESOLVED_NOT_PUBLISHED' | 'RESOLVED_ABANDONED';
  evidence: { observedAt: string; releaseURL?: string; releaseId?: string; note: string /* ≤ 2000 */ };
  members?: { position: number; resolution: 'PUBLISHED' | 'NOT_PUBLISHED' }[]; // PARTIAL only
}

interface LifecycleResult {
  managedPostId: string;
  operationKey: string;
  payloadHash: string;
  replayed: boolean;
  sequence: number;
  revision: number;
  scheduleGeneration: number;          // after the operation
  lifecycle: string;
  schedule: ScheduleView | null;
  dispatches: DispatchView[];          // affected ones
}

interface DispatchView {
  dispatchId: string; scheduleId: string; occurrence: number; dueAt: string;
  status: string; version: number; code: string | null;
  revision: number; bindingGeneration: number; scheduleGeneration: number; releaseHash: string;
  members: { position: number; postId: string; status: string; releaseId?: string; releaseURL?: string }[];
  resolution: object | null; admittedAt: string | null; settledAt: string | null;
}
```

### 4.1 Refusal codes (all `409` unless stated)

| Code | Meaning |
| --- | --- |
| `OPERATION_KEY_PAYLOAD_MISMATCH` | same key, different payload |
| `OPERATION_KEY_CREDENTIAL_MISMATCH` | same key, different credential |
| `OPERATION_KEY_KIND_MISMATCH` | the key belongs to a draft or another kind |
| `REVISION_CONFLICT` | |
| `SCHEDULE_GENERATION_CONFLICT` | |
| `BINDING_GENERATION_MISMATCH` | |
| `CHANNEL_NOT_QUALIFIED` | |
| `CHANNEL_IDENTITY_CHANGED` | |
| `CHANNEL_UNAVAILABLE` | disabled, refreshNeeded, inBetweenSteps or deleted |
| `POST_DRIFTED` | |
| `POST_NOT_SCHEDULABLE` | lifecycle is not DRAFT, or rows are not DRAFT |
| `SCHEDULE_ACTIVE` | |
| `DISPATCH_UNRESOLVED` | some dispatch is UNKNOWN or PARTIAL |
| `DISPATCH_IN_PROGRESS` | cancel or delete of an ADMITTED occurrence |
| `DISPATCH_VERSION_CONFLICT` | |
| `POST_DELETED` | |
| `RELEASE_HASH_MISMATCH` | `422` |
| `CODEC_REFUSED` | `422`: content is not a strict codec value |
| `CODEC_NOT_QUALIFIED_FOR_PROVIDER` | `422`: `adapter.editor !== 'normal'` |
| `MEDIA_NOT_CURRENT` | `422` |
| `MEDIA_DELIVERY_NOT_QUALIFIED` | `422`: media present but no qualified delivery path (§13 B1) |
| `PROVIDER_NOT_QUALIFIED` | `422` |
| `OUTSIDE_LIFECYCLE_WINDOW` | `422` |
| `LIFECYCLE_NOT_ENABLED` | `403` |
| `LIFECYCLE_NOT_AVAILABLE` | `409` |

---

## 5. Release hash and exact caption conversion

### 5.1 Codec leaf

New file `libraries/nestjs-libraries/src/database/prisma/managed/managed.caption.codec.ts`. It is the strict leaf the user asked for. `stripHtmlValidation` and the existing vectors are not changed.

- `decodeManagedCaption(codec, content): { ok: string } | { refused: reason }` is a single-pass tokenizer with no regex chains and no double decoding.
  - **`ww-plain-escape-v1`:** `content` contains no `<`, `>` or U+00A0. Every `&` starts exactly one of `&amp;`, `&lt;`, `&gt;` or `&nbsp;`. There is no U+000D, no U+0000 and no lone surrogate. Each entity is decoded once, and `&nbsp;` becomes **U+00A0**, not a space. LF stays literal.
  - **`ww-plain-paragraph-escape-v1`:** `content` is exactly `<p>` + body + `</p>`, with no other `<`. The body follows the rule above.
  - Anything else gets `CODEC_REFUSED` with one reason: `RAW_LT`, `RAW_GT`, `RAW_NBSP`, `BARE_AMPERSAND`, `UNKNOWN_ENTITY`, `NOT_ONE_PARAGRAPH`, `FORBIDDEN_CHARACTER` or `EMPTY`.
- `encodeManagedCaption(codec, text)` is the inverse. It is used only by the tests and by `release-preview` to assert the round trip.
- Both codecs also require `sanitizePostContent(content) === content`, which the draft gate already enforces. A value that passes both the draft gate and the codec is therefore a fixed point.
- New fixture `managed/publication.caption.vectors.json` (`ww-publication-caption-vectors-v1`). It holds `{ codec, content, text | refused }` vectors, including `&amp;lt;b&amp;gt;` → `&lt;b&gt;` (decoded once), NBSP kept, emoji and astral characters, LF, quotes and every refusal. The existing `canonical.caption.vectors.json` is untouched.

The text sent to the provider is the decoded text. It is passed as `message` straight to the adapter, so `stripHtmlValidation` is **not** called on the managed path. The dispatcher is a new caller and changes nothing for upstream callers.

Provider eligibility is decided generically:

- Only adapters with `editor === 'normal'` and `mentionFormat` unused accept a plain codec. Every other adapter gets `CODEC_NOT_QUALIFIED_FOR_PROVIDER`.
- A provider's own downstream escaping (for example a provider that escapes reserved characters) is the adapter's documented `textTransport`. The provider's qualification must prove that the text equals the published text (§8, §13 B3).

### 5.2 `ww-release-hash-v1`

```
releaseHash = "sha256:" + sha256hex(canonicalJson({
  v: "ww-release-hash-v1",
  managedPostId, revision, integrationId, providerIdentifier,
  identityFingerprint,            // binding's
  codec,
  settings,                       // as bound in the revision snapshot (without __type)
  members: [{ position, delay,
              text,               // decodeManagedCaption(codec, content).ok
              media: [{ position, mediaId, evidenceId, sha256, byteLength, mimeType,
                        alt?, thumbnail?: { mediaId, evidenceId, sha256 }, thumbnailTimestampMs? }] }]
}))
```

- `canonicalJson` is the existing function: keys sorted, `undefined` dropped, UTF-16 JSON escaping of `JSON.stringify`.
- W&W must reproduce it byte for byte. `release-preview` is the oracle, and the vectors file gains three release-hash vectors.
- The schedule and the date are **not** in the release hash. They are bound separately by `scheduleGeneration` and `dueAt`, so rescheduling the same approved content keeps the same hash.

---

## 6. Write semantics

All lifecycle writes follow the same steps, mirroring `createDraft`/`editDraft`:

1. Normalize the body and compute `payloadHash = fingerprint({ kind, managedPostId, ...body without version })`.
2. Outside the transaction, run `ManagedMediaService.currentEvidence` for every media and cover in the bound revision. This is the existing pinned-key/namespace read; the transaction never calls storage.
3. `ManagedRepository.mutate(org, tx => …)`:
   - **Replay.** `getOperation(key)` returns one of:
     - another credential: `OPERATION_KEY_CREDENTIAL_MISMATCH`
     - another kind: `OPERATION_KEY_KIND_MISMATCH`
     - another hash: `OPERATION_KEY_PAYLOAD_MISMATCH`
     - otherwise: `JSON.parse(result)` with `replayed: true`
   - **Gates** (each returns `{ refused }` like the existing `Outcome<T>`):
     - the post exists and is not deleted
     - `revision` and `scheduleGeneration` equal the expected values
     - no dispatch is UNKNOWN or PARTIAL (except for resolve)
     - `reconcileBinding` passes: an identity change pauses the binding and the pause is committed
     - the binding is QUALIFIED at the expected generation
     - the integration connection is usable
     - `rowFingerprint(rows) === managed.rowFingerprint`
     - the rows are in the state the operation expects
     - the media evidence for the current stored path equals the snapshot's `evidenceId`/`sha256`, and `currentEvidence` matched
     - the codec decodes every member
     - the recomputed release hash equals `body.releaseHash`
     - the provider and the window are open
     - if any media is present, a qualified delivery path exists (§13 B1)
   - **Effects:**
     - **schedule:** `scheduleGeneration+1`. Create `ManagedSchedule(ACTIVE)` and dispatch occurrence 0 (`dueAt = publishAt`). Rows `DRAFT->QUEUE`, `publishDate = publishAt`. `lifecycle = SCHEDULED`. Event `POST_SCHEDULED`.
     - **publish-now:** the same, with `mode NOW` and `dueAt = now()`, and `repeat` is not allowed. Event `POST_PUBLISH_REQUESTED`. The dispatcher is nudged in-process; the next tick is ≤ 5 s anyway.
     - **cancel:**
       - `OCCURRENCE`: the PENDING dispatch at the expected version becomes CANCELLED. The next occurrence is materialized at once, so the series continues. Rows and generation are unchanged.
       - `REMAINING`: every PENDING occurrence `>= fromOccurrence` becomes CANCELLED, and `scheduleGeneration+1`. If none is ADMITTED, the schedule ends now and the rows go back to DRAFT unless PUBLISHED. If one is ADMITTED, the schedule is marked to end when that one settles and is not materialized again.
       - `SERIES`: like `REMAINING` from 0. An ADMITTED occurrence answers `DISPATCH_IN_PROGRESS`. It cannot be recalled, and W&W retries after it settles, which mirrors the moment upstream's terminate would have produced an unknown.
       - QUEUE or ERROR rows go back to DRAFT and `lifecycle = DRAFT`, after which the post is editable again.
     - **delete:**
       - Refused while a dispatch is ADMITTED, UNKNOWN or PARTIAL.
       - PENDING dispatches become CANCELLED and the ACTIVE schedule becomes `SUPERSEDED_BY_DELETE`. `scheduleGeneration+1`.
       - Every row of the group gets `deletedAt`, as in upstream `deletePost`. They are retained, not unlinked, and their state is kept.
       - `lifecycle = DELETED`, `deletedOperationKey`. Event `POST_DELETED`.
       - A published post is **not** removed from the platform. Upstream does not do that either, and it would be a separate provider effect outside parity.
       - Draft edits of a deleted post return `POST_NOT_DRAFT`. That is the existing gate, and it already refuses rows with `deletedAt`.
     - **resolve:**
       - Only an UNKNOWN or PARTIAL dispatch at the expected version. It moves to `RESOLVED_*` with the evidence stored. Nothing is sent.
       - `RESOLVED_PUBLISHED`: rows become PUBLISHED with the given release URL/id, and the next occurrence is materialized if the series is ACTIVE.
       - `RESOLVED_NOT_PUBLISHED`: the series becomes HALTED and the rows ERROR. W&W may cancel the series (rows back to DRAFT) and then schedule again with a **new** key. That is allowed only because a human recorded that nothing was published.
       - `RESOLVED_ABANDONED`: the series becomes HALTED and the rows keep their state.
   - `nextSequence`, `appendEvent`, and then `createOperation({ …, result })`. The result answered is stored verbatim.
4. A lifecycle route answers its stored result. A lost response is answered by sending the same key again, or with `GET /operations/:key`. That existing route reads `ManagedOperation` and would answer `COMMITTED` for a lifecycle key. Its response shape must be checked by a test, and it is not changed.

---

## 7. Dispatcher: admission, call gate, recovery

`ManagedDispatcher` (`libraries/nestjs-libraries/src/database/prisma/managed/managed.dispatcher.ts`, composed in `ManagedRuntimeModule`) works as follows.

**Loop.** It runs only while `POSTIZ_MANAGED_DISPATCHER=enabled` and this process holds the runtime lease. Every 5 s it selects up to 10 due `PENDING` dispatches for lifecycle-enabled organizations (`dueAt <= now`), and recovers expired `ADMITTED` leases. One dispatch per organization is in flight in this process.

**Admission (final-call).** For each due dispatch:

1. Outside the transaction, `currentEvidence` reads the pinned media.
2. In `mutate(org)`:
   - re-check every gate in §6 against the dispatch's bound `revision`, `bindingGeneration`, `scheduleGeneration` and `releaseHash`
   - the provider, window and organization gates are open
   - lateness: `now - dueAt <= maxLatenessMs`, otherwise `NOT_SENT LATE_BEYOND_TOLERANCE`. Upstream would publish late with no bound.
   - for an occurrence greater than 0, the rows must be PUBLISHED (a repeat of the published post). For occurrence 0, the rows must be QUEUE.
3. Any failed gate moves the dispatch to `NOT_SENT` with the code. The rows go to `ERROR`, the series becomes HALTED and the event `DISPATCH_NOT_SENT` is written. Nothing was sent, which is the safe outcome.
4. On pass, the dispatch moves to `ADMITTED` with `leaseHolder = instance` and `leaseExpiresAt = now + 35 min`. A `ManagedDispatchCall(member 0, POST, attempt 1, DISPATCHING, requestHash)` is created and the event `DISPATCH_ADMITTED` is written. **This transaction commits before any provider byte is sent.**

**Send.** Immediately before the adapter call, the dispatcher re-checks that the Redis lease is still held by this instance. If not, it exits like the existing lease-loss path, and the call row stays DISPATCHING, which recovery turns into UNKNOWN. Then it calls `adapter.post({ internalId, token, message: text, settings, media }, deadline)`.

- The token is read by a new `ManagedRepository` method with `select: { token: true, internalId: true, providerIdentifier: true }`, used inside the dispatcher only, never returned or logged.
- Media are given as `ManagedReleaseMedia`: pinned key, sha256, size and type. The adapter reads them with the existing private read and re-hashes them. A mismatch fails before the request (`NOT_SENT MEDIA_CHANGED`).

**Settle.** In a new `mutate`, conditional on the call still being `DISPATCHING` with this `leaseHolder`:

| Adapter outcome | What happens |
| --- | --- |
| `{ status: 'success', releaseId, releaseURL }` | Call `OK`. Member published. If there are more members, `isCommentable` is the adapter's capability (upstream sends only the root when the provider can't comment). Wait `delay` minutes, held as a `nextAt` on the dispatch rather than a sleep, then a COMMENT call row goes through the same gate. |
| `{ status: 'pending', pendingData }` | Call `PENDING_PROVIDER` with `pendingData` stored privately. Read-only `checkPostStatus` polls follow every 20 s, at most 90, without call rows. `ready` creates a `FINALIZE` call row (gate as above). `completed` is OK. 90 checks without an answer is `UNKNOWN PENDING_UNCONFIRMED`. |
| Provider rejected (`bad_body`) | Call `REJECTED`. On member 0 the dispatch becomes `REJECTED`, the rows ERROR and the series HALTED. On member > 0 the dispatch becomes `PARTIAL`. |
| `refresh_token` / `Disconnect` | Call `REJECTED CHANNEL_REFRESH_NEEDED`, treated like a rejection. No managed refresh exists, and `RefreshIntegrationService` refuses it. The integration is not written. |
| Adapter proves the request never left (DNS/connect refused before write, thrown `NotSentError`) | Call `NOT_SENT`. A new attempt row is allowed once (attempt 2). |
| Timeout, socket reset after write, process death, anything else | Call `UNKNOWN`, and the dispatch `UNKNOWN` or `PARTIAL` (if an earlier member was published). The event `DISPATCH_OUTCOME_UNKNOWN` is written. **Never resent.** W&W resolves it. |

When every member is done, the dispatch becomes `PUBLISHED`: rows PUBLISHED with `releaseURL`/`releaseId` (the same fields as upstream `updatePost`), `lifecycle = PUBLISHED`, event `DISPATCH_PUBLISHED`. With a repeat series and no ending flagged, occurrence n+1 is materialized with `dueAt = anchorAt + (n+1)·intervalDays`. That is anchored and deterministic, unlike upstream's "interval minus publish time" drift, and this difference is documented.

There are no webhooks, notifications, streak, internal plugs or global plugs. Those are managed refusals today and stay so.

**Recovery.**

- A dispatch `ADMITTED` whose lease expired while a call row is `DISPATCHING`: the call becomes `UNKNOWN DISPATCHER_LOST` and the dispatch `UNKNOWN` or `PARTIAL`.
- `PENDING_PROVIDER` calls resume polling (read-only) under the new lease.
- A `DISPATCHING` row is never sent again.

---

## 8. Provider adapters

`managed.publish.provider.ts` holds the `ManagedPublishAdapter` interface: `editor`, `canComment`, `textTransport`, `post`, `postPending?`, `checkPostStatus?`, `finalizePost?`, `comment?` and `mediaTransport: 'BYTES' | 'URL'`. It also holds the closed factory `managedPublishAdapters(env)`, which returns `{}` unless `POSTIZ_MANAGED_LIFECYCLE_PROVIDERS` names a provider.

- **Composition.** One adapter per qualified provider composes the existing upstream provider class: its constructor, `post`, `comment` and pending methods. Nothing is copied. The runtime imports that one class, never `IntegrationManager` or all providers.
- **First candidate.** Instagram, matching the existing consent adapter. Its `mediaTransport` is `URL`, so it is blocked on B1 for media posts. Its text-only behavior still needs provider proof.
- **Adapter tests.** The real upstream class runs with `fetch` replaced by a scripted in-process fake that records requests. That proves request shape, the exact `message` bytes and the answer mapping (`success`, `pending`, `bad_body`, `refresh_token`, timeout → UNKNOWN). No network is used.

---

## 9. Shared 200/hour budget

- Every lifecycle route goes through the existing per-organization Redis bucket (`managedRateLimit()`, ceiling 200), the same bucket as drafts, media, creative and helpers.
- The dispatcher's provider calls are not HTTP requests and do not consume it.
- W&W should not poll each dispatch. It should use `GET /changes` (one request returns every lifecycle event) at most once per 60 s, which costs 60/h and leaves 140/h for writes and reads. The capabilities document carries `recommendedFeedPollSeconds: 60`.
- `GET /dispatches/:id` is for review screens only.

---

## 10. Cross-repo contract for the W&W app (SQL, UI, MCP)

W&W implements these in its own repository. This fork only guarantees the HTTP contract above.

**SQL (W&W database, additive):**

- `postiz_lifecycle_operation`
  - `operation_key` (pk), `tenant_id`, `managed_post_id`
  - `kind` (`SCHEDULE|PUBLISH_NOW|CANCEL|DELETE|RESOLVE`)
  - `expected_revision`, `expected_binding_generation`, `expected_schedule_generation`, `expected_dispatch_version`
  - `release_hash`, `codec`, `scope`, `occurrence`
  - `request_json`, `state` (`PREPARED|SENT|COMMITTED|REFUSED|UNKNOWN`), `refusal_code`, `response_json`
  - `created_by`, `created_at`, `settled_at`
  - The row is written `PREPARED` **before** the HTTP call. A lost response leaves it `SENT` and is resolved by resending the same key or `GET /operations/:key`. It is never re-keyed.
- `postiz_dispatch`
  - `dispatch_id` (pk), `managed_post_id`, `schedule_generation`, `occurrence`, `due_at`, `status`, `version`, `code`, `release_hash`, `members_json`, `resolution_json`, `last_sequence`
  - Upserted from the feed, keeping the highest `version`.
- `postiz_dispatch_review`
  - `dispatch_id`, `opened_sequence`, `assigned_to`, `decision`, `evidence_json`, `operation_key`
  - Opened on `DISPATCH_OUTCOME_UNKNOWN` or `DISPATCH_PARTIAL`.
- The managed post mirror gets `schedule_generation`, `lifecycle` and `active_schedule_json`.

**Operation key grammar:** `ww:<tenantShort>:<approvalId>:<kind>:<n>`, where `n` is monotonic per approval and kind. It must match `^[A-Za-z0-9._:-]{8,128}$`.

**UI commands.** Each one sends the expected generations it last displayed and shows `409` codes verbatim:

- *Schedule*: date, optional repeat days / max occurrences
- *Publish now*: needs confirmation that shows the release preview
- *Cancel occurrence* / *Cancel remaining from #n* / *Cancel series*
- *Delete*
- *Resolve unknown*: a mandatory evidence note, plus per-member choices for PARTIAL

Before *Schedule* or *Publish now*, W&W computes the release hash locally and compares it with `release-preview`. On a difference it stops and does not send.

**MCP tools.** These are thin wrappers over the same commands, with identical bodies. They are never automatic, and `postiz_resolve_dispatch` requires a human principal:

- `postiz_schedule_post`
- `postiz_publish_post_now`
- `postiz_cancel_post_schedule` (with `scope`)
- `postiz_delete_post`
- `postiz_resolve_dispatch`
- `postiz_get_post_lifecycle`

---

## 11. Files

New:

- `prisma/managed/managed.lifecycle.service.ts`
- `managed.dispatcher.ts`
- `managed.publish.provider.ts`
- `managed.caption.codec.ts`
- `managed/publication.caption.vectors.json`
- `dtos/managed/managed.lifecycle.dto.ts`
- `apps/backend/src/managed-api/managed.lifecycle.controller.ts`

Modified (additive):

- `schema.prisma` (§3)
- `managed.repository.ts`: new `ManagedTx`/reader methods with explicit selects, the token-only select, and the `result` on `createOperation`
- `managed.mode.ts`: the two scopes and the lifecycle gate readers
- `managed.api.module.ts`: controller and providers
- `managed-runtime.module.ts`: dispatcher and `MANAGED_DISPATCHER_PRESENT`
- `managed-runtime.config.ts`: validation of the new variables
- `__tests__/fakes/fake.prisma.db.ts`: three models and the new columns

Unchanged:

- `managed.service.ts` draft paths and `MANAGED_CAPABILITIES`
- `post.activity.ts`
- every workflow
- the fence
- `strip.html.validation.ts`
- `scripts/test-managed-database*` (root's)

---

## 12. Tests and acceptance

All of these run under `jest.managed.config.js`.

**Network guard.** A new setup file, `managed/__tests__/no.outbound.network.ts`, is loaded by every lifecycle spec. It replaces `globalThis.fetch`, `http(s).request/get`, `net.connect`/`createConnection` and `tls.connect` with a refusal for any non-loopback host, and fails the test that tried it. A self-test proves that `fetch('https://example.com')` throws.

**Unit specs (fake DB, real service code):**

- `managed.caption.codec.spec.ts`: every vector, the encode/decode round trip, no double decode, NBSP preserved
- `managed.lifecycle.service.spec.ts`:
  - every gate and refusal code
  - replay, payload mismatch, credential mismatch and kind mismatch
  - 6 concurrent schedules with the same key give 1 schedule; 6 with different keys give 1 winner and `SCHEDULE_GENERATION_CONFLICT`
  - cancel for each scope, including against an ADMITTED occurrence
  - delete retains the rows with `deletedAt`
  - resolve transitions
  - drift and identity change at schedule time
  - the release-hash vectors
  - the draft routes and `/capabilities` give byte-identical answers before and after the feature (golden snapshot)
- `managed.dispatcher.spec.ts` (fake adapter, fake clock):
  - admission refusals each produce NOT_SENT with no adapter call
  - each adapter outcome maps as in §7
  - a crash between admission and settle (the process is killed after the adapter promise starts) recovers to UNKNOWN and the adapter count stays 1
  - a stale lease holder's settle is refused
  - lease loss before sending means no call
  - pending → ready → finalize uses one FINALIZE row
  - thread delays, PARTIAL, and repeat materialization only after PUBLISHED, with anchored due times
  - the window closing between schedule and due time gives NOT_SENT WINDOW_CLOSED
- `managed.publish.provider.spec.ts`: the real upstream class of each candidate runs with scripted `fetch`, checking the exact message bytes and the outcome mapping. The empty registry is the default.
- `post.activity.managed.spec.ts` and `managed.effects.spec.ts` are re-run unchanged and must still pass. This proves the live guards are intact.

**HTTP and worker acceptance** (`managed-runtime/__tests__/lifecycle.acceptance.spec.ts`):

- A real `ManagedRuntimeModule` Nest app on loopback, with the real controller, guards, throttler (Redis fake), real `ManagedLifecycleService`, real `ManagedDispatcher` and a fake adapter registered through the factory's test seam.
- It covers create draft → schedule → the clock advances → the dispatcher publishes → the feed shows each event in order.
- Then a repeat publishes twice and is cancelled with `SERIES`, and delete is checked.
- It also checks lost-response replay over HTTP, `LIFECYCLE_NOT_AVAILABLE` on an `AppModule`-like composition without the token, every gate OFF by default, and that the 201st request across lifecycle and draft routes is throttled.

**Actual PostgreSQL** (`managed/__tests__/lifecycle.actual-pg.spec.ts`, run by root's existing PG18 harness):

- Production Prisma against the regenerated baseline.
- Concurrent schedule/cancel/delete races under the real row lock.
- A dispatcher crash between commit and settle, simulated by a child process killed with `SIGKILL`, recovers to UNKNOWN.
- Dense sequences.
- `ManagedOperation.result` replay.
- Old rows (null/default columns) still read for drafts.
- The fake adapter only.

Root decides whether its harness picks this spec up. This plan does not edit the harness.

---

## 13. Blockers and open decisions (none of them can be lifted by code here)

- **B1 Media delivery.** The runtime's storage is private and never served (`deployment.md`). URL-transport providers, Instagram among them, fetch media from a public URL. A media post needs one of two things, and both are hosting and data-exposure decisions for the owner:
  - a signed, short-lived, digest-pinned capability URL served by the runtime, which needs public ingress
  - a provider byte-upload path

  Until then media schedules refuse with `MEDIA_DELIVERY_NOT_QUALIFIED`, and only text-only posts can be admitted.
- **B2 Outbound network.** `deployment.md` states the runtime needs no outbound network. The dispatcher needs egress to provider hosts. The hosting, egress allowlist and container requalification are open.
- **B3 Provider qualification.** No adapter is qualified. For each provider, someone must prove with consent on a real test account:
  - that the exact text is published (`textTransport`)
  - which errors are "not sent" and which are "unknown"
  - what pending/finalize does
  - whether comments thread

  The local fakes cannot prove these.
- **B4 Accounts and tokens.** No channel exists in the runtime until owner consent connects one. Token refresh is refused for managed organizations, so an expired token yields `REJECTED CHANNEL_REFRESH_NEEDED`. A managed refresh path would be a separate design.
- **B5 Unfenced lease.** The Redis lease carries no fencing token into PostgreSQL or the provider. A process paused after losing the lease could still send one call before it exits. The call row bounds this to one UNKNOWN, never a silent duplicate. Hosted single-instance discipline stays an operator requirement.
- **B6 Schema rollout.** Root must regenerate and re-pin the baseline. There is no reviewed additive diff for an existing managed database.
- **B7 Window.** The access window ends at `2026-11-10T23:00Z`. Gates refuse at or after that time, and repeats that would run past it expire.
- **B8 Not built here.** Platform-side deletion of published posts, editing a published post, plugs, webhooks and notifications. None of these is part of upstream delete or schedule parity as defined in §6.
