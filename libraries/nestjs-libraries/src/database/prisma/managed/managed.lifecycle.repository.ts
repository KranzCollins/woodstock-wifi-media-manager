import { Injectable } from '@nestjs/common';
import { Prisma, State } from '@prisma/client';
import { PrismaTransaction } from '../prisma.service';
import { ManagedReader, PrismaManagedStore } from './managed.repository';
import { rowFingerprint } from './managed.service';
import { runAsManagedWriter } from './managed.write.fence';
import { ManagedPublishCredential } from './managed.publish.provider';

// Internal, organization-scoped persistence. This is not a policy/service
// interface and is never returned by a controller. Network IO must finish
// before entering mutate; the service rechecks its pinned inputs here.
type ScopedCreate<T> = Omit<T, 'organizationId'>;
type PostUpdate = Pick<Prisma.ManagedPostLifecycleUpdateManyMutationInput,
  'lifecycle' | 'scheduleGeneration' | 'activeScheduleId' | 'lastLifecycleSequence' |
  'lastOperationKey' | 'deletedAt' | 'deletedOperationKey' | 'deletedSequence' | 'deletedFromLifecycle'>;
type ScheduleUpdate = Pick<Prisma.ManagedScheduleUpdateManyMutationInput,
  'status' | 'lastOccurrence' | 'endRequestedOperationKey' | 'endRequestedAt' |
  'endedAt' | 'endedCode' | 'endedOperationKey'>;
type DispatchUpdate = Pick<Prisma.ManagedDispatchUpdateManyMutationInput,
  'status' | 'code' | 'members' | 'resolution' | 'cancelledByOperationKey' |
  'leaseHolder' | 'leaseExpiresAt' | 'fencingToken' | 'activeCallId' | 'nextActionAt' |
  'nextStep' | 'nextMember' | 'deferralCode' | 'deferralCount' | 'firstDeferredAt' |
  'lastDeferredAt' | 'admittedAt' | 'settledAt' | 'lastLifecycleSequence'>;
type CallUpdate = Pick<Prisma.ManagedDispatchCallUpdateManyMutationInput,
  'status' | 'code' | 'leaseExpiresAt' | 'consumedUnits' | 'sentLedger' |
  'pendingEnvelope' | 'pollCount' | 'pollReservedUnits' | 'nextPollAt' |
  'pollDeadlineAt' | 'lastPolledAt' | 'result' | 'settledAt'>;

export class ManagedLifecycleStore {
  // A read-only view of legacy rows in the SAME transaction snapshot. It
  // cannot allocate a legacy sequence or alter immutable revisions.
  readonly draft: ManagedReader;
  #sequence: number | null;
  #initialSequence: number | null;

  constructor(
    private readonly db: Prisma.TransactionClient,
    private readonly organizationId: string,
    private readonly writable: boolean,
    sequence: number | null = null
  ) {
    this.draft = new PrismaManagedStore(db, organizationId, null);
    this.#sequence = sequence;
    this.#initialSequence = sequence;
  }

  private requireWrite() {
    if (!this.writable) throw new Error('Lifecycle reader cannot mutate');
  }

  async headSequence(): Promise<number> {
    if (this.#sequence !== null) return this.#sequence;
    return (await this.db.managedLifecycleOrganization.findUnique({
      where: { organizationId: this.organizationId }, select: { sequence: true },
    }))?.sequence ?? 0;
  }

  getPost(managedPostId: string) {
    return this.db.managedPostLifecycle.findFirst({ where: { organizationId: this.organizationId, managedPostId } });
  }
  getSchedule(id: string) {
    return this.db.managedSchedule.findFirst({ where: { organizationId: this.organizationId, id } });
  }
  getLatestSchedule(managedPostId: string) {
    return this.db.managedSchedule.findFirst({
      where: { organizationId: this.organizationId, managedPostId },
      orderBy: { scheduleGeneration: 'desc' },
    });
  }
  countSchedules(managedPostId: string) {
    return this.db.managedSchedule.count({ where: { organizationId: this.organizationId, managedPostId } });
  }
  getDispatch(id: string) {
    return this.db.managedDispatch.findFirst({ where: { organizationId: this.organizationId, id } });
  }
  getOccurrence(scheduleId: string, occurrence: number) {
    return this.db.managedDispatch.findFirst({ where: { organizationId: this.organizationId, scheduleId, occurrence } });
  }
  getCall(id: string) {
    return this.db.managedDispatchCall.findFirst({ where: { organizationId: this.organizationId, id } });
  }
  listCalls(dispatchId: string) {
    return this.db.managedDispatchCall.findMany({
      where: { organizationId: this.organizationId, dispatchId },
      orderBy: [{ member: 'asc' }, { admittedAt: 'asc' }, { id: 'asc' }],
    });
  }
  listDispatches(managedPostId: string, scheduleId?: string) {
    return this.db.managedDispatch.findMany({
      where: { organizationId: this.organizationId, managedPostId, ...(scheduleId ? { scheduleId } : {}) },
      orderBy: [{ scheduleGeneration: 'asc' }, { occurrence: 'asc' }],
    });
  }
  liveSchedules(after: string | null = null) {
    return this.db.managedSchedule.findMany({ where: { organizationId: this.organizationId,
      status: { in: ['ACTIVE', 'ENDING'] }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 20 });
  }
  // Private dispatcher-only credential. Never used by the public reader or DTOs.
  async publicationCredential(integrationId: string, providerIdentifier: string, until: Date) {
    const integration = await this.db.integration.findFirst({ where: { organizationId: this.organizationId,
      id: integrationId, providerIdentifier, deletedAt: null, disabled: false, refreshNeeded: false, inBetweenSteps: false,
      OR: [{ tokenExpiration: null }, { tokenExpiration: { gt: until } }] }, select: { token: true } });
    return integration?.token ? new ManagedPublishCredential(integration.token) : null;
  }
  // Deferral changes retry metadata only, not the confirmed cancellation scope.
  // Its current value is available from the dispatch read; no lifecycle transition is fabricated.
  async deferDispatch(id: string, expectedVersion: number, data: {
    nextActionAt: Date; deferralCode: string; deferralCount: number; firstDeferredAt: Date; lastDeferredAt: Date;
  }) {
    this.requireWrite();
    return (await this.db.managedDispatch.updateMany({ where: { organizationId: this.organizationId, id, version: expectedVersion }, data })).count === 1;
  }
  getOperation(operationKey: string) {
    return this.db.managedLifecycleOperation.findFirst({ where: { organizationId: this.organizationId, operationKey } });
  }
  // the lifecycle writes that created or ended a schedule, in feed order
  listScheduleOperations(scheduleId: string) {
    return this.db.managedLifecycleOperation.findMany({
      where: { organizationId: this.organizationId, scheduleId },
      orderBy: { sequence: 'asc' },
    });
  }
  getClaim(operationKey: string) {
    return this.db.managedOperation.findFirst({
      where: { organizationId: this.organizationId, operationKey },
      select: { operationKey: true, kind: true, payloadHash: true, managedPostId: true, revision: true, credentialId: true, sequence: true },
    });
  }
  listEvents(after: number, limit: number) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
      throw new Error('Invalid lifecycle feed bound');
    }
    return this.db.managedLifecycleChangeEvent.findMany({
      where: { organizationId: this.organizationId, sequence: { gt: after } },
      orderBy: { sequence: 'asc' }, take: limit,
    });
  }
  dueDispatches(now: Date, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid dispatch bound');
    return this.db.managedDispatch.findMany({
      where: { organizationId: this.organizationId, status: { in: ['PENDING', 'ADMITTED'] }, nextActionAt: { lte: now } },
      orderBy: [{ nextActionAt: 'asc' }, { id: 'asc' }], take: limit,
    });
  }

  async createPost(data: ScopedCreate<Prisma.ManagedPostLifecycleUncheckedCreateInput>) {
    this.requireWrite();
    await this.requireManagedPost(data.managedPostId);
    return this.db.managedPostLifecycle.create({ data: { ...data, organizationId: this.organizationId } });
  }
  async createSchedule(data: ScopedCreate<Prisma.ManagedScheduleUncheckedCreateInput>) {
    this.requireWrite();
    await this.requireManagedPost(data.managedPostId);
    return this.db.managedSchedule.create({ data: { ...data, organizationId: this.organizationId } });
  }
  async createDispatch(data: ScopedCreate<Prisma.ManagedDispatchUncheckedCreateInput>) {
    this.requireWrite();
    const schedule = await this.getSchedule(data.scheduleId);
    if (!schedule || schedule.managedPostId !== data.managedPostId ||
        schedule.scheduleGeneration !== data.scheduleGeneration || schedule.revision !== data.revision ||
        schedule.bindingGeneration !== data.bindingGeneration || schedule.releaseHash !== data.releaseHash ||
        schedule.contentSha256 !== data.contentSha256) throw new Error('Lifecycle dispatch scope mismatch');
    return this.db.managedDispatch.create({ data: { ...data, organizationId: this.organizationId } });
  }
  async createCall(data: ScopedCreate<Prisma.ManagedDispatchCallUncheckedCreateInput>) {
    this.requireWrite();
    const dispatch = await this.getDispatch(data.dispatchId);
    if (!dispatch || dispatch.managedPostId !== data.managedPostId || dispatch.version !== data.dispatchVersion ||
        dispatch.fencingToken !== data.fencingToken || dispatch.leaseHolder !== data.holder) {
      throw new Error('Lifecycle call scope mismatch');
    }
    return this.db.managedDispatchCall.create({ data: { ...data, organizationId: this.organizationId } });
  }
  async updatePost(managedPostId: string, expectedVersion: number, data: PostUpdate) {
    this.requireWrite();
    return (await this.db.managedPostLifecycle.updateMany({
      where: { organizationId: this.organizationId, managedPostId, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    })).count === 1;
  }
  async updateSchedule(id: string, expectedVersion: number, data: ScheduleUpdate) {
    this.requireWrite();
    return (await this.db.managedSchedule.updateMany({
      where: { organizationId: this.organizationId, id, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    })).count === 1;
  }
  async transitionDispatch(id: string, expectedVersion: number, data: DispatchUpdate) {
    this.requireWrite();
    return (await this.db.managedDispatch.updateMany({
      where: { organizationId: this.organizationId, id, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    })).count === 1;
  }
  // The feed position of the event that follows a dispatch transition the
  // journal already made. Not a transition: the version, fence and lease stay
  // exactly as the journal's handle holds them. Only the event just appended
  async markDispatchSequence(id: string, expectedVersion: number, sequence: number) {
    this.requireWrite();
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence !== this.#sequence) {
      throw new Error('Invalid lifecycle dispatch sequence');
    }
    return (await this.db.managedDispatch.updateMany({
      where: { organizationId: this.organizationId, id, version: expectedVersion },
      data: { lastLifecycleSequence: sequence },
    })).count === 1;
  }
  // Lease renewal/claim is not a dispatch transition. The service validates
  // expiry, status and owner under the organization lock before this CAS.
  // nextActionAt moves with a poll lease: the dispatcher looks again once the
  // lease lapsed or the next poll is due
  async leaseDispatch(id: string, expectedVersion: number, expectedFence: number,
    data: Pick<DispatchUpdate, 'leaseHolder' | 'leaseExpiresAt' | 'fencingToken' | 'nextActionAt'>) {
    this.requireWrite();
    return (await this.db.managedDispatch.updateMany({
      where: { organizationId: this.organizationId, id, version: expectedVersion, fencingToken: expectedFence }, data,
    })).count === 1;
  }
  async updateCall(id: string, expectedStatus: string, holder: string, dispatchVersion: number, fencingToken: number, data: CallUpdate) {
    this.requireWrite();
    return (await this.db.managedDispatchCall.updateMany({
      where: { organizationId: this.organizationId, id, status: expectedStatus, holder, dispatchVersion, fencingToken }, data,
    })).count === 1;
  }
  // The only Post-row write of the lifecycle: the live member rows of the
  // post's group move from known states to one state and/or due time, or are
  // retired with a retained deletedAt, and the new fingerprint is recorded so
  // the change is not foreign drift. Content, delay, media, settings and
  // links are never written, and no row is removed; the revision, its
  // snapshot and the DRAFT feed position stay. Refuses unless the rows are
  // exactly the ones `expectedFingerprint` recorded
  async transitionPostRows(managedPostId: string, expectedFingerprint: string,
    change: { from: readonly State[]; to?: State; publishDate?: Date; deletedAt?: Date }) {
    this.requireWrite();
    const data = {
      ...(change.to ? { state: change.to } : {}),
      ...(change.publishDate ? { publishDate: change.publishDate } : {}),
      ...(change.deletedAt ? { deletedAt: change.deletedAt } : {}),
    };
    if (!Object.keys(data).length) throw new Error('Lifecycle post row change is empty');
    const managed = await this.draft.getManagedPost(managedPostId);
    const rows = managed ? await this.draft.getPostRows([managed.group]) : [];
    const live = rows.filter(row => !row.deletedAt);
    if (!managed || managed.rowFingerprint !== expectedFingerprint || rowFingerprint(rows) !== expectedFingerprint ||
        !live.length || live.some(row => !(change.from as readonly string[]).includes(row.state))) {
      throw new Error('Lifecycle post rows are not the expected rows');
    }
    const moved = await this.db.post.updateMany({
      where: { organizationId: this.organizationId, group: managed.group, id: { in: live.map(row => row.id) },
        deletedAt: null, state: { in: [...change.from] } },
      data,
    });
    const next = rowFingerprint(await this.draft.getPostRows([managed.group]));
    if (moved.count !== live.length || (await this.db.managedPost.updateMany({
      where: { organizationId: this.organizationId, id: managedPostId, rowFingerprint: expectedFingerprint },
      data: { rowFingerprint: next },
    })).count !== 1) throw new Error('Lifecycle post rows changed during the transition');
    return next;
  }
  async revokeCall(callId: string, at: Date, reason: string) {
    this.requireWrite();
    return (await this.db.managedMediaCapability.updateMany({
      where: { organizationId: this.organizationId, callId, revokedAt: null },
      data: { revokedAt: at, revokeReason: reason },
    })).count;
  }
  async appendEvent(data: Omit<Prisma.ManagedLifecycleChangeEventUncheckedCreateInput, 'organizationId' | 'sequence'>) {
    this.requireWrite();
    if (this.#sequence === null) throw new Error('Lifecycle write counter is unavailable');
    const sequence = ++this.#sequence;
    await this.db.managedLifecycleChangeEvent.create({ data: { ...data, organizationId: this.organizationId, sequence } });
    return sequence;
  }
  async createOperation(data: ScopedCreate<Prisma.ManagedLifecycleOperationUncheckedCreateInput>) {
    this.requireWrite();
    await this.requireManagedPost(data.managedPostId);
    if (!['SCHEDULE', 'PUBLISH_NOW', 'CANCEL', 'DELETE', 'RESOLVE'].includes(data.kind) ||
        !Number.isSafeInteger(data.sequence) || data.sequence < 1 || data.sequence !== this.#sequence) {
      throw new Error('Invalid lifecycle operation claim');
    }
    // These two immutable records MUST commit together. The shared claim
    // deliberately has no position in the legacy feed.
    await this.db.managedOperation.create({ data: {
      organizationId: this.organizationId, operationKey: data.operationKey,
      kind: data.kind, payloadHash: data.payloadHash, managedPostId: data.managedPostId,
      revision: data.revision, credentialId: data.credentialId, sequence: 0,
    } });
    return this.db.managedLifecycleOperation.create({ data: { ...data, organizationId: this.organizationId } });
  }

  private async requireManagedPost(managedPostId: string) {
    if (!await this.draft.getManagedPost(managedPostId)) throw new Error('Lifecycle managed post is not in scope');
  }

  async flush() {
    this.requireWrite();
    if (this.#sequence === this.#initialSequence) return;
    await this.db.managedLifecycleOrganization.upsert({
      where: { organizationId: this.organizationId },
      create: { organizationId: this.organizationId, sequence: this.#sequence! },
      update: { sequence: this.#sequence! }, select: { id: true },
    });
  }
}

@Injectable()
export class ManagedLifecycleRepository {
  constructor(private readonly transaction: PrismaTransaction) {}

  read<T>(organizationId: string, read: (store: ManagedLifecycleStore) => Promise<T>) {
    return this.transaction.model.$transaction(
      (db) => read(new ManagedLifecycleStore(db, organizationId, false)),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }

  mutate<T>(organizationId: string, mutate: (store: ManagedLifecycleStore) => Promise<T>) {
    return runAsManagedWriter(organizationId, () => this.transaction.model.$transaction(async (db) => {
      // No lazy legacy organization creation: lifecycle only follows a
      // retained managed draft. Missing organization refuses atomically.
      await db.managedOrganization.update({
        where: { organizationId }, data: { updatedAt: new Date() }, select: { sequence: true },
      });
      const current = await db.managedLifecycleOrganization.findUnique({
        where: { organizationId }, select: { sequence: true },
      });
      const store = new ManagedLifecycleStore(db, organizationId, true, current?.sequence ?? 0);
      const result = await mutate(store);
      await store.flush();
      return result;
    }, { maxWait: 10000, timeout: 20000 }));
  }
}
