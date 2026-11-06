import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { ManagedLifecycleRepository } from './managed.lifecycle.repository';
import { ManagedLifecycleService } from './managed.lifecycle.service';
import { ManagedLifecycleDispatchAuthority, managedDispatchStepDueAt } from './managed.lifecycle.dispatch-authority';
import { ManagedDispatchJournal } from './managed.lifecycle.dispatch-journal';
import { ManagedMediaCapabilityService, ManagedMediaPin } from './managed.lifecycle.media-capability';
import { ManagedPublishAdapter, ManagedPublishOutcome, ManagedPublishStep } from './managed.publish.provider';
import { ManagedPublishTransport } from './managed.publish.transport';
import type { ManagedRequestBudget } from './managed.request.budget';
import type { ManagedLifecycleOperatorConfig } from './managed.lifecycle.configuration';
import { lifecycleAdmissionTimeRefusal } from './managed.lifecycle.contracts';
import type { ManagedReleaseObservedMedia } from './managed.lifecycle.release';

export interface ManagedLifecycleDispatcherPorts {
  repository: ManagedLifecycleRepository;
  service: ManagedLifecycleService;
  authority: ManagedLifecycleDispatchAuthority;
  media: ManagedMediaCapabilityService;
  budget: ManagedRequestBudget;
  adapters: ReadonlyMap<string, ManagedPublishAdapter>;
  configuration(): ManagedLifecycleOperatorConfig | null;
  now(): Date;
  fetch: typeof globalThis.fetch;
}

// One bounded step per due dispatch. All network mutations go through the
// durable journal and metered transport. Restart reads these same rows;
// this class keeps no publication queue and never refreshes a credential.
export class ManagedLifecycleDispatcher implements OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running: Promise<void> | null = null;
  private readonly reportedAt = new Map<string, number>();
  private failure(code: string): void {
    const now = Date.now();
    if (now - (this.reportedAt.get(code) ?? 0) < 60000) return;
    this.reportedAt.set(code, now);
    Logger.warn(code, 'ManagedLifecycleDispatcher');
  }
  private readonly scheduleCursors = new Map<string, string>();
  constructor(private readonly ports: ManagedLifecycleDispatcherPorts) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const next = async () => {
      if (this.stopped) return;
      await this.runOnce();
      if (!this.stopped) { this.timer = setTimeout(next, 1000); this.timer.unref(); }
    };
    void next();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.tick().finally(() => { this.running = null; });
    return this.running;
  }
  private async tick(): Promise<void> {
    const config = this.ports.configuration();
    if (!config?.dispatcherEnabled) return;
    for (const organizationId of config.organizations) {
      try {
        const rows = await this.ports.repository.read(organizationId, store => store.dueDispatches(this.ports.now()));
        for (const row of rows) {
          try { await this.step(organizationId, row.id, config); }
          catch { this.failure('DISPATCH_STEP_UNAVAILABLE'); }
        }
        // Rotate a bounded page so an older long series cannot starve newer ones.
        const schedules = await this.ports.repository.read(organizationId,
          store => store.liveSchedules(this.scheduleCursors.get(organizationId) ?? null));
        if (schedules.length < 20) this.scheduleCursors.delete(organizationId);
        else this.scheduleCursors.set(organizationId, schedules[schedules.length - 1].id);
        for (const schedule of schedules) {
          try {
            const context = await this.context(organizationId, null);
            await context.journal.materializeNext(organizationId, schedule.id);
          } catch { this.failure('MATERIALIZER_UNAVAILABLE'); }
        }
      } catch { this.failure('DISPATCH_STORE_UNAVAILABLE'); }
    }
  }

  private async context(organizationId: string, dispatchId: string | null) {
    let observed: ManagedReleaseObservedMedia = new Map();
    const refresh = async () => { if (dispatchId) observed = await this.ports.authority.observe(organizationId, dispatchId); };
    const journal = new ManagedDispatchJournal({ repository: this.ports.repository, budget: this.ports.budget,
      now: this.ports.now,
      validate: (store, dispatch, admission, deadline) => this.ports.authority.validate(store, dispatch, admission, deadline, observed),
      validatePoll: async (store, dispatch, call, deadline) => {
        if (!this.ports.configuration()?.dispatcherEnabled) throw new Error('Runtime unavailable');
        const valid = await this.ports.authority.validatePoll(store, dispatch, call, deadline, observed);
        if (!this.ports.configuration()?.dispatcherEnabled) throw new Error('Runtime unavailable');
        return valid;
      },
      event: (store, kind, dispatch) => this.ports.service.recordDispatchEvent(store, kind, dispatch),
    });
    return { journal, refresh, observed: () => observed };
  }

  private async step(organizationId: string, dispatchId: string, config: ManagedLifecycleOperatorConfig): Promise<void> {
    const context = await this.context(organizationId, dispatchId), { journal } = context;
    if (await journal.recoverExpired(organizationId, dispatchId)) return;
    if (await journal.expirePending(organizationId, dispatchId)) return;
    await context.refresh();
    const snapshot = await this.ports.repository.read(organizationId, async store => {
      const dispatch = await store.getDispatch(dispatchId);
      if (!dispatch || !['PENDING', 'ADMITTED'].includes(dispatch.status) || !dispatch.nextActionAt ||
          dispatch.nextActionAt > this.ports.now() || (dispatch.leaseExpiresAt && dispatch.leaseExpiresAt > this.ports.now())) return null;
      const calls = await store.listCalls(dispatchId);
      const active = dispatch.activeCallId ? calls.find(call => call.id === dispatch.activeCallId) : null;
      const schedule = await store.getSchedule(dispatch.scheduleId);
      const current = await this.ports.authority.currentRelease(store, dispatch, context.observed());
      return { dispatch, calls, active, schedule, current };
    });
    if (!snapshot) return;
    const { dispatch, calls, active, schedule, current } = snapshot;
    if (active?.status === 'DISPATCHING') return; // It is never replayed, even if the original sender disappeared.
    if (!current) {
      if (!this.ports.configuration()?.dispatcherEnabled) return;
      if (active?.status === 'PENDING_PROVIDER') await journal.haltPending(organizationId, dispatch.id, dispatch.version);
      else await journal.refuseBeforeCall(organizationId, dispatch.id, dispatch.version,
        schedule && this.ports.now() >= schedule.policyExpiresAt ? 'WINDOW_CLOSED' : 'LIFECYCLE_GATE_CLOSED');
      return;
    }
    const adapter = this.ports.adapters.get(current.release.providerIdentifier);
    if (!adapter) { await journal.refuseBeforeCall(organizationId, dispatch.id, dispatch.version, 'PROVIDER_NOT_QUALIFIED'); return; }
    const prepared = adapter.prepare({ internalId: current.release.internalId, profile: current.release.profile!,
      settings: { ...current.release.settings }, members: current.release.members.map(member => ({
        postId: member.postId, text: member.text, media: [...member.media],
      })) });
    const polling = active?.status === 'PENDING_PROVIDER';
    const step: ManagedPublishStep = polling ? 'POLL' : dispatch.status === 'PENDING' ? 'POST' : dispatch.nextStep as ManagedPublishStep;
    const member = dispatch.status === 'PENDING' ? 0 : polling ? active.member : dispatch.nextMember;
    if (!['POST', 'POLL', 'FINALIZE', 'COMMENT'].includes(step) || member === null) return;
    const previous = calls.filter(call => call.member === member && call.pendingEnvelope)
      .sort((a, b) => b.stage - a.stage || b.admittedAt.getTime() - a.admittedAt.getTime())[0];
    const continuation = polling ? active.pendingEnvelope : previous?.pendingEnvelope;
    if ((step === 'POLL' || step === 'FINALIZE') && !continuation) return;
    if (!polling) {
      const due = managedDispatchStepDueAt(dispatch, step, member, calls, current.release);
      if (!due) { await journal.refuseBeforeCall(organizationId, dispatch.id, dispatch.version, 'LIFECYCLE_GATE_CLOSED'); return; }
      const refusal = lifecycleAdmissionTimeRefusal({ dueAt: due.toISOString(), maxLatenessMs: current.schedule.maxLatenessMs,
        windowEndsAt: current.until.toISOString() },
        { grantedAt: current.schedule.policyGrantedAt, expiresAt: current.schedule.policyExpiresAt }, this.ports.now());
      if (refusal && refusal !== 'NOT_DUE') {
        await journal.refuseBeforeCall(organizationId, dispatch.id, dispatch.version,
          refusal === 'LATE_BEYOND_TOLERANCE' ? refusal : 'WINDOW_CLOSED');
        return;
      }
    }
    const units = adapter.stepUnits(prepared, step, continuation ?? undefined);
    const deadlineAt = new Date(Math.min(this.ports.now().getTime() + adapter.steps[step].deadlineMs,
      current.until.getTime(), polling ? active.pollDeadlineAt!.getTime() : Infinity));
    const credential = await this.ports.repository.read(organizationId, store =>
      store.publicationCredential(current.schedule.integrationId, adapter.identifier, deadlineAt));
    if (!credential || (!polling && current.until.getTime() - this.ports.now().getTime() < adapter.steps[step].deadlineMs)) {
      if (polling) await journal.haltPending(organizationId, dispatch.id, dispatch.version);
      else await journal.refuseBeforeCall(organizationId, dispatch.id, dispatch.version, credential ? 'WINDOW_CLOSED' : 'CHANNEL_UNAVAILABLE');
      return;
    }

    if (polling) {
      const result = await journal.claimPoll(organizationId, { dispatchId, reservedUnits: units, deadlineMs: adapter.steps.POLL.deadlineMs });
      if (result.status === 'BUDGET_REFUSED') { await journal.defer(organizationId, dispatchId, dispatch.version, result.reservation); return; }
      if (result.status !== 'CLAIMED') return;
      const { handle } = result;
      const transport = new ManagedPublishTransport({ reservedUnits: units, deadlineAt: new Date(handle.deadlineAt), now: this.ports.now,
        verifyAdmission: async deadline => { await context.refresh(); return journal.verifyPoll(handle, deadline); },
        recordAttempt: (ordinal, mutation) => journal.recordPollAttempt(handle, ordinal, mutation), fetch: this.ports.fetch });
      let outcome: ManagedPublishOutcome;
      try { outcome = await adapter.poll(prepared, continuation!, { credential, fetch: transport.adapterFetch(), ledger: () => transport.ledger() }); }
      catch { outcome = { status: 'poll_failed' }; }
      await journal.settlePoll(handle, outcome, transport);
      return;
    }

    const stage: 0 | 1 = step === 'FINALIZE' && previous?.step === 'FINALIZE' && previous.stage === 0 && previous.status === 'OK' ? 1 : 0;
    const previousAttempt = calls.find(call => call.member === member && call.step === step && call.stage === stage && call.status === 'NOT_SENT');
    const attempt = previousAttempt ? 2 : 1;
    const result = await journal.admit(organizationId, { dispatchId, expectedVersion: dispatch.version, member,
      step: step as 'POST' | 'COMMENT' | 'FINALIZE', stage, attempt, reservedUnits: units,
      deadlineMs: adapter.steps[step].deadlineMs, requestHash: prepared.requestHash });
    if (result.status === 'BUDGET_REFUSED') { await journal.defer(organizationId, dispatchId, dispatch.version, result.reservation); return; }
    if (result.status !== 'ADMITTED') {
      // A still-owned overdue step is terminal; a competing transition wins its CAS.
      if (this.ports.now() > dispatch.admissibleUntil && dispatch.status === 'PENDING')
        await journal.refuseBeforeCall(organizationId, dispatchId, dispatch.version, 'LATE_BEYOND_TOLERANCE');
      return;
    }
    const { handle } = result;
    const transport = new ManagedPublishTransport({ reservedUnits: units, deadlineAt: new Date(handle.deadlineAt), now: this.ports.now,
      verifyAdmission: async deadline => { await context.refresh(); return journal.verifyAdmission(handle, deadline); },
      recordAttempt: (ordinal, mutation) => journal.recordAttempt(handle, ordinal, mutation), fetch: this.ports.fetch });
    const call = { credential, fetch: transport.adapterFetch(), ledger: () => transport.ledger() };
    const urls = new Map<string, string>();
    const media = { url: async (pin: ManagedMediaPin) => {
      const key = `${pin.mediaId}:${pin.evidenceId}`;
      const old = urls.get(key); if (old) return old;
      const grant = await this.ports.media.mint({ organizationId, dispatchId, callId: handle.callId,
        dispatchVersion: handle.dispatchVersion, media: pin,
        policy: { grantedAt: current.schedule.policyGrantedAt, expiresAt: current.until },
        ttlMs: Math.min(15 * 60 * 1000, current.until.getTime() - this.ports.now().getTime()), maxFetches: 8 });
      const extension = pin.mimeType === 'image/jpeg' ? 'jpg' : pin.mimeType === 'image/png' ? 'png' : 'mp4';
      const url = `${config.mediaOrigin}/managed-media/${grant.token()}.${extension}`;
      urls.set(key, url); return url;
    } };
    let outcome: ManagedPublishOutcome;
    try {
      if (step === 'POST') outcome = await adapter.postPending(prepared, { ...call, media });
      else if (step === 'FINALIZE') outcome = await adapter.finalize(prepared, continuation!, call);
      else {
        const parent = JSON.parse(dispatch.members)[0]?.release?.releaseId;
        if (typeof parent !== 'string') throw new Error('Missing parent release');
        outcome = await adapter.comment(prepared, member, parent, call);
      }
    } catch {
      outcome = transport.ledger().mutationMayHaveLeft ? { status: 'unknown', code: 'OUTCOME_UNKNOWN' }
        : { status: 'not_sent', code: 'REQUEST_NOT_SENT' };
    }
    // Retry only the fenced DB settlement, never the provider request. A lost
    // commit acknowledgement becomes a stale settlement, not another send.
    for (let tries = 1; ; tries++) {
      try { await journal.settle(handle, outcome, transport); return; }
      catch (error) { if (tries >= 3 || this.ports.now().getTime() >= handle.deadlineAt) throw error; }
    }
  }
}
