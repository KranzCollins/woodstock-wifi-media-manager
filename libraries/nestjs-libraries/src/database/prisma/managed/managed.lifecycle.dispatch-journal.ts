import { randomUUID } from 'crypto';
import type { ManagedDispatch, ManagedDispatchCall, ManagedSchedule } from '@prisma/client';
import { ManagedLifecycleRepository, ManagedLifecycleStore } from './managed.lifecycle.repository';
import {
  lifecycleNextPollAt, lifecycleOccurrenceDueAts, MANAGED_DISPATCH_NOT_SENT_CODES, MANAGED_DISPATCH_REJECTED_CODES, MANAGED_LIFECYCLE_LIMITS,
  MANAGED_LIFECYCLE_TIMING, MANAGED_MATERIALIZE_AFTER, MANAGED_RELEASE_ID, MANAGED_RELEASE_URL,
} from './managed.lifecycle.contracts';
import type { ManagedLifecycleEventKind } from './managed.lifecycle.contracts';
import { managedLifecycleStoredResult } from './managed.lifecycle.views';
import type { ManagedRequestBudget, ManagedRequestReservation } from './managed.request.budget';
import { ManagedPublishTransport } from './managed.publish.transport';
import type { ManagedPublishSentLedger, ManagedPublishTransportCode } from './managed.publish.transport';
import { ManagedPublishContinuation } from './managed.publish.provider';
import type { ManagedPublishOutcome } from './managed.publish.provider';

// Durable mutation admission, the transport's attempt journal, the
// settlement of an admitted mutation, the read-only polls of a pending one
// and the materialization of a series' next occurrence. This component never
// invokes a provider. The dispatcher must reserve -> admit -> construct one
// transport -> settle, and must never replay DISPATCHING; a pending call is
// expirePending -> reserve -> claimPoll -> one transport -> settlePoll, and a
// poll never sends a mutation. Production composition supplies the actual
// release/policy validators and dense public event writer; none has a
// permissive default.
export interface ManagedDispatchAdmission {
  dispatchId: string;
  expectedVersion: number;
  member: number;
  step: 'POST' | 'COMMENT' | 'FINALIZE';
  stage: 0 | 1;
  attempt: 1 | 2;
  reservedUnits: number;
  deadlineMs: number;
  requestHash: string;
}
export interface ManagedDispatchHandle {
  organizationId: string;
  dispatchId: string;
  callId: string;
  holder: string;
  dispatchVersion: number;
  fencingToken: number;
  deadlineAt: number;
}
export interface ManagedDispatchJournalPorts {
  repository: ManagedLifecycleRepository;
  budget: ManagedRequestBudget;
  now(): Date;
  // Rechecks current authorization, captured schedule window, exact release,
  // binding and stage. Only DB/previously observed pinned bytes in this lock.
  validate(store: ManagedLifecycleStore, dispatch: ManagedDispatch,
    admission: ManagedDispatchAdmission, deadlineAt: Date): Promise<boolean>;
  // Rechecks, for one read-only poll of the dispatch's PENDING_PROVIDER call
  // lasting until deadlineAt: the current policy, the window the schedule
  // captured, the exact release, binding and the original mutation call. Only
  // DB/previously observed pinned bytes in this lock. Without it no poll is
  // claimed (and nothing is reserved): there is no permissive default
  validatePoll?(store: ManagedLifecycleStore, dispatch: ManagedDispatch,
    call: ManagedDispatchCall, deadlineAt: Date): Promise<boolean>;
  // Appends exactly one fully validated lifecycle event for the transition
  // just written and brings the post along, in this same transaction: the
  // ManagedPostLifecycle row and the group's Post rows (transitionPostRows,
  // which records rowFingerprint; never a revision or its snapshot). No IO
  // outside PostgreSQL. Every row has already moved when it runs: `dispatch`
  // is re-read after its one transition (version already +1; on a settlement
  // lastLifecycleSequence is the sequence its event takes), the call is
  // settled or pending, a settled call's capabilities are revoked and the
  // schedule is halted, completed or cancelled. It never transitions the
  // dispatch, call or schedule again, so no version moves twice.
  // OCCURRENCE_MATERIALIZED: `dispatch` is the PENDING occurrence just
  // created, its lastLifecycleSequence the sequence its event takes.
  event(store: ManagedLifecycleStore, kind: ManagedJournalEventKind, dispatch: ManagedDispatch): Promise<void>;
}
export type ManagedDispatchEventKind = Extract<ManagedLifecycleEventKind,
  'DISPATCH_ADMITTED' | 'DISPATCH_PROGRESSED' | 'DISPATCH_NOT_SENT' | 'DISPATCH_PUBLISHED' |
  'DISPATCH_REJECTED' | 'DISPATCH_PARTIAL' | 'DISPATCH_OUTCOME_UNKNOWN'>;
export type ManagedJournalEventKind = ManagedDispatchEventKind | Extract<ManagedLifecycleEventKind, 'OCCURRENCE_MATERIALIZED' | 'OCCURRENCE_EXPIRED'>;
// One read-only poll of the dispatch's PENDING_PROVIDER call: its
// shared-budget units and the adapter's POLL deadline (at most 30 s)
export interface ManagedPollClaim {
  dispatchId: string;
  reservedUnits: number;
  deadlineMs: number;
}
// The poll lease: the dispatch's version, fence and holder of this claim.
// callId is the original mutation call, whose holder, version and fence (the
// authority of its media) the poll never takes over
export interface ManagedPollHandle {
  organizationId: string;
  dispatchId: string;
  callId: string;
  holder: string;
  dispatchVersion: number;
  fencingToken: number;
  deadlineAt: number;
  pollCount: number;
  reservedUnits: number;
}
export type ManagedPollClaimResult =
  | { status: 'CLAIMED'; handle: Readonly<ManagedPollHandle> }
  | { status: 'BUDGET_REFUSED'; reservation: ManagedRequestReservation }
  | { status: 'STATE_REFUSED' }
  // the authority closed before the poll: nothing was sent, the pending
  // mutation's outcome is not known
  | { status: 'SETTLED'; dispatch: 'UNKNOWN' | 'PARTIAL' };
// next: POLL again at the call's nextPollAt, or FINALIZE `stage` of the member
export type ManagedPollSettlement =
  | { status: 'SETTLED'; call: 'PENDING_PROVIDER' | 'OK' | 'REJECTED' | 'UNKNOWN';
      dispatch: 'ADMITTED' | 'REJECTED' | 'UNKNOWN' | 'PARTIAL'; next: 'POLL' | 'FINALIZE' | null; stage: 0 | 1 | null }
  | { status: 'STALE' };
export type ManagedMaterialization =
  | { status: 'MATERIALIZED'; dispatchId: string; occurrence: number }
  | { status: 'NONE'; reason: 'NOT_LIVE' | 'NOT_LATEST' | 'PREVIOUS_NOT_SETTLED' | 'SERIES_END' };
export type ManagedDispatchAdmissionResult =
  | { status: 'ADMITTED'; handle: Readonly<ManagedDispatchHandle> }
  | { status: 'BUDGET_REFUSED'; reservation: ManagedRequestReservation }
  | { status: 'STATE_REFUSED' };
type SettledCallStatus = 'OK' | 'PENDING_PROVIDER' | 'REJECTED' | 'UNKNOWN' | 'NOT_SENT';
type SettledDispatchStatus = 'ADMITTED' | 'PUBLISHED' | 'REJECTED' | 'UNKNOWN' | 'PARTIAL' | 'NOT_SENT';
// next: what the dispatch waits for now, all of it a later, separate step:
// a member's delay before its COMMENT, a read-only POLL, or attempt 2 (RETRY)
export type ManagedDispatchSettlement =
  | { status: 'SETTLED'; call: SettledCallStatus; dispatch: SettledDispatchStatus; next: 'COMMENT' | 'POLL' | 'RETRY' | null }
  | { status: 'STALE'; lateEvidence: boolean };

type DispatchChange = Parameters<ManagedLifecycleStore['transitionDispatch']>[2];
type CallChange = Parameters<ManagedLifecycleStore['updateCall']>[5];
type ScheduleChange = Parameters<ManagedLifecycleStore['updateSchedule']>[2];

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const TRANSPORT_FAILURES: readonly ManagedPublishTransportCode[] = ['REQUEST_REFUSED', 'RESERVATION_EXHAUSTED',
  'ADMISSION_LOST', 'DEADLINE_EXPIRED', 'RESPONSE_TOO_LARGE', 'TRANSPORT_FAILED', 'PROVIDER_REJECTED'];
// What an adapter may answer for a mutation step. DISPATCHER_LOST and
// PENDING_UNCONFIRMED belong to recovery and the poller
const ADAPTER_UNKNOWN: readonly string[] = ['OUTCOME_UNKNOWN', 'STEP_BUDGET_EXCEEDED', 'LEASE_LOST'];
const ADAPTER_NOT_SENT: readonly string[] = ['REQUEST_NOT_SENT', 'MEDIA_NOT_CURRENT', 'MEDIA_CHANGED', 'MEDIA_DELIVERY_NOT_QUALIFIED'];
const MAX_PENDING_ENVELOPE = 16 * 1024;
const SETTLED_EVENTS: Record<Exclude<SettledDispatchStatus, 'ADMITTED'>, ManagedDispatchEventKind> = {
  PUBLISHED: 'DISPATCH_PUBLISHED', REJECTED: 'DISPATCH_REJECTED', UNKNOWN: 'DISPATCH_OUTCOME_UNKNOWN',
  PARTIAL: 'DISPATCH_PARTIAL', NOT_SENT: 'DISPATCH_NOT_SENT',
};
const freshLedger = (): ManagedPublishSentLedger => ({ attemptedRequests: 0, attemptedMutations: 0,
  completedRequests: 0, mutationMayHaveLeft: false, failure: null });
const parseMembers = (dispatch: ManagedDispatch): any[] => {
  const value: unknown = JSON.parse(dispatch.members);
  if (!Array.isArray(value) || !value.length || value.length > MANAGED_LIFECYCLE_LIMITS.members ||
      value.some((item, index) => !item || item.position !== index || typeof item.postId !== 'string')) {
    throw new Error('Invalid retained dispatch members');
  }
  return value;
};
const parseLedger = (call: ManagedDispatchCall): ManagedPublishSentLedger | null => {
  if (call.sentLedger === null) return call.consumedUnits === 0 ? freshLedger() : null;
  try {
    const value = JSON.parse(call.sentLedger) as ManagedPublishSentLedger;
    if (!Number.isSafeInteger(value.attemptedRequests) || value.attemptedRequests !== call.consumedUnits ||
        value.attemptedRequests < 0 || value.attemptedRequests > call.reservedUnits ||
        !Number.isSafeInteger(value.attemptedMutations) || value.attemptedMutations < 0 ||
        value.attemptedMutations > value.attemptedRequests || value.mutationMayHaveLeft !== (value.attemptedMutations > 0)) return null;
    return value;
  } catch { return null; }
};
// The step transport's own final ledger, only when it is exactly the durable
// pre-send record plus what the transport alone saw afterwards (answers and
// its failure). null for anything else: then nothing it says is proof
const agreedLedger = (ledger: Readonly<ManagedPublishSentLedger>, durable: ManagedPublishSentLedger | null): ManagedPublishSentLedger | null =>
  durable && ledger.attemptedRequests === durable.attemptedRequests &&
  ledger.attemptedMutations === durable.attemptedMutations && ledger.mutationMayHaveLeft === durable.mutationMayHaveLeft &&
  Number.isSafeInteger(ledger.completedRequests) && ledger.completedRequests >= 0 &&
  ledger.completedRequests <= ledger.attemptedRequests && (ledger.failure === null || TRANSPORT_FAILURES.includes(ledger.failure))
    ? { attemptedRequests: ledger.attemptedRequests, attemptedMutations: ledger.attemptedMutations,
        completedRequests: ledger.completedRequests, mutationMayHaveLeft: ledger.mutationMayHaveLeft, failure: ledger.failure }
    : null;
// An https URL as the closed contract takes it, spelled exactly as parsed and
// without credentials, port, query or fragment; anything else is null
const releaseUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > MANAGED_LIFECYCLE_LIMITS.releaseUrlMax ||
      !MANAGED_RELEASE_URL.test(value) || /[?#]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === 'https:' && !url.username && !url.password && !url.port ? value : null;
  } catch { return null; }
};
const releaseOf = (outcome: { releaseId: unknown; releaseURL: unknown }) =>
  typeof outcome.releaseId === 'string' && MANAGED_RELEASE_ID.test(outcome.releaseId)
    ? { releaseId: outcome.releaseId, releaseURL: releaseUrl(outcome.releaseURL) } : null;

type Verdict =
  | { call: 'OK'; code: null; release: { releaseId: string; releaseURL: string | null } }
  | { call: 'PENDING_PROVIDER'; code: null; envelope: string }
  | { call: 'REJECTED' | 'UNKNOWN' | 'NOT_SENT'; code: string };
// What a mutation step's answer is worth against its agreed ledger. Whatever
// does not fit is UNKNOWN: never NOT_SENT, never published. ready and
// poll_failed answer a poll, never a mutation
function verdictOf(outcome: ManagedPublishOutcome, ledger: ManagedPublishSentLedger | null, step: string): Verdict {
  const unknown: Verdict = { call: 'UNKNOWN', code: 'OUTCOME_UNKNOWN' };
  if (!ledger || !outcome || typeof outcome !== 'object') return unknown;
  // the transport stops at its first failure, so the requests it saw answered
  // are a prefix of those it attempted: at least this many mutations were
  const answeredMutations = ledger.attemptedMutations - (ledger.attemptedRequests - ledger.completedRequests);
  switch (outcome.status) {
    case 'success': {
      const release = answeredMutations >= 1 ? releaseOf(outcome) : null;
      return release ? { call: 'OK', code: null, release } : unknown;
    }
    case 'pending': {
      const envelope = step !== 'COMMENT' && answeredMutations >= 1 && ledger.failure === null &&
        outcome.continuation instanceof ManagedPublishContinuation ? outcome.continuation.sealed() : null;
      return typeof envelope === 'string' && envelope.length > 0 && Buffer.byteLength(envelope) <= MAX_PENDING_ENVELOPE
        ? { call: 'PENDING_PROVIDER', code: null, envelope } : unknown;
    }
    case 'rejected':
      return ledger.completedRequests >= 1 && (MANAGED_DISPATCH_REJECTED_CODES as readonly string[]).includes(outcome.code)
        ? { call: 'REJECTED', code: outcome.code } : unknown;
    case 'unknown':
      return { call: 'UNKNOWN', code: ADAPTER_UNKNOWN.includes(outcome.code) ? outcome.code : 'OUTCOME_UNKNOWN' };
    case 'not_sent':
      return ledger.attemptedMutations === 0 && !ledger.mutationMayHaveLeft && ADAPTER_NOT_SENT.includes(outcome.code)
        ? { call: 'NOT_SENT', code: outcome.code } : unknown;
  }
  return unknown;
}
// The wait before a member, in whole minutes, exactly as the schedule fixed
// it with the reviewed release
const memberDelayMs = (schedule: ManagedSchedule, members: readonly any[], position: number) => {
  const release = JSON.parse(schedule.release)?.members;
  const stored = Array.isArray(release) && release.length === members.length ? release[position] : null;
  if (!stored || stored.position !== position || stored.postId !== members[position].postId ||
      !Number.isSafeInteger(stored.delay) || stored.delay < 0 || stored.delay > MANAGED_LIFECYCLE_LIMITS.memberDelayMaxMinutes) {
    throw new Error('Invalid retained member delay');
  }
  return stored.delay * 60 * 1000;
};
// The cancel that last truncated an ENDING schedule: the latest REMAINING
// cancel of it in feed order, whose stored answer left the schedule ENDING
// with the lastOccurrence it has now. A later cancel that truncated nothing
// (or any other version change) does not hide it. null, and the schedule
// stays ENDING, only when the stored answers contradict the schedule; never
// an exception that would lose the settled outcome
async function lastTruncation(store: ManagedLifecycleStore, schedule: ManagedSchedule): Promise<string | null> {
  if (!schedule.endRequestedOperationKey) return null;
  let last: { key: string; schedule: { scheduleId: string; status: string; lastOccurrence: number | null } | null } | null = null;
  try {
    for (const operation of await store.listScheduleOperations(schedule.id)) {
      if (operation.kind !== 'CANCEL') continue;
      const answer = managedLifecycleStoredResult(operation, false);
      if (operation.managedPostId !== schedule.managedPostId) return null;
      if (answer.kind === 'CANCEL' && answer.cancellation.scope === 'REMAINING') {
        last = { key: operation.operationKey, schedule: answer.schedule };
      }
    }
  } catch { return null; }
  return last && last.schedule?.scheduleId === schedule.id && last.schedule.status === 'ENDING' &&
    last.schedule.lastOccurrence === schedule.lastOccurrence ? last.key : null;
}

// the adapter's POLL deadline, the most a read-only poll may take
const MAX_POLL_DEADLINE_MS = 30 * 1000;
type PollVerdict =
  | { call: 'PENDING_PROVIDER'; envelope: string }
  | { call: 'OK'; envelope: string }
  | { call: 'REJECTED' | 'UNKNOWN'; code: string };
const sealedOf = (continuation: unknown): string | null => {
  const envelope = continuation instanceof ManagedPublishContinuation ? continuation.sealed() : null;
  return typeof envelope === 'string' && envelope.length > 0 && Buffer.byteLength(envelope) <= MAX_PENDING_ENVELOPE ? envelope : null;
};
// What a poll's answer proves against its transport's ledger. A poll only
// reads: a ledger that shows a mutation, or an answer that something may be
// published (success / unknown), is UNKNOWN, never published. Whatever else
// proves nothing (a failed read, an answer without one, a malformed or
// foreign answer) keeps the call pending until the fixed deadline
function pollVerdictOf(outcome: ManagedPublishOutcome, ledger: Readonly<ManagedPublishSentLedger>,
  reservedUnits: number, envelope: string): PollVerdict {
  const unknown: PollVerdict = { call: 'UNKNOWN', code: 'OUTCOME_UNKNOWN' };
  if (!ledger || !Number.isSafeInteger(ledger.attemptedRequests) || ledger.attemptedRequests < 0 ||
      ledger.attemptedRequests > reservedUnits || ledger.attemptedMutations !== 0 || ledger.mutationMayHaveLeft !== false ||
      !Number.isSafeInteger(ledger.completedRequests) || ledger.completedRequests < 0 ||
      ledger.completedRequests > ledger.attemptedRequests ||
      (ledger.failure !== null && !TRANSPORT_FAILURES.includes(ledger.failure))) return unknown;
  const retained: PollVerdict = { call: 'PENDING_PROVIDER', envelope };
  if (!outcome || typeof outcome !== 'object') return retained;
  // an answer was read, and nothing failed after it
  const read = ledger.completedRequests >= 1 && ledger.failure === null;
  switch (outcome.status) {
    case 'pending':
    case 'ready': {
      const next = read ? sealedOf(outcome.continuation) : null;
      return next ? { call: outcome.status === 'ready' ? 'OK' : 'PENDING_PROVIDER', envelope: next } : retained;
    }
    case 'rejected':
      return ledger.completedRequests >= 1 && (MANAGED_DISPATCH_REJECTED_CODES as readonly string[]).includes(outcome.code)
        ? { call: 'REJECTED', code: outcome.code } : retained;
    case 'unknown':
      return { call: 'UNKNOWN', code: ADAPTER_UNKNOWN.includes(outcome.code) ? outcome.code : 'OUTCOME_UNKNOWN' };
    case 'success':
      return unknown;
  }
  return retained;
}

export class ManagedDispatchJournal {
  constructor(private readonly ports: ManagedDispatchJournalPorts) {
    if (!ports.repository || !ports.budget || typeof ports.now !== 'function' ||
        typeof ports.validate !== 'function' || typeof ports.event !== 'function') throw new Error('Missing dispatch journal port');
  }

  async admit(organizationId: string, admission: ManagedDispatchAdmission): Promise<ManagedDispatchAdmissionResult> {
    if (typeof organizationId !== 'string' || !ID.test(organizationId) || !ID.test(admission.dispatchId) ||
        !Number.isSafeInteger(admission.expectedVersion) || admission.expectedVersion < 1 ||
        !Number.isSafeInteger(admission.member) || admission.member < 0 || admission.member >= MANAGED_LIFECYCLE_LIMITS.members ||
        !['POST', 'COMMENT', 'FINALIZE'].includes(admission.step) || ![1, 2].includes(admission.attempt) ||
        ![0, 1].includes(admission.stage) || (admission.stage !== 0 && admission.step !== 'FINALIZE') ||
        !Number.isSafeInteger(admission.reservedUnits) || admission.reservedUnits < 1 || admission.reservedUnits > MANAGED_LIFECYCLE_LIMITS.maxStepUnits ||
        !Number.isSafeInteger(admission.deadlineMs) || admission.deadlineMs < 1 || admission.deadlineMs > MANAGED_LIFECYCLE_TIMING.maxStepDeadlineMs ||
        typeof admission.requestHash !== 'string' || !HASH.test(admission.requestHash)) return { status: 'STATE_REFUSED' };
    const reservation = await this.ports.budget.reserveDetailed(organizationId, admission.reservedUnits);
    if (!reservation.accepted) return { status: 'BUDGET_REFUSED', reservation };
    // A lost race retains unused reserved units. It never earns a refund or
    // permission for another request outside a later reservation.
    return this.ports.repository.mutate(organizationId, async store => {
      const dispatch = await store.getDispatch(admission.dispatchId);
      if (!dispatch || dispatch.version !== admission.expectedVersion || dispatch.activeCallId !== null ||
          !['PENDING', 'ADMITTED'].includes(dispatch.status)) return { status: 'STATE_REFUSED' };
      const now = this.ports.now();
      if (!Number.isFinite(now.getTime()) || !dispatch.nextActionAt || dispatch.nextActionAt > now ||
          (dispatch.leaseExpiresAt && dispatch.leaseExpiresAt > now)) return { status: 'STATE_REFUSED' };
      const members = parseMembers(dispatch);
      const member = members[admission.member];
      if (!member || members.slice(0, admission.member).some(value => value.status !== 'PUBLISHED') ||
          (admission.step === 'FINALIZE' ? member.status !== 'PENDING_PROVIDER' : member.status !== 'WAITING') ||
          (admission.step !== 'FINALIZE' && (admission.step === 'POST') !== (admission.member === 0))) return { status: 'STATE_REFUSED' };
      if (dispatch.status === 'PENDING' && (admission.member !== 0 || admission.step !== 'POST' || admission.attempt !== 1)) return { status: 'STATE_REFUSED' };
      if (dispatch.status === 'ADMITTED' && (dispatch.nextStep !== admission.step || dispatch.nextMember !== admission.member)) return { status: 'STATE_REFUSED' };
      const calls = await store.listCalls(dispatch.id);
      const same = calls.filter(call => call.member === admission.member && call.step === admission.step && call.stage === admission.stage);
      if (admission.stage === 1 && !calls.some(call => call.member === admission.member &&
          call.step === 'FINALIZE' && call.stage === 0 && call.status === 'OK')) return { status: 'STATE_REFUSED' };
      if (admission.attempt === 1 ? same.length !== 0 :
          same.length !== 1 || same[0].attempt !== 1 || same[0].status !== 'NOT_SENT' ||
          parseLedger(same[0])?.mutationMayHaveLeft !== false) return { status: 'STATE_REFUSED' };
      const deadlineAt = new Date(now.getTime() + admission.deadlineMs);
      if (!await this.ports.validate(store, dispatch, admission, deadlineAt)) return { status: 'STATE_REFUSED' };
      // No queued work may use time consumed by validation as a free lease
      // extension. A slow check loses its admission before IO can begin.
      const after = this.ports.now();
      if (!(after.getTime() < deadlineAt.getTime())) return { status: 'STATE_REFUSED' };
      const holder = randomUUID(); const callId = randomUUID();
      const leaseExpiresAt = new Date(deadlineAt.getTime() + MANAGED_LIFECYCLE_TIMING.leaseMarginMs);
      const version = dispatch.version + 1; const fence = dispatch.fencingToken + 1;
      members[admission.member] = { ...member, status: 'DISPATCHING', code: null, release: null };
      if (!await store.transitionDispatch(dispatch.id, dispatch.version, {
        status: 'ADMITTED', members: JSON.stringify(members), leaseHolder: holder, leaseExpiresAt,
        fencingToken: fence, activeCallId: callId, nextActionAt: leaseExpiresAt, nextStep: null, nextMember: null,
        deferralCode: null, admittedAt: dispatch.admittedAt ?? now,
      })) throw new Error('Dispatch admission lost its version');
      await store.createCall({ id: callId, managedPostId: dispatch.managedPostId, dispatchId: dispatch.id,
        member: admission.member, postId: member.postId, step: admission.step, stage: admission.stage, attempt: admission.attempt,
        status: 'DISPATCHING', holder, dispatchVersion: version, fencingToken: fence, leaseExpiresAt, deadlineAt,
        requestHash: admission.requestHash, reservedUnits: admission.reservedUnits, consumedUnits: 0,
        sentLedger: JSON.stringify(freshLedger()), admittedAt: now });
      const admitted = await store.getDispatch(dispatch.id);
      await this.ports.event(store, dispatch.status === 'PENDING' ? 'DISPATCH_ADMITTED' : 'DISPATCH_PROGRESSED', admitted!);
      return { status: 'ADMITTED', handle: Object.freeze({ organizationId, dispatchId: dispatch.id, callId, holder,
        dispatchVersion: version, fencingToken: fence, deadlineAt: deadlineAt.getTime() }) };
    });
  }

  // The exact admission the handle names, still DISPATCHING under its holder,
  // version and fence, before its deadline and inside its lease
  private async owned(store: ManagedLifecycleStore, handle: ManagedDispatchHandle, deadlineAt: Date) {
    const dispatch = await store.getDispatch(handle.dispatchId);
    const call = await store.getCall(handle.callId);
    const now = this.ports.now().getTime();
    if (!dispatch || !call || !Number.isFinite(now) || deadlineAt.getTime() !== handle.deadlineAt ||
        !(now < handle.deadlineAt) || call.deadlineAt.getTime() !== handle.deadlineAt ||
        dispatch.status !== 'ADMITTED' || call.status !== 'DISPATCHING' || dispatch.activeCallId !== call.id ||
        call.dispatchId !== dispatch.id || call.managedPostId !== dispatch.managedPostId ||
        dispatch.version !== handle.dispatchVersion || call.dispatchVersion !== handle.dispatchVersion ||
        dispatch.fencingToken !== handle.fencingToken || call.fencingToken !== handle.fencingToken ||
        dispatch.leaseHolder !== handle.holder || call.holder !== handle.holder ||
        !dispatch.leaseExpiresAt || dispatch.leaseExpiresAt.getTime() < handle.deadlineAt ||
        call.leaseExpiresAt.getTime() < handle.deadlineAt) return null;
    return { dispatch, call };
  }

  private async current(store: ManagedLifecycleStore, handle: ManagedDispatchHandle, deadlineAt: Date) {
    const owned = await this.owned(store, handle, deadlineAt);
    if (!owned) return null;
    const { dispatch, call } = owned;
    const admission: ManagedDispatchAdmission = { dispatchId: dispatch.id, expectedVersion: dispatch.version,
      member: call.member, step: call.step as ManagedDispatchAdmission['step'], attempt: call.attempt as 1 | 2,
      stage: call.stage as 0 | 1,
      reservedUnits: call.reservedUnits, deadlineMs: call.deadlineAt.getTime() - call.admittedAt.getTime(), requestHash: call.requestHash };
    if (!await this.ports.validate(store, dispatch, admission, deadlineAt) ||
        !(this.ports.now().getTime() < handle.deadlineAt)) return null;
    return { dispatch, call };
  }

  verifyAdmission(handle: ManagedDispatchHandle, deadlineAt: Date): Promise<boolean> {
    return this.ports.repository.mutate(handle.organizationId, async store => !!await this.current(store, handle, deadlineAt));
  }

  recordAttempt(handle: ManagedDispatchHandle, ordinal: number, mutation: boolean): Promise<boolean> {
    return this.ports.repository.mutate(handle.organizationId, async store => {
      const current = await this.current(store, handle, new Date(handle.deadlineAt));
      if (!current || typeof mutation !== 'boolean' || !Number.isSafeInteger(ordinal)) return false;
      const ledger = parseLedger(current.call);
      if (!ledger || ordinal !== ledger.attemptedRequests + 1 || ordinal > current.call.reservedUnits) return false;
      ledger.attemptedRequests = ordinal;
      ledger.attemptedMutations += mutation ? 1 : 0;
      ledger.mutationMayHaveLeft ||= mutation;
      return store.updateCall(current.call.id, 'DISPATCHING', handle.holder, handle.dispatchVersion, handle.fencingToken,
        { consumedUnits: ordinal, sentLedger: JSON.stringify(ledger) });
    });
  }

  // Records once what this step's adapter answered, under exactly the
  // admission the handle names, checked before anything is written.
  // validate() is not asked again: it gates sending, and refusing to record
  // an answer already received would only lose a known outcome. The ledger is
  // read from the transport the dispatcher built for this step, never from
  // adapter or client input, and must agree with the durable pre-send record.
  // Only a proved REQUEST_NOT_SENT of attempt 1 earns attempt 2, as a new
  // admission with its own call id and reservation; nothing ambiguous is ever
  // sent again. A pending call keeps its row, holder, version and fence (the
  // capability authority of its media), without a sender lease. A stale
  // handle changes nothing; a success it carried is kept as late evidence
  // once recovery made its call UNKNOWN
  async settle(handle: ManagedDispatchHandle, outcome: ManagedPublishOutcome,
    transport: ManagedPublishTransport): Promise<ManagedDispatchSettlement> {
    if (!(transport instanceof ManagedPublishTransport)) throw new Error('Settlement needs the step transport');
    const ledger = transport.ledger();
    const settled = await this.ports.repository.mutate(handle.organizationId, async store => {
      const owned = await this.owned(store, handle, new Date(handle.deadlineAt));
      const now = this.ports.now();
      if (!owned || !(now.getTime() < handle.deadlineAt)) return null;
      const { dispatch, call } = owned;
      const members = parseMembers(dispatch);
      const member = members[call.member];
      if (member?.status !== 'DISPATCHING' || member.postId !== call.postId) throw new Error('Settled call does not match retained member');
      const schedule = await this.scheduleOf(store, dispatch);
      const final = agreedLedger(ledger, parseLedger(call));
      const verdict = verdictOf(outcome, final, call.step);
      const sequence = (await store.headSequence()) + 1;
      const free = { activeCallId: null, leaseHolder: null, leaseExpiresAt: null, deferralCode: null, lastLifecycleSequence: sequence };
      const sent = final ? { sentLedger: JSON.stringify(final) } : {};
      const next = call.member + 1;
      let status: SettledDispatchStatus = 'ADMITTED';
      let wait: 'COMMENT' | 'POLL' | 'RETRY' | null = null;
      let change: DispatchChange;
      let callChange: CallChange;
      const ended = (settledAs: SettledDispatchStatus): DispatchChange => ({ ...free, status: settledAs, code: verdict.code,
        members: JSON.stringify(members), nextActionAt: null, nextStep: null, nextMember: null, settledAt: now });

      if (verdict.call === 'OK') {
        members[call.member] = { ...member, status: 'PUBLISHED', code: null, release: { ...verdict.release, source: 'PROVIDER_RESPONSE' } };
        callChange = { ...sent, status: 'OK', code: null, result: JSON.stringify(verdict.release), settledAt: now };
        if (next < members.length) {
          wait = 'COMMENT';
          change = { ...free, members: JSON.stringify(members), nextStep: 'COMMENT', nextMember: next,
            nextActionAt: new Date(now.getTime() + memberDelayMs(schedule, members, next)) };
        } else {
          status = 'PUBLISHED';
          change = ended(status);
        }
      } else if (verdict.call === 'PENDING_PROVIDER') {
        // pendingSince is now; the deadline is fixed from it. Whether a poll
        // may still go out (scope, window, policy) is checked when it does
        wait = 'POLL';
        const nextPollAt = new Date(lifecycleNextPollAt(now.toISOString(), null, 0));
        members[call.member] = { ...member, status: 'PENDING_PROVIDER', code: null, release: null };
        callChange = { ...sent, status: 'PENDING_PROVIDER', code: null, pendingEnvelope: verdict.envelope, pollCount: 0,
          lastPolledAt: null, nextPollAt, pollDeadlineAt: new Date(now.getTime() + MANAGED_LIFECYCLE_TIMING.pollDeadlineMs) };
        change = { members: JSON.stringify(members), leaseHolder: null, leaseExpiresAt: null, deferralCode: null,
          lastLifecycleSequence: sequence, nextActionAt: nextPollAt, nextStep: null, nextMember: null };
      } else if (verdict.call === 'NOT_SENT' && verdict.code === 'REQUEST_NOT_SENT' && call.attempt === 1) {
        wait = 'RETRY';
        members[call.member] = { ...member, status: call.step === 'FINALIZE' ? 'PENDING_PROVIDER' : 'WAITING', code: null, release: null };
        callChange = { ...sent, status: 'NOT_SENT', code: verdict.code, settledAt: now };
        change = { ...free, members: JSON.stringify(members), nextStep: call.step, nextMember: call.member, nextActionAt: now };
      } else {
        members[call.member] = { ...member, status: verdict.call, code: verdict.code, release: null };
        for (let n = next; n < members.length; n++) {
          members[n] = { ...members[n], status: 'NOT_SENT', code: 'PREVIOUS_MEMBER_FAILED', release: null };
        }
        callChange = { ...sent, status: verdict.call, code: verdict.code, settledAt: now };
        status = call.member === 0 ? verdict.call : 'PARTIAL';
        change = ended(status);
      }

      await this.endSchedule(store, schedule, dispatch, status, now);
      if (!await store.transitionDispatch(dispatch.id, dispatch.version, change)) throw new Error('Settled dispatch lost its version');
      if (!await store.updateCall(call.id, 'DISPATCHING', handle.holder, handle.dispatchVersion, handle.fencingToken,
        callChange)) throw new Error('Settled call changed');
      // a pending call's media is still being fetched by the provider
      if (verdict.call !== 'PENDING_PROVIDER') await store.revokeCall(call.id, now, 'CALL_SETTLED');
      await this.ports.event(store, status === 'ADMITTED' ? 'DISPATCH_PROGRESSED' : SETTLED_EVENTS[status],
        (await store.getDispatch(dispatch.id))!);
      if (await store.headSequence() !== sequence) throw new Error('A settlement appends exactly one lifecycle event');
      return { status: 'SETTLED' as const, call: verdict.call, dispatch: status, next: wait };
    });
    if (settled) return settled;
    const evidence = outcome?.status === 'success' ? releaseOf(outcome) : null;
    return { status: 'STALE', lateEvidence: !!evidence && await this.recordLateEvidence(handle, evidence) };
  }

  // What a settled occurrence does to its live schedule; the generation never
  // moves. A failure halts it, keeping any end request. The final retained
  // occurrence, published, completes it, or cancels a truncated one as its
  // last truncating cancel when that is provable. An earlier published
  // occurrence leaves it live for the separate materializer of the next one
  private async endSchedule(store: ManagedLifecycleStore, schedule: ManagedSchedule, dispatch: ManagedDispatch,
    status: SettledDispatchStatus | 'EXPIRED', now: Date) {
    if (status === 'ADMITTED' || !['ACTIVE', 'ENDING'].includes(schedule.status)) return;
    let change: ScheduleChange | null = null;
    if (status !== 'PUBLISHED') change = { status: 'HALTED', endedAt: now, endedCode: status };
    else if (dispatch.occurrence >= schedule.lastOccurrence) {
      if (schedule.status === 'ACTIVE') change = { status: 'COMPLETED', endedAt: now, endedCode: status };
      else {
        const key = await lastTruncation(store, schedule);
        if (key) change = { status: 'CANCELLED', endedAt: now, endedCode: status, endedOperationKey: key };
      }
    }
    if (change && !await store.updateSchedule(schedule.id, schedule.version, change)) throw new Error('Settled schedule changed');
  }

  private async scheduleOf(store: ManagedLifecycleStore, dispatch: ManagedDispatch) {
    const schedule = await store.getSchedule(dispatch.scheduleId);
    if (!schedule || schedule.managedPostId !== dispatch.managedPostId ||
        schedule.scheduleGeneration !== dispatch.scheduleGeneration) throw new Error('Settled dispatch lost its schedule');
    return schedule;
  }

  // Called by recovery, never by another sender as permission to retry. The
  // lost call is UNKNOWN (PARTIAL after a published member) and halts the
  // series as a settled failure does; only a human resolution may resume it
  recoverExpired(organizationId: string, dispatchId: string): Promise<boolean> {
    return this.ports.repository.mutate(organizationId, async store => {
      const dispatch = await store.getDispatch(dispatchId);
      if (!dispatch || dispatch.status !== 'ADMITTED' || !dispatch.activeCallId) return false;
      const call = await store.getCall(dispatch.activeCallId); const now = this.ports.now();
      if (!call || call.status !== 'DISPATCHING' || call.dispatchId !== dispatch.id ||
          !dispatch.leaseExpiresAt || call.leaseExpiresAt > now || dispatch.leaseExpiresAt > now) return false;
      const members = parseMembers(dispatch);
      if (members[call.member]?.status !== 'DISPATCHING') throw new Error('Expired call does not match retained member');
      members[call.member] = { ...members[call.member], status: 'UNKNOWN', code: 'DISPATCHER_LOST', release: null };
      for (let n = call.member + 1; n < members.length; n++) {
        members[n] = { ...members[n], status: 'NOT_SENT', code: 'PREVIOUS_MEMBER_FAILED', release: null };
      }
      const status = call.member === 0 ? 'UNKNOWN' : 'PARTIAL';
      const sequence = (await store.headSequence()) + 1;
      await this.endSchedule(store, await this.scheduleOf(store, dispatch), dispatch, status, now);
      if (!await store.updateCall(call.id, 'DISPATCHING', call.holder, call.dispatchVersion, call.fencingToken,
        { status: 'UNKNOWN', code: 'DISPATCHER_LOST', settledAt: now })) throw new Error('Expired call changed');
      if (!await store.transitionDispatch(dispatch.id, dispatch.version, {
        status, code: 'DISPATCHER_LOST', members: JSON.stringify(members),
        activeCallId: null, leaseHolder: null, leaseExpiresAt: null, nextActionAt: null, nextStep: null, nextMember: null,
        deferralCode: null, settledAt: now, lastLifecycleSequence: sequence,
      })) throw new Error('Expired dispatch changed');
      await store.revokeCall(call.id, now, 'CALL_SETTLED');
      await this.ports.event(store, 'DISPATCH_OUTCOME_UNKNOWN', (await store.getDispatch(dispatch.id))!);
      if (await store.headSequence() !== sequence) throw new Error('A recovery appends exactly one lifecycle event');
      return true;
    });
  }

  // ---- read-only polls of a PENDING_PROVIDER call -------------------------------

  // Claims the next poll of the dispatch's pending call: the shared budget is
  // reserved first, then, under the lock and before any IO, the poll's count,
  // time, next poll and units are recorded on the call and the dispatch gets a
  // fresh poll lease (holder, fence) without a transition. The call keeps the
  // original mutation's holder, version and fence, so its media capabilities
  // stay bound to it. Refused while a poll lease lives, before the call's
  // nextPollAt and from its fixed pollDeadlineAt on (expirePending's job). A
  // crashed poll is claimed again once its lease lapsed; nothing is sent again
  // but a read. A closed authority sends nothing and the outcome of the
  // pending mutation becomes UNKNOWN (PARTIAL after a published member)
  async claimPoll(organizationId: string, claim: ManagedPollClaim): Promise<ManagedPollClaimResult> {
    const validatePoll = this.ports.validatePoll;
    if (typeof validatePoll !== 'function') throw new Error('Missing dispatch journal poll authority');
    if (typeof organizationId !== 'string' || !ID.test(organizationId) || !claim || !ID.test(claim.dispatchId) ||
        !Number.isSafeInteger(claim.reservedUnits) || claim.reservedUnits < 1 || claim.reservedUnits > MANAGED_LIFECYCLE_LIMITS.maxStepUnits ||
        !Number.isSafeInteger(claim.deadlineMs) || claim.deadlineMs < 1 || claim.deadlineMs > MAX_POLL_DEADLINE_MS) return { status: 'STATE_REFUSED' };
    const reservation = await this.ports.budget.reserveDetailed(organizationId, claim.reservedUnits);
    if (!reservation.accepted) return { status: 'BUDGET_REFUSED', reservation };
    return this.ports.repository.mutate(organizationId, async (store): Promise<ManagedPollClaimResult> => {
      const dispatch = await store.getDispatch(claim.dispatchId);
      const call = dispatch?.activeCallId ? await store.getCall(dispatch.activeCallId) : null;
      const now = this.ports.now();
      if (!dispatch || !call || dispatch.status !== 'ADMITTED' || dispatch.nextStep !== null ||
          call.dispatchId !== dispatch.id || call.managedPostId !== dispatch.managedPostId ||
          call.status !== 'PENDING_PROVIDER' || !call.pendingEnvelope || !call.pollDeadlineAt || !call.nextPollAt ||
          !Number.isFinite(now.getTime()) || (dispatch.leaseExpiresAt && dispatch.leaseExpiresAt > now) ||
          now < call.nextPollAt || now >= call.pollDeadlineAt) return { status: 'STATE_REFUSED' };
      // no poll request is outstanding after the fixed deadline
      const deadlineAt = new Date(Math.min(now.getTime() + claim.deadlineMs, call.pollDeadlineAt.getTime()));
      if (!await validatePoll.call(this.ports, store, dispatch, call, deadlineAt)) {
        const status = await this.endPending(store, dispatch, call, 'UNKNOWN', 'PENDING_UNCONFIRMED', now);
        return { status: 'SETTLED', dispatch: status as 'UNKNOWN' | 'PARTIAL' };
      }
      if (!(this.ports.now().getTime() < deadlineAt.getTime())) return { status: 'STATE_REFUSED' };
      const holder = randomUUID();
      const fence = dispatch.fencingToken + 1;
      const pollCount = call.pollCount + 1;
      const leaseExpiresAt = new Date(deadlineAt.getTime() + MANAGED_LIFECYCLE_TIMING.leaseMarginMs);
      const pendingSince = new Date(call.pollDeadlineAt.getTime() - MANAGED_LIFECYCLE_TIMING.pollDeadlineMs);
      const nextPollAt = new Date(lifecycleNextPollAt(pendingSince.toISOString(), now.toISOString(), pollCount));
      if (!await store.leaseDispatch(dispatch.id, dispatch.version, dispatch.fencingToken, {
        leaseHolder: holder, leaseExpiresAt, fencingToken: fence,
        nextActionAt: new Date(Math.max(leaseExpiresAt.getTime(), nextPollAt.getTime())),
      })) throw new Error('Poll claim lost its dispatch');
      if (!await store.updateCall(call.id, 'PENDING_PROVIDER', call.holder, call.dispatchVersion, call.fencingToken, {
        pollCount, lastPolledAt: now, nextPollAt, pollReservedUnits: call.pollReservedUnits + claim.reservedUnits,
      })) throw new Error('Poll claim lost its call');
      return { status: 'CLAIMED', handle: Object.freeze({ organizationId, dispatchId: dispatch.id, callId: call.id, holder,
        dispatchVersion: dispatch.version, fencingToken: fence, deadlineAt: deadlineAt.getTime(), pollCount,
        reservedUnits: claim.reservedUnits }) };
    });
  }

  // The exact poll the handle names: the pending call is still the active
  // one, polled this many times, under the poll lease's version, fence and
  // holder, before the poll's deadline
  private async polling(store: ManagedLifecycleStore, handle: ManagedPollHandle, deadlineAt: Date) {
    const dispatch = await store.getDispatch(handle.dispatchId);
    const call = await store.getCall(handle.callId);
    const now = this.ports.now().getTime();
    if (!dispatch || !call || !Number.isFinite(now) || deadlineAt.getTime() !== handle.deadlineAt ||
        !(now < handle.deadlineAt) || dispatch.status !== 'ADMITTED' || dispatch.activeCallId !== call.id ||
        call.dispatchId !== dispatch.id || call.managedPostId !== dispatch.managedPostId ||
        call.status !== 'PENDING_PROVIDER' || !call.pendingEnvelope || !call.pollDeadlineAt ||
        handle.deadlineAt > call.pollDeadlineAt.getTime() || call.pollCount !== handle.pollCount ||
        dispatch.version !== handle.dispatchVersion || dispatch.fencingToken !== handle.fencingToken ||
        dispatch.leaseHolder !== handle.holder ||
        dispatch.leaseExpiresAt?.getTime() !== handle.deadlineAt + MANAGED_LIFECYCLE_TIMING.leaseMarginMs) return null;
    return { dispatch, call };
  }

  // The poll transport's verifyAdmission: the poll lease and the poll
  // authority, before every read
  verifyPoll(handle: ManagedPollHandle, deadlineAt: Date): Promise<boolean> {
    const validatePoll = this.ports.validatePoll;
    if (typeof validatePoll !== 'function') return Promise.resolve(false);
    return this.ports.repository.mutate(handle.organizationId, async store => {
      const owned = await this.polling(store, handle, deadlineAt);
      return !!owned && await validatePoll.call(this.ports, store, owned.dispatch, owned.call, deadlineAt) === true &&
        this.ports.now().getTime() < handle.deadlineAt;
    });
  }

  // The poll transport's recordAttempt. A poll never mutates: a mutation is
  // refused before it can leave. A read changes nothing at the provider; what
  // a poll may use was recorded on the call when it was claimed
  recordPollAttempt(handle: ManagedPollHandle, ordinal: number, mutation: boolean): Promise<boolean> {
    if (mutation !== false || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > handle.reservedUnits) return Promise.resolve(false);
    return this.ports.repository.mutate(handle.organizationId, async store =>
      !!await this.polling(store, handle, new Date(handle.deadlineAt)));
  }

  // Records once what this poll read, under exactly the poll the handle
  // names. pending (or a poll that proved nothing) keeps the call pending,
  // without a transition or event, until its nextPollAt. ready is the call's
  // OK: its media was fetched, so its capabilities are revoked; the updated
  // sealed continuation is kept and the member, still PENDING_PROVIDER, waits
  // for its next FINALIZE stage as a new admission (POST -> stage 0, carousel
  // FINALIZE stage 0 -> stage 1). rejected is the provider's refusal;
  // anything that may be published is UNKNOWN. A provider status is never a
  // publication. A stale handle changes nothing
  async settlePoll(handle: ManagedPollHandle, outcome: ManagedPublishOutcome,
    transport: ManagedPublishTransport): Promise<ManagedPollSettlement> {
    if (!(transport instanceof ManagedPublishTransport)) throw new Error('Poll settlement needs the poll transport');
    const ledger = transport.ledger();
    const settled = await this.ports.repository.mutate(handle.organizationId, async (store): Promise<ManagedPollSettlement | null> => {
      const owned = await this.polling(store, handle, new Date(handle.deadlineAt));
      if (!owned) return null;
      const { dispatch, call } = owned;
      const now = this.ports.now();
      let verdict = pollVerdictOf(outcome, ledger, handle.reservedUnits, call.pendingEnvelope!);
      // the stage after this call's; a FINALIZE stage 1 has none
      const stage = call.step === 'POST' ? 0 : call.step === 'FINALIZE' && call.stage === 0 ? 1 : null;
      if (verdict.call === 'OK' && stage === null) verdict = { call: 'UNKNOWN', code: 'OUTCOME_UNKNOWN' };

      if (verdict.call === 'PENDING_PROVIDER') {
        if (verdict.envelope !== call.pendingEnvelope && !await store.updateCall(call.id, 'PENDING_PROVIDER', call.holder,
          call.dispatchVersion, call.fencingToken, { pendingEnvelope: verdict.envelope })) throw new Error('Polled call changed');
        if (!await store.leaseDispatch(dispatch.id, dispatch.version, dispatch.fencingToken, {
          leaseHolder: null, leaseExpiresAt: null, fencingToken: dispatch.fencingToken, nextActionAt: call.nextPollAt,
        })) throw new Error('Polled dispatch changed');
        return { status: 'SETTLED', call: 'PENDING_PROVIDER', dispatch: 'ADMITTED', next: 'POLL', stage: null };
      }
      if (verdict.call !== 'OK') {
        const status = await this.endPending(store, dispatch, call, verdict.call, verdict.code, now);
        return { status: 'SETTLED', call: verdict.call, dispatch: status, next: null, stage: null };
      }

      const members = parseMembers(dispatch);
      const member = members[call.member];
      if (member?.status !== 'PENDING_PROVIDER' || member.postId !== call.postId) throw new Error('Polled call does not match retained member');
      await this.scheduleOf(store, dispatch);
      const sequence = (await store.headSequence()) + 1;
      if (!await store.transitionDispatch(dispatch.id, dispatch.version, {
        activeCallId: null, leaseHolder: null, leaseExpiresAt: null, deferralCode: null, lastLifecycleSequence: sequence,
        nextStep: 'FINALIZE', nextMember: call.member, nextActionAt: now,
      })) throw new Error('Polled dispatch lost its version');
      if (!await store.updateCall(call.id, 'PENDING_PROVIDER', call.holder, call.dispatchVersion, call.fencingToken, {
        status: 'OK', code: null, pendingEnvelope: verdict.envelope, nextPollAt: null, settledAt: now,
      })) throw new Error('Polled call changed');
      await store.revokeCall(call.id, now, 'CALL_SETTLED');
      await this.ports.event(store, 'DISPATCH_PROGRESSED', (await store.getDispatch(dispatch.id))!);
      if (await store.headSequence() !== sequence) throw new Error('A poll settlement appends exactly one lifecycle event');
      return { status: 'SETTLED', call: 'OK', dispatch: 'ADMITTED', next: 'FINALIZE', stage };
    });
    return settled ?? { status: 'STALE' };
  }

  // A pending call whose fixed pollDeadlineAt passed without ready, once no
  // poll lease lives: UNKNOWN PENDING_UNCONFIRMED (PARTIAL after a published
  // member), never NOT_SENT; the series halts
  expirePending(organizationId: string, dispatchId: string): Promise<boolean> {
    return this.ports.repository.mutate(organizationId, async store => {
      const dispatch = await store.getDispatch(dispatchId);
      const call = dispatch?.activeCallId ? await store.getCall(dispatch.activeCallId) : null;
      const now = this.ports.now();
      if (!dispatch || !call || dispatch.status !== 'ADMITTED' || call.dispatchId !== dispatch.id ||
          call.status !== 'PENDING_PROVIDER' || !call.pollDeadlineAt || !Number.isFinite(now.getTime()) ||
          now < call.pollDeadlineAt || (dispatch.leaseExpiresAt && dispatch.leaseExpiresAt > now)) return false;
      await this.endPending(store, dispatch, call, 'UNKNOWN', 'PENDING_UNCONFIRMED', now);
      return true;
    });
  }

  // The pending call's end as REJECTED or UNKNOWN: the one dispatch
  // transition, the call settled under its original identity, its media
  // revoked, later members never sent, the series halted, one event
  private async endPending(store: ManagedLifecycleStore, dispatch: ManagedDispatch, call: ManagedDispatchCall,
    callStatus: 'REJECTED' | 'UNKNOWN', code: string, now: Date): Promise<'REJECTED' | 'UNKNOWN' | 'PARTIAL'> {
    const members = parseMembers(dispatch);
    const member = members[call.member];
    if (member?.status !== 'PENDING_PROVIDER' || member.postId !== call.postId) throw new Error('Pending call does not match retained member');
    members[call.member] = { ...member, status: callStatus, code, release: null };
    for (let n = call.member + 1; n < members.length; n++) {
      members[n] = { ...members[n], status: 'NOT_SENT', code: 'PREVIOUS_MEMBER_FAILED', release: null };
    }
    const status = call.member === 0 ? callStatus : 'PARTIAL';
    const sequence = (await store.headSequence()) + 1;
    await this.endSchedule(store, await this.scheduleOf(store, dispatch), dispatch, status, now);
    if (!await store.transitionDispatch(dispatch.id, dispatch.version, {
      status, code, members: JSON.stringify(members), activeCallId: null, leaseHolder: null, leaseExpiresAt: null,
      nextActionAt: null, nextStep: null, nextMember: null, deferralCode: null, settledAt: now, lastLifecycleSequence: sequence,
    })) throw new Error('Pending dispatch lost its version');
    if (!await store.updateCall(call.id, 'PENDING_PROVIDER', call.holder, call.dispatchVersion, call.fencingToken,
      { status: callStatus, code, nextPollAt: null, settledAt: now })) throw new Error('Pending call changed');
    await store.revokeCall(call.id, now, 'CALL_SETTLED');
    await this.ports.event(store, SETTLED_EVENTS[status], (await store.getDispatch(dispatch.id))!);
    if (await store.headSequence() !== sequence) throw new Error('A settlement appends exactly one lifecycle event');
    return status;
  }

  haltPending(organizationId: string, dispatchId: string, expectedVersion: number): Promise<boolean> {
    return this.ports.repository.mutate(organizationId, async store => {
      const dispatch = await store.getDispatch(dispatchId), now = this.ports.now();
      const call = dispatch?.activeCallId ? await store.getCall(dispatch.activeCallId) : null;
      if (!dispatch || dispatch.version !== expectedVersion || dispatch.status !== 'ADMITTED' || !call ||
          call.status !== 'PENDING_PROVIDER' || call.dispatchId !== dispatch.id ||
          (dispatch.leaseExpiresAt && dispatch.leaseExpiresAt > now)) return false;
      await this.endPending(store, dispatch, call, 'UNKNOWN', 'PENDING_UNCONFIRMED', now);
      return true;
    });
  }

  async defer(organizationId: string, dispatchId: string, expectedVersion: number,
    reservation: ManagedRequestReservation): Promise<boolean> {
    return this.ports.repository.mutate(organizationId, async store => {
      const dispatch = await store.getDispatch(dispatchId), now = this.ports.now();
      if (!dispatch || dispatch.version !== expectedVersion || !['PENDING', 'ADMITTED'].includes(dispatch.status) ||
          (dispatch.leaseExpiresAt && dispatch.leaseExpiresAt > now)) return false;
      const call = dispatch.activeCallId ? await store.getCall(dispatch.activeCallId) : null;
      if (dispatch.activeCallId && call?.status !== 'PENDING_PROVIDER') return false;
      const bound = call?.pollDeadlineAt?.getTime() ?? (dispatch.status === 'PENDING' ? dispatch.admissibleUntil.getTime() + 1 : Infinity);
      const next = Math.min(now.getTime() + Math.max(1000, reservation.retryAfterMs ?? 30000), bound);
      if (next <= now.getTime()) return false;
      return store.deferDispatch(dispatch.id, dispatch.version, { nextActionAt: new Date(next),
        deferralCode: reservation.code === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'BUDGET_UNAVAILABLE',
        deferralCount: dispatch.deferralCount + 1, firstDeferredAt: dispatch.firstDeferredAt ?? now, lastDeferredAt: now });
    });
  }

  // A refusal before a new call is admitted cannot be an unknown provider effect.
  // Prior published members remain visible as PARTIAL; no existing call is replayed.
  async refuseBeforeCall(organizationId: string, dispatchId: string, expectedVersion: number,
    code: typeof MANAGED_DISPATCH_NOT_SENT_CODES[number]): Promise<boolean> {
    if (!(MANAGED_DISPATCH_NOT_SENT_CODES as readonly string[]).includes(code)) return false;
    return this.ports.repository.mutate(organizationId, async store => {
      const dispatch = await store.getDispatch(dispatchId), now = this.ports.now();
      if (!dispatch || dispatch.version !== expectedVersion || dispatch.activeCallId ||
          !['PENDING', 'ADMITTED'].includes(dispatch.status) || (dispatch.leaseExpiresAt && dispatch.leaseExpiresAt > now)) return false;
      const members = parseMembers(dispatch);
      const partial = members.some(member => member.status === 'PUBLISHED');
      const status = partial ? 'PARTIAL' : dispatch.admittedAt === null && ['WINDOW_CLOSED', 'LATE_BEYOND_TOLERANCE'].includes(code) ? 'EXPIRED' : 'NOT_SENT';
      let first = true;
      for (let index = 0; index < members.length; index++) if (status !== 'EXPIRED' && members[index].status !== 'PUBLISHED') {
        members[index] = { ...members[index], status: 'NOT_SENT', code: first ? code : 'PREVIOUS_MEMBER_FAILED', release: null };
        first = false;
      }
      const sequence = (await store.headSequence()) + 1;
      await this.endSchedule(store, await this.scheduleOf(store, dispatch), dispatch, status, now);
      if (!await store.transitionDispatch(dispatch.id, dispatch.version, { status, code, members: JSON.stringify(members),
        nextActionAt: null, nextStep: null, nextMember: null, leaseHolder: null, leaseExpiresAt: null,
        settledAt: now, deferralCode: null, lastLifecycleSequence: sequence })) throw new Error('Preflight dispatch changed');
      await this.ports.event(store, status === 'EXPIRED' ? 'OCCURRENCE_EXPIRED' : status === 'PARTIAL' ? 'DISPATCH_PARTIAL' : 'DISPATCH_NOT_SENT',
        (await store.getDispatch(dispatch.id))!);
      if (await store.headSequence() !== sequence) throw new Error('Preflight refusal appends exactly one lifecycle event');
      return true;
    });
  }

  // ---- the next occurrence of a series --------------------------------------------

  // Materializes the next anchored occurrence of the post's latest, live
  // schedule as one durable PENDING dispatch, once the last materialized one
  // is PUBLISHED, RESOLVED_PUBLISHED or CANCELLED, and only up to the
  // schedule's lastOccurrence, inside the window it captured. No IO. Again
  // (or concurrently) it finds that occurrence PENDING and does nothing; a
  // failed, expired or unresolved occurrence stops the series here
  materializeNext(organizationId: string, scheduleId: string): Promise<ManagedMaterialization> {
    if (typeof organizationId !== 'string' || !ID.test(organizationId) || typeof scheduleId !== 'string' ||
        !ID.test(scheduleId)) return Promise.resolve({ status: 'NONE', reason: 'NOT_LIVE' });
    return this.ports.repository.mutate(organizationId, async (store): Promise<ManagedMaterialization> => {
      const schedule = await store.getSchedule(scheduleId);
      if (!schedule || !['ACTIVE', 'ENDING'].includes(schedule.status)) return { status: 'NONE', reason: 'NOT_LIVE' };
      const latest = await store.getLatestSchedule(schedule.managedPostId);
      const post = await store.getPost(schedule.managedPostId);
      if (latest?.id !== schedule.id || !post || post.deletedAt || post.activeScheduleId !== schedule.id ||
          post.scheduleGeneration !== schedule.scheduleGeneration) return { status: 'NONE', reason: 'NOT_LATEST' };
      const dispatches = await store.listDispatches(schedule.managedPostId, schedule.id);
      if (!dispatches.length || dispatches.some((row, index) => row.occurrence !== index ||
          row.scheduleGeneration !== schedule.scheduleGeneration)) throw new Error('Materialized occurrences are not contiguous');
      const last = dispatches[dispatches.length - 1];
      if (!(MANAGED_MATERIALIZE_AFTER as readonly string[]).includes(last.status)) return { status: 'NONE', reason: 'PREVIOUS_NOT_SETTLED' };
      const occurrence = last.occurrence + 1;
      if (occurrence > schedule.lastOccurrence) return { status: 'NONE', reason: 'SERIES_END' };
      const dueAts = lifecycleOccurrenceDueAts(schedule.anchorAt.toISOString(), schedule.intervalDays, schedule.maxOccurrences);
      const dueAt = dueAts[occurrence] ? new Date(dueAts[occurrence]) : null;
      if (!dueAt || dueAt >= schedule.policyExpiresAt) throw new Error('The next occurrence is outside its schedule');
      const sequence = (await store.headSequence()) + 1;
      // the shape of the lifecycle service's own materialization
      const created = await store.createDispatch({
        managedPostId: schedule.managedPostId, scheduleId: schedule.id, occurrence, dueAt,
        admissibleUntil: new Date(Math.min(dueAt.getTime() + schedule.maxLatenessMs, schedule.policyExpiresAt.getTime() - 1)),
        status: 'PENDING', revision: schedule.revision, bindingGeneration: schedule.bindingGeneration,
        scheduleGeneration: schedule.scheduleGeneration, contentSha256: schedule.contentSha256, releaseHash: schedule.releaseHash,
        members: JSON.stringify(parseMembers(last).map((member, position) => ({
          position, postId: member.postId, status: 'WAITING', code: null, release: null,
        }))),
        nextActionAt: dueAt, lastLifecycleSequence: sequence, createdAt: this.ports.now(),
      });
      await this.ports.event(store, 'OCCURRENCE_MATERIALIZED', created);
      if (await store.headSequence() !== sequence) throw new Error('A materialization appends exactly one lifecycle event');
      return { status: 'MATERIALIZED', dispatchId: created.id, occurrence };
    });
  }

  // A stale sender's answer is retained separately in the call's private
  // result envelope. It can never turn UNKNOWN into PUBLISHED or authorize a
  // resend. Only closed identifiers/URLs enter this evidence; no provider body.
  recordLateEvidence(handle: ManagedDispatchHandle, evidence: { releaseId: string; releaseURL: string | null }): Promise<boolean> {
    if (!evidence || typeof evidence.releaseId !== 'string' || !MANAGED_RELEASE_ID.test(evidence.releaseId) ||
        (evidence.releaseURL !== null && (typeof evidence.releaseURL !== 'string' ||
          evidence.releaseURL.length > MANAGED_LIFECYCLE_LIMITS.releaseUrlMax || !MANAGED_RELEASE_URL.test(evidence.releaseURL)))) {
      return Promise.resolve(false);
    }
    return this.ports.repository.mutate(handle.organizationId, async store => {
      const call = await store.getCall(handle.callId);
      if (!call || call.dispatchId !== handle.dispatchId || call.status !== 'UNKNOWN' || call.result !== null ||
          call.holder !== handle.holder || call.dispatchVersion !== handle.dispatchVersion || call.fencingToken !== handle.fencingToken) return false;
      return store.updateCall(call.id, 'UNKNOWN', handle.holder, handle.dispatchVersion, handle.fencingToken, {
        result: JSON.stringify({ kind: 'LATE_EVIDENCE', observedAt: this.ports.now().toISOString(),
          releaseId: evidence.releaseId, releaseURL: evidence.releaseURL, changesOutcome: false }),
      });
    });
  }
}
