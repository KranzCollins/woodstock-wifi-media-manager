import type {
  ManagedSchedule, ManagedDispatch, ManagedDispatchCall, ManagedPostLifecycle,
  ManagedLifecycleChangeEvent, ManagedLifecycleOperation,
} from '@prisma/client';
import type { ManagedPostRow } from './managed.repository';
import {
  lifecycleOccurrenceDueAts, MANAGED_LIFECYCLE_TIMING, MANAGED_LIFECYCLE_VERSION,
  parseManagedLifecycleResponse, parseManagedScheduleView,
} from './managed.lifecycle.contracts';

// Explicit allowlisted projections only. Never spread a Prisma row: calls,
// releases, credentials, pending envelopes and capability paths stay private.
export class ManagedLifecycleProjectionError extends Error {
  constructor() { super('Stored lifecycle state cannot be projected'); }
}
const invalid = (): never => { throw new ManagedLifecycleProjectionError(); };
const iso = (value: Date | null) => value === null ? null : value.toISOString();
function json(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return invalid(); }
}

export function managedScheduleView(row: ManagedSchedule) {
  return parseManagedScheduleView({
    scheduleId: row.id, managedPostId: row.managedPostId, scheduleGeneration: row.scheduleGeneration,
    scheduleVersion: row.version, mode: row.mode, status: row.status, revision: row.revision,
    bindingGeneration: row.bindingGeneration, releaseHash: row.releaseHash, contentSha256: row.contentSha256,
    codec: row.codec, anchorAt: iso(row.anchorAt), intervalDays: row.intervalDays, maxOccurrences: row.maxOccurrences,
    dueAts: lifecycleOccurrenceDueAts(row.anchorAt.toISOString(), row.intervalDays, row.maxOccurrences),
    windowEndsAt: iso(row.policyExpiresAt), maxLatenessMs: row.maxLatenessMs, operationKey: row.operationKey,
    lastOccurrence: row.lastOccurrence === -1 ? null : row.lastOccurrence,
    endRequestedOperationKey: row.endRequestedOperationKey, endRequestedAt: iso(row.endRequestedAt),
    endedAt: iso(row.endedAt), endedOperationKey: row.endedOperationKey, createdAt: iso(row.createdAt),
  }) ?? invalid();
}

export function managedDispatchView(row: ManagedDispatch, calls: readonly ManagedDispatchCall[]) {
  if (calls.some(call => call.organizationId !== row.organizationId || call.dispatchId !== row.id ||
      call.managedPostId !== row.managedPostId)) return invalid();
  let continuation: unknown = null;
  if (row.status === 'ADMITTED') {
    if (row.activeCallId !== null) {
      const call = calls.find(item => item.id === row.activeCallId);
      if (!call) return invalid();
      if (call.status === 'DISPATCHING') {
        if (call.holder !== row.leaseHolder || call.fencingToken !== row.fencingToken ||
            call.dispatchVersion !== row.version) return invalid();
        continuation = { kind: 'IN_CALL', member: call.member, step: call.step, callId: call.id,
          attempt: call.attempt, reservedUnits: call.reservedUnits,
          admittedAt: iso(call.admittedAt), leaseExpiresAt: iso(call.leaseExpiresAt) };
      } else if (call.status === 'PENDING_PROVIDER') {
        if (!call.pollDeadlineAt || !call.nextPollAt) return invalid();
        continuation = { kind: 'PROVIDER_PENDING', member: call.member, step: call.step, callId: call.id,
          pendingSince: new Date(call.pollDeadlineAt.getTime() - MANAGED_LIFECYCLE_TIMING.pollDeadlineMs).toISOString(),
          pollCount: call.pollCount, lastPolledAt: iso(call.lastPolledAt), nextPollAt: iso(call.nextPollAt),
          pollDeadlineAt: iso(call.pollDeadlineAt) };
      } else return invalid();
    } else {
      if (!row.nextActionAt || row.nextMember === null || row.nextStep === null) return invalid();
      const previous = calls.filter(call => call.member === row.nextMember && call.step === row.nextStep)
        .sort((a, b) => b.stage - a.stage || b.attempt - a.attempt)[0];
      continuation = { kind: 'NEXT_STEP', member: row.nextMember, nextStep: row.nextStep,
        attempt: previous?.status === 'NOT_SENT' ? previous.attempt + 1 : 1, nextActionAt: iso(row.nextActionAt) };
    }
  } else if (row.activeCallId !== null) return invalid();

  return parseManagedLifecycleResponse('DISPATCH', {
    dispatchId: row.id, scheduleId: row.scheduleId, managedPostId: row.managedPostId,
    occurrence: row.occurrence, dueAt: iso(row.dueAt), admissibleUntil: iso(row.admissibleUntil),
    status: row.status, dispatchVersion: row.version, code: row.code, revision: row.revision,
    bindingGeneration: row.bindingGeneration, scheduleGeneration: row.scheduleGeneration,
    releaseHash: row.releaseHash, contentSha256: row.contentSha256, members: json(row.members),
    deferral: row.deferralCode === null ? null : {
      code: row.deferralCode, count: row.deferralCount, firstDeferredAt: iso(row.firstDeferredAt), nextAttemptAt: iso(row.nextActionAt),
    }, continuation, admittedAt: iso(row.admittedAt), settledAt: iso(row.settledAt),
    cancelledByOperationKey: row.cancelledByOperationKey, resolution: json(row.resolution),
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
  }) ?? invalid();
}

export function managedPostLifecycleView(input: {
  post: ManagedPostRow; lifecycle: ManagedPostLifecycle | null; asOfSequence: number;
  latestSchedule: ManagedSchedule | null; scheduleCount: number;
  dispatches: readonly ManagedDispatch[]; calls: readonly ManagedDispatchCall[];
}) {
  const { post, lifecycle, latestSchedule } = input;
  if ((lifecycle && (lifecycle.organizationId !== post.organizationId || lifecycle.managedPostId !== post.id)) ||
      (latestSchedule && (latestSchedule.organizationId !== post.organizationId || latestSchedule.managedPostId !== post.id)) ||
      input.dispatches.some(row => row.organizationId !== post.organizationId || row.managedPostId !== post.id || row.scheduleId !== latestSchedule?.id)) return invalid();
  const dispatches = input.dispatches.map(row => managedDispatchView(row, input.calls.filter(call => call.dispatchId === row.id)));
  return parseManagedLifecycleResponse('LIFECYCLE', {
    version: MANAGED_LIFECYCLE_VERSION, managedPostId: post.id, asOfSequence: input.asOfSequence,
    revision: post.revision, bindingGeneration: post.bindingGeneration,
    scheduleGeneration: lifecycle?.scheduleGeneration ?? 0, lifecycle: lifecycle?.lifecycle ?? 'DRAFT',
    deletion: lifecycle?.deletedAt ? { mode: 'RETAINED_SOFT_DELETE', platformPost: 'NOT_DELETED',
      deletedAt: iso(lifecycle.deletedAt), operationKey: lifecycle.deletedOperationKey } : null,
    schedule: latestSchedule ? managedScheduleView(latestSchedule) : null, dispatches,
    unresolvedDispatchIds: dispatches.filter(row => row.status === 'UNKNOWN' || row.status === 'PARTIAL').map(row => row.dispatchId),
    scheduleCount: input.scheduleCount,
  }) ?? invalid();
}

// A page of the lifecycle feed from its rows; `data` holds the projection the
// write stored. A gap, a foreign row or a projection that no longer parses
// fails the whole page, so a cursor never skips or loops on it
export function managedLifecycleEventsPage(afterSequence: number, headSequence: number,
  rows: readonly ManagedLifecycleChangeEvent[]) {
  return parseManagedLifecycleResponse('EVENTS', {
    version: MANAGED_LIFECYCLE_VERSION, afterSequence, headSequence,
    nextSequence: afterSequence + rows.length,
    events: rows.map(row => ({
      sequence: row.sequence, kind: row.kind, managedPostId: row.managedPostId,
      scheduleId: row.scheduleId, dispatchId: row.dispatchId, operationKey: row.operationKey,
      at: iso(row.createdAt), projection: json(row.data),
    })),
    hasMore: afterSequence + rows.length < headSequence,
  }) ?? invalid();
}

// The answer a lifecycle write stored, as first answered or replayed. Only
// when the row's own columns are the ones the answer names
export function managedLifecycleStoredResult(row: ManagedLifecycleOperation, replayed: boolean) {
  const result = parseManagedLifecycleResponse('RESULT', json(row.result)) ?? invalid();
  if (result.kind !== row.kind || result.operationKey !== row.operationKey || result.payloadHash !== row.payloadHash ||
      result.managedPostId !== row.managedPostId || result.sequence !== row.sequence ||
      result.committedAt !== iso(row.committedAt) || result.scheduleGeneration !== row.scheduleGeneration ||
      result.replayed !== false) return invalid();
  return replayed ? parseManagedLifecycleResponse('RESULT', { ...result, replayed: true }) ?? invalid() : result;
}

// GET /lifecycle/operations/:operationKey for a committed lifecycle key, as of
// the read's head. SUPERSEDED once a later write changed the generation
export function managedLifecycleOperationView(row: ManagedLifecycleOperation, asOfSequence: number,
  current: ManagedPostLifecycle | null) {
  const result = managedLifecycleStoredResult(row, false);
  const currentScheduleGeneration = current?.scheduleGeneration ?? 0;
  return parseManagedLifecycleResponse('OPERATION', {
    version: MANAGED_LIFECYCLE_VERSION, operationKey: row.operationKey, status: 'COMMITTED', asOfSequence,
    kind: row.kind, payloadHash: row.payloadHash, managedPostId: row.managedPostId, sequence: row.sequence,
    committedAt: result.committedAt, currentScheduleGeneration, currentLifecycle: current?.lifecycle ?? 'DRAFT',
    ack: currentScheduleGeneration === result.scheduleGeneration ? 'CURRENT' : 'SUPERSEDED', result,
  }) ?? invalid();
}
