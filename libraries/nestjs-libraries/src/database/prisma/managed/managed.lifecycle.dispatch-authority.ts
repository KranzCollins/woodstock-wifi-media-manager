import type { ManagedDispatch, ManagedDispatchCall, ManagedSchedule } from '@prisma/client';
import { canonicalJson } from './managed.service';
import { lifecycleAdmissionTimeRefusal, lifecycleOccurrenceDueAts, lifecycleWindowRefusal, MANAGED_LIFECYCLE_TIMING, ManagedLifecycleException } from './managed.lifecycle.contracts';
import { ManagedLifecycleRepository, ManagedLifecycleStore } from './managed.lifecycle.repository';
import { buildManagedRelease, managedReleaseMediaIds, observeManagedReleaseMedia,
  ManagedPreparedRelease, ManagedReleaseObservedMedia } from './managed.lifecycle.release';
import type { ManagedLifecycleConfiguration } from './managed.lifecycle.service';
import type { ManagedDispatchAdmission } from './managed.lifecycle.dispatch-journal';
import type { ManagedMediaCallAuthority, ManagedMediaActiveCall, ManagedMediaPinnedStorage } from './managed.lifecycle.media-capability';
import type { ManagedPublishStep, ManagedPublishAdapter } from './managed.publish.provider';

// A budget deferral changes nextActionAt only. The actual ready time comes
// from immutable call outcomes, so waiting never resets the lateness bound.
export function managedDispatchStepDueAt(dispatch: ManagedDispatch, step: ManagedPublishStep, member: number,
  calls: readonly ManagedDispatchCall[], release: ManagedPreparedRelease): Date | null {
  if (step === 'POST') return dispatch.dueAt;
  const candidates = calls.filter(call => call.status === 'OK' && call.settledAt &&
    (step === 'FINALIZE' ? call.member === member && !!call.pendingEnvelope :
      step === 'COMMENT' && call.member === member - 1 && !!call.result))
    .sort((a, b) => b.dispatchVersion - a.dispatchVersion);
  const previous = candidates[0];
  if (!previous?.settledAt) return null;
  const delay = step === 'COMMENT' ? release.members[member]?.delay : 0;
  if (!Number.isSafeInteger(delay) || delay! < 0) return null;
  return new Date(previous.settledAt.getTime() + delay! * 60000);
}

// The real DB/release validator of the journal and media capabilities.
// No provider IO, credential reads or refresh. Storage observations are taken
// outside a transaction; the retained revision, binding and fingerprints are
// checked again in the journal's organization transaction before each request.
// Byte delivery itself still verifies the entire current pinned object.
export class ManagedLifecycleDispatchAuthority implements ManagedMediaCallAuthority {
  constructor(private readonly repository: ManagedLifecycleRepository,
    private readonly storage: Pick<ManagedMediaPinnedStorage, 'pinnedEvidence' | 'namespace' | 'versionAt'>,
    private readonly configuration: ManagedLifecycleConfiguration,
    private readonly adapters: ReadonlyMap<string, ManagedPublishAdapter>,
    private readonly now: () => Date) {}

  async observe(organizationId: string, dispatchId: string): Promise<ManagedReleaseObservedMedia> {
    const ids = await this.repository.read(organizationId, async store => {
      const dispatch = await store.getDispatch(dispatchId);
      return dispatch ? managedReleaseMediaIds(store.draft, dispatch.managedPostId, dispatch.revision) : [];
    });
    return observeManagedReleaseMedia(this.storage, organizationId, ids);
  }

  // Shared by admission and capability authorization, using only the store
  // of this transaction. A later policy cannot extend a captured schedule.
  async currentRelease(store: ManagedLifecycleStore, dispatch: ManagedDispatch,
    observedMedia: ManagedReleaseObservedMedia): Promise<{ release: ManagedPreparedRelease; schedule: ManagedSchedule; until: Date } | null> {
    const gates = await this.configuration.gates(dispatch.organizationId);
    const now = this.now();
    const schedule = await store.getSchedule(dispatch.scheduleId);
    const post = await store.getPost(dispatch.managedPostId);
    const adapter = schedule ? this.adapters.get(schedule.providerIdentifier) : null;
    if (!gates?.organizationEnabled || !gates.dispatcherAvailable || !gates.mediaDeliveryReady || !gates.policy ||
        !schedule || !post || post.deletedAt || post.activeScheduleId !== schedule.id ||
        !['ACTIVE', 'ENDING'].includes(schedule.status) || schedule.lastOccurrence < dispatch.occurrence ||
        !adapter || !gates.providers.includes(adapter.identifier) ||
        post.scheduleGeneration !== dispatch.scheduleGeneration || schedule.scheduleGeneration !== dispatch.scheduleGeneration ||
        schedule.revision !== dispatch.revision || schedule.bindingGeneration !== dispatch.bindingGeneration ||
        schedule.releaseHash !== dispatch.releaseHash || schedule.contentSha256 !== dispatch.contentSha256 ||
        schedule.managedPostId !== dispatch.managedPostId ||
        lifecycleWindowRefusal(schedule.policyExpiresAt.toISOString(), gates.policy, now)) return null;
    // The original grant is retained as well as its end; a malformed stored
    // policy is never repaired from a current environment extension.
    if (lifecycleWindowRefusal(schedule.policyExpiresAt.toISOString(),
      { grantedAt: schedule.policyGrantedAt, expiresAt: schedule.policyExpiresAt }, now)) return null;
    const dueAts = lifecycleOccurrenceDueAts(schedule.anchorAt.toISOString(), schedule.intervalDays, schedule.maxOccurrences);
    if (dueAts[dispatch.occurrence] !== dispatch.dueAt.toISOString() ||
        dispatch.admissibleUntil.getTime() !== Math.min(dispatch.dueAt.getTime() + schedule.maxLatenessMs,
          schedule.policyExpiresAt.getTime() - 1)) return null;
    if (dispatch.occurrence > 0) {
      const predecessor = await store.getOccurrence(schedule.id, dispatch.occurrence - 1);
      if (!predecessor || !['PUBLISHED', 'RESOLVED_PUBLISHED', 'CANCELLED'].includes(predecessor.status)) return null;
    }
    try {
      const { release } = await buildManagedRelease(store.draft, {
        managedPostId: dispatch.managedPostId, expectedRevision: dispatch.revision,
        codec: schedule.codec as ManagedPreparedRelease['codec'],
        provider: { identifier: adapter.identifier, editor: adapter.editor, requiresMedia: adapter.requiresMedia,
          maxStepUnits: adapter.maxStepUnits, maxStepDeadlineMs: adapter.maxStepDeadlineMs },
        mediaDeliveryReady: true, observedMedia,
      });
      if (release.integrationId !== schedule.integrationId || release.providerIdentifier !== schedule.providerIdentifier ||
          release.identityFingerprint !== schedule.identityFingerprint || release.releaseHash !== schedule.releaseHash) return null;
      const { rowFingerprint: _rowFingerprint, ...frozen } = release;
      if (canonicalJson(JSON.parse(schedule.release)) !== canonicalJson({ v: 'ww-scheduled-release-v1', dueAts, ...frozen })) return null;
      return { release, schedule, until: new Date(Math.min(schedule.policyExpiresAt.getTime(), gates.policy.expiresAt.getTime())) };
    } catch (error) {
      if (error instanceof ManagedLifecycleException || error instanceof SyntaxError) return null;
      // Database/storage unavailability is not evidence of release drift.
      throw error;
    }
  }

  async validate(store: ManagedLifecycleStore, dispatch: ManagedDispatch, admission: ManagedDispatchAdmission,
    deadlineAt: Date, observedMedia: ManagedReleaseObservedMedia): Promise<boolean> {
    const current = await this.currentRelease(store, dispatch, observedMedia);
    if (!current || !Number.isFinite(deadlineAt.getTime()) || deadlineAt <= this.now() || deadlineAt > current.until) return false;
    const adapter = this.adapters.get(current.release.providerIdentifier)!;
    const calls = await store.listCalls(dispatch.id);
    const dueAt = managedDispatchStepDueAt(dispatch, admission.step, admission.member, calls, current.release);
    if (!dueAt || lifecycleAdmissionTimeRefusal({ dueAt: dueAt.toISOString(),
      maxLatenessMs: current.schedule.maxLatenessMs, windowEndsAt: current.until.toISOString() },
      { grantedAt: current.schedule.policyGrantedAt, expiresAt: current.schedule.policyExpiresAt }, this.now())) return false;
    try {
      const prepared = adapter.prepare({ internalId: current.release.internalId, profile: current.release.profile!,
        settings: { ...current.release.settings }, members: current.release.members.map(member => ({
          postId: member.postId, text: member.text, media: [...member.media],
        })) });
      const pending = admission.step === 'FINALIZE'
        ? calls.filter(item => item.member === admission.member && item.pendingEnvelope)
          .sort((a, b) => b.stage - a.stage || b.admittedAt.getTime() - a.admittedAt.getTime())[0]?.pendingEnvelope ?? undefined
        : undefined;
      return prepared.requestHash === admission.requestHash &&
        admission.deadlineMs === adapter.steps[admission.step].deadlineMs &&
        admission.reservedUnits === adapter.stepUnits(prepared, admission.step, pending) &&
        admission.member < prepared.members && (admission.stage === 0 || prepared.finalizeSteps === 2);
    } catch { return false; }
  }

  // Read-only recheck before each provider poll of a PENDING_PROVIDER call.
  // The journal already verified lease/holder/version/pollCount; this
  // independently rebinds the original call to the frozen release, current
  // and captured policy, live schedule and the original pending deadline.
  // The original mutation deadline is deliberately not required: provider
  // processing legitimately outlives it. Nothing is renewed or extended.
  async validatePoll(store: ManagedLifecycleStore, dispatch: ManagedDispatch, call: ManagedDispatchCall,
    deadlineAt: Date, observedMedia: ManagedReleaseObservedMedia): Promise<boolean> {
    const now = this.now();
    if (dispatch.status !== 'ADMITTED' || !dispatch.activeCallId || dispatch.activeCallId !== call.id ||
        call.status !== 'PENDING_PROVIDER' || call.dispatchId !== dispatch.id ||
        call.organizationId !== dispatch.organizationId || call.managedPostId !== dispatch.managedPostId ||
        !['POST', 'FINALIZE'].includes(call.step) || call.stage !== 0 ||
        call.member !== 0 || !Number.isInteger(call.pollCount) || call.pollCount < 0 ||
        typeof call.pendingEnvelope !== 'string' || !call.pendingEnvelope ||
        typeof call.requestHash !== 'string' || !call.requestHash || !call.holder ||
        !Number.isSafeInteger(call.dispatchVersion) || call.dispatchVersion < 1 || call.dispatchVersion > dispatch.version ||
        !Number.isSafeInteger(call.fencingToken) || call.fencingToken < 1 || call.fencingToken > dispatch.fencingToken ||
        !call.pollDeadlineAt || !Number.isFinite(call.pollDeadlineAt.getTime()) ||
        !Number.isFinite(call.admittedAt.getTime()) || call.pollDeadlineAt <= call.admittedAt ||
        !Number.isFinite(deadlineAt.getTime()) || deadlineAt <= now || now >= call.pollDeadlineAt ||
        deadlineAt > call.pollDeadlineAt) return false;
    // The stored row is reread in this transaction; a caller's copy is never
    // trusted over the journal's current state of the same call.
    const stored = await store.getCall(call.id);
    if (!stored || stored.dispatchId !== dispatch.id || stored.status !== 'PENDING_PROVIDER' ||
        stored.requestHash !== call.requestHash || stored.member !== call.member || stored.postId !== call.postId ||
        stored.step !== call.step || stored.stage !== call.stage || stored.pendingEnvelope !== call.pendingEnvelope ||
        stored.holder !== call.holder || stored.dispatchVersion !== call.dispatchVersion ||
        stored.fencingToken !== call.fencingToken || stored.admittedAt.getTime() !== call.admittedAt.getTime() ||
        stored.pollDeadlineAt?.getTime() !== call.pollDeadlineAt.getTime()) return false;
    // Live schedule, current policy, captured policy and frozen release.
    const current = await this.currentRelease(store, dispatch, observedMedia);
    if (!current || deadlineAt > current.until || now >= current.until ||
        current.schedule.id !== dispatch.scheduleId || current.schedule.managedPostId !== call.managedPostId) return false;
    const adapter = this.adapters.get(current.release.providerIdentifier);
    if (!adapter || adapter.identifier !== current.schedule.providerIdentifier) return false;
    const poll = adapter.steps.POLL;
    if (!poll || deadlineAt.getTime() - now.getTime() > poll.deadlineMs ||
        poll.deadlineMs > adapter.maxStepDeadlineMs) return false;
    const member = current.release.members[call.member];
    if (!member || member.postId !== call.postId) return false;
    try {
      const prepared = adapter.prepare({ internalId: current.release.internalId, profile: current.release.profile!,
        settings: { ...current.release.settings }, members: current.release.members.map(item => ({
          postId: item.postId, text: item.text, media: [...item.media],
        })) });
      if (prepared.requestHash !== call.requestHash || call.member >= prepared.members ||
          (call.step === 'FINALIZE' && prepared.finalizeSteps !== 2)) return false;
      // Poll units are their own reservation; the call's reservedUnits stay
      // with the original POST/FINALIZE and are deliberately not compared.
      const units = adapter.stepUnits(prepared, 'POLL', call.pendingEnvelope);
      return Number.isInteger(units) && units > 0 && units <= adapter.maxStepUnits;
    } catch { return false; }
  }
  async activeCall(organizationId: string, callId: string): Promise<ManagedMediaActiveCall | null> {
    const initial = await this.repository.read(organizationId, store => store.getCall(callId));
    if (!initial) return null;
    const observed = await this.observe(organizationId, initial.dispatchId);
    return this.repository.read(organizationId, async store => {
      const call = await store.getCall(callId);
      const dispatch = call ? await store.getDispatch(call.dispatchId) : null;
      if (!call || !dispatch || dispatch.status !== 'ADMITTED' || dispatch.activeCallId !== call.id ||
          call.managedPostId !== dispatch.managedPostId || !['DISPATCHING', 'PENDING_PROVIDER'].includes(call.status)) return null;
      const current = await this.currentRelease(store, dispatch, observed);
      if (!current) return null;
      let activeUntil: Date;
      if (call.status === 'DISPATCHING') {
        if (call.dispatchVersion !== dispatch.version || call.fencingToken !== dispatch.fencingToken ||
            call.holder !== dispatch.leaseHolder || !dispatch.leaseExpiresAt ||
            dispatch.leaseExpiresAt.getTime() !== call.leaseExpiresAt.getTime() || this.now() >= call.deadlineAt) return null;
        // The capability may survive the successful transition to pending
        // ingestion. Each fetch still requires the current call state; an
        // expired DISPATCHING lease is never authority. The capability leaf's
        // independent 15-minute maximum remains; it cannot be renewed.
        activeUntil = new Date(Math.min(call.admittedAt.getTime() + MANAGED_LIFECYCLE_TIMING.pollDeadlineMs,
          current.until.getTime()));
      } else {
        // Pending polling may advance the dispatch version. The media remains
        // bound to the original mutation's version until ingestion is ready.
        if (!call.pendingEnvelope || !call.pollDeadlineAt) return null;
        activeUntil = new Date(Math.min(call.pollDeadlineAt.getTime(), current.until.getTime()));
      }
      const member = current.release.members[call.member];
      if (!member || member.postId !== call.postId || call.step !== 'POST') return null;
      const media = member.media.flatMap(value => value.thumbnail ? [value.pin, value.thumbnail] : [value.pin]);
      return { organizationId, dispatchId: dispatch.id, callId, dispatchVersion: call.dispatchVersion,
        active: this.now() < activeUntil, activeUntil, media };
    });
  }
}
