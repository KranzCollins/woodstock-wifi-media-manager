import { HttpException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import { MANAGED_RATE_LIMIT_MAX } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import {
  decodeManagedPublicationText,
  MANAGED_CAPTION_CODECS,
  MANAGED_PUBLICATION_TEXT_MAX_CODE_UNITS,
  MANAGED_PUBLICATION_TEXT_RULES,
  ManagedCaptionCodec,
  ManagedPublicationTextError,
  ManagedPublicationTextInput,
  ManagedPublicationTextRefusal,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publication-text';
import {
  MANAGED_ALT_MAX_LENGTH,
  MANAGED_OPERATION_KEY,
  MANAGED_THUMBNAIL_TIMESTAMP_MAX_MS,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';

// The closed wire contract of the owned post lifecycle, ww.managed-lifecycle.v1
// (docs/managed-extension/lifecycle-root-decisions-20261105.md as amended by
// lifecycle-architecture-corrections-20261105.md; both override
// lifecycle-implementation-20261105.md where they differ): schedule,
// publish-now, cancel, delete and resolve, the reads W&W needs to follow them,
// the lifecycle event feed and operation lookup (both apart from the DRAFT
// ones) and the continuation the dispatcher persists. Nothing here is mounted,
// gated open or called by a runtime yet. The DRAFT capabilities (v2), routes,
// change feed and operation lookup are not changed by it.
//
// Every request and response is a strict object: unknown keys are refused at
// every level. Every key an object declares is required, and a value that can
// be missing is null, never absent. In a discriminated union each variant
// declares its own keys, so a key only another variant takes is not sent, and
// is refused when it is. Numbers are safe integers, instants are ISO UTC with
// milliseconds, hashes are sha256:<64 lowercase hex> and *Sha256 digests are
// 64 lowercase hex. Pure: no Prisma, no Nest DI, no network, no clock (time
// checks take `now`).

export const MANAGED_LIFECYCLE_VERSION = 'ww.managed-lifecycle.v1' as const;
export const MANAGED_RELEASE_HASH_VERSION = 'ww-release-hash-v1' as const;
// the DRAFT capability document W&W pins; this contract never replaces it
export const MANAGED_DRAFT_CAPABILITIES_VERSION = 'ww-managed-capabilities-v2' as const;

// The end of the operator-stated customer access, exclusive. A qualification
// policy can end no later, and can last at most seven days
export const MANAGED_LIFECYCLE_MAX_EXPIRY = new Date('2026-11-10T23:00:00.000Z');
export const MANAGED_LIFECYCLE_MAX_POLICY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
export const MANAGED_LIFECYCLE_MAX_POLICY_MS =
  MANAGED_LIFECYCLE_MAX_POLICY_DAYS * DAY_MS;

// A repeat must fit inside one policy: publishAt is after the policy started
// and every occurrence is before it ends, so at most seven daily occurrences
// and an interval of at most six days can ever be accepted
export const MANAGED_LIFECYCLE_LIMITS = Object.freeze({
  minLeadMs: 60 * 1000,
  maxLatenessMs: 60 * 60 * 1000,
  repeatMinIntervalDays: 1,
  repeatMaxIntervalDays: MANAGED_LIFECYCLE_MAX_POLICY_DAYS - 1,
  repeatMinOccurrences: 2,
  repeatMaxOccurrences: MANAGED_LIFECYCLE_MAX_POLICY_DAYS,
  // members[] and media[] bounds of managed.post.dto.ts
  members: 20,
  mediaPerMember: 10,
  // ManagedPostMemberDto.delay, in minutes
  memberDelayMaxMinutes: 10080,
  noteMax: 2000,
  releaseUrlMax: 2048,
  releaseIdMax: 256,
  providersMax: 32,
  mediaTypesMax: 16,
  // the most shared-budget units an adapter may declare for one step (a
  // multi-member finalize included); each adapter declares its own, lower
  // bound, and only that is reserved
  maxStepUnits: 32,
  eventsPageMax: 100,
});

// How the dispatcher paces itself; also declared to W&W. The DB lease of an
// admitted call is taken for one step at a time, until at least the adapter's
// step deadline plus leaseMarginMs, and renewed at the next step. A pending
// call is polled read-only with exponential backoff, and never after the
// fixed deadline pendingSince + pollDeadlineMs
export const MANAGED_LIFECYCLE_TIMING = Object.freeze({
  dispatcherTickMs: 5 * 1000,
  dueBatch: 10,
  leaseMarginMs: 30 * 1000,
  // the most a step may take: the publish transport's own maximum deadline
  maxStepDeadlineMs: 120 * 1000,
  pollInitialDelayMs: 15 * 1000,
  pollBackoffFactor: 2,
  pollMaxDelayMs: 5 * 60 * 1000,
  pollDeadlineMs: 30 * 60 * 1000,
  recommendedFeedPollSeconds: 60,
});

// The wait after poll number pollCount (0: after the call went pending)
export function lifecyclePollDelayMs(pollCount: number) {
  const { pollInitialDelayMs, pollBackoffFactor, pollMaxDelayMs } =
    MANAGED_LIFECYCLE_TIMING;
  return Math.min(
    pollMaxDelayMs,
    pollInitialDelayMs * pollBackoffFactor ** Math.min(Math.max(pollCount, 0), 16)
  );
}

// When the next poll is due at the earliest: the backoff after the last poll,
// never later than the deadline. A budget deferral may move it later, up to
// the deadline. NaN for an input that is not an instant
const nextPollTime = (
  pendingSince: string,
  lastPolledAt: string | null,
  pollCount: number
) =>
  Math.min(
    Date.parse(lastPolledAt ?? pendingSince) + lifecyclePollDelayMs(pollCount),
    Date.parse(pendingSince) + MANAGED_LIFECYCLE_TIMING.pollDeadlineMs
  );

export const lifecycleNextPollAt = (
  pendingSince: string,
  lastPolledAt: string | null,
  pollCount: number
) => new Date(nextPollTime(pendingSince, lastPolledAt, pollCount)).toISOString();

// how many polls fit before the deadline, the last one at it
function maxPolls() {
  let at = 0;
  let polls = 0;
  while (at < MANAGED_LIFECYCLE_TIMING.pollDeadlineMs) {
    at += lifecyclePollDelayMs(polls);
    polls++;
  }
  return polls;
}
export const MANAGED_LIFECYCLE_MAX_POLLS = maxPolls();

const MAX_OCCURRENCE = MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences - 1;
const MAX_POSITION = MANAGED_LIFECYCLE_LIMITS.members - 1;

// ---- closed vocabularies ----------------------------------------------------

// appended to MANAGED_SCOPES by root together with the routes; not granted
// to any credential by this file
export const MANAGED_LIFECYCLE_SCOPES = ['posts:schedule', 'posts:publish'] as const;
export type ManagedLifecycleScope = (typeof MANAGED_LIFECYCLE_SCOPES)[number];

export const MANAGED_LIFECYCLE_KINDS = [
  'SCHEDULE',
  'PUBLISH_NOW',
  'CANCEL',
  'DELETE',
  'RESOLVE',
] as const;
export type ManagedLifecycleKind = (typeof MANAGED_LIFECYCLE_KINDS)[number];

// the existing DRAFT operation kinds; their keys keep the DRAFT lookup
export const MANAGED_DRAFT_OPERATION_KINDS = ['CREATE_DRAFT', 'EDIT_DRAFT'] as const;

// While the post's latest schedule is live (ACTIVE / ENDING) its lifecycle is
// DISPATCHING when a call is admitted, REVIEW when one is unresolved, and
// SCHEDULED otherwise, even when an earlier occurrence already published the
// Post rows (lifecycleWhileScheduled). The rows' own state at admission is a
// separate fact (lifecycleAdmissionRowState)
export const MANAGED_POST_LIFECYCLES = [
  'DRAFT',
  'SCHEDULED',
  'DISPATCHING',
  'PUBLISHED',
  'FAILED',
  'REVIEW',
  'DELETED',
] as const;
export type ManagedPostLifecycle = (typeof MANAGED_POST_LIFECYCLES)[number];

// the states a delete may be confirmed from; never while a call is admitted,
// unknown or partial (DISPATCHING / REVIEW)
export const MANAGED_DELETABLE_LIFECYCLES = [
  'DRAFT',
  'SCHEDULED',
  'PUBLISHED',
  'FAILED',
] as const;

// ACTIVE: never truncated, no end request. ENDING: a REMAINING cancel
// truncated the series (lastOccurrence lowered, the end request recorded)
// while earlier, unaffected occurrences up to lastOccurrence remain: a
// pending one, later unmaterialized ones, or one admitted or unresolved. They
// run under the generation they have; nothing after lastOccurrence is ever
// materialized. Once the last of them settles (or is resolved) the schedule
// is CANCELLED, never COMPLETED, or HALTED when it failed, keeping its end
// request. A cancel that leaves nothing to run ends it CANCELLED at once.
// The end request is the first one and is never rewritten; every later
// cancel is its own operation and feed event
export const MANAGED_SCHEDULE_STATUSES = [
  'ACTIVE',
  'ENDING',
  'COMPLETED',
  'CANCELLED',
  'HALTED',
  'SUPERSEDED_BY_DELETE',
] as const;
export type ManagedScheduleStatus = (typeof MANAGED_SCHEDULE_STATUSES)[number];

export const MANAGED_DISPATCH_STATUSES = [
  'PENDING',
  'ADMITTED',
  'PUBLISHED',
  'CANCELLED',
  'EXPIRED',
  'NOT_SENT',
  'REJECTED',
  'PARTIAL',
  'UNKNOWN',
  'RESOLVED_PUBLISHED',
  'RESOLVED_NOT_PUBLISHED',
  'RESOLVED_ABANDONED',
] as const;
export type ManagedDispatchStatus = (typeof MANAGED_DISPATCH_STATUSES)[number];

export const MANAGED_DISPATCH_MEMBER_STATUSES = [
  'WAITING',
  'DISPATCHING',
  'PENDING_PROVIDER',
  'PUBLISHED',
  'NOT_COMMENTABLE',
  'REJECTED',
  'NOT_SENT',
  'UNKNOWN',
  'RESOLVED_NOT_PUBLISHED',
  'RESOLVED_UNDETERMINED',
] as const;
export type ManagedDispatchMemberStatus =
  (typeof MANAGED_DISPATCH_MEMBER_STATUSES)[number];

// recorded refusals: nothing left this server
export const MANAGED_DISPATCH_NOT_SENT_CODES = [
  'LIFECYCLE_GATE_CLOSED',
  'PROVIDER_NOT_QUALIFIED',
  'WINDOW_CLOSED',
  'LATE_BEYOND_TOLERANCE',
  'REVISION_CONFLICT',
  'BINDING_GENERATION_MISMATCH',
  'CHANNEL_UNAVAILABLE',
  'CHANNEL_IDENTITY_CHANGED',
  'POST_DRIFTED',
  'MEDIA_NOT_CURRENT',
  'MEDIA_CHANGED',
  'MEDIA_DELIVERY_NOT_QUALIFIED',
  'CODEC_REFUSED',
  'RELEASE_HASH_MISMATCH',
  // the transport's own ledger proved the request never left, on both
  // allowed attempts
  'REQUEST_NOT_SENT',
] as const;
export const MANAGED_DISPATCH_REJECTED_CODES = [
  'PROVIDER_REJECTED',
  'CHANNEL_REFRESH_NEEDED',
] as const;
// the request may have reached the provider; never sent again
export const MANAGED_DISPATCH_UNKNOWN_CODES = [
  'OUTCOME_UNKNOWN',
  'DISPATCHER_LOST',
  'LEASE_LOST',
  'PENDING_UNCONFIRMED',
  // a request beyond the units reserved for the step, after one was sent
  'STEP_BUDGET_EXCEEDED',
] as const;
// the code of the member a PARTIAL dispatch stopped at
export const MANAGED_DISPATCH_PARTIAL_CODES = [
  ...MANAGED_DISPATCH_UNKNOWN_CODES,
  ...MANAGED_DISPATCH_REJECTED_CODES,
  ...MANAGED_DISPATCH_NOT_SENT_CODES,
] as const;
// PREVIOUS_MEMBER_FAILED: never sent because a member before it failed
export const MANAGED_MEMBER_NOT_SENT_CODES = [
  ...MANAGED_DISPATCH_NOT_SENT_CODES,
  'PREVIOUS_MEMBER_FAILED',
] as const;
// a due step that waits without losing its place: the shared budget is
// exhausted or unavailable before admission, or another call of the
// organization is in flight
export const MANAGED_DISPATCH_DEFERRAL_CODES = [
  'BUDGET_EXHAUSTED',
  'BUDGET_UNAVAILABLE',
  'ORGANIZATION_IN_FLIGHT',
] as const;

// One provider mutation of a dispatch: each is admitted on its own
export const MANAGED_CALL_STEPS = ['POST', 'COMMENT', 'FINALIZE'] as const;
export type ManagedCallStep = (typeof MANAGED_CALL_STEPS)[number];

// The next occurrence of a series is materialized only once the one before
// it is one of these: a skipped (cancelled) occurrence lets the series go on,
// a failed, expired or unresolved one does not
export const MANAGED_MATERIALIZE_AFTER = [
  'PUBLISHED',
  'RESOLVED_PUBLISHED',
  'CANCELLED',
] as const;

export const MANAGED_CANCEL_SCOPES = ['OCCURRENCE', 'REMAINING', 'SERIES'] as const;
export type ManagedCancelScope = (typeof MANAGED_CANCEL_SCOPES)[number];
export const MANAGED_RESOLUTIONS = [
  'RESOLVED_PUBLISHED',
  'RESOLVED_NOT_PUBLISHED',
  'RESOLVED_ABANDONED',
] as const;
export type ManagedResolution = (typeof MANAGED_RESOLUTIONS)[number];
export const MANAGED_RESOLVE_OUTCOMES = [
  'PUBLISHED',
  'NOT_PUBLISHED',
  'UNDETERMINED',
] as const;

// The kinds of the lifecycle event feed. It is its own feed with its own
// sequence: none of these is ever written to the DRAFT change feed, whose
// kinds and sequence stay as they are. DISPATCH_PROGRESSED: a member of an
// admitted dispatch was published or went pending
export const MANAGED_LIFECYCLE_EVENT_KINDS = [
  'POST_SCHEDULED',
  'POST_PUBLISH_REQUESTED',
  'POST_SCHEDULE_CANCELLED',
  'POST_OCCURRENCE_CANCELLED',
  'POST_DELETED',
  'OCCURRENCE_MATERIALIZED',
  'OCCURRENCE_EXPIRED',
  'DISPATCH_ADMITTED',
  'DISPATCH_PROGRESSED',
  'DISPATCH_NOT_SENT',
  'DISPATCH_PUBLISHED',
  'DISPATCH_REJECTED',
  'DISPATCH_PARTIAL',
  'DISPATCH_OUTCOME_UNKNOWN',
  'DISPATCH_RESOLVED',
] as const;
export type ManagedLifecycleEventKind =
  (typeof MANAGED_LIFECYCLE_EVENT_KINDS)[number];

export const MANAGED_DRAFT_OPERATION_ROUTE =
  '/managed/v1/operations/:operationKey' as const;
export const MANAGED_LIFECYCLE_OPERATION_ROUTE =
  '/managed/v1/lifecycle/operations/:operationKey' as const;

// The lifecycle lookup and feed are their own routes: a lifecycle key is
// never pushed through the DRAFT decoder, and a key of the other kind is a
// typed OPERATION_KEY_KIND_MISMATCH on either lookup, never ABSENT
export const MANAGED_LIFECYCLE_ROUTES = [
  { name: 'capabilities', method: 'GET', path: '/managed/v1/lifecycle/capabilities', scope: 'posts:read' },
  { name: 'schedule', method: 'POST', path: '/managed/v1/posts/:managedPostId/schedule', scope: 'posts:schedule' },
  { name: 'publish-now', method: 'POST', path: '/managed/v1/posts/:managedPostId/publish-now', scope: 'posts:publish' },
  { name: 'cancel', method: 'POST', path: '/managed/v1/posts/:managedPostId/cancel', scope: 'posts:schedule' },
  { name: 'delete', method: 'POST', path: '/managed/v1/posts/:managedPostId/delete', scope: 'posts:schedule' },
  { name: 'lifecycle', method: 'GET', path: '/managed/v1/posts/:managedPostId/lifecycle', scope: 'posts:read' },
  { name: 'dispatch', method: 'GET', path: '/managed/v1/dispatches/:dispatchId', scope: 'posts:read' },
  { name: 'resolve', method: 'POST', path: '/managed/v1/dispatches/:dispatchId/resolve', scope: 'posts:publish' },
  { name: 'operation', method: 'GET', path: MANAGED_LIFECYCLE_OPERATION_ROUTE, scope: 'posts:read' },
  { name: 'events', method: 'GET', path: '/managed/v1/lifecycle/events', scope: 'posts:read' },
  { name: 'release-preview', method: 'GET', path: '/managed/v1/lifecycle/release-preview/:managedPostId', scope: 'posts:read' },
] as const;

// ---- value formats ------------------------------------------------------------

export const MANAGED_LIFECYCLE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Post / Integration / Media ids, as managed.post.dto.ts takes them
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MANAGED_LIFECYCLE_HASH = /^sha256:[0-9a-f]{64}$/;
export const MANAGED_LIFECYCLE_SHA256 = /^[0-9a-f]{64}$/;
const SHA256_HEX = MANAGED_LIFECYCLE_SHA256;
// Date#toISOString, nothing else: UTC, milliseconds, upper-case T and Z
export const MANAGED_LIFECYCLE_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROVIDER_IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const MIME_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,100}$/;
// printable ASCII only; a provider value that is not is answered as null
export const MANAGED_RELEASE_ID = /^[\x21-\x7e]{1,256}$/;
export const MANAGED_RELEASE_URL = /^https:\/\/[\x21-\x7e]+$/;
// the same rule as ManagedMediaRefDto.alt
const ALT = /^[^\x00-\x1f\x7f-\x9f]*$/;
// human text: LF and TAB allowed, no other control (so no CR)
export const MANAGED_LIFECYCLE_NOTE = /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]+$/u;

// an exact Date#toISOString value of a real instant (no 2026-02-30)
export function isLifecycleInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !MANAGED_LIFECYCLE_INSTANT.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

const safeInt = (min: number) =>
  z.number().int().min(min).max(Number.MAX_SAFE_INTEGER);
const instant = z.string().refine(isLifecycleInstant, 'not an ISO UTC instant');
const hash = z.string().regex(MANAGED_LIFECYCLE_HASH);
const uuid = z.string().regex(MANAGED_LIFECYCLE_UUID);
const id = z.string().regex(ID);
const operationKey = z.string().regex(MANAGED_OPERATION_KEY);
const version = z.literal(MANAGED_LIFECYCLE_VERSION);
const codec = z.custom<ManagedCaptionCodec>((value) =>
  MANAGED_CAPTION_CODECS.includes(value as ManagedCaptionCodec)
);
const occurrence = z.number().int().min(0).max(MAX_OCCURRENCE);
const position = z.number().int().min(0).max(MAX_POSITION);
const maxLatenessMs = z
  .number()
  .int()
  .min(0)
  .max(MANAGED_LIFECYCLE_LIMITS.maxLatenessMs);
const releaseUrl = z
  .string()
  .max(MANAGED_LIFECYCLE_LIMITS.releaseUrlMax)
  .regex(MANAGED_RELEASE_URL);
const releaseId = z.string().regex(MANAGED_RELEASE_ID);
const note = z
  .string()
  .min(1)
  .max(MANAGED_LIFECYCLE_LIMITS.noteMax)
  .regex(MANAGED_LIFECYCLE_NOTE)
  .refine((value) => value.trim().length > 0, 'note is blank');
// W&W's digest of the content it approved: stored and answered as sent,
// never derived, checked or trusted here (the release hash is derived
// independently from what this server would send)
const contentSha256 = z.string().regex(SHA256_HEX);

// This repository disables strictNullChecks, so zod's inferred object keys
// appear optional to TypeScript. Every schema here requires every key it (or
// its variant) declares; restore that fact only after successful runtime
// parsing (as managed.creative.contracts.ts). It distributes over a union, so
// each variant keeps only its own keys
type RequiredParsed<T> = T extends readonly (infer Item)[] ? RequiredParsed<Item>[]
  : T extends object ? { [Key in keyof T]-?: RequiredParsed<T[Key]> } : T;

// A schema that accepts exactly this constant: the static rules of the
// capability document can't drift from what W&W mirrors
function exactly(value: unknown): z.ZodTypeAny {
  if (Array.isArray(value)) {
    return z.tuple(value.map(exactly) as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }
  if (value && typeof value === 'object') {
    return z
      .object(
        Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, exactly(entry)])
        )
      )
      .strict();
  }
  return z.literal(value as z.Primitive);
}

// ---- anchored occurrences -------------------------------------------------------

// Occurrence n is due at publishAt + n·intervalDays whole UTC days (no time
// zone, no DST, no drift from when the previous one was sent). Empty when the
// input is not a bounded series: zod runs refinements on values that already
// failed a bound, and nothing here may throw or grow with them
export function lifecycleOccurrenceDueAts(
  anchorAt: string,
  intervalDays: number | null,
  occurrences: number
): string[] {
  if (
    !isLifecycleInstant(anchorAt) ||
    !Number.isInteger(occurrences) ||
    occurrences < 1 ||
    occurrences > MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences ||
    (intervalDays === null
      ? occurrences !== 1
      : !Number.isInteger(intervalDays) ||
        intervalDays < MANAGED_LIFECYCLE_LIMITS.repeatMinIntervalDays ||
        intervalDays > MANAGED_LIFECYCLE_LIMITS.repeatMaxIntervalDays)
  ) {
    return [];
  }
  const anchor = Date.parse(anchorAt);
  return Array.from({ length: occurrences }, (_, index) =>
    new Date(anchor + index * (intervalDays ?? 0) * DAY_MS).toISOString()
  );
}

const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

// ---- requests -------------------------------------------------------------------

// The exact, finite series a schedule confirms: every due time is in the
// body, so the confirmation (and its payload hash) binds the whole future
// scope. The window it must fit is captured when it is accepted; a later
// policy never extends it
const repeatPlan = z
  .object({
    intervalDays: z
      .number()
      .int()
      .min(MANAGED_LIFECYCLE_LIMITS.repeatMinIntervalDays)
      .max(MANAGED_LIFECYCLE_LIMITS.repeatMaxIntervalDays),
    maxOccurrences: z
      .number()
      .int()
      .min(MANAGED_LIFECYCLE_LIMITS.repeatMinOccurrences)
      .max(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences),
    dueAts: z
      .array(instant)
      .min(MANAGED_LIFECYCLE_LIMITS.repeatMinOccurrences)
      .max(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences),
  })
  .strict();

// What a release binds: the revision, the binding generation, the schedule
// generation last read, the release hash W&W recomputed from its own approved
// payload and compared with the release preview, and W&W's own digest of
// that payload. Both hashes are frozen by the confirmation and stored with
// the schedule and every dispatch
const releaseBinding = {
  version,
  operationKey,
  expectedRevision: safeInt(1),
  expectedBindingGeneration: safeInt(1),
  expectedScheduleGeneration: safeInt(0),
  releaseHash: hash,
  contentSha256,
  codec,
  maxLatenessMs,
};

const scheduleRequest = z
  .object({
    ...releaseBinding,
    publishAt: instant,
    repeat: repeatPlan.nullable(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (
      body.repeat &&
      !sameList(
        body.repeat.dueAts,
        lifecycleOccurrenceDueAts(
          body.publishAt,
          body.repeat.intervalDays,
          body.repeat.maxOccurrences
        )
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['repeat', 'dueAts'],
        message: 'dueAts are not publishAt + n * intervalDays for every occurrence',
      });
    }
  });

// publish-now is due at the server's time of acceptance and never repeats.
// It is refused while the post has a live schedule: cancelling it is a
// separate, confirmed operation, never implied
const publishNowRequest = z.object(releaseBinding).strict();

// One occurrence a cancel or delete affects. One occurrence of a series is
// materialized at a time (PENDING, bound by its dispatch and version); later
// ones are bound by their number and anchored due time. Occurrence 0 is
// affected like any other
const affectedOccurrence = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('PENDING'),
      occurrence,
      dueAt: instant,
      dispatchId: uuid,
      expectedDispatchVersion: safeInt(1),
    })
    .strict(),
  z
    .object({
      state: z.literal('NOT_MATERIALIZED'),
      occurrence,
      dueAt: instant,
    })
    .strict(),
]);

const affectedOccurrences = z
  .array(affectedOccurrence)
  .min(1)
  .max(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences)
  .superRefine((list, ctx) => {
    list.forEach((entry, index) => {
      if (index > 0 && entry.state === 'PENDING') {
        ctx.addIssue({ code: 'custom', path: [index, 'state'], message: 'only the first affected occurrence can be materialized' });
      }
      const previous = list[index - 1];
      if (
        previous &&
        (entry.occurrence !== previous.occurrence + 1 ||
          Date.parse(entry.dueAt) <= Date.parse(previous.dueAt))
      ) {
        ctx.addIssue({ code: 'custom', path: [index, 'occurrence'], message: 'affected occurrences are not contiguous and ascending' });
      }
    });
  });

// The one earlier occurrence a REMAINING cancel leaves alone because it is
// admitted, or settled but unresolved. It keeps the admission and generation
// it has, and the schedule is ENDING until it settles or is resolved
const inFlightOccurrence = z
  .object({
    occurrence,
    dispatchId: uuid,
    expectedStatus: z.enum(['ADMITTED', 'UNKNOWN', 'PARTIAL']),
    expectedDispatchVersion: safeInt(1),
  })
  .strict();

export type ManagedAffectedOccurrence = RequiredParsed<
  z.infer<typeof affectedOccurrence>
>;
export type ManagedInFlightOccurrence = RequiredParsed<
  z.infer<typeof inFlightOccurrence>
>;

const postBinding = {
  version,
  operationKey,
  expectedRevision: safeInt(1),
  expectedScheduleGeneration: safeInt(0),
};

// The exact schedule state a cancel (or the cancels of a delete) was
// previewed against: its version (+1 on every change of the schedule), the
// occurrences it affects with the version of the materialized one, and the
// hash of that preview (lifecycleAffectedHashInput), which W&W's human
// confirmation binds. The server derives the scope again from the schedule as
// stored (lifecycleCancelScope) and refuses any difference
const scopeBinding = {
  scheduleId: uuid,
  expectedScheduleVersion: safeInt(1),
  affected: affectedOccurrences,
  affectedHash: hash,
};

const cancelBinding = { ...postBinding, ...scopeBinding };

// No cancel changes the schedule generation, so the later steps of an
// admitted occurrence keep the generation and admission they started with;
// every cancel increments the schedule version.
// OCCURRENCE: the PENDING occurrence, occurrence 0 included. The series goes
//   on with the next anchored occurrence, or ends when it was the last.
// REMAINING: every future occurrence from fromOccurrence on (0 included).
//   Earlier pending or admitted occurrences remain unchanged. The series is
//   truncated: lastOccurrence becomes fromOccurrence - 1. The first
//   truncation is recorded as the end request; a later REMAINING (against
//   the new schedule version, with its own affectedHash) only lowers
//   lastOccurrence again and leaves that end request as it is. inFlight is
//   the earlier admitted or unresolved occurrence, when one exists.
// SERIES: every unsettled occurrence; refused while any occurrence is
//   admitted or unresolved.
// A cancel that leaves nothing to run ends the schedule CANCELLED and is its
// endedOperationKey (recorded as the end request too when there was none).
const cancelRequest = z
  .discriminatedUnion('scope', [
    z
      .object({
        ...cancelBinding,
        scope: z.literal('OCCURRENCE'),
        occurrence,
      })
      .strict(),
    z
      .object({
        ...cancelBinding,
        scope: z.literal('REMAINING'),
        fromOccurrence: occurrence,
        inFlight: inFlightOccurrence.nullable(),
      })
      .strict(),
    z
      .object({
        ...cancelBinding,
        scope: z.literal('SERIES'),
      })
      .strict(),
  ])
  .superRefine((body, ctx) => {
    const [first] = body.affected;
    if (!first) {
      return;
    }
    if (
      body.scope === 'OCCURRENCE' &&
      (body.affected.length !== 1 ||
        first.state !== 'PENDING' ||
        first.occurrence !== body.occurrence)
    ) {
      ctx.addIssue({ code: 'custom', path: ['affected'], message: 'an OCCURRENCE cancel affects exactly that pending occurrence' });
    }
    if (body.scope === 'REMAINING' && first.occurrence !== body.fromOccurrence) {
      ctx.addIssue({ code: 'custom', path: ['affected'], message: 'a REMAINING cancel starts at fromOccurrence' });
    }
    if (
      body.scope === 'REMAINING' &&
      body.inFlight &&
      (body.inFlight.occurrence >= body.fromOccurrence ||
        first.state !== 'NOT_MATERIALIZED')
    ) {
      ctx.addIssue({ code: 'custom', path: ['inFlight'], message: 'the occurrence in flight precedes fromOccurrence, and nothing after it is materialized' });
    }
  });

// Removal of the retained Postiz record only, published or not: the rows get
// deletedAt and are kept, the social-network post is never deleted. Refused
// while any dispatch is admitted or unresolved. A SCHEDULED post (a live
// schedule, whatever an earlier occurrence published) binds the occurrences
// the delete cancels, as a SERIES cancel would, and only it does; the
// service checks the schedule is live and the scope exact
// (lifecycleCancelScope 'DELETE'). The live schedule is SUPERSEDED_BY_DELETE
const deleteRequest = z
  .object({
    ...postBinding,
    expectedLifecycle: z.enum(MANAGED_DELETABLE_LIFECYCLES),
    effect: z.literal('RETAINED_SOFT_DELETE'),
    cancels: z.object(scopeBinding).strict().nullable(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if ((body.expectedLifecycle === 'SCHEDULED') !== (body.cancels !== null)) {
      ctx.addIssue({ code: 'custom', path: ['cancels'], message: 'only a scheduled post binds the occurrences it cancels, and it must' });
    }
  });

export const MANAGED_AFFECTED_HASH_VERSION = 'ww-affected-scope-v1' as const;

// What affectedHash is taken over: fingerprint(lifecycleAffectedHashInput())
// with fingerprint() of managed.service.ts, as the release hash. The scope is
// DELETE for the cancels of a delete, whose inFlight is always null
export function lifecycleAffectedHashInput(
  scope: ManagedCancelScope | 'DELETE',
  binding: {
    scheduleId: string;
    expectedScheduleVersion: number;
    affected: readonly ManagedAffectedOccurrence[];
    inFlight: ManagedInFlightOccurrence | null;
  }
) {
  return {
    v: MANAGED_AFFECTED_HASH_VERSION,
    scope,
    scheduleId: binding.scheduleId,
    scheduleVersion: binding.expectedScheduleVersion,
    affected: binding.affected,
    inFlight: binding.inFlight,
  };
}

const isAll = (statuses: readonly string[], allowed: readonly string[]) =>
  statuses.every((status) => allowed.includes(status));

// the first member that is not published (the length when every one is)
const firstUnpublished = (statuses: readonly ManagedDispatchMemberStatus[]) => {
  const index = statuses.findIndex((status) => status !== 'PUBLISHED');
  return index < 0 ? statuses.length : index;
};

// Whether members can be in these statuses under a dispatch of this status.
// Members go in order: one is only sent once the one before it is published,
// and once one fails every later one is NOT_SENT. So at most one member is
// open or failed, every one before it is published, and every one after it
// waits or, once the dispatch settled, was not sent. A resolved status never
// fits: a resolved dispatch is checked by the members it was resolved from
function membersFit(
  status: ManagedDispatchStatus,
  statuses: readonly ManagedDispatchMemberStatus[]
): boolean {
  const [root, ...rest] = statuses;
  const at = firstUnpublished(statuses);
  const after = statuses.slice(at + 1);
  switch (status) {
    case 'PENDING':
    case 'CANCELLED':
    case 'EXPIRED':
      return isAll(statuses, ['WAITING']);
    case 'NOT_SENT':
      // refused at admission, or the root proven never sent
      return (
        isAll(statuses, ['WAITING']) ||
        (root === 'NOT_SENT' && isAll(rest, ['NOT_SENT']))
      );
    case 'ADMITTED':
      return (
        at < statuses.length &&
        ['WAITING', 'DISPATCHING', 'PENDING_PROVIDER'].includes(statuses[at]) &&
        isAll(after, ['WAITING'])
      );
    case 'PUBLISHED':
      // a provider that can't comment only publishes the root
      return (
        root === 'PUBLISHED' &&
        (isAll(rest, ['PUBLISHED']) || isAll(rest, ['NOT_COMMENTABLE']))
      );
    case 'REJECTED':
    case 'UNKNOWN':
      return root === status && isAll(rest, ['NOT_SENT']);
    case 'PARTIAL':
      return (
        at > 0 &&
        at < statuses.length &&
        ['UNKNOWN', 'REJECTED', 'NOT_SENT'].includes(statuses[at]) &&
        isAll(after, ['NOT_SENT'])
      );
  }
  return false;
}

// One member of the dispatch a human resolves, as it was shown to them:
// every member is listed with its status, and exactly the UNKNOWN one gets
// an outcome. An outcome is a human's observation, never a provider answer
const resolveMember = z
  .object({
    position,
    postId: id,
    expectedStatus: z.enum(MANAGED_DISPATCH_MEMBER_STATUSES),
    outcome: z.enum(MANAGED_RESOLVE_OUTCOMES).nullable(),
    releaseURL: releaseUrl.nullable(),
    releaseId: releaseId.nullable(),
  })
  .strict()
  .superRefine((member, ctx) => {
    if ((member.expectedStatus === 'UNKNOWN') !== (member.outcome !== null)) {
      ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'exactly an UNKNOWN member has an outcome' });
    }
    const cited = member.releaseURL !== null || member.releaseId !== null;
    if (member.outcome === 'PUBLISHED' ? !cited : cited) {
      ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'only a PUBLISHED outcome cites a release, and it must' });
    }
  });

type ManagedResolveOutcome = (typeof MANAGED_RESOLVE_OUTCOMES)[number];
const RESOLVED_MEMBER: Record<ManagedResolveOutcome, ManagedDispatchMemberStatus> = {
  PUBLISHED: 'PUBLISHED',
  NOT_PUBLISHED: 'RESOLVED_NOT_PUBLISHED',
  UNDETERMINED: 'RESOLVED_UNDETERMINED',
};

// What a member is once its outcome is recorded
export const lifecycleResolvedMemberStatus = (member: {
  expectedStatus?: ManagedDispatchMemberStatus;
  outcome?: ManagedResolveOutcome | null;
}) => (member.outcome ? RESOLVED_MEMBER[member.outcome] : member.expectedStatus);

// Whether the members are every member of an UNKNOWN / PARTIAL dispatch, in
// position order
const resolvableFrom = (
  status: 'UNKNOWN' | 'PARTIAL',
  positions: readonly number[],
  statuses: readonly ManagedDispatchMemberStatus[]
) =>
  positions.every((position, index) => position === index) &&
  membersFit(status, statuses);

const resolveEvidence = z
  .object({
    source: z.literal('HUMAN_OBSERVATION'),
    observedAt: instant,
    note,
  })
  .strict();

// The resolution the members mean once every outcome is recorded: published
// only when the whole thread is, not published only when the root was found
// not published (so nothing was), abandoned otherwise (an undetermined
// member, or a thread that stopped part way). The body must name it
export function lifecycleResolutionOf(
  statuses: readonly ManagedDispatchMemberStatus[]
): ManagedResolution {
  const [root, ...rest] = statuses;
  if (root === 'PUBLISHED' && isAll(rest, ['PUBLISHED'])) {
    return 'RESOLVED_PUBLISHED';
  }
  if (root === 'RESOLVED_NOT_PUBLISHED' && isAll(rest, ['NOT_SENT'])) {
    return 'RESOLVED_NOT_PUBLISHED';
  }
  return 'RESOLVED_ABANDONED';
}

// Records what a human observed for an UNKNOWN or PARTIAL dispatch, bound to
// its exact version and to every member as it was shown. It sends nothing
// and never makes the dispatcher send anything again: members that were never
// sent stay NOT_SENT. RESOLVED_PUBLISHED lets the series go on;
// RESOLVED_NOT_PUBLISHED and RESOLVED_ABANDONED halt it (a new schedule is a
// new key and a new confirmation). Reading a dispatch or an operation never
// resolves anything
const resolveRequest = z
  .object({
    version,
    operationKey,
    expectedDispatchVersion: safeInt(1),
    expectedStatus: z.enum(['UNKNOWN', 'PARTIAL']),
    expectedScheduleGeneration: safeInt(1),
    resolution: z.enum(MANAGED_RESOLUTIONS),
    evidence: resolveEvidence,
    members: z.array(resolveMember).min(1).max(MANAGED_LIFECYCLE_LIMITS.members),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (
      !resolvableFrom(
        body.expectedStatus,
        body.members.map((member) => member.position),
        body.members.map((member) => member.expectedStatus)
      )
    ) {
      ctx.addIssue({ code: 'custom', path: ['members'], message: `members are not every member of an ${body.expectedStatus} dispatch, in order` });
    }
    if (
      body.resolution !==
      lifecycleResolutionOf(body.members.map(lifecycleResolvedMemberStatus))
    ) {
      ctx.addIssue({ code: 'custom', path: ['resolution'], message: 'resolution does not follow from the member outcomes' });
    }
  });

const LIFECYCLE_REQUESTS = {
  SCHEDULE: scheduleRequest,
  PUBLISH_NOW: publishNowRequest,
  CANCEL: cancelRequest,
  DELETE: deleteRequest,
  RESOLVE: resolveRequest,
};

export type ManagedLifecycleRequestOf<K extends ManagedLifecycleKind> =
  RequiredParsed<z.infer<(typeof LIFECYCLE_REQUESTS)[K]>>;
export type ManagedScheduleRequest = ManagedLifecycleRequestOf<'SCHEDULE'>;
export type ManagedPublishNowRequest = ManagedLifecycleRequestOf<'PUBLISH_NOW'>;
export type ManagedCancelRequest = ManagedLifecycleRequestOf<'CANCEL'>;
export type ManagedDeleteRequest = ManagedLifecycleRequestOf<'DELETE'>;
export type ManagedResolveRequest = ManagedLifecycleRequestOf<'RESOLVE'>;

// The body of a lifecycle write, or null. Unknown keys, a field the scope
// does not take, and inconsistent fields are refused, never ignored
export function parseManagedLifecycleRequest<K extends ManagedLifecycleKind>(
  kind: K,
  raw: unknown
): ManagedLifecycleRequestOf<K> | null {
  const parsed = LIFECYCLE_REQUESTS[kind].safeParse(raw);
  return parsed.success ? (parsed.data as ManagedLifecycleRequestOf<K>) : null;
}

// What the payload hash is taken over (fingerprint() of managed.service.ts,
// like the draft writes): the kind, the route target and every body field but
// version and operationKey. Every field is required, so a null is always
// hashed and nothing depends on whether a key was sent
export function lifecyclePayloadInput(
  kind: ManagedLifecycleKind,
  target: string,
  body: Record<string, unknown>
) {
  return {
    kind,
    [kind === 'RESOLVE' ? 'dispatchId' : 'managedPostId']: target,
    ...Object.fromEntries(
      Object.entries(body).filter(
        ([key]) => key !== 'version' && key !== 'operationKey'
      )
    ),
  };
}

// ---- time ---------------------------------------------------------------------

// The operator's qualification policy for lifecycle effects (empty / off by
// default; how root reads it is not part of this contract)
export interface ManagedLifecyclePolicy {
  grantedAt: Date;
  expiresAt: Date;
}

export const MANAGED_LIFECYCLE_TIME_REFUSALS = [
  'POLICY_INVALID',
  'POLICY_AFTER_CUTOFF',
  'POLICY_TOO_LONG',
  'POLICY_NOT_STARTED',
  'POLICY_EXPIRED',
  'PUBLISH_AT_TOO_SOON',
  'OCCURRENCE_AT_OR_AFTER_EXPIRY',
  'SCHEDULE_WINDOW_ENDED',
  'NOT_DUE',
  'LATE_BEYOND_TOLERANCE',
  'EVIDENCE_IN_FUTURE',
  'EVIDENCE_BEFORE_ADMISSION',
] as const;
export type ManagedLifecycleTimeRefusal =
  (typeof MANAGED_LIFECYCLE_TIME_REFUSALS)[number];

// Open only inside [grantedAt, expiresAt), with expiresAt no later than the
// exclusive cutoff and at most seven days after grantedAt
export function lifecyclePolicyRefusal(
  policy: ManagedLifecyclePolicy | null,
  now: Date = new Date()
): ManagedLifecycleTimeRefusal | null {
  const grantedAt = policy?.grantedAt?.getTime();
  const expiresAt = policy?.expiresAt?.getTime();
  const at = now.getTime();
  if (
    !Number.isFinite(grantedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(at) ||
    expiresAt <= grantedAt
  ) {
    return 'POLICY_INVALID';
  }
  if (expiresAt > MANAGED_LIFECYCLE_MAX_EXPIRY.getTime()) {
    return 'POLICY_AFTER_CUTOFF';
  }
  if (expiresAt - grantedAt > MANAGED_LIFECYCLE_MAX_POLICY_MS) {
    return 'POLICY_TOO_LONG';
  }
  if (at < grantedAt) {
    return 'POLICY_NOT_STARTED';
  }
  if (at >= expiresAt) {
    return 'POLICY_EXPIRED';
  }
  return null;
}

// A schedule: open policy, publishAt at least a minute ahead, and every
// occurrence before the policy ends. The policy's expiresAt is then stored
// as the schedule's windowEndsAt; a later policy never extends it
export function lifecycleScheduleTimeRefusal(
  body: Pick<ManagedScheduleRequest, 'publishAt' | 'repeat'>,
  policy: ManagedLifecyclePolicy | null,
  now: Date = new Date()
): ManagedLifecycleTimeRefusal | null {
  const refusal = lifecyclePolicyRefusal(policy, now);
  if (refusal) {
    return refusal;
  }
  if (Date.parse(body.publishAt) < now.getTime() + MANAGED_LIFECYCLE_LIMITS.minLeadMs) {
    return 'PUBLISH_AT_TOO_SOON';
  }
  const dueAts = body.repeat ? body.repeat.dueAts : [body.publishAt];
  if (Date.parse(dueAts[dueAts.length - 1]) >= policy.expiresAt.getTime()) {
    return 'OCCURRENCE_AT_OR_AFTER_EXPIRY';
  }
  return null;
}

// Every outgoing provider request, read-only polls included: inside the
// current policy and before the window the schedule captured
export function lifecycleWindowRefusal(
  windowEndsAt: string,
  policy: ManagedLifecyclePolicy | null,
  now: Date = new Date()
): ManagedLifecycleTimeRefusal | null {
  const refusal = lifecyclePolicyRefusal(policy, now);
  if (refusal) {
    return refusal;
  }
  const endsAt = Date.parse(windowEndsAt);
  if (!Number.isFinite(endsAt) || now.getTime() >= endsAt) {
    return 'SCHEDULE_WINDOW_ENDED';
  }
  return null;
}

// The dispatcher's final-call check of a due step (the occurrence's dueAt
// for its POST, nextActionAt for a later one): inside the window, due, and
// not later than the schedule's tolerance. A refusal is NOT_SENT
export function lifecycleAdmissionTimeRefusal(
  step: { dueAt: string; maxLatenessMs: number; windowEndsAt: string },
  policy: ManagedLifecyclePolicy | null,
  now: Date = new Date()
): ManagedLifecycleTimeRefusal | null {
  const refusal = lifecycleWindowRefusal(step.windowEndsAt, policy, now);
  if (refusal) {
    return refusal;
  }
  const dueAt = Date.parse(step.dueAt);
  if (now.getTime() < dueAt) {
    return 'NOT_DUE';
  }
  if (now.getTime() - dueAt > step.maxLatenessMs) {
    return 'LATE_BEYOND_TOLERANCE';
  }
  return null;
}

// A resolution sends nothing, so it is not bound to the policy window; its
// observation must lie between the admission and now
export function lifecycleResolveTimeRefusal(
  body: Pick<ManagedResolveRequest, 'evidence'>,
  admittedAt: string,
  now: Date = new Date()
): ManagedLifecycleTimeRefusal | null {
  const observedAt = Date.parse(body.evidence.observedAt);
  if (observedAt > now.getTime()) {
    return 'EVIDENCE_IN_FUTURE';
  }
  if (observedAt < Date.parse(admittedAt)) {
    return 'EVIDENCE_BEFORE_ADMISSION';
  }
  return null;
}

// ---- responses ------------------------------------------------------------------

// The pinned evidence of one media: the same facts, bounds and policy for a
// primary media and for its cover, so the release hash W&W derives
// independently binds the size and type of the cover it approved too
const mediaEvidence = {
  mediaId: id,
  evidenceId: id,
  sha256: z.string().regex(SHA256_HEX),
  byteLength: safeInt(0),
  mimeType: z.string().regex(MIME_TYPE).nullable(),
};

// One media exactly as it would be sent: the evidence the revision bound and
// the options W&W reviewed. No storage key, path or URL
const releaseMedia = z
  .object({
    position: z.number().int().min(0).max(MANAGED_LIFECYCLE_LIMITS.mediaPerMember - 1),
    ...mediaEvidence,
    alt: z.string().min(1).max(MANAGED_ALT_MAX_LENGTH).regex(ALT).nullable(),
    thumbnail: z.object(mediaEvidence).strict().nullable(),
    thumbnailTimestampMs: z
      .number()
      .int()
      .min(0)
      .max(MANAGED_THUMBNAIL_TIMESTAMP_MAX_MS)
      .nullable(),
  })
  .strict()
  .refine(
    (media) => media.thumbnail === null || media.thumbnailTimestampMs === null,
    'thumbnail and thumbnailTimestampMs are mutually exclusive'
  );

const releaseMember = z
  .object({
    position,
    delay: z.number().int().min(0).max(MANAGED_LIFECYCLE_LIMITS.memberDelayMaxMinutes),
    // as stored, encoded with the codec
    content: z.string().max(MANAGED_PUBLICATION_TEXT_MAX_CODE_UNITS),
    // what the provider receives: decodeManagedPublicationText(content)
    text: z.string().max(MANAGED_PUBLICATION_TEXT_MAX_CODE_UNITS),
    media: z.array(releaseMedia).max(MANAGED_LIFECYCLE_LIMITS.mediaPerMember),
  })
  .strict();

// GET /lifecycle/release-preview/:managedPostId?revision=&codec=: exactly what
// would be sent, every member's text decoded by the real strict decoder
// before anything can be queued. A comparison, never a source: W&W derives
// the release hash from its own approved payload and retained upload
// bindings and only compares it with this one; no text or media value is
// taken from here. The settings enter only by their fingerprint, so no
// free-form object is answered: settingsHash is fingerprint() of
// managed.service.ts (sha256 of canonicalJson: keys sorted at every level,
// undefined-valued keys omitted, no whitespace) over the approved provider
// settings exactly as the revision bound them, without the __type the
// server sets from the channel. W&W reproduces it from the settings it approved
const releasePreview = z
  .object({
    version,
    hashVersion: z.literal(MANAGED_RELEASE_HASH_VERSION),
    managedPostId: uuid,
    revision: safeInt(1),
    bindingGeneration: safeInt(1),
    integrationId: id,
    providerIdentifier: z.string().regex(PROVIDER_IDENTIFIER),
    identityFingerprint: hash,
    codec,
    settingsHash: hash,
    members: z.array(releaseMember).min(1).max(MANAGED_LIFECYCLE_LIMITS.members),
    releaseHash: hash,
  })
  .strict()
  .superRefine((preview, ctx) => {
    preview.members.forEach((member, index) => {
      if (member.position !== index) {
        ctx.addIssue({ code: 'custom', path: ['members', index, 'position'], message: 'positions are not 0..n-1' });
      }
      member.media.forEach((media, mediaIndex) => {
        if (media.position !== mediaIndex) {
          ctx.addIssue({ code: 'custom', path: ['members', index, 'media', mediaIndex, 'position'], message: 'positions are not 0..n-1' });
        }
      });
      // the text is the strict decoding of the content, nothing else
      let text: string | null = null;
      try {
        text = decodeManagedPublicationText({
          codec: preview.codec,
          content: member.content,
          editor: 'normal',
        });
      } catch (err) {
        if (!(err instanceof ManagedPublicationTextError)) {
          throw err;
        }
      }
      if (text !== member.text) {
        ctx.addIssue({ code: 'custom', path: ['members', index, 'text'], message: 'text is not the strict decoding of content' });
      }
    });
  });

export type ManagedReleasePreview = RequiredParsed<z.infer<typeof releasePreview>>;

// What the release hash is taken over: fingerprint(releaseHashInput(preview))
// with fingerprint() of managed.service.ts. Every media goes in as answered,
// its cover's sha256, byteLength and mimeType included. The stored content, the binding
// generation and anything about the schedule are not in it: the schedule and
// due time are bound by scheduleGeneration and dueAt, so rescheduling the same
// approved release keeps its hash
export function releaseHashInput(preview: ManagedReleasePreview) {
  return {
    v: MANAGED_RELEASE_HASH_VERSION,
    managedPostId: preview.managedPostId,
    revision: preview.revision,
    integrationId: preview.integrationId,
    providerIdentifier: preview.providerIdentifier,
    identityFingerprint: preview.identityFingerprint,
    codec: preview.codec,
    settingsHash: preview.settingsHash,
    members: preview.members.map((member) => ({
      position: member.position,
      delay: member.delay,
      text: member.text,
      media: member.media,
    })),
  };
}

const isLiveSchedule = (status: ManagedScheduleStatus) =>
  status === 'ACTIVE' || status === 'ENDING';

// Whether a schedule of each status has an end request. A HALTED or
// superseded one keeps the one it had, if any; a truncated remainder that
// settles ends CANCELLED, so a COMPLETED schedule never had one
const END_REQUEST: Record<ManagedScheduleStatus, Presence> = {
  ACTIVE: 'ABSENT',
  ENDING: 'REQUIRED',
  COMPLETED: 'ABSENT',
  CANCELLED: 'REQUIRED',
  HALTED: 'EITHER',
  SUPERSEDED_BY_DELETE: 'EITHER',
};

const scheduleView = z
  .object({
    scheduleId: uuid,
    managedPostId: uuid,
    scheduleGeneration: safeInt(1),
    // +1 on every change of the schedule; what expectedScheduleVersion is
    // compared with
    scheduleVersion: safeInt(1),
    mode: z.enum(['AT', 'NOW']),
    status: z.enum(MANAGED_SCHEDULE_STATUSES),
    revision: safeInt(1),
    bindingGeneration: safeInt(1),
    releaseHash: hash,
    contentSha256,
    codec,
    anchorAt: instant,
    intervalDays: z
      .number()
      .int()
      .min(MANAGED_LIFECYCLE_LIMITS.repeatMinIntervalDays)
      .max(MANAGED_LIFECYCLE_LIMITS.repeatMaxIntervalDays)
      .nullable(),
    maxOccurrences: z
      .number()
      .int()
      .min(1)
      .max(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences),
    // every occurrence the confirmation bound, materialized or not
    dueAts: z.array(instant).min(1).max(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences),
    // the policy's exclusive end when the schedule was accepted
    windowEndsAt: instant,
    maxLatenessMs,
    operationKey,
    // the last occurrence that can still be materialized: maxOccurrences - 1
    // until a cancel truncates the series, null when it was truncated before
    // occurrence 0. A later truncation only lowers it
    lastOccurrence: occurrence.nullable(),
    // the first cancel that truncated or ended the series, kept as it was
    // through every later cancel, a halt and a delete. Never on an ACTIVE or
    // COMPLETED schedule; always on an ENDING or CANCELLED one
    endRequestedOperationKey: operationKey.nullable(),
    endRequestedAt: instant.nullable(),
    endedAt: instant.nullable(),
    // the operation that actually ended it: the cancel that left nothing to
    // run, or (when it ended as the remaining occurrences settled) the last
    // cancel that truncated it, which may be a later one than the end
    // request; the delete that superseded it; a resolution, or nothing, for
    // a halt
    endedOperationKey: operationKey.nullable(),
    createdAt: instant,
  })
  .strict()
  .superRefine((schedule, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    if (
      schedule.dueAts.length !== schedule.maxOccurrences ||
      (schedule.intervalDays === null) !== (schedule.maxOccurrences === 1) ||
      !sameList(
        schedule.dueAts,
        lifecycleOccurrenceDueAts(schedule.anchorAt, schedule.intervalDays, schedule.maxOccurrences)
      )
    ) {
      issue('dueAts', 'dueAts are not the anchored series of maxOccurrences');
    }
    if (schedule.mode === 'NOW' && schedule.intervalDays !== null) {
      issue('intervalDays', 'publish-now never repeats');
    }
    if (
      Date.parse(schedule.windowEndsAt) > MANAGED_LIFECYCLE_MAX_EXPIRY.getTime() ||
      schedule.dueAts.some((dueAt) => Date.parse(dueAt) >= Date.parse(schedule.windowEndsAt))
    ) {
      issue('windowEndsAt', 'an occurrence is not before the window the schedule captured');
    }

    const live = isLiveSchedule(schedule.status);
    if (live !== (schedule.endedAt === null)) {
      issue('endedAt', 'only an ended schedule has endedAt');
    }
    const endRequested = schedule.endRequestedOperationKey !== null;
    const endRequest = END_REQUEST[schedule.status];
    if (
      endRequested !== (schedule.endRequestedAt !== null) ||
      (endRequest === 'REQUIRED' && !endRequested) ||
      (endRequest === 'ABSENT' && endRequested)
    ) {
      issue('endRequestedOperationKey', `the end request does not match status ${schedule.status}`);
    }
    if (
      (schedule.endRequestedAt !== null &&
        Date.parse(schedule.endRequestedAt) < Date.parse(schedule.createdAt)) ||
      (schedule.endedAt !== null &&
        Date.parse(schedule.endedAt) <
          Date.parse(schedule.endRequestedAt ?? schedule.createdAt))
    ) {
      issue('endedAt', 'the schedule ended before it was created or its end requested');
    }
    // ENDING is only reached by a truncation, which lowers lastOccurrence
    if (
      schedule.lastOccurrence === null
        ? schedule.status !== 'CANCELLED'
        : schedule.lastOccurrence >= schedule.maxOccurrences ||
          (!endRequested && schedule.lastOccurrence !== schedule.maxOccurrences - 1) ||
          (schedule.status === 'ENDING' &&
            schedule.lastOccurrence === schedule.maxOccurrences - 1)
    ) {
      issue('lastOccurrence', 'lastOccurrence is not the series as confirmed or truncated');
    }
    if (
      (['CANCELLED', 'SUPERSEDED_BY_DELETE'].includes(schedule.status) &&
        schedule.endedOperationKey === null) ||
      ((live || schedule.status === 'COMPLETED') && schedule.endedOperationKey !== null)
    ) {
      issue('endedOperationKey', 'endedOperationKey does not match the status');
    }
  });

const memberRelease = z
  .object({
    releaseId: releaseId.nullable(),
    releaseURL: releaseUrl.nullable(),
    source: z.enum(['PROVIDER_RESPONSE', 'HUMAN_RESOLUTION']),
  })
  .strict()
  .refine(
    (release) =>
      release.source === 'PROVIDER_RESPONSE'
        ? release.releaseId !== null
        : release.releaseId !== null || release.releaseURL !== null,
    'a release cites what it was published as'
  );

const MEMBER_CODES: Partial<Record<ManagedDispatchMemberStatus, readonly string[]>> = {
  REJECTED: MANAGED_DISPATCH_REJECTED_CODES,
  NOT_SENT: MANAGED_MEMBER_NOT_SENT_CODES,
  UNKNOWN: MANAGED_DISPATCH_UNKNOWN_CODES,
};

// One member of the thread (position 0 is the post, the rest comments). Never
// the provider token, pendingData, request bytes or a storage path
const dispatchMember = z
  .object({
    position,
    postId: id,
    status: z.enum(MANAGED_DISPATCH_MEMBER_STATUSES),
    code: z.string().nullable(),
    release: memberRelease.nullable(),
  })
  .strict()
  .superRefine((member, ctx) => {
    const codes = MEMBER_CODES[member.status];
    if (codes ? !codes.includes(member.code) : member.code !== null) {
      ctx.addIssue({ code: 'custom', path: ['code'], message: 'code does not match the member status' });
    }
    if ((member.status === 'PUBLISHED') !== (member.release !== null)) {
      ctx.addIssue({ code: 'custom', path: ['release'], message: 'only a PUBLISHED member has a release' });
    }
  });

// Where an admitted dispatch is: persisted at every step, so a restarted
// runtime goes on from it alone, and answered as is (never pendingData, a
// token, request bytes or a storage path).
// IN_CALL: one mutation is DISPATCHING under a DB lease taken for this step.
//   Once leaseExpiresAt passed it is UNKNOWN, and it is never sent again.
// PROVIDER_PENDING: the provider took the call and answered pending. It is
//   polled read-only, each poll reserving its own units, backing off from the
//   last poll (lifecycleNextPollAt) until pollDeadlineAt, after which it is
//   UNKNOWN (PENDING_UNCONFIRMED). No lease is held between polls.
// NEXT_STEP: the next mutation waits for nextActionAt: a member's delay, the
//   second attempt after the transport's ledger proved the first never left,
//   the FINALIZE of a pending call the provider reported ready, or a budget
//   deferral. It is reserved, admitted and leased like the first
const continuation = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('IN_CALL'),
        member: position,
        step: z.enum(MANAGED_CALL_STEPS),
        callId: uuid,
        attempt: z.number().int().min(1).max(2),
        // the adapter's maximum for the step, reserved from the shared
        // budget before the call was admitted; units it did not use are kept
        reservedUnits: z.number().int().min(1).max(MANAGED_LIFECYCLE_LIMITS.maxStepUnits),
        admittedAt: instant,
        leaseExpiresAt: instant,
      })
      .strict(),
    z
      .object({
        kind: z.literal('PROVIDER_PENDING'),
        member: position,
        step: z.enum(MANAGED_CALL_STEPS),
        callId: uuid,
        pendingSince: instant,
        pollCount: z.number().int().min(0).max(MANAGED_LIFECYCLE_MAX_POLLS),
        lastPolledAt: instant.nullable(),
        nextPollAt: instant,
        pollDeadlineAt: instant,
      })
      .strict(),
    z
      .object({
        kind: z.literal('NEXT_STEP'),
        member: position,
        nextStep: z.enum(MANAGED_CALL_STEPS),
        attempt: z.number().int().min(1).max(2),
        nextActionAt: instant,
      })
      .strict(),
  ])
  .superRefine((next, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', path: [], message });
    const step = next.kind === 'NEXT_STEP' ? next.nextStep : next.step;

    if (step !== 'FINALIZE' && (step === 'POST') !== (next.member === 0)) {
      issue('the root is posted and every other member is a comment');
    }
    if (next.kind === 'NEXT_STEP' && next.nextStep === 'POST' && next.attempt !== 2) {
      issue('the root only waits for its second attempt');
    }
    if (next.kind === 'IN_CALL') {
      const lease = Date.parse(next.leaseExpiresAt) - Date.parse(next.admittedAt);
      if (
        !(lease > 0) ||
        lease >
          MANAGED_LIFECYCLE_TIMING.maxStepDeadlineMs + MANAGED_LIFECYCLE_TIMING.leaseMarginMs
      ) {
        issue('the lease is not taken for this one step');
      }
    }
    if (next.kind === 'PROVIDER_PENDING') {
      const since = Date.parse(next.pendingSince);
      const deadline = Date.parse(next.pollDeadlineAt);
      const nextPollAt = Date.parse(next.nextPollAt);
      if (
        deadline !== since + MANAGED_LIFECYCLE_TIMING.pollDeadlineMs ||
        (next.pollCount === 0) !== (next.lastPolledAt === null) ||
        (next.lastPolledAt !== null && Date.parse(next.lastPolledAt) < since) ||
        nextPollAt < nextPollTime(next.pendingSince, next.lastPolledAt, next.pollCount) ||
        nextPollAt > deadline
      ) {
        issue('the polls are not the backoff before the fixed deadline');
      }
    }
  });

export type ManagedDispatchContinuation = RequiredParsed<z.infer<typeof continuation>>;

// The continuation as the dispatcher persisted it, or null: a restarted
// runtime resumes only from a value that parses
export function parseManagedDispatchContinuation(
  raw: unknown
): ManagedDispatchContinuation | null {
  const parsed = continuation.safeParse(raw);
  return parsed.success ? (parsed.data as ManagedDispatchContinuation) : null;
}

const deferral = z
  .object({
    code: z.enum(MANAGED_DISPATCH_DEFERRAL_CODES),
    count: safeInt(1),
    firstDeferredAt: instant,
    nextAttemptAt: instant,
  })
  .strict();

const resolutionView = z
  .object({
    resolution: z.enum(MANAGED_RESOLUTIONS),
    previousStatus: z.enum(['UNKNOWN', 'PARTIAL']),
    operationKey,
    resolvedAt: instant,
    evidence: resolveEvidence,
    // every member as the human confirmed it (the resolve request's members)
    members: z.array(resolveMember).min(1).max(MANAGED_LIFECYCLE_LIMITS.members),
    resend: z.literal('NEVER'),
  })
  .strict();

type Presence = 'REQUIRED' | 'ABSENT' | 'EITHER';
interface DispatchStatusRule {
  codes: readonly string[] | null;
  admittedAt: Presence;
  settledAt: Presence;
  continuation: Presence;
  deferral: Presence;
  cancelledByOperationKey: Presence;
  resolution: Presence;
}

const NOT_STARTED = {
  continuation: 'ABSENT',
  deferral: 'ABSENT',
  cancelledByOperationKey: 'ABSENT',
  resolution: 'ABSENT',
} as const;
const SETTLED_AFTER_ADMISSION = {
  ...NOT_STARTED,
  admittedAt: 'REQUIRED',
  settledAt: 'REQUIRED',
} as const;
const RESOLVED_RULE: DispatchStatusRule = {
  ...SETTLED_AFTER_ADMISSION,
  codes: MANAGED_DISPATCH_PARTIAL_CODES,
  resolution: 'REQUIRED',
};

// Which fields each dispatch status has (its members: membersFit). EXPIRED:
// never admitted before admissibleUntil or the window passed; NOT_SENT:
// refused by the admission check, or the root proven never sent
const DISPATCH_RULES: Record<ManagedDispatchStatus, DispatchStatusRule> = {
  PENDING: { ...NOT_STARTED, codes: null, admittedAt: 'ABSENT', settledAt: 'ABSENT', deferral: 'EITHER' },
  ADMITTED: {
    ...NOT_STARTED,
    codes: null,
    admittedAt: 'REQUIRED',
    settledAt: 'ABSENT',
    continuation: 'REQUIRED',
    deferral: 'EITHER',
  },
  PUBLISHED: { ...SETTLED_AFTER_ADMISSION, codes: null },
  CANCELLED: { ...NOT_STARTED, codes: null, admittedAt: 'ABSENT', settledAt: 'REQUIRED', cancelledByOperationKey: 'REQUIRED' },
  EXPIRED: { ...NOT_STARTED, codes: ['WINDOW_CLOSED', 'LATE_BEYOND_TOLERANCE'], admittedAt: 'ABSENT', settledAt: 'REQUIRED' },
  NOT_SENT: { ...NOT_STARTED, codes: MANAGED_DISPATCH_NOT_SENT_CODES, admittedAt: 'EITHER', settledAt: 'REQUIRED' },
  REJECTED: { ...SETTLED_AFTER_ADMISSION, codes: MANAGED_DISPATCH_REJECTED_CODES },
  PARTIAL: { ...SETTLED_AFTER_ADMISSION, codes: MANAGED_DISPATCH_PARTIAL_CODES },
  UNKNOWN: { ...SETTLED_AFTER_ADMISSION, codes: MANAGED_DISPATCH_UNKNOWN_CODES },
  RESOLVED_PUBLISHED: RESOLVED_RULE,
  RESOLVED_NOT_PUBLISHED: RESOLVED_RULE,
  RESOLVED_ABANDONED: RESOLVED_RULE,
};

// GET /dispatches/:dispatchId, and every dispatch inside other answers. One
// occurrence of a schedule with the exact binding it was materialized with.
// Only PUBLISHED and RESOLVED_PUBLISHED are evidence of publication; every
// other status, the HTTP acknowledgement of the write included, is not
const dispatchView = z
  .object({
    dispatchId: uuid,
    scheduleId: uuid,
    managedPostId: uuid,
    occurrence,
    dueAt: instant,
    // the last instant the POST may be admitted: dueAt + the schedule's
    // maxLatenessMs, and before its windowEndsAt
    admissibleUntil: instant,
    status: z.enum(MANAGED_DISPATCH_STATUSES),
    // +1 on every status or member transition (not on a poll); what
    // expectedDispatchVersion is compared with
    dispatchVersion: safeInt(1),
    code: z.string().nullable(),
    revision: safeInt(1),
    bindingGeneration: safeInt(1),
    scheduleGeneration: safeInt(1),
    releaseHash: hash,
    contentSha256,
    members: z.array(dispatchMember).min(1).max(MANAGED_LIFECYCLE_LIMITS.members),
    deferral: deferral.nullable(),
    continuation: continuation.nullable(),
    admittedAt: instant.nullable(),
    settledAt: instant.nullable(),
    cancelledByOperationKey: operationKey.nullable(),
    resolution: resolutionView.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict()
  .superRefine((dispatch, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const rule = DISPATCH_RULES[dispatch.status];
    const present = (
      key: 'admittedAt' | 'settledAt' | 'continuation' | 'deferral' | 'cancelledByOperationKey' | 'resolution'
    ) => {
      const presence = rule[key];
      const has = dispatch[key] !== null;
      if ((presence === 'REQUIRED' && !has) || (presence === 'ABSENT' && has)) {
        issue(key, `${key} does not match status ${dispatch.status}`);
      }
    };

    if (rule.codes ? !rule.codes.includes(dispatch.code) : dispatch.code !== null) {
      issue('code', `code does not match status ${dispatch.status}`);
    }
    present('admittedAt');
    present('settledAt');
    present('continuation');
    present('deferral');
    present('cancelledByOperationKey');
    present('resolution');

    const lateness = Date.parse(dispatch.admissibleUntil) - Date.parse(dispatch.dueAt);
    if (lateness < 0 || lateness > MANAGED_LIFECYCLE_LIMITS.maxLatenessMs) {
      issue('admissibleUntil', 'admissibleUntil is not dueAt + maxLatenessMs');
    }
    dispatch.members.forEach((member, index) => {
      if (member.position !== index) {
        issue('members', 'member positions are not 0..n-1');
      }
    });

    // A resolved dispatch is checked by the members it was resolved from
    const statuses = dispatch.members.map((member) => member.status);
    const resolution = dispatch.resolution;
    const before = resolution
      ? resolution.members.map((member) => member.expectedStatus)
      : statuses;
    if (!resolution) {
      if (!membersFit(dispatch.status, statuses)) {
        issue('members', `member statuses do not match status ${dispatch.status}`);
      }
    } else if (
      resolution.resolution !== dispatch.status ||
      !resolvableFrom(
        resolution.previousStatus,
        resolution.members.map((member) => member.position),
        before
      ) ||
      resolution.members.some(
        (member, index) => member.postId !== dispatch.members[index]?.postId
      ) ||
      !sameList(statuses, resolution.members.map(lifecycleResolvedMemberStatus)) ||
      dispatch.status !== lifecycleResolutionOf(statuses)
    ) {
      issue('resolution', 'the members are not the ones the resolution recorded');
    }

    // the member the dispatch stopped at carries its code, and every member
    // after it was not sent because of it
    const at = firstUnpublished(before);
    dispatch.members.forEach((member, index) => {
      if (
        member.status === 'NOT_SENT' &&
        (index > at) !== (member.code === 'PREVIOUS_MEMBER_FAILED')
      ) {
        issue('members', 'only a member after the one that failed is PREVIOUS_MEMBER_FAILED');
      }
    });
    if (
      (['REJECTED', 'UNKNOWN', 'PARTIAL'].includes(dispatch.status) ||
        (dispatch.status === 'NOT_SENT' && dispatch.admittedAt !== null)) &&
      dispatch.code !== dispatch.members[at]?.code
    ) {
      issue('code', 'code is not the code of the member the dispatch stopped at');
    }
    if (
      dispatch.status === 'NOT_SENT' &&
      (dispatch.admittedAt === null) !== (statuses[0] === 'WAITING')
    ) {
      issue('admittedAt', 'only a dispatch refused at admission has no admittedAt');
    }

    const next = dispatch.continuation;
    if (next) {
      const expected =
        next.kind === 'IN_CALL'
          ? 'DISPATCHING'
          : next.kind === 'PROVIDER_PENDING' || next.nextStep === 'FINALIZE'
          ? 'PENDING_PROVIDER'
          : 'WAITING';
      if (next.member !== firstUnpublished(statuses) || statuses[next.member] !== expected) {
        issue('continuation', 'continuation does not name the member in progress');
      }
      if (
        dispatch.deferral &&
        (next.kind === 'IN_CALL' ||
          dispatch.deferral.nextAttemptAt !==
            (next.kind === 'PROVIDER_PENDING' ? next.nextPollAt : next.nextActionAt))
      ) {
        issue('deferral', 'only a waiting step is deferred, to when it is tried next');
      }
    }
  });

export type ManagedDispatchView = RequiredParsed<z.infer<typeof dispatchView>>;
export type ManagedScheduleView = RequiredParsed<z.infer<typeof scheduleView>>;

export function parseManagedScheduleView(raw: unknown): ManagedScheduleView | null {
  const parsed = scheduleView.safeParse(raw);
  return parsed.success ? (parsed.data as ManagedScheduleView) : null;
}

// The exact scope a cancel (DELETE: the cancels of a delete) affects now,
// from the schedule and its dispatches as stored: what the body's affected,
// inFlight and affectedHash must have been computed from. `from` is the
// body's occurrence / fromOccurrence (null for SERIES and DELETE). A code
// when that scope can't be cancelled as asked
export function lifecycleCancelScope(
  schedule: Pick<ManagedScheduleView, 'status' | 'dueAts' | 'lastOccurrence'>,
  dispatches: readonly Pick<
    ManagedDispatchView,
    'dispatchId' | 'occurrence' | 'status' | 'dispatchVersion'
  >[],
  scope: ManagedCancelScope | 'DELETE',
  from: number | null
):
  | { affected: ManagedAffectedOccurrence[]; inFlight: ManagedInFlightOccurrence | null }
  | ManagedLifecycleCode {
  const last = schedule.lastOccurrence;
  if (!['ACTIVE', 'ENDING'].includes(schedule.status) || last === null) {
    return 'LIFECYCLE_STATE_CONFLICT';
  }

  // one occurrence is materialized at a time: only the latest can be open
  const latest = dispatches.reduce<(typeof dispatches)[number] | null>(
    (found, dispatch) =>
      !found || dispatch.occurrence > found.occurrence ? dispatch : found,
    null
  );
  const pending = latest?.status === 'PENDING' ? latest : null;
  const inFlight =
    latest && ['ADMITTED', 'UNKNOWN', 'PARTIAL'].includes(latest.status) ? latest : null;
  const first = pending ? pending.occurrence : (latest?.occurrence ?? -1) + 1;
  if (first > last) {
    return 'LIFECYCLE_STATE_CONFLICT';
  }

  const blocked = inFlight
    ? inFlight.status === 'ADMITTED'
      ? 'DISPATCH_IN_PROGRESS'
      : 'DISPATCH_UNRESOLVED'
    : null;
  if (scope === 'SERIES' || scope === 'DELETE') {
    if (blocked) {
      return blocked;
    }
  } else if (!Number.isSafeInteger(from) || from < first || from > last ||
      (scope === 'OCCURRENCE' && from !== first)) {
    return blocked && from === inFlight.occurrence ? blocked : 'CANCEL_SCOPE_MISMATCH';
  }
  if (scope === 'OCCURRENCE' && !pending) {
    return 'CANCEL_SCOPE_MISMATCH';
  }

  const affected: ManagedAffectedOccurrence[] = [];
  const start = scope === 'REMAINING' ? from! : first;
  for (let n = start; n <= (scope === 'OCCURRENCE' ? first : last); n++) {
    affected.push(
      n === first && pending
        ? {
            state: 'PENDING',
            occurrence: n,
            dueAt: schedule.dueAts[n],
            dispatchId: pending.dispatchId,
            expectedDispatchVersion: pending.dispatchVersion,
          }
        : { state: 'NOT_MATERIALIZED', occurrence: n, dueAt: schedule.dueAts[n] }
    );
  }
  return {
    affected,
    inFlight:
      scope === 'REMAINING' && inFlight
        ? {
            occurrence: inFlight.occurrence,
            dispatchId: inFlight.dispatchId,
            expectedStatus: inFlight.status as ManagedInFlightOccurrence['expectedStatus'],
            expectedDispatchVersion: inFlight.dispatchVersion,
          }
        : null,
  };
}

// The state the post's rows must be in when an occurrence is admitted: QUEUE
// until an occurrence of the schedule was published, PUBLISHED from then on.
// A cancelled (skipped) occurrence publishes nothing, so after a skipped
// occurrence 0 the next one is still admitted from QUEUE. Independent of the
// post's lifecycle, which stays SCHEDULED while the schedule is live
export const lifecycleAdmissionRowState = (
  earlier: readonly ManagedDispatchStatus[]
): 'QUEUE' | 'PUBLISHED' =>
  earlier.some((status) => status === 'PUBLISHED' || status === 'RESOLVED_PUBLISHED')
    ? 'PUBLISHED'
    : 'QUEUE';

// The post's lifecycle while its latest schedule is live, from every
// dispatch of that schedule: an admitted call, then an unresolved one, else
// SCHEDULED, whatever an earlier occurrence published
export const lifecycleWhileScheduled = (
  statuses: readonly ManagedDispatchStatus[]
): 'SCHEDULED' | 'DISPATCHING' | 'REVIEW' =>
  statuses.includes('ADMITTED')
    ? 'DISPATCHING'
    : statuses.includes('UNKNOWN') || statuses.includes('PARTIAL')
    ? 'REVIEW'
    : 'SCHEDULED';

// The answer of every lifecycle write, stored verbatim with its operation and
// answered again (replayed: true) for the same key and payload
const resultBinding = {
  version,
  operationKey,
  payloadHash: hash,
  replayed: z.boolean(),
  sequence: safeInt(1),
  committedAt: instant,
  managedPostId: uuid,
  revision: safeInt(1),
  // after the operation
  scheduleGeneration: safeInt(0),
  lifecycle: z.enum(MANAGED_POST_LIFECYCLES),
  schedule: scheduleView.nullable(),
  // the dispatches the operation created or changed
  dispatches: z.array(dispatchView).max(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences),
};

const cancelledOccurrences = z
  .array(occurrence)
  .max(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences);

// What a cancel leaves of the series, and the schedule status that is:
// CONTINUES: an OCCURRENCE cancel of an ACTIVE series that goes on.
// ENDS_AFTER_IN_FLIGHT: a REMAINING cancel that left only the earlier
//   occurrence that is admitted or unresolved.
// ENDS_AFTER_REMAINING: a truncated series that still has an earlier pending
//   occurrence, or future occurrences up to lastOccurrence, to run.
// ENDED: nothing is left to run; this cancel ended the schedule CANCELLED.
export const MANAGED_CANCEL_SERIES = [
  'CONTINUES',
  'ENDS_AFTER_IN_FLIGHT',
  'ENDS_AFTER_REMAINING',
  'ENDED',
] as const;
type ManagedCancelSeries = (typeof MANAGED_CANCEL_SERIES)[number];

const CANCEL_SERIES_RULES: Record<
  ManagedCancelSeries,
  {
    status: ManagedScheduleStatus;
    scopes: readonly ManagedCancelScope[];
    lifecycles: readonly ManagedPostLifecycle[];
  }
> = {
  CONTINUES: { status: 'ACTIVE', scopes: ['OCCURRENCE'], lifecycles: ['SCHEDULED'] },
  ENDS_AFTER_IN_FLIGHT: { status: 'ENDING', scopes: ['REMAINING'], lifecycles: ['DISPATCHING', 'REVIEW'] },
  ENDS_AFTER_REMAINING: {
    status: 'ENDING',
    scopes: ['OCCURRENCE', 'REMAINING'],
    lifecycles: ['SCHEDULED', 'DISPATCHING', 'REVIEW'],
  },
  ENDED: { status: 'CANCELLED', scopes: MANAGED_CANCEL_SCOPES, lifecycles: ['DRAFT', 'PUBLISHED', 'FAILED'] },
};

// ascending without gaps or repeats, as the affected occurrences they are
const isContiguous = (list: readonly number[]) =>
  list.every((value, index) => index === 0 || value === list[index - 1] + 1);

const lifecycleResult = z
  .discriminatedUnion('kind', [
    z.object({ ...resultBinding, kind: z.literal('SCHEDULE') }).strict(),
    z.object({ ...resultBinding, kind: z.literal('PUBLISH_NOW') }).strict(),
    z
      .object({
        ...resultBinding,
        kind: z.literal('CANCEL'),
        cancellation: z
          .object({
            scope: z.enum(MANAGED_CANCEL_SCOPES),
            scheduleId: uuid,
            cancelledOccurrences: cancelledOccurrences.min(1),
            series: z.enum(MANAGED_CANCEL_SERIES),
            // no cancel changes the schedule generation an admitted
            // occurrence is bound to; every cancel advances the version
            generation: z.literal('UNCHANGED'),
            scheduleVersion: z.literal('ADVANCED'),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...resultBinding,
        kind: z.literal('DELETE'),
        deletion: z
          .object({
            mode: z.literal('RETAINED_SOFT_DELETE'),
            platformPost: z.literal('NOT_DELETED'),
            wasPublished: z.boolean(),
            retainedPostIds: z.array(id).min(1).max(MANAGED_LIFECYCLE_LIMITS.members),
            cancelledOccurrences,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...resultBinding,
        kind: z.literal('RESOLVE'),
        dispatchId: uuid,
        resolution: z.enum(MANAGED_RESOLUTIONS),
        resend: z.literal('NEVER'),
      })
      .strict(),
  ])
  .superRefine((result, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    // A retained draft can be deleted before it ever had a schedule. Every
    // other lifecycle operation necessarily belongs to a positive generation.
    if (result.scheduleGeneration === 0 && (result.kind !== 'DELETE' ||
        result.schedule !== null || result.dispatches.length !== 0)) {
      issue('scheduleGeneration', 'only deletion of a never-scheduled draft has generation zero');
    }

    if (
      result.dispatches.some((dispatch) => dispatch.managedPostId !== result.managedPostId) ||
      (result.schedule && result.schedule.managedPostId !== result.managedPostId)
    ) {
      issue('managedPostId', 'the answer covers another post');
    }

    if (result.kind === 'SCHEDULE' || result.kind === 'PUBLISH_NOW') {
      const schedule = result.schedule;
      const [first] = result.dispatches;
      if (
        !schedule ||
        schedule.mode !== (result.kind === 'SCHEDULE' ? 'AT' : 'NOW') ||
        schedule.status !== 'ACTIVE' ||
        schedule.operationKey !== result.operationKey ||
        schedule.scheduleGeneration !== result.scheduleGeneration
      ) {
        issue('schedule', 'the new schedule is not the one this operation created');
      }
      if (
        result.dispatches.length !== 1 ||
        first.occurrence !== 0 ||
        first.status !== 'PENDING' ||
        first.scheduleGeneration !== result.scheduleGeneration
      ) {
        issue('dispatches', 'a new schedule materializes exactly its first occurrence');
      }
      if (result.lifecycle !== 'SCHEDULED') {
        issue('lifecycle', 'a new schedule leaves the post SCHEDULED');
      }
    }
    if (
      result.kind === 'CANCEL' &&
      result.schedule?.scheduleId !== result.cancellation.scheduleId
    ) {
      issue('cancellation', 'the cancelled schedule is not the one answered');
    }
    if (result.kind === 'DELETE' && result.lifecycle !== 'DELETED') {
      issue('lifecycle', 'a delete leaves the post DELETED');
    }

    // A cancel or delete keeps the generation, cancels only occurrences of
    // the answered schedule and answers only the dispatch it cancelled: at
    // most the one materialized occurrence, the first it cancelled. An
    // affected occurrence never materialized has no dispatch to answer
    if (result.kind === 'CANCEL' || result.kind === 'DELETE') {
      const schedule = result.schedule;
      const cancelled =
        result.kind === 'CANCEL'
          ? result.cancellation.cancelledOccurrences
          : result.deletion.cancelledOccurrences;
      if (schedule && schedule.scheduleGeneration !== result.scheduleGeneration) {
        issue('schedule', 'a cancel or delete never changes the schedule generation');
      }
      if (
        !isContiguous(cancelled) ||
        (cancelled.length > 0 &&
          (!schedule || cancelled[cancelled.length - 1] >= schedule.maxOccurrences))
      ) {
        issue('cancelledOccurrences', 'cancelled occurrences are not unique, ascending occurrences of the schedule');
      }
      if (
        result.dispatches.length > 1 ||
        result.dispatches.some(
          (dispatch) =>
            dispatch.status !== 'CANCELLED' ||
            dispatch.cancelledByOperationKey !== result.operationKey ||
            dispatch.scheduleId !== schedule?.scheduleId ||
            dispatch.scheduleGeneration !== result.scheduleGeneration ||
            dispatch.occurrence !== cancelled[0]
        )
      ) {
        issue('dispatches', 'only the materialized occurrence this operation cancelled is answered');
      }
    }

    if (result.kind === 'CANCEL' && result.schedule) {
      const { scope, series, cancelledOccurrences: cancelled } = result.cancellation;
      const schedule = result.schedule;
      const rule = CANCEL_SERIES_RULES[series];
      const [first] = cancelled;
      const last = schedule.lastOccurrence;
      if (
        schedule.status !== rule.status ||
        !rule.scopes.includes(scope) ||
        schedule.scheduleVersion < 2 ||
        (series === 'ENDED' && schedule.endedOperationKey !== result.operationKey)
      ) {
        issue('cancellation', 'series does not match the scope and the schedule it left');
      }
      // REMAINING truncates right before the first occurrence it cancelled;
      // OCCURRENCE ends the series only when it cancelled the last one;
      // SERIES cancels through lastOccurrence
      if (
        scope === 'REMAINING'
          ? last !== (first > 0 ? first - 1 : null)
          : scope === 'OCCURRENCE'
          ? cancelled.length !== 1 || (series === 'ENDED' ? first !== last : !(first < last))
          : cancelled[cancelled.length - 1] !== last
      ) {
        issue('cancelledOccurrences', 'cancelled occurrences do not match the scope and lastOccurrence');
      }
      if (scope === 'OCCURRENCE' && result.dispatches.length !== 1) {
        issue('dispatches', 'an OCCURRENCE cancel answers the pending dispatch it cancelled');
      }
      if (!rule.lifecycles.includes(result.lifecycle)) {
        issue('lifecycle', `lifecycle does not match series ${series}`);
      }
    }

    // A delete answers the latest schedule, if the post ever had one. Only
    // the live schedule it superseded has occurrences it cancelled, through
    // its lastOccurrence; nothing it cancelled is fabricated. Publication is
    // only asserted against what the answer itself shows
    if (result.kind === 'DELETE') {
      const schedule = result.schedule;
      const { cancelledOccurrences: cancelled, wasPublished } = result.deletion;
      const superseded = schedule?.status === 'SUPERSEDED_BY_DELETE';
      if (
        (schedule === null) !== (result.scheduleGeneration === 0) ||
        (schedule && isLiveSchedule(schedule.status))
      ) {
        issue('schedule', 'a delete answers the latest schedule, never a live one');
      }
      if (
        superseded !== (cancelled.length > 0) ||
        (superseded &&
          (schedule.endedOperationKey !== result.operationKey ||
            cancelled[cancelled.length - 1] !== schedule.lastOccurrence))
      ) {
        issue('cancelledOccurrences', 'only the schedule this delete superseded has cancelled occurrences, through its lastOccurrence');
      }
      if (
        (result.scheduleGeneration === 0 && wasPublished) ||
        (schedule?.status === 'COMPLETED' && !wasPublished)
      ) {
        issue('deletion', 'wasPublished contradicts the answered schedule');
      }
    }
    if (
      result.kind === 'RESOLVE' &&
      !result.dispatches.some(
        (dispatch) =>
          dispatch.dispatchId === result.dispatchId && dispatch.status === result.resolution
      )
    ) {
      issue('dispatches', 'the resolved dispatch is not in the answer');
    }
  });

export type ManagedLifecycleResult = RequiredParsed<z.infer<typeof lifecycleResult>>;

// GET /posts/:managedPostId/lifecycle: a database read of the post's
// lifecycle and its latest schedule. History is in the lifecycle event feed
const lifecycleView = z
  .object({
    version,
    managedPostId: uuid,
    asOfSequence: safeInt(0),
    revision: safeInt(1),
    bindingGeneration: safeInt(1),
    scheduleGeneration: safeInt(0),
    lifecycle: z.enum(MANAGED_POST_LIFECYCLES),
    deletion: z
      .object({
        mode: z.literal('RETAINED_SOFT_DELETE'),
        platformPost: z.literal('NOT_DELETED'),
        deletedAt: instant,
        operationKey,
      })
      .strict()
      .nullable(),
    schedule: scheduleView.nullable(),
    dispatches: z.array(dispatchView).max(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences),
    unresolvedDispatchIds: z.array(uuid).max(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences),
    scheduleCount: safeInt(0),
  })
  .strict()
  .superRefine((view, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    if ((view.lifecycle === 'DELETED') !== (view.deletion !== null)) {
      issue('deletion', 'only a DELETED post has a deletion');
    }
    if ((view.schedule === null) !== (view.scheduleCount === 0)) {
      issue('scheduleCount', 'scheduleCount does not match schedule');
    }
    if (view.schedule && view.schedule.scheduleGeneration > view.scheduleGeneration) {
      issue('schedule', 'the schedule is newer than the post');
    }
    if (
      view.dispatches.some(
        (dispatch) =>
          dispatch.scheduleId !== view.schedule?.scheduleId ||
          dispatch.managedPostId !== view.managedPostId
      )
    ) {
      issue('dispatches', 'a dispatch is not of the latest schedule');
    }
    const unresolved = view.dispatches
      .filter((dispatch) => dispatch.status === 'UNKNOWN' || dispatch.status === 'PARTIAL')
      .map((dispatch) => dispatch.dispatchId);
    if (!sameList(unresolved, view.unresolvedDispatchIds)) {
      issue('unresolvedDispatchIds', 'unresolvedDispatchIds are not the UNKNOWN / PARTIAL dispatches');
    }

    // a live schedule decides the lifecycle; a tombstone has none, nothing
    // admitted or unresolved, and names the delete that superseded it
    const live = view.schedule !== null && isLiveSchedule(view.schedule.status);
    if (view.lifecycle === 'DELETED') {
      if (
        live ||
        unresolved.length > 0 ||
        view.dispatches.some((dispatch) => dispatch.status === 'ADMITTED')
      ) {
        issue('schedule', 'a deleted post has no live schedule and nothing in flight');
      }
    } else if (
      live
        ? view.lifecycle !==
          lifecycleWhileScheduled(view.dispatches.map((dispatch) => dispatch.status))
        : view.lifecycle === 'SCHEDULED'
    ) {
      issue('lifecycle', 'lifecycle does not follow from the live schedule');
    }
    if (
      view.schedule?.status === 'SUPERSEDED_BY_DELETE' &&
      view.deletion?.operationKey !== view.schedule.endedOperationKey
    ) {
      issue('schedule', 'a superseded schedule belongs to the deletion of the post');
    }
  });

// GET /lifecycle/operations/:operationKey: whether a lifecycle key committed,
// and if so the answer stored with it (replayed: false, as first answered).
// ABSENT is only true as of asOfSequence. A DRAFT key is never an answer
// here: it is a typed 409 OPERATION_KEY_KIND_MISMATCH
// (lifecycleKindMismatchException), as a lifecycle key is on the DRAFT lookup
const operationLookup = z
  .discriminatedUnion('status', [
    z
      .object({
        version,
        operationKey,
        status: z.literal('ABSENT'),
        asOfSequence: safeInt(0),
      })
      .strict(),
    z
      .object({
        version,
        operationKey,
        status: z.literal('COMMITTED'),
        asOfSequence: safeInt(1),
        kind: z.enum(MANAGED_LIFECYCLE_KINDS),
        payloadHash: hash,
        managedPostId: uuid,
        sequence: safeInt(1),
        committedAt: instant,
        currentScheduleGeneration: safeInt(0),
        currentLifecycle: z.enum(MANAGED_POST_LIFECYCLES),
        // SUPERSEDED: a later lifecycle write changed the schedule generation
        ack: z.enum(['CURRENT', 'SUPERSEDED']),
        result: lifecycleResult,
      })
      .strict(),
  ])
  .superRefine((lookup, ctx) => {
    if (lookup.status !== 'COMMITTED') {
      return;
    }
    const { result } = lookup;
    if (
      result.kind !== lookup.kind ||
      result.operationKey !== lookup.operationKey ||
      result.payloadHash !== lookup.payloadHash ||
      result.managedPostId !== lookup.managedPostId ||
      result.sequence !== lookup.sequence ||
      result.committedAt !== lookup.committedAt ||
      result.replayed !== false
    ) {
      ctx.addIssue({ code: 'custom', path: ['result'], message: 'result is not the stored answer of this key' });
    }
    if (lookup.asOfSequence < lookup.sequence) {
      ctx.addIssue({ code: 'custom', path: ['asOfSequence'], message: 'read before the key committed' });
    }
    // the generation only ever advances
    if (lookup.currentScheduleGeneration < result.scheduleGeneration) {
      ctx.addIssue({ code: 'custom', path: ['currentScheduleGeneration'], message: 'the current schedule generation is older than the answer' });
    }
    const current = lookup.currentScheduleGeneration === result.scheduleGeneration;
    if ((lookup.ack === 'CURRENT') !== current) {
      ctx.addIssue({ code: 'custom', path: ['ack'], message: 'ack does not match the current schedule generation' });
    }
  });

// Which ids each event kind names. A write names its operation key, the
// dispatcher never does (its events follow from no request); a dispatch
// event names its dispatch and that dispatch's schedule
interface EventRule {
  scheduleId: Presence;
  dispatchId: Presence;
  operationKey: Presence;
}
const BY_DISPATCHER: EventRule = { scheduleId: 'REQUIRED', dispatchId: 'REQUIRED', operationKey: 'ABSENT' };
const NEW_SCHEDULE: EventRule = { scheduleId: 'REQUIRED', dispatchId: 'REQUIRED', operationKey: 'REQUIRED' };
const EVENT_RULES: Record<ManagedLifecycleEventKind, EventRule> = {
  POST_SCHEDULED: NEW_SCHEDULE,
  POST_PUBLISH_REQUESTED: NEW_SCHEDULE,
  POST_SCHEDULE_CANCELLED: { scheduleId: 'REQUIRED', dispatchId: 'ABSENT', operationKey: 'REQUIRED' },
  POST_OCCURRENCE_CANCELLED: NEW_SCHEDULE,
  // a post that was never scheduled has no schedule to name
  POST_DELETED: { scheduleId: 'EITHER', dispatchId: 'ABSENT', operationKey: 'REQUIRED' },
  OCCURRENCE_MATERIALIZED: BY_DISPATCHER,
  OCCURRENCE_EXPIRED: BY_DISPATCHER,
  DISPATCH_ADMITTED: BY_DISPATCHER,
  DISPATCH_PROGRESSED: BY_DISPATCHER,
  DISPATCH_NOT_SENT: BY_DISPATCHER,
  DISPATCH_PUBLISHED: BY_DISPATCHER,
  DISPATCH_REJECTED: BY_DISPATCHER,
  DISPATCH_PARTIAL: BY_DISPATCHER,
  DISPATCH_OUTCOME_UNKNOWN: BY_DISPATCHER,
  DISPATCH_RESOLVED: NEW_SCHEDULE,
};

// One event of the lifecycle feed, with the post's lifecycle view as of it
// (its latest schedule, every dispatch of that schedule, so at most
// repeatMaxOccurrences, and the retained deletion tombstone). Nothing else:
// no free-form JSON, pendingData, token, request bytes or storage path
const lifecycleEvent = z
  .object({
    sequence: safeInt(1),
    kind: z.enum(MANAGED_LIFECYCLE_EVENT_KINDS),
    managedPostId: uuid,
    scheduleId: uuid.nullable(),
    dispatchId: uuid.nullable(),
    operationKey: operationKey.nullable(),
    at: instant,
    projection: lifecycleView,
  })
  .strict()
  .superRefine((event, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const rule = EVENT_RULES[event.kind];
    (['scheduleId', 'dispatchId', 'operationKey'] as const).forEach((key) => {
      const has = event[key] !== null;
      if ((rule[key] === 'REQUIRED' && !has) || (rule[key] === 'ABSENT' && has)) {
        issue(key, `${key} does not match kind ${event.kind}`);
      }
    });

    const { projection } = event;
    if (
      projection.managedPostId !== event.managedPostId ||
      projection.asOfSequence !== event.sequence
    ) {
      issue('projection', 'the projection is not of this post as of this event');
    }
    if (event.scheduleId !== null && projection.schedule?.scheduleId !== event.scheduleId) {
      issue('scheduleId', 'the event names a schedule the projection does not have');
    }
    if (
      event.dispatchId !== null &&
      !projection.dispatches.some((dispatch) => dispatch.dispatchId === event.dispatchId)
    ) {
      issue('dispatchId', 'the event names a dispatch the projection does not have');
    }
    if ((event.kind === 'POST_DELETED') !== (projection.lifecycle === 'DELETED')) {
      issue('projection', 'only the deletion event projects a DELETED post');
    }
  });

// GET /lifecycle/events?after=: its own feed and sequence, apart from the
// DRAFT change feed. The events are dense: afterSequence + 1 up to
// nextSequence, which the next page is read after. hasMore exactly when the
// head is further, and then the page makes progress, so a cursor can't loop
const eventsPage = z
  .object({
    version,
    afterSequence: safeInt(0),
    headSequence: safeInt(0),
    nextSequence: safeInt(0),
    events: z.array(lifecycleEvent).max(MANAGED_LIFECYCLE_LIMITS.eventsPageMax),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((page, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (page.events.some((event, index) => event.sequence !== page.afterSequence + 1 + index)) {
      issue('events', 'events are not dense and ascending from afterSequence + 1');
    }
    if (
      page.nextSequence !== page.afterSequence + page.events.length ||
      page.nextSequence > page.headSequence
    ) {
      issue('nextSequence', 'nextSequence is not the last event, at most the head');
    }
    if (
      page.hasMore !== page.nextSequence < page.headSequence ||
      (page.hasMore && page.events.length === 0)
    ) {
      issue('hasMore', 'hasMore does not match the head');
    }
  });

// ---- capabilities -----------------------------------------------------------------

// Everything the capability document declares that does not depend on the
// operator's gates
export const MANAGED_LIFECYCLE_RULES = {
  routes: MANAGED_LIFECYCLE_ROUTES,
  operationKey: {
    pattern: MANAGED_OPERATION_KEY.source,
    namespace: 'SHARED_WITH_DRAFTS',
    // on either lookup or write, never ABSENT
    otherKind: 'OPERATION_KEY_KIND_MISMATCH',
  },
  payloadHash: { excludes: ['version', 'operationKey'], nulls: 'HASHED', absentKeys: 'REFUSED' },
  codecs: [...MANAGED_CAPTION_CODECS],
  // the publication text policy itself, apart from the DRAFT v2 text domain;
  // the strict decoder runs before anything is queued and again at admission
  text: {
    rules: MANAGED_PUBLICATION_TEXT_RULES,
    checkedAt: ['RELEASE_PREVIEW', 'REQUEST_ACCEPTANCE', 'ADMISSION'],
    upstreamConverter: 'NOT_USED',
  },
  releaseHash: {
    version: MANAGED_RELEASE_HASH_VERSION,
    boundSeparately: ['SCHEDULE_GENERATION', 'DUE_AT'],
    digest: 'SHA256_CANONICAL_JSON_SORTED_KEYS',
    // fingerprint() of the approved provider settings, without __type
    settingsHash: { input: 'APPROVED_PROVIDER_SETTINGS', excludes: ['__type'] },
    media: ['SHA256', 'BYTE_LENGTH', 'MIME_TYPE'],
    cover: ['SHA256', 'BYTE_LENGTH', 'MIME_TYPE'],
  },
  // both hashes are frozen by the confirmation and stored with the schedule
  // and every dispatch; the release preview is only compared with
  approval: {
    contentSha256: 'WW_APPROVED_PAYLOAD_STORED_AS_SENT',
    releaseHash: 'DERIVED_INDEPENDENTLY',
    frozenWith: ['REVISION', 'BINDING_GENERATION', 'SCHEDULE_GENERATION', 'AFFECTED_SCOPE'],
    releasePreview: 'COMPARISON_ONLY',
  },
  window: {
    appliesTo: ['SCHEDULE', 'PUBLISH_NOW', 'ADMISSION', 'PROVIDER_REQUEST'],
    maxExpiresAt: MANAGED_LIFECYCLE_MAX_EXPIRY.toISOString(),
    expiry: 'EXCLUSIVE',
    maxPolicyDays: MANAGED_LIFECYCLE_MAX_POLICY_DAYS,
    minLeadMs: MANAGED_LIFECYCLE_LIMITS.minLeadMs,
    maxLatenessMs: MANAGED_LIFECYCLE_LIMITS.maxLatenessMs,
    // windowEndsAt is captured when a schedule is accepted
    schedule: 'CAPTURED_IMMUTABLE',
    laterPolicy: 'NEVER_EXTENDS',
  },
  timing: { ...MANAGED_LIFECYCLE_TIMING },
  repeat: {
    minIntervalDays: MANAGED_LIFECYCLE_LIMITS.repeatMinIntervalDays,
    maxIntervalDays: MANAGED_LIFECYCLE_LIMITS.repeatMaxIntervalDays,
    minOccurrences: MANAGED_LIFECYCLE_LIMITS.repeatMinOccurrences,
    maxOccurrences: MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences,
    anchoring: 'PUBLISH_AT_PLUS_WHOLE_UTC_DAYS',
    materialization: 'ONE_AT_A_TIME',
    materializeAfter: [...MANAGED_MATERIALIZE_AFTER],
    afterFailureOrUnknown: 'NO_FURTHER_OCCURRENCE',
  },
  cancel: {
    scopes: [...MANAGED_CANCEL_SCOPES],
    binding: ['EXPECTED_SCHEDULE_VERSION', 'AFFECTED_OCCURRENCES', 'AFFECTED_HASH'],
    affectedHashVersion: MANAGED_AFFECTED_HASH_VERSION,
    affectedAdmitted: 'REFUSED',
    unaffectedAdmitted: 'SETTLES_UNDER_ITS_OWN_BINDING',
    generation: 'UNCHANGED',
    scheduleVersion: 'ADVANCED',
    endRequest: 'FIRST_RETAINED',
    truncation: 'ONLY_LOWERS_LAST_OCCURRENCE',
    series: [...MANAGED_CANCEL_SERIES],
  },
  delete: {
    mode: 'RETAINED_SOFT_DELETE',
    platformPost: 'NEVER_DELETED',
    refusedWhile: ['ADMITTED', 'UNKNOWN', 'PARTIAL'],
  },
  resolve: { evidence: 'HUMAN_OBSERVATION', resend: 'NEVER', providerCalls: 'NONE' },
  // One request is one unit of the shared bucket, reserved before its IO.
  // A step reserves the units its adapter declares (at most maxStepUnits)
  // before the call is admitted, and every sub-request is metered against
  // them; each poll and each media fetch reserves its own
  budget: {
    bucket: 'ORGANIZATION_SHARED',
    perHour: MANAGED_RATE_LIMIT_MAX,
    reservation: 'BEFORE_IO',
    unitsPerRequest: 1,
    counted: [
      'LIFECYCLE_API_REQUEST',
      'PROVIDER_MUTATION_REQUEST',
      'PROVIDER_STATUS_READ',
      'PROVIDER_INTERNAL_REQUEST',
      'MEDIA_CAPABILITY_FETCH',
    ],
    step: {
      units: 'ADAPTER_DECLARED',
      maxUnits: MANAGED_LIFECYCLE_LIMITS.maxStepUnits,
      reservedBefore: 'ADMISSION',
      unusedUnits: 'KEPT',
      beyondReservation: 'UNKNOWN_ONCE_ANY_SENT',
    },
    poll: 'RESERVED_PER_POLL',
    mediaFetch: 'RESERVED_PER_FETCH_BEFORE_STORAGE_READ',
    unavailable: 'NO_ADMISSION',
    exhaustedBeforeAdmission: 'DEFERRED',
    exhaustedAfterAdmission: 'NEVER_RESENT',
  },
  // only the transport's own sent ledger proves a request never left; an
  // adapter's error never does
  dispatch: {
    notSentProof: 'TRANSPORT_SENT_LEDGER',
    adapterAssertion: 'NOT_PROOF',
    ambiguous: 'UNKNOWN_NEVER_RESENT',
  },
  // Digest-pinned, short-lived capability fetches from the private runtime
  // volume (managed.lifecycle.media-capability.ts, ww-media-capability-v1;
  // not imported, it depends on this file). Whether it is ready is a gate,
  // gates.media; a provider that requires media is listed only while it is
  media: {
    delivery: 'DIGEST_PINNED_CAPABILITY_FETCH',
    capability: 'ww-media-capability-v1',
    source: 'PRIVATE_RUNTIME_VOLUME',
    scope: 'ONE_ADMITTED_CALL',
    verifies: ['SHA256', 'BYTE_LENGTH', 'MIME_TYPE', 'CURRENT_REVISION', 'SCOPE', 'EXPIRY', 'REVOCATION'],
    ranges: 'FROM_VERIFIED_OBJECT_ONLY',
    revoked: 'WHEN_CALL_SETTLES',
    token: 'NEVER_HASHED_LOGGED_OR_ANSWERED',
    readiness: 'GATED',
  },
  events: {
    feed: 'SEPARATE_FROM_DRAFT_FEED',
    kinds: [...MANAGED_LIFECYCLE_EVENT_KINDS],
    pageMax: MANAGED_LIFECYCLE_LIMITS.eventsPageMax,
    projection: 'LIFECYCLE_VIEW',
  },
} as const;

// What an adapter declares about itself. A provider qualifies from these
// facts, never from its name alone
export interface ManagedLifecycleProviderFacts {
  identifier: string;
  // the upstream provider's editor; only a normal one takes a managed caption
  editor: string;
  // whether the adapter refuses text-only content (instagram-standalone does)
  requiresMedia: boolean;
  // the units one step reserves, and how long it may take
  maxStepUnits: number;
  maxStepDeadlineMs: number;
}

// What the operator configured
export interface ManagedLifecycleGates {
  organizationEnabled: boolean;
  dispatcherAvailable: boolean;
  // the media capability delivery is configured for this runtime
  mediaDeliveryReady: boolean;
  providers: readonly ManagedLifecycleProviderFacts[];
  policy: ManagedLifecyclePolicy | null;
}

// the default: every gate closed, nothing qualified
export const MANAGED_LIFECYCLE_GATES_CLOSED: ManagedLifecycleGates = Object.freeze({
  organizationEnabled: false,
  dispatcherAvailable: false,
  mediaDeliveryReady: false,
  providers: Object.freeze([]),
  policy: null,
});

const boundedInt = (value: number, max: number) =>
  Number.isInteger(value) && value >= 1 && value <= max;

// Whether an adapter's facts let it publish: a normal editor, media delivery
// ready when it requires media, and a bounded step
export const lifecycleProviderEligible = (
  facts: ManagedLifecycleProviderFacts,
  mediaDeliveryReady: boolean
) =>
  PROVIDER_IDENTIFIER.test(facts.identifier) &&
  (MANAGED_PUBLICATION_TEXT_RULES.editors as readonly string[]).includes(facts.editor) &&
  (!facts.requiresMedia || mediaDeliveryReady) &&
  boundedInt(facts.maxStepUnits, MANAGED_LIFECYCLE_LIMITS.maxStepUnits) &&
  boundedInt(facts.maxStepDeadlineMs, MANAGED_LIFECYCLE_TIMING.maxStepDeadlineMs);

// GET /lifecycle/capabilities. Publication is qualified only while every gate
// is open, and then only for the eligible providers. An identifier declared
// twice is not listed
export function managedLifecycleCapabilities(
  gates: ManagedLifecycleGates,
  now: Date = new Date()
) {
  const policyOpen = lifecyclePolicyRefusal(gates.policy, now) === null;
  const open = gates.organizationEnabled && gates.dispatcherAvailable && policyOpen;
  const declared = gates.providers.map((facts) => facts.identifier);
  const providers = open
    ? gates.providers
        .filter(
          (facts) =>
            declared.indexOf(facts.identifier) === declared.lastIndexOf(facts.identifier) &&
            lifecycleProviderEligible(facts, gates.mediaDeliveryReady)
        )
        .map((facts) => ({
          identifier: facts.identifier,
          editor: 'normal' as const,
          requiresMedia: facts.requiresMedia,
          maxStepUnits: facts.maxStepUnits,
          maxStepDeadlineMs: facts.maxStepDeadlineMs,
        }))
        .sort((left, right) => (left.identifier < right.identifier ? -1 : 1))
        .slice(0, MANAGED_LIFECYCLE_LIMITS.providersMax)
    : [];

  return {
    version: MANAGED_LIFECYCLE_VERSION,
    draftCapabilities: MANAGED_DRAFT_CAPABILITIES_VERSION,
    gates: {
      organization: gates.organizationEnabled ? 'ENABLED' : 'NOT_ENABLED',
      dispatcher: gates.dispatcherAvailable ? 'AVAILABLE' : 'NOT_AVAILABLE',
      media: gates.mediaDeliveryReady ? 'READY' : 'NOT_READY',
      policy: policyOpen ? 'OPEN' : 'CLOSED',
      grantedAt: policyOpen ? gates.policy.grantedAt.toISOString() : null,
      expiresAt: policyOpen ? gates.policy.expiresAt.toISOString() : null,
    },
    publication: { qualified: providers.length > 0, providers },
    rules: MANAGED_LIFECYCLE_RULES,
  };
}

const qualifiedProvider = z
  .object({
    identifier: z.string().regex(PROVIDER_IDENTIFIER),
    editor: z.enum(MANAGED_PUBLICATION_TEXT_RULES.editors),
    requiresMedia: z.boolean(),
    maxStepUnits: z.number().int().min(1).max(MANAGED_LIFECYCLE_LIMITS.maxStepUnits),
    maxStepDeadlineMs: z
      .number()
      .int()
      .min(1)
      .max(MANAGED_LIFECYCLE_TIMING.maxStepDeadlineMs),
  })
  .strict();

const capabilities = z
  .object({
    version,
    draftCapabilities: z.literal(MANAGED_DRAFT_CAPABILITIES_VERSION),
    gates: z
      .object({
        organization: z.enum(['ENABLED', 'NOT_ENABLED']),
        dispatcher: z.enum(['AVAILABLE', 'NOT_AVAILABLE']),
        media: z.enum(['READY', 'NOT_READY']),
        policy: z.enum(['OPEN', 'CLOSED']),
        grantedAt: instant.nullable(),
        expiresAt: instant.nullable(),
      })
      .strict(),
    publication: z
      .object({
        qualified: z.boolean(),
        providers: z.array(qualifiedProvider).max(MANAGED_LIFECYCLE_LIMITS.providersMax),
      })
      .strict(),
    rules: exactly(MANAGED_LIFECYCLE_RULES),
  })
  .strict()
  .superRefine((document, ctx) => {
    const open =
      document.gates.organization === 'ENABLED' &&
      document.gates.dispatcher === 'AVAILABLE' &&
      document.gates.policy === 'OPEN';
    const { providers } = document.publication;
    if (
      document.publication.qualified !== providers.length > 0 ||
      (!open && providers.length > 0)
    ) {
      ctx.addIssue({ code: 'custom', path: ['publication'], message: 'publication is only qualified while every gate is open' });
    }
    if (
      providers.some(
        (provider, index) =>
          (index > 0 && provider.identifier <= providers[index - 1].identifier) ||
          (provider.requiresMedia && document.gates.media !== 'READY')
      )
    ) {
      ctx.addIssue({ code: 'custom', path: ['publication', 'providers'], message: 'providers are not unique and sorted, or require media that is not ready' });
    }
    const policyOpen = document.gates.policy === 'OPEN';
    if (
      policyOpen !== (document.gates.expiresAt !== null) ||
      policyOpen !== (document.gates.grantedAt !== null)
    ) {
      ctx.addIssue({ code: 'custom', path: ['gates'], message: 'only an open policy names its window' });
    }
    if (
      document.gates.expiresAt !== null &&
      (Date.parse(document.gates.expiresAt) > MANAGED_LIFECYCLE_MAX_EXPIRY.getTime() ||
        document.gates.grantedAt === null ||
        Date.parse(document.gates.expiresAt) - Date.parse(document.gates.grantedAt) >
          MANAGED_LIFECYCLE_MAX_POLICY_MS)
    ) {
      ctx.addIssue({ code: 'custom', path: ['gates'], message: 'the window exceeds the cutoff or seven days' });
    }
  });

// ---- refusals -----------------------------------------------------------------

export type ManagedLifecycleCode =
  | 'LIFECYCLE_INPUT_INVALID'
  | 'LIFECYCLE_NOT_ENABLED'
  | 'NOT_FOUND'
  | 'OPERATION_KEY_PAYLOAD_MISMATCH'
  | 'OPERATION_KEY_CREDENTIAL_MISMATCH'
  | 'OPERATION_KEY_KIND_MISMATCH'
  | 'REVISION_CONFLICT'
  | 'SCHEDULE_GENERATION_CONFLICT'
  | 'BINDING_GENERATION_MISMATCH'
  | 'LIFECYCLE_STATE_CONFLICT'
  | 'CHANNEL_NOT_QUALIFIED'
  | 'CHANNEL_IDENTITY_CHANGED'
  | 'CHANNEL_UNAVAILABLE'
  | 'POST_DRIFTED'
  | 'POST_DELETED'
  | 'POST_NOT_SCHEDULABLE'
  | 'SCHEDULE_ACTIVE'
  | 'CANCEL_SCOPE_MISMATCH'
  | 'DISPATCH_IN_PROGRESS'
  | 'DISPATCH_UNRESOLVED'
  | 'DISPATCH_VERSION_CONFLICT'
  | 'DISPATCH_NOT_RESOLVABLE'
  | 'RESOLVE_MEMBERS_MISMATCH'
  | 'LIFECYCLE_NOT_AVAILABLE'
  | 'RELEASE_HASH_MISMATCH'
  | 'CODEC_REFUSED'
  | 'CODEC_NOT_QUALIFIED_FOR_PROVIDER'
  | 'MEDIA_NOT_CURRENT'
  | 'MEDIA_DELIVERY_NOT_QUALIFIED'
  | 'PROVIDER_NOT_QUALIFIED'
  | 'OUTSIDE_LIFECYCLE_WINDOW'
  | 'RESOLUTION_EVIDENCE_INVALID';

const STATUS: Record<ManagedLifecycleCode, HttpStatus> = {
  LIFECYCLE_INPUT_INVALID: HttpStatus.BAD_REQUEST,
  LIFECYCLE_NOT_ENABLED: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  OPERATION_KEY_PAYLOAD_MISMATCH: HttpStatus.CONFLICT,
  OPERATION_KEY_CREDENTIAL_MISMATCH: HttpStatus.CONFLICT,
  OPERATION_KEY_KIND_MISMATCH: HttpStatus.CONFLICT,
  REVISION_CONFLICT: HttpStatus.CONFLICT,
  SCHEDULE_GENERATION_CONFLICT: HttpStatus.CONFLICT,
  BINDING_GENERATION_MISMATCH: HttpStatus.CONFLICT,
  LIFECYCLE_STATE_CONFLICT: HttpStatus.CONFLICT,
  CHANNEL_NOT_QUALIFIED: HttpStatus.CONFLICT,
  CHANNEL_IDENTITY_CHANGED: HttpStatus.CONFLICT,
  CHANNEL_UNAVAILABLE: HttpStatus.CONFLICT,
  POST_DRIFTED: HttpStatus.CONFLICT,
  POST_DELETED: HttpStatus.CONFLICT,
  POST_NOT_SCHEDULABLE: HttpStatus.CONFLICT,
  SCHEDULE_ACTIVE: HttpStatus.CONFLICT,
  CANCEL_SCOPE_MISMATCH: HttpStatus.CONFLICT,
  DISPATCH_IN_PROGRESS: HttpStatus.CONFLICT,
  DISPATCH_UNRESOLVED: HttpStatus.CONFLICT,
  DISPATCH_VERSION_CONFLICT: HttpStatus.CONFLICT,
  DISPATCH_NOT_RESOLVABLE: HttpStatus.CONFLICT,
  RESOLVE_MEMBERS_MISMATCH: HttpStatus.CONFLICT,
  LIFECYCLE_NOT_AVAILABLE: HttpStatus.CONFLICT,
  RELEASE_HASH_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  CODEC_REFUSED: HttpStatus.UNPROCESSABLE_ENTITY,
  CODEC_NOT_QUALIFIED_FOR_PROVIDER: HttpStatus.UNPROCESSABLE_ENTITY,
  MEDIA_NOT_CURRENT: HttpStatus.UNPROCESSABLE_ENTITY,
  MEDIA_DELIVERY_NOT_QUALIFIED: HttpStatus.UNPROCESSABLE_ENTITY,
  PROVIDER_NOT_QUALIFIED: HttpStatus.UNPROCESSABLE_ENTITY,
  OUTSIDE_LIFECYCLE_WINDOW: HttpStatus.UNPROCESSABLE_ENTITY,
  RESOLUTION_EVIDENCE_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
};

export const managedLifecycleStatusOf = (code: ManagedLifecycleCode) => STATUS[code];

// every refusal reason of the strict text leaf, checked against its type
const TEXT_REASONS: Record<ManagedPublicationTextRefusal, true> = {
  CODEC_NOT_SUPPORTED: true,
  EDITOR_NOT_SUPPORTED: true,
  CONTENT_NOT_STRING: true,
  CONTENT_TOO_LONG: true,
  WRAPPER_INVALID: true,
  RAW_ANGLE_BRACKET: true,
  RAW_NO_BREAK_SPACE: true,
  ENTITY_NOT_CANONICAL: true,
  UNREPRESENTABLE_CODE_POINT: true,
  ROUND_TRIP_MISMATCH: true,
};

export type ManagedLifecycleReason =
  | ManagedPublicationTextRefusal
  | ManagedLifecycleTimeRefusal;

export class ManagedLifecycleException extends HttpException {
  constructor(
    public readonly code: ManagedLifecycleCode,
    msg: string,
    public readonly reason?: ManagedLifecycleReason
  ) {
    super(reason ? { code, msg, reason } : { code, msg }, STATUS[code]);
  }
}

// A member that is not a strict value of the bound codec. The reason is the
// leaf's; nothing of the content is answered
export const lifecycleTextException = (err: ManagedPublicationTextError) =>
  err.reason === 'EDITOR_NOT_SUPPORTED'
    ? new ManagedLifecycleException(
        'CODEC_NOT_QUALIFIED_FOR_PROVIDER',
        "The channel's provider does not take a plain managed caption",
        err.reason
      )
    : new ManagedLifecycleException(
        'CODEC_REFUSED',
        'A member is not a strict value of the bound codec',
        err.reason
      );

const TIME_CODES: Record<ManagedLifecycleTimeRefusal, ManagedLifecycleCode> = {
  POLICY_INVALID: 'LIFECYCLE_NOT_ENABLED',
  POLICY_AFTER_CUTOFF: 'LIFECYCLE_NOT_ENABLED',
  POLICY_TOO_LONG: 'LIFECYCLE_NOT_ENABLED',
  POLICY_NOT_STARTED: 'LIFECYCLE_NOT_ENABLED',
  POLICY_EXPIRED: 'OUTSIDE_LIFECYCLE_WINDOW',
  PUBLISH_AT_TOO_SOON: 'OUTSIDE_LIFECYCLE_WINDOW',
  OCCURRENCE_AT_OR_AFTER_EXPIRY: 'OUTSIDE_LIFECYCLE_WINDOW',
  SCHEDULE_WINDOW_ENDED: 'OUTSIDE_LIFECYCLE_WINDOW',
  NOT_DUE: 'OUTSIDE_LIFECYCLE_WINDOW',
  LATE_BEYOND_TOLERANCE: 'OUTSIDE_LIFECYCLE_WINDOW',
  EVIDENCE_IN_FUTURE: 'RESOLUTION_EVIDENCE_INVALID',
  EVIDENCE_BEFORE_ADMISSION: 'RESOLUTION_EVIDENCE_INVALID',
};

export const lifecycleTimeException = (reason: ManagedLifecycleTimeRefusal) =>
  new ManagedLifecycleException(
    TIME_CODES[reason],
    TIME_CODES[reason] === 'LIFECYCLE_NOT_ENABLED'
      ? 'Lifecycle effects are not configured with a valid policy for this time'
      : TIME_CODES[reason] === 'RESOLUTION_EVIDENCE_INVALID'
      ? 'The observation is not between the admission and now'
      : 'The time is outside the lifecycle window',
    reason
  );

// A key committed by the other kind of operation, on either lookup or write:
// never ABSENT, never answered through the other decoder
export const lifecycleKindMismatchException = () =>
  new ManagedLifecycleException(
    'OPERATION_KEY_KIND_MISMATCH',
    'The operation key belongs to the other kind of managed operation'
  );

// the body of every lifecycle refusal
const errorBody = z
  .object({
    code: z.custom<ManagedLifecycleCode>(
      (value) => typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATUS, value)
    ),
    msg: z.string().min(1).max(500),
    reason: z
      .custom<ManagedLifecycleReason>(
        (value) =>
          typeof value === 'string' &&
          (Object.prototype.hasOwnProperty.call(TEXT_REASONS, value) ||
            (MANAGED_LIFECYCLE_TIME_REFUSALS as readonly string[]).includes(value))
      )
      .optional(),
  })
  .strict();

// ---- parsing responses ------------------------------------------------------------

const LIFECYCLE_RESPONSES = {
  CAPABILITIES: capabilities,
  RESULT: lifecycleResult,
  LIFECYCLE: lifecycleView,
  DISPATCH: dispatchView,
  OPERATION: operationLookup,
  EVENTS: eventsPage,
  RELEASE_PREVIEW: releasePreview,
  ERROR: errorBody,
};

export type ManagedLifecycleResponseName = keyof typeof LIFECYCLE_RESPONSES;
export type ManagedLifecycleResponseOf<N extends ManagedLifecycleResponseName> =
  RequiredParsed<z.infer<(typeof LIFECYCLE_RESPONSES)[N]>>;

// A lifecycle answer, or null: for the server to assert what it answers and
// for W&W to mirror. Anything outside the closed shape is refused
export function parseManagedLifecycleResponse<N extends ManagedLifecycleResponseName>(
  name: N,
  raw: unknown
): ManagedLifecycleResponseOf<N> | null {
  const parsed = LIFECYCLE_RESPONSES[name].safeParse(raw);
  return parsed.success ? (parsed.data as ManagedLifecycleResponseOf<N>) : null;
}

// Where a request or answer breaks the contract: paths and zod issue codes
// only, never a value (a refusal message can quote this)
export function managedLifecycleIssues(
  name: ManagedLifecycleKind | ManagedLifecycleResponseName,
  raw: unknown
): string[] {
  const schema: z.ZodTypeAny =
    name in LIFECYCLE_REQUESTS
      ? LIFECYCLE_REQUESTS[name as ManagedLifecycleKind]
      : LIFECYCLE_RESPONSES[name as ManagedLifecycleResponseName];
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? []
    : parsed.error.issues
        .slice(0, 20)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`);
}
