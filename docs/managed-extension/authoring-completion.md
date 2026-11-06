# Managed authoring: completion note (2026-11-04)

Scope: TEST-001 / ww.test.acc, DRAFT only. Nothing here publishes, schedules,
deletes, reconnects, generates or changes hosting. The author did not run any
tests; the root operator runs them.

## 1. Authoring contract (create, edit, members, media options)

- **Members are positional.** On edit, the root and each kept child keep
  their Post row id and position. Members added past the old end become new
  rows chained after the last kept row. Members past the new end are retired.
- **Retirement.** A retired row is unlinked (`parentPostId: null`) and
  soft-deleted (`deletedAt`), which is how upstream `createOrUpdatePost`
  retires a removed comment. It is never hard-deleted and never reused. When
  the list grows again, new rows are created. Every revision snapshot lists
  all members retired so far in `retiredMembers` (`postId`, `position` at
  retirement, `retiredAtRevision`). The key is absent while there are none.
- **Gates.** Retiring a row that left DRAFT fails the whole transaction
  (`409 POST_NOT_DRAFT`), and no row changes. A retired row changed outside
  the managed path shows up as `DRIFTED` and blocks edits (`409 POST_DRIFTED`).
- **Media options.** `alt`, `thumbnail` and `thumbnailTimestampMs` only come
  from the request, never from the library row. Each key is written to
  `Post.image` only when it was sent. A request without options hashes as it
  did before options existed.
  - A cover (`thumbnail`) is proven like any other media, and its evidence
    is bound into the snapshot.
  - Covers and offsets only apply to evidence-proven `video/*`.
  - A cover must be a proven JPEG or PNG.
  - `thumbnail` and `thumbnailTimestampMs` cannot be sent together.
  - The offset is stored as sent, with
    `thumbnailTimestampBounds: 'UNQUALIFIED_DURATION_UNKNOWN'`.
- **Operation status.** `GET /operations/:operationKey` (`posts:read`) is a
  pure read.
  - `ABSENT` is only true as of `asOfSequence`.
  - `COMMITTED` returns the stored snapshot, with `ack: CURRENT | HISTORICAL`.
- **Immutable history.** Revision snapshots, payload hashes, operations and
  feed events are only ever inserted. Nothing in this change rewrites them.

Review result: no correctness hole was found that needed a code change. The
1 -> 3 -> 2 -> 3 path, replay, concurrent membership edits, retiring a
non-DRAFT row and drift on a retired row are all covered in
`managed.service.spec.ts`.

## 2. Current-media observation

`GET /managed/v1/posts/:managedPostId/media-observation?revision=N`, scope
`posts:read`. `managedPostId` is a UUID and `revision` is an integer of at
least 1 (`ManagedMediaObservationQueryDto`).

The endpoint goes through these steps:

1. **Start.** It reads, in one RepeatableRead transaction, the post, the
   snapshot of its current revision, the integration identity, the binding
   (as stored, never reconciled), all group rows, and the media and evidence
   rows for every id the revision references, including covers.
2. **Precondition.** If `N` is not the current revision, it refuses with
   `409 REVISION_CONFLICT`. An unknown post, or a post in another
   organization, gets `404 NOT_FOUND`. Storage is not read in either case.
3. **Bound.** It reads at most 20 members × 10 media × (media + cover) = 400
   identities. More than that gets `422 OBSERVATION_BOUND_EXCEEDED`, which the
   DTO caps make unreachable. Each distinct object is read once, one after
   another. Each read is bounded by the recorded `byteLength`, and evidence
   larger than `min(managed digest bound, 64 MiB)` is not read.
   - **Total bytes.** The recorded `byteLength` of the distinct
     `mediaId:evidenceId` pairs is added up before any storage call. Above
     256 MiB the request is refused with `422 OBSERVATION_BOUND_EXCEEDED`.
     Nothing is read, written or recorded.
   - **One at a time.** An organization can have only one observation in
     flight per backend process. A second one gets
     `409 OBSERVATION_IN_PROGRESS` ("Another media observation of this
     organization is in progress"), before any read. The client may retry it
     once the first one has answered. The slot is released in a `finally`
     block: on success, refusal, a thrown read or database error, and on
     abort. Other organizations are not held up.
   - **Deadline and cancellation.** The reads must finish within 45 s
     (`AbortSignal.timeout`). The signal is checked between objects and
     attached to the stream that is being digested. That is all the 45 s covers: it stops a streamed read and
     keeps a new object from starting. It is not a deadline on the storage
     metadata calls (`objectNamespace`, `objectVersionAt`, `openObjectAt`),
     which take no signal; one that hangs holds the organization's slot
     until it answers. This is deliberate: racing those calls against the
     deadline would free the slot while their requests keep running, and
     repeated calls would pile them up. When the client closes the
     response, the controller aborts the same reads; a response that is
     already destroyed or finished when the route runs starts aborted. A
     stopped
     observation answers `INDETERMINATE` with
     `OBSERVATION_DEADLINE_EXCEEDED` or `OBSERVATION_CANCELLED`. It claims
     nothing about any identity and skips the end read.
   - No database transaction is held while storage is read.
4. **Per object** (`ManagedMediaService.observeEvidence`):
   - The database must still hold the exact evidence the revision bound:
     same id, sha256 and size.
   - The evidence must be pinned (key, namespace and version).
   - The media's path must still address the pinned key.
   - Keys must resolve in the pinned namespace before and after the read.
   - The storage version must be unchanged across the read
     (`readBackKey`).
   - The bytes must have the recorded digest and size, at the recorded
     version.
   - A public URL is never fetched.
5. **End.** It reads the same state again and compares three fingerprints:
   - **post:** revision, lastSequence, the stored and recomputed row
     fingerprints;
   - **channel:** the identity fingerprint, plus the binding's generation,
     status and fingerprint;
   - **records:** media id, path, status and evidence id for each media.

   If any of them differs, the answer is `INDETERMINATE` and no identity
   claim is made.

Nothing is written at any point: no evidence, re-pin, backfill, operation,
event, binding reconciliation, Post row or snapshot.

### Response (closed)

```ts
// shared
{
  managedPostId: string;
  revision: number;                       // the observed (current) revision
  observation: 'PRIVATE_STORAGE_READ_BY_PINNED_KEY';
  startedAt: string; finishedAt: string;  // ISO
  binding: {
    atRevisionGeneration: number;         // bound by the revision
    generation: number | null;            // as read at the start
    status: string | null;
  };
}
// either
& {
  status: 'VERIFIED' | 'UNVERIFIED' | 'NO_MEDIA_REFERENCED';
  reasons: ('MEDIA_UNVERIFIED' | 'ROWS_DRIFTED')[];
  rows: 'CONSISTENT' | 'DRIFTED';
  media: {
    memberPosition: number; mediaPosition: number;
    role: 'MEDIA' | 'THUMBNAIL';
    mediaId: string; evidenceId: string; sha256: string;
    byteLength: number; mimeType: string | null;  // as recorded
    status: 'VERIFIED' | 'UNVERIFIED';
    reason?: 'MEDIA_REMOVED' | 'MEDIA_NOT_READY' | 'EVIDENCE_MISSING'
      | 'EVIDENCE_CHANGED_SINCE_REVISION' | 'STORAGE_HAS_NO_PRIVATE_READ'
      | 'STORAGE_IDENTITY_UNPROVEN' | 'STORAGE_IDENTITY_CHANGED'
      | 'NOT_IN_PRIVATE_STORAGE' | 'READ_FAILED' | 'CHANGED_DURING_READ'
      | 'TOO_LARGE_FOR_BOUNDED_READ' | 'BYTES_MISMATCH'
      | 'STORAGE_VERSION_CHANGED';
    observedAt: string;
  }[];
}
// or
& {
  status: 'INDETERMINATE';
  reasons: ('POST_CHANGED_DURING_OBSERVATION'
    | 'BINDING_CHANGED_DURING_OBSERVATION'
    | 'MEDIA_RECORD_CHANGED_DURING_OBSERVATION'
    | 'OBSERVATION_DEADLINE_EXCEEDED'      // alone; the reads were stopped
    | 'OBSERVATION_CANCELLED')[];          // alone; the client went away
}
```

`GET /capabilities` also declares the bounds in `posts.mediaObservation`. It
adds `maxRecordedBytes: 268435456`, `deadlineMs: 45000` and
`inFlight: 'ONE_PER_ORGANIZATION_PER_PROCESS'` and leaves the existing keys
unchanged.

`VERIFIED` means three things: every identity is VERIFIED, the rows are
CONSISTENT, and nothing changed between the start and end reads. A post
without media answers `NO_MEDIA_REFERENCED`, which is not `VERIFIED`. No
storage key, namespace, version, path or credential id is returned.

`GET /posts/:managedPostId` has not changed. It is still a database read of
what the revision recorded (`EVIDENCE_RECORDED_AT_REVISION` and the others)
and never calls storage. A test asserts this.

## 3. Caption capability (capabilities v2)

`GET /capabilities` is now `ww-managed-capabilities-v2`. The caption vectors
are unchanged and stay at `ww-canonical-caption-vectors-v1`; only the codec
metadata in the fixture changed.

- No codec is `recommended` any more. `content.publication` is
  `{ qualified: false, converter: 'stripHtmlValidation', checkedModes: ['normal'] }`.
- Each codec now declares `reviewText: 'EXACT'` (`postContentPlainText`
  round trip, vector-tested), `draftStorage`, `publication: 'NOT_QUALIFIED'`
  and `publicationDefects`:
  - `ww-plain-escape-v1`:
    - `draftStorage: 'ACCEPTED_UNCHECKED_ESCAPES'`
    - defect `ENTITIES_REACH_PROVIDER_ENCODED`
  - `ww-plain-paragraph-escape-v1`:
    - `draftStorage: 'RECOMMENDED'`
    - defects `NBSP_REACHES_PROVIDER_AS_SPACE` and
      `LITERAL_ENTITY_TEXT_DECODED_TWICE` ("&lt;b&gt;" reaches a provider as
      "<b>")
- The upstream converter has not been changed, and publishing has not been
  enabled.
- A W&W client pinned to v1 must fail closed and update its pin.

## 4. Repeat `/verify` keeps the existing evidence (review D1)

`POST /managed/v1/media/:mediaId/verify` on media whose pinned evidence
still describes the object now writes nothing. "Still describes" means the
key and namespace are unchanged, the storage version is the recorded one
before and after the read, and the bytes have the recorded sha256 and size.
In that case:

- No evidence row and no event are written.
- The response is `VERIFIED` with the existing evidence's `mimeType` and
  `method`, so `method` can now also be `UPLOAD_READBACK` or
  `UPLOAD_CAPTURE`.
- An uploaded video and its cover can still be used in drafts, and the
  observation of revisions bound to that evidence stays exact.

Before it answers `VERIFIED` this way, it reads the media and its evidence
again (`ManagedRepository.read`, no transaction held during the storage
read). The media path and the evidence id must be the same, and the
evidence's storage version, sha256, size, namespace and key unchanged.
Otherwise it answers `UNVERIFIED` with `CHANGED_DURING_READ` and still
writes nothing.

If the object was rewritten (a new version, or other bytes), the request is
still answered by a new `PRIVATE_STORAGE_READ` read, never by the old proof.
A changed key or namespace is still `STORAGE_IDENTITY_CHANGED`. Evidence
missing its key, namespace or storage version is `STORAGE_IDENTITY_UNPROVEN`
before any private read, so it is never replaced by a new row that would
drop the type it proved.

## Remaining limits

- An observation is a point-in-time result as of `finishedAt`. It is not a
  lease. Storage can change right after the read, and a change that is
  reverted inside the read window between two version checks (ABA) can only
  be caught by the adapter's version semantics.
- The binding status is reported, not gated. A paused or requalified channel
  can still give `VERIFIED` media. W&W must also check `binding`.
- Retired members' media are not observed, because they are not current.
- `mimeType` is the recorded one. `PRIVATE_STORAGE_READ` evidence has
  `null`.
- Cost: up to 256 MiB of recorded bytes and 45 s per call, one call per
  organization at a time, under the shared `posts:read` rate budget. These
  bounds hold **within one backend process only**:
  - The in-flight slot is an in-memory set. Each host or replica behind a load
    balancer allows its own observation, so N processes allow up to N
    concurrent observations per organization. There is no distributed lock.
  - The deadline stops this process's streamed reads. Once the stream is
    destroyed, the read stops, but bytes already requested from storage are
    still delivered.
  - The deadline does not bound the metadata calls (`objectNamespace`,
    `objectVersionAt`, `openObjectAt`). They take no cancellation, so a hung
    storage metadata call keeps the organization's slot (and the request)
    open until storage answers. Fixing that needs cancellable adapter
    methods, which are out of scope here.
  - The 200/hour rate budget is unchanged.
- Local storage only. R2 or hosted storage is not qualified, and neither is
  a distributed (multi-process) deployment.
- The publication converter was only vector-checked in `normal` mode.
- Real PostgreSQL and HTTP cases (observation writes nothing, revision or
  binding races, refusals) are left to the root operator's actual-PG suite.

## Files changed in this job

- `libraries/nestjs-libraries/src/database/prisma/managed/managed.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/managed/managed.media.service.ts`
  (the new `observeEvidence` method and its types; in `verifyStoredMedia`
  the repeat-verify re-read and the unversioned-pin refusal)
- `libraries/nestjs-libraries/src/database/prisma/managed/managed.errors.ts`
  (`OBSERVATION_BOUND_EXCEEDED`)
- `libraries/nestjs-libraries/src/dtos/managed/managed.query.dto.ts`
- `libraries/nestjs-libraries/src/database/prisma/managed/canonical.caption.vectors.json`
- `apps/backend/src/managed-api/routes/v1/managed.controller.ts`
- `libraries/nestjs-libraries/src/database/prisma/managed/__tests__/managed.service.spec.ts`
- `libraries/nestjs-libraries/src/database/prisma/managed/__tests__/managed.media.spec.ts`
- `apps/backend/src/managed-api/__tests__/managed.controller.spec.ts`
- `docs/managed-extension/README.md` (pointer only), this note
