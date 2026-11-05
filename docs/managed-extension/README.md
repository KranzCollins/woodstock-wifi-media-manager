# W&W managed-organization extension (local prototype)

This is a locally implemented, undeployed managed-organization extension for an owned Postiz fork. W&W is the intended sole DRAFT writer for enrolled organizations. Authentication, durable enrollment, early effect guards and a Prisma write boundary enforce that intent on the covered paths below. The boundary is not a claim that every future Postiz model or raw SQL writer is covered.

On 2026-11-05 the final combined managed suite passed 1,008 tests in 34 suites and the isolated runtime production build passed. Actual PostgreSQL/Nest HTTP qualification separately covers concurrent create/edit, private media, durable creative request receipts and crash recovery. Creative provider execution is faked; no paid generation or social-provider effect was performed. See [deployment](deployment.md), [creative runtime](creative-runtime.md) and the evidence directory for the precise proof boundaries. A final commit-bound container rebuild and hosted qualification are separate gates; local tests are not activation or full W&W parity completion.

## Upstream pin, license and changes

- Upstream: Postiz (`gitroomhq/postiz-app`), AGPL-3.0. The license is in
  `/LICENSE` and has not been modified. This extension is a modification of
  that work and is distributed under the same license. Upstream source notices
  are kept as they are.
- Pinned base commit: `bd8353f09f8dbaec54f15985f26d34b56ac69636`
  (`Merge remote-tracking branch 'origin/main'`), branch
  `codex/ww-managed-prototype`.
- The exact extension changes are listed under "File ownership" below. Nothing
  outside that list was changed.

## Scope and non-goals

In scope:

- An opt-in managed mode that is **disabled by default**.
- Service authentication separate from cookies/API keys.
- A read-only channel view with identity bindings.
- DRAFT create and expected-revision edit, with idempotent operation keys.
- Media byte digests.
- A post inventory and a durable change feed.
- Refusal of covered competing writers and managed publish dispatch.

Out of scope (refused or deliberately not built):

- Publishing, scheduling (`QUEUE`), deleting or replacing posts.
- Live channel connection/reconnection and helper effects without separate owner consent and qualification. The dedicated consent and helper protocols are implemented and default OFF.
- Paid creative execution without separate rights, funding and kind-specific qualification. Image, video and clipping adapters are implemented and tested with fakes; credit purchases, top-ups and billing are not provided.
- Any Postiz Cloud or production change.

The managed API has no social publish implementation. Covered mutation routes refuse before provider effects. Existing read-only analytics/helper paths are not universally blocked; see limitations. Fakes are confined to tests.

## Enabling (operator authority only)

Operator configuration selects allowed organizations and credentials. Durable database enrollments prevent an accidentally changed environment from turning off protection after enrollment. A caller cannot choose an organization; the credential supplies it. Startup requires the managed schema to exist even before the first enrollment.

| Variable | Meaning |
| --- | --- |
| `POSTIZ_MANAGED_MODE` | Must be exactly `enabled`. Without durable enrollments, other values leave routes unmounted. Startup checks all retained enrollments; missing mode, missing enrolled IDs or an unreadable/missing enrollment table prevents startup before serving requests or starting Temporal activities. |
| `POSTIZ_MANAGED_ORGANIZATIONS` | Comma-separated exact organization ids. No wildcards, no prefixes. |
| `POSTIZ_MANAGED_CREDENTIALS` | JSON array of `{ "id", "organizationId", "tokenSha256", "scopes": [] }`. Only the SHA-256 (hex) of each token is stored. A credential whose `organizationId` is not in the allowlist is ignored. |
| `POSTIZ_MANAGED_RATE_LIMIT` | Requests per hour per **organization**, shared by every managed route and credential of it (default and ceiling `200`; a higher value is clamped to `200`). Redis-backed `@nestjs/throttler`, read once when the controller is loaded. |
| `POSTIZ_MANAGED_MAX_DIGEST_BYTES` | Upper bound for a private storage read when verifying existing media (default 64 MiB). |

Scopes: `channels:read`, `channels:qualify`, `posts:read`, `posts:write`,
`media:write`, `media:upload`. `media:upload` covers only the reserved
upload routes and is meant for the W&W ingest worker's own credential;
`media:write` does not grant it.

Authentication: `Authorization: Bearer <token>` on `/managed/v1/*`, where the
token is at least 32 characters. Cookies, `auth` headers, Postiz API keys, OAuth
`pos_` tokens, `x-postiz-org` and `showorg` are never read on these routes.
Requests that carry `x-postiz-org`, `showorg` or `impersonate` are rejected so
that nobody assumes an override works. A token is compared by its SHA-256
digest with `timingSafeEqual`.

Bounded inputs:

- JSON bodies use express' default 100 kB limit (`/managed` is not in the 50 MB
  list).
- A reserved upload body is raw `application/octet-stream`, at most the
  reserved `byteLength` (≤ 20 MiB, the whole W&W file bound). It is cut off
  in the stream at that size, and it is only read after the attempt holds the
  reservation.
- At most 20 members per post and 10 media per member.
- Content is limited to 100 000 characters and settings to 32 kB of JSON.
- Page limits are 1..100.
- Operation keys must match `^[A-Za-z0-9._:-]{8,128}$`.

## HTTP contract (`/managed/v1`)

All writes return `409` with a stable `code` on a conflict, and `422` when the
media proof is missing. Errors look like `{ "code": "...", "msg": "..." }`.

### Channels

`GET /channels` (`channels:read`)

```json
[{
  "integrationId": "cl...",
  "providerIdentifier": "linkedin-page",
  "displayName": "W&W",
  "socialIdentity": { "internalId": "123", "profile": "ww" },
  "connection": { "disabled": false, "refreshNeeded": false, "inBetweenSteps": false, "deleted": false },
  "binding": {
    "generation": 2,
    "status": "QUALIFIED",
    "identityFingerprint": "sha256:…",
    "boundIdentity": { "providerIdentifier": "linkedin-page", "internalId": "123", "profile": "ww" },
    "qualifiedAt": "…", "pausedAt": null
  },
  "identityEvidence": "RECORDED_IN_POSTIZ_NOT_UPSTREAM_VERIFIED"
}]
```

Never returned: tokens, refresh tokens, `customInstanceDetails` (which can hold
private keys or app secrets), `additionalSettings`, whole rows, picture or other
URLs/paths, user or customer emails.

- `socialIdentity` is what Postiz has **recorded**. It is not a fresh upstream
  verification.
- A binding starts as `PENDING_QUALIFICATION` with generation 1.
- `generation` is monotonic. It goes up on every binding transition: qualify,
  pause, requalify.
- If the recorded identity under the same integration id changes, the binding
  moves to `PAUSED_IDENTITY_CHANGED` with a new generation, and writes are
  refused. The identity is `providerIdentifier`, `internalId`, `profile`,
  `rootInternalId` and deleted.

`POST /channels/:integrationId/qualify` (`channels:qualify`)
`{ "expectedGeneration": 1, "identityFingerprint": "sha256:…" }`

The binding becomes `QUALIFIED` with `generation + 1`, but only if both values
match what the server currently has. This is how a staff member confirms the
identity they saw in W&W. Requalifying after a pause works the same way.

### Media

#### Reserved uploads (`media:upload`)

The only upload path that survives a lost response or a worker crash. The
operation key namespace is separate from the post operation keys.

1. `POST /media/uploads`
   `{ "operationKey", "sha256", "byteLength", "mimeType" }`. `sha256` is
   lowercase hex, `byteLength` is 1..20 MiB (and at most 10 MB for images, the
   media library's own limit), and `mimeType` is one of `image/jpeg|png|gif|
   webp|avif|bmp|tiff` or `video/mp4`. This creates `RESERVED`. No byte is
   sent yet.
   - The key is bound to the org, to the reserving credential, and to
     `requestHash = sha256({kind, byteLength, mimeType, sha256})`.
   - The same key with the same declaration returns the current state with
     `replayed: true`.
   - The same key with another digest, size or type returns
     `409 OPERATION_KEY_PAYLOAD_MISMATCH`.
   - Another credential, even of the same org, gets
     `409 OPERATION_KEY_CREDENTIAL_MISMATCH` on every route.
   - Another org gets `404`.
   - Storage without create-only writes and private read-back is refused with
     `409 STORAGE_HAS_NO_PRIVATE_READ` before anything is reserved.
2. `PUT /media/uploads/:operationKey/content` takes a raw body,
   `Content-Type: application/octet-stream`, and `Content-Length` must equal
   `byteLength`.
   - **Claim, before the body is read.** In one org-locked transaction, a
     `RESERVED` reservation moves to `RECEIVING` with a 15 minute lease. A
     `ManagedMediaUploadAttempt` row is committed in the same transaction. It
     holds the attempt's server-generated storage key
     (`managed-<uploadId>-<attempt>.<ext>`) and stored path.
   - **Write.** The type is sniffed from the first bytes before anything is
     written. The body is capped at `byteLength` and digested while it streams.
     It is written with a create-only write under that recorded key: local
     `open(..., 'wx')`, R2 `PutObject` with `If-None-Match: *`. An existing
     object is never replaced.
   - **Read-back.** A bounded private read of the stored object digests it and
     sniffs its type, and the object version must not change during the read.
     The digest and size must equal both the streamed digest and the
     declaration, and the type must equal the declared type.
   - **Terminal record.** One transaction re-checks that this attempt still
     owns the reservation (`RECEIVING` and the same `attempt`). It then creates
     the `Media` row, the `ManagedMediaEvidence` (`method: "UPLOAD_READBACK"`,
     bound to the stored path and storage version) and a
     `MEDIA_EVIDENCE_RECORDED` event (with `operationKey`) using `nextSequence`.
     It also marks the attempt `STORED` and the reservation `COMPLETED`.
   - Answers:
     - `COMPLETED` returns the stored record (`replayed: true`). The body is
       not stored again.
     - `RECEIVING` within the lease returns `409 UPLOAD_IN_PROGRESS`. After the
       lease it returns `409 UPLOAD_NEEDS_RECOVERY`. Nothing is ever resent
       automatically.
     - `FAILED` returns `409 UPLOAD_FAILED`.
     - Bytes that do not match return `422 MEDIA_DIGEST_MISMATCH`,
       `MEDIA_SIZE_MISMATCH` or `MEDIA_TYPE_MISMATCH`. The attempt closes; the unreferenced object is retained.
     - A write that failed after it may have stored bytes returns
       `409 UPLOAD_NEEDS_RECOVERY` and the attempt stays held.
     - An attempt that lost its reservation to a recovery returns
       `409 UPLOAD_SUPERSEDED`; its unreferenced object is retained, never reused or deleted.
3. `GET /media/uploads/:operationKey` is a pure read:
   `{ operationKey, status, sha256, byteLength, mimeType, attempt,
   leaseExpiresAt, recoverable, recovery, failureReason, media }`, where
   `media = { mediaId, evidenceId, sha256, byteLength, mimeType,
   method: "UPLOAD_READBACK", sequence }` once `COMPLETED`. After a lost
   response, this is how the worker learns the outcome. Storage keys and paths
   are never returned.
4. `POST /media/uploads/:operationKey/recover` works only on a `RECEIVING`
   reservation whose lease and bounded recovery grace ran out. It writes nothing to storage. It reads back the current attempt's **recorded private key and namespace**. Unknown or changed namespace is `READ_FAILED`, never absence. Public URL equality is insufficient:
   - Absent: the attempt is closed as `ABSENT` and the reservation goes back to
     `RESERVED`. The next content `PUT` uses a new recorded key
     (`attempt + 1`).
   - Present and matching: it is completed exactly as above.
   - Present but not matching: the attempt is closed as `BYTES_REJECTED`.
   - Storage cannot answer (`READ_FAILED`, `CHANGED_DURING_READ`): the attempt
     stays `RECEIVING` and is returned with `recovery` set. Recovery can be
     asked again and decides nothing until storage answers.

   A stale writer that finishes later fails the ownership re-check, so its
   commit is refused.

`MANAGED_UPLOAD_MAX_ATTEMPTS = 3`: once the third attempt is closed, the
reservation becomes `FAILED` with `failureReason` and a `MEDIA_UPLOAD_FAILED`
event. `COMPLETED` and `FAILED` are final, and attempt rows are never deleted.

#### Legacy capture upload (deprecated)

`POST /media` returns `410 ENDPOINT_REMOVED` without an upload interceptor. It cannot accept bytes. The internal capture primitive remains for controlled fixtures and existing evidence; it is not an alternative idempotency-free managed HTTP upload route.

`POST /media/:mediaId/verify` (`media:write`)

This covers media that already belongs to the org. It does a bounded **private
storage read**:

- Local storage: a path confined to `UPLOAD_DIRECTORY`.
- Cloudflare R2: only keys under the configured bucket URL, read with
  `GetObject` on the server's own bucket.

There is no URL fetch, so this cannot be used for SSRF. The response is either
`{ status: "VERIFIED", sha256, byteLength, method: "PRIVATE_STORAGE_READ" }` or
`{ status: "UNVERIFIED", reason }`. The reason is one of
`NOT_IN_PRIVATE_STORAGE`, `TOO_LARGE_FOR_BOUNDED_READ`, `READ_FAILED`,
`CHANGED_DURING_READ` or `STORAGE_HAS_NO_PRIVATE_READ`.

Evidence is bound to the media id **and** the exact stored path at capture. If
the stored path changes later, that evidence no longer applies. Media paths are
not returned.

### Posts (DRAFT only)

`POST /posts` (`posts:write`)

```json
{
  "operationKey": "ww:approval:42:create",
  "integrationId": "cl...",
  "expectedBindingGeneration": 2,
  "intendedPublishDate": "2026-11-20T09:00:00.000Z",
  "settings": { "...provider settings..." },
  "members": [
    { "content": "<p>Caption</p>", "delay": 0,
      "media": [{ "mediaId": "…", "sha256": "…" }] }
  ]
}
```

`PUT /posts/:managedPostId` (`posts:write`) takes the same body plus
`expectedRevision`. It is one atomic replacement of the caption, media,
settings and intended date on **the same** Post rows (same ids, same group).
The member count must stay the same, because adding or removing members would
mean creating or deleting rows.

Semantics:

- **Durable operation key.** `operationKey` is unique per organization. The
  server computes `payloadHash = sha256(canonical JSON)`, with keys sorted and
  the date normalized to ISO UTC. The hash covers the operation kind, the post
  id (for edits) and every field of the body.
  - The same key with the same hash returns the stored result with
    `replayed: true`. This holds for retries and for concurrent duplicates.
  - The same key with a different hash returns `409 OPERATION_KEY_PAYLOAD_MISMATCH`.
- **Serialization.** Each managed mutation runs in one Prisma interactive
  transaction. The transaction first takes the org's `ManagedOrganization` row
  lock (the same no-op update pattern as `ClippingRepository.createClips`).
  Concurrent creates with the same key therefore serialize, and the second one
  sees the first one's operation.
- **Edits are expected-revision.** If the revision does not match, the server
  returns `409 REVISION_CONFLICT`. Every revision snapshot is kept in
  `ManagedPostRevision`, so history is preserved even though the Post rows are
  updated in place. Nothing is ever deleted.
- **Channel gate.** The binding must be `QUALIFIED` and must equal
  `expectedBindingGeneration`. If it is not qualified the server returns
  `409 CHANNEL_NOT_QUALIFIED`, and if the generation differs it returns
  `409 BINDING_GENERATION_MISMATCH`.
  - The identity is re-read inside the transaction. If it changed, the binding
    is paused in that same committed transaction and the server returns
    `409 CHANNEL_IDENTITY_CHANGED`.
- **Media gate.** Every `mediaId` must belong to the org and not be deleted.
  Otherwise the server returns `422 MEDIA_NOT_FOUND`, which covers both
  ownership and existence.
  - It must have evidence for its current stored path, otherwise
    `422 MEDIA_PROOF_MISSING`.
  - The caller's `sha256` must equal the server evidence, otherwise
    `422 MEDIA_DIGEST_MISMATCH`.
  - The order of the media and their digests are bound into the revision
    snapshot.
- **State gate.** Edits require every row to be `DRAFT` and not deleted.
  Otherwise the server returns `409 POST_NOT_DRAFT`.
- **Drift detection.** Each managed write stores a fingerprint of the actual
  Post rows. A later mismatch shows up in reads as `integrity.status: "DRIFTED"`,
  and edits are refused with `409 POST_DRIFTED`. A mismatch is only possible if
  something bypassed the fence.

Response: `{ managedPostId, revision, sequence, operationKey, payloadHash, replayed, post }`.

`GET /posts/:managedPostId` and `GET /posts/:managedPostId/revisions` (`posts:read`).
These are database reads. They report the evidence recorded at the revision
and never call storage.

`GET /posts/:managedPostId/media-observation?revision=N` (`posts:read`) is a
fresh, read-only look at private storage for the current revision only. It is
described in `docs/managed-extension/authoring-completion.md`.

### Inventory

`GET /posts?cursor=&limit=` (`posts:read`)

```json
{
  "snapshotSequence": 17,
  "items": [{
    "managedPostId": "…", "group": "…", "integrationId": "…",
    "revision": 2, "bindingGeneration": 2, "lastSequence": 15,
    "createdOperationKey": "…", "lastOperationKey": "…",
    "state": "DRAFT",
    "dates": { "intendedPublishDate": "…", "createdAt": "…", "updatedAt": "…" },
    "settings": {},
    "members": [{ "postId": "…", "position": 0, "role": "ROOT", "parentPostId": null,
                  "content": "…", "delay": 0,
                  "media": [{ "position": 0, "mediaId": "…", "sha256": "…", "byteLength": 1, "mimeType": "image/png",
                              "method": "UPLOAD_CAPTURE", "status": "VERIFIED" }] }],
    "integrity": { "status": "CONSISTENT", "rowFingerprint": "sha256:…" }
  }],
  "nextCursor": "…", "complete": false,
  "coverage": { "managedPosts": 12, "unmanagedRootPostsInOrganization": 3 }
}
```

- The first page reads `snapshotSequence`, the page and the coverage in one
  `RepeatableRead` transaction. The cursor is opaque. It carries the snapshot
  sequence and the keyset (`ManagedPost.id`, which is immutable and never
  deleted).
- **Completeness rule:** the inventory pages, followed by
  `GET /changes?after=snapshotSequence` up to `headSequence`, contain every
  managed post at its latest revision. Dedupe by `managedPostId` and keep the
  highest `revision`.
- `unmanagedRootPostsInOrganization` counts the org's non-deleted root posts
  that are not managed. These are posts that existed before enrollment. The
  inventory does not silently hide them, but it does not take ownership of them
  either.

### Change feed

`GET /changes?after=N&limit=` (`posts:read`)

Returns `{ events: [{ sequence, kind, entityType, entityId, revision, bindingGeneration, operationKey, occurredAt, data }], headSequence, nextAfter, hasMore }`.

- Sequences are dense (no gaps) per organization. Each sequence is allocated
  while the org lock is held, in the same transaction as the mutation, so
  commit order equals sequence order. A reader at `after=N` can never later
  find a committed event with a sequence `<= N`.
- Event kinds:
  - `CHANNEL_BINDING_CREATED`
  - `CHANNEL_QUALIFIED`
  - `CHANNEL_PAUSED_IDENTITY_CHANGED`
  - `MEDIA_EVIDENCE_RECORDED` (with `operationKey` for a reserved upload)
  - `MEDIA_UPLOAD_FAILED` (a reservation that used up its attempts)
  - `POST_CREATED`
  - `POST_REVISED` (the `data` holds the full revision snapshot)
  - `DISPATCH_REFUSED`

## Competing writers (shared boundary)

`managedWriteFence` (Prisma `$use` middleware, registered in `PrismaService`)
intercepts every top-level write (`create*`, `update*`, `upsert`, `delete*`) on
`Post`, `Integration` and `Media`.

- It resolves the target organization from the arguments, or reads it with
  `findUnique`/`findMany` on the same `where`.
- It refuses with `ManagedWriteRefusedError` (HTTP 403, code
  `MANAGED_WRITE_REFUSED`) when the org is managed and the call is not running
  inside `runAsManagedWriter(sameOrgId, …)`.
- If the org cannot be resolved while managed mode is on, it fails closed with
  `MANAGED_FENCE_UNRESOLVED_ORGANIZATION`.

Because it sits below every repository, it covers all of these:

- Dashboard and UI routes (`PostsController`, `MediaController`,
  `IntegrationsController`, including customer/group reassignment, preferences,
  enable/disable, delete and time slots).
- The public API (`/public/v1/*`).
- MCP and agent tools, which call `PostsService`.
- Autopost, comments that rewrite posts, `generatePostsDraft`, sets and
  third-party flows.
- OAuth reconnect (`createOrUpdateIntegration`).
- Worker activities (`changeState`, `updatePost`, media processing).

Unmanaged organizations take the
early return. Their behavior does not change.

Dispatch refusal before any external call (worker):

- `PostActivity.getPost` and `getPostsList` return "no post" for a managed org.
  This applies to every frozen `postWorkflowV1xx`, so the workflow ends before
  the publish sleep.
- `postSocial`, `postSocialPending`, `postComment`, `checkPostStatus`,
  `finalizePost` and `processInternalPlug` throw a non-retryable `BadBody`
  before resolving any provider.
- The `changeState` activity catches the fence refusal and records
  `DISPATCH_REFUSED` instead of writing the row.
- `searchForMissingThreeHoursPosts` skips managed orgs.
- `RefreshIntegrationService.refresh` returns `false` for a managed org before
  calling the provider.
- No workflow file and no activity signature was changed.

External effects refused before the call (`refuseManagedEffect`, HTTP 403
`MANAGED_EFFECT_REFUSED`, or an early return inside a worker/cron body), so
the fence is never the first thing that stops them:

- Channel connect/reconnect: `GET /integrations/social/:integration`, the
  no-auth OAuth callback, `POST /integrations/provider/:id/connect` (page
  selection), and the Telegram / Moltbook connect helpers
  (`/integrations/telegram/updates`, `/integrations/moltbook/*`).
- Channel name/picture change (`/integrations/:id/nickname`) and refresh
  (no-auth refresh route, `RefreshIntegrationService`, the refresh cron).
- Provider tools: `/integrations/function` (and so `/integrations/mentions`,
  which then only reads the mention cache), `/public/v1/integration-trigger`
  and the agent `integrationTrigger` tool.
- Global plugs (`processPlugs`) and internal plugs of a managed channel.
- Media: URL upload, AI image/video generation (before any credit check), and
  the media processor (`submitProcessing` / `checkProcessing` /
  `failProcessing`, which can rewrite an object in place).
- Ordinary uploads, refused by `ManagedEffectGuard` (`@RefuseManagedEffect`).
  Guards run before `FileInterceptor`, so no multipart byte reaches storage.
  The guard covers `/media/upload-server`, `/media/upload-simple`, the R2
  multipart `/media/:endpoint`, the public `/public/v1/upload` and the upload
  widget `/media-widget/upload`.
- Video helpers: `MediaService.videoFunction(orgId, …)` refuses before the
  video provider is resolved. Both route callers (`/media/video/function`,
  public `/video/function`) now pass the org, and so does the agent
  `videoFunctionTool`.
- Third party: `/third-party/:id/submit` (paid `sendData`), `/:id/import` and
  `/function/:id/:functionName` refuse before the integration lookup, the
  third-party call or the storage upload.
- Clipping (every paid step) and autopost (feed load and generation).
- Billing webhooks: `SubscriptionService.modifySubscriptionByOrg` catches and
  logs a fence refusal of a managed org's channel writes, so the rest of the
  plan change is still applied and nothing throws back to the payment provider.

Note: `GET /channels` takes the org lock. It creates a binding the first time
it sees a channel and pauses a binding whose identity changed, and both of
these land in the feed. So this read can also write.

## File ownership (all extension changes)

New:

- `docs/managed-extension/README.md`
- `libraries/nestjs-libraries/src/database/prisma/managed/`
  - `managed.mode.ts`: env config, exact allowlist, credentials, timing-safe
    token match.
  - `managed.write.fence.ts`: Prisma middleware and the `runAsManagedWriter`
    context.
  - `managed.errors.ts`: the stable `{ code, msg }` exceptions and
    `ManagedWriteRefusedError`.
  - `managed.repository.ts`: all Prisma access, the locked transaction, the
    RepeatableRead reader and credential-safe selects.
  - `managed.service.ts`: channels and bindings, the create/edit gates, the
    payload hash, inventory and feed.
  - `managed.media.service.ts`: recording upload captures, the bounded
    private read, and the reserved upload protocol (reserve, claim, write,
    read-back, settle, recover).
  - `__tests__/*.spec.ts`
  - `__tests__/fakes/fake.prisma.db.ts`: FAKE in-memory Prisma.
  - `__tests__/fakes/prisma.client.fake.ts`: FAKE `@prisma/client`.
- `libraries/nestjs-libraries/src/dtos/managed/managed.post.dto.ts`,
  `managed.query.dto.ts` and `managed.media.upload.dto.ts`
- `libraries/nestjs-libraries/src/user/managed.credential.from.request.ts`
- `apps/backend/src/services/auth/managed.auth.middleware.ts`,
  `managed.scope.guard.ts` and `managed.effect.guard.ts`
- `apps/backend/src/managed-api/managed.api.module.ts` and
  `routes/v1/managed.controller.ts`
- `apps/backend/src/managed-api/__tests__/managed.auth.middleware.spec.ts` and
  `managed.effect.guard.spec.ts`
- `apps/orchestrator/src/activities/__tests__/post.activity.managed.spec.ts`
- `jest.managed.config.js`, `tsconfig.managed.spec.json`

Modified (unmanaged behavior is retained except durable enrollment startup and reserved-object alias protection):

- `libraries/nestjs-libraries/src/database/prisma/schema.prisma`: 9 new
  models (`ManagedMediaUpload` and `ManagedMediaUploadAttempt` are the
  reserved-upload ones). No existing model or column changed.
- `.../prisma/prisma.service.ts`: `this.$use(managedWriteFence(this))`.
- `.../prisma/database.module.ts`: the 3 managed providers.
- `libraries/nestjs-libraries/src/upload/upload.interface.ts`: optional
  `openPrivateReadStream`, `privateObjectVersion`, `objectPath` and
  `createObjectAt` (create-only), `StorageObjectExistsError` and
  `STORAGE_OBJECT_KEY`. They are implemented in `local.storage.ts` and
  `cloudflare.storage.ts`.
- Early refusals (one guard line or decorator each, unmanaged behavior
  unchanged): `apps/backend/src/api/routes/media.controller.ts`,
  `media.widget.controller.ts`, `third-party.controller.ts`,
  `public-api/routes/v1/public.integrations.controller.ts`,
  `.../prisma/media/media.service.ts` (`videoFunction` takes `orgId` first),
  `.../chat/tools/video.function.tool.ts`.
- `.../upload/custom.upload.validation.ts`: `digestStream()` and an optional
  `observer` parameter on `uploadStreamToStorage`.
- `.../upload/multer.stream.engine.ts`: an optional capture flag,
  `captureUploadOptions()` and `CapturedUploadFile.capturedDigest`.
- `libraries/nestjs-libraries/src/throttler/throttler.provider.ts`:
  `ThrottlerManagedCredentialGuard`.
- `libraries/nestjs-libraries/src/integrations/refresh.integration.service.ts`:
  an early `false` for a managed org.
- `apps/orchestrator/src/activities/post.activity.ts`: guards inside the
  existing activity bodies. `ManagedService` is injected. No signature
  changed.
- `apps/backend/src/app.module.ts`: imports `ManagedApiModule`.

## Tests

Run them with `pnpm exec jest -c jest.managed.config.js`.

- The root `jest.config.ts` depends on `@nx/jest`, which is not installed in
  this repo.
- The specs are transpile-only, so type-checking is separate. Run
  `pnpm run prisma-generate` first, because the schema changed, and then
  `tsc --noEmit` for `apps/backend` and `apps/orchestrator`.
- All the specs use FAKE collaborators, and `@prisma/client` is mapped to a
  FAKE.
- The content gate is **not** faked: `managed.service.spec.ts` runs the real
  `sanitizePostContent` (DOMPurify on jsdom 29), and its first content test
  fails if a stand-in is used. jsdom 29 pulls ESM-only packages
  (`@exodus/bytes`, `parse5` 8, `entities` 8, …) that Node loads with
  `require(esm)` but Jest's module registry cannot, so
  `jest.managed.config.js` runs only those packages through
  `@babel/plugin-transform-modules-commonjs` (`ESM_PACKAGES`). If another
  ESM-only dependency shows up as `SyntaxError: Unexpected token 'export'`,
  add its package name there; never map the sanitizer to a mock.

| Spec | What it proves |
| --- | --- |
| `managed.mode.spec.ts` | Disabled by default. The allowlist matches exactly. Credentials for orgs off the allowlist, unknown scopes or ambiguous entries are ignored. Malformed config fails closed. |
| `managed.auth.middleware.spec.ts` | There is no cookie, `auth` header, API key or `pos_` fallback. Override headers are refused. The org comes from the credential. Nothing is mounted while disabled. A route with a missing or undeclared scope is refused. Token attempts are bounded per address and fail closed without Redis. The controller's real `@Throttle` metadata gives one 200 / hour budget per organization across every route and credential (the 201st call is a `ThrottlerException`), and another organization keeps its own budget. |
| `managed.effects.spec.ts` | Each external-effect entry point listed above refuses a managed org before the FAKE provider, AI, processor, ingest or feed is reached (and `fetch` is never called), and still reaches it for an unmanaged org. A billing plan change of a managed org completes although its channel writes are refused. |
| `managed.write.fence.spec.ts` | Every existing write shape on Post, Integration and Media for a managed org is refused, including the worker's id-only `changeState`, sweeps by group, OAuth upsert and customer reassignment. Unmanaged writes pass. The writer context is scoped to one org. An unresolvable create fails closed. The low-level disabled-mode fence is a pass-through, but the separate startup enrollment guard prevents a process with retained enrollments from reaching that state. |
| `managed.service.spec.ts` | Runs the real repository and service on the FAKE DB. Channel output and Prisma selects contain no secrets. Pending → qualified. The exact generation and fingerprint are required. An identity change or deletion pauses the binding (committed) until requalification. Create replay, key/payload conflict, canonical hashing, 6 concurrent duplicate creates → 1 post. Edits keep the same rows and the full history. Stale and concurrent edits → one winner. No member add or remove. Drift and non-DRAFT are refused. Unknown, foreign, unproven, mismatched or path-changed media are refused. Sequences are dense. Inventory plus feed is complete under racing creates and edits. Coverage, cursor tampering and org isolation. |
| `managed.media.spec.ts` | The capture digest equals the SHA-256 of the bytes the FAKE storage received. Local private reads stay confined: outside paths, `..` and symlinks are refused. Verify gives VERIFIED, NOT_IN_PRIVATE_STORAGE, TOO_LARGE, READ_FAILED, CHANGED_DURING_READ or STORAGE_HAS_NO_PRIVATE_READ, and only for the org's own media. `fetch` is never called. An internal capture without proof is rejected. |
| `managed.media.upload.spec.ts` | Real `LocalStorage` in a temp dir, FAKE DB, FAKE sniffer. Covers a lost successful response (status, resend and re-reserve return the same media and evidence with one write), concurrent duplicates (6 reserves give 1 row, 2 content sends give 1 write and `UPLOAD_IN_PROGRESS`), and a changed payload or other credential or org being refused. A worker death before the write recovers to a new recorded key, never a resend. A stale writer is superseded; its object is retained and never adopted. A worker death after the write (terminal transaction lost) completes from a read-back. A write failure after storing is held. Digest, size (header and actual) and type drift are refused, and three attempts give `FAILED`. Over-long bodies are cut off. Unknown keys get 404 with no rows. Storage that cannot answer is held until it can. Create-only local writes never replace bytes and refuse non-media keys. |
| `managed.effect.guard.spec.ts` | A real Nest app with `FileInterceptor` and a FAKE multer engine on loopback shows the guard refuses a managed org before any byte reaches storage, and stores as before for an unmanaged org or with the mode off. The real dashboard and widget upload handlers carry the guard. The third-party submit, function and import routes refuse before the lookup, the third party and storage. |
| `refresh.guard.spec.ts` | A managed org never reaches the FAKE provider's `refreshToken` or `createOrUpdateIntegration`. An unmanaged org is unchanged. |
| `post.activity.managed.spec.ts` | `getPost` and `getPostsList` return "no post". `postSocial`, `postSocialPending`, `postComment`, `checkPostStatus`, `finalizePost` and `processInternalPlug` refuse before the FAKE provider is resolved. `changeState` records `DISPATCH_REFUSED` instead of writing. The missed-post sweep skips managed orgs. Unmanaged orgs and disabled mode publish to the FAKE provider as before. |

## Qualification limits and remaining work

- The actual PostgreSQL18 harness creates and removes only its own private cluster, applies the complete schema, and exercises production Prisma with real local storage. This does not qualify hosted migrations, backup restoration, Redis admission, proxy behavior or deployment.
- Reserved upload attempts pin private namespace before a write. Local identity uses real directory path/device/inode; R2 uses endpoint account and bucket name. A deleted and recreated R2 bucket with the same name is not distinguishable. A local directory swap between checking and opening is a remaining operator-level race.
- A writer deadline aborts this process's request; it cannot prove a storage server will not commit bytes already received. Closed attempts have unique nonreused keys. Late objects stay unreferenced and are never deleted automatically. A dead writer cannot append its final observation. No orphan sweeper exists.
- Local files are not fsynced. Current evidence must be checked again before accepting a later draft; a completed upload receipt alone is not current byte proof. Stored-media private namespace protection is still under implementation at this checkpoint.
- R2 create-only PUT, exact-length streaming, bucket lookup, private reads and proxy disconnect behavior have not been qualified on hosted infrastructure. Tests of R2 behavior use fakes.
- The Prisma fence covers top-level Post, Integration and Media writes, including tested interactive transactions. Raw SQL, nested writes from other models and new future writers require separate review. TagsPosts and collaboration Comments are not fenced. Drift detection does not excuse a missing write guard.
- The fence's organization lookup uses the base Prisma client while an interactive transaction may already hold a connection; pool exhaustion and load behavior require hosted qualification.
- Paid post generation, short-link creation, Copilot chat/agent calls, third-party connection/delete and managed notification email have early guards and focused refusal tests. Some existing read-only provider routes still read tokens and contact providers; no blanket zero-outbound guarantee is claimed.
- Exact upstream social account identity is not verified: channel evidence remains `RECORDED_IN_POSTIZ_NOT_UPSTREAM_VERIFIED`.
- Integration updates sharing a root account with a managed organization are refused as a whole, including an unmanaged sibling reconnect. Operator resolution must preserve the managed boundary.
- Unknown storage results stay held without a deadline-based assumption of success or absence. Recovery needs positive evidence; another operation key must not be used to bypass uncertainty.
- No production, real clients, publication, scheduling, deletion, reconnect, paid generation or new paid hosting has been exercised. An owned deployment and account-owner consent remain external activation requirements.
