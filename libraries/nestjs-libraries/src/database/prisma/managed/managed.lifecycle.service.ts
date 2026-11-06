import type {
  ManagedDispatch,
  ManagedDispatchCall,
  ManagedPostLifecycle,
  ManagedSchedule,
  State,
} from '@prisma/client';
import { MANAGED_OPERATION_KEY } from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';
import type { ManagedPostRow } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import {
  fingerprint,
  rowFingerprint,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import {
  ManagedLifecycleRepository,
  ManagedLifecycleStore,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.repository';
import type { ManagedJournalEventKind } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.dispatch-journal';
import {
  managedDispatchView,
  managedLifecycleEventsPage,
  managedLifecycleOperationView,
  ManagedLifecycleProjectionError,
  managedLifecycleStoredResult,
  managedPostLifecycleView,
  managedScheduleView,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.views';
import {
  buildManagedRelease,
  managedReleaseMediaIds,
  ManagedPreparedRelease,
  ManagedReleaseObservedMedia,
  observeManagedReleaseMedia,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.release';
import type { ManagedMediaPinnedStorage } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-capability';
import {
  ManagedPublishAdapter,
  ManagedPublishPrepareError,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.provider';
import {
  lifecycleAdmissionRowState,
  lifecycleAffectedHashInput,
  lifecycleCancelScope,
  lifecycleKindMismatchException,
  lifecycleOccurrenceDueAts,
  lifecyclePayloadInput,
  lifecyclePolicyRefusal,
  lifecycleResolvedMemberStatus,
  lifecycleResolveTimeRefusal,
  lifecycleScheduleTimeRefusal,
  lifecycleTimeException,
  lifecycleWhileScheduled,
  MANAGED_CANCEL_SERIES,
  MANAGED_LIFECYCLE_GATES_CLOSED,
  MANAGED_LIFECYCLE_KINDS,
  MANAGED_LIFECYCLE_LIMITS,
  MANAGED_LIFECYCLE_MAX_EXPIRY,
  MANAGED_LIFECYCLE_UUID,
  MANAGED_LIFECYCLE_VERSION,
  MANAGED_RELEASE_HASH_VERSION,
  ManagedAffectedOccurrence,
  managedLifecycleCapabilities,
  ManagedCancelScope,
  ManagedDispatchStatus,
  ManagedDispatchView,
  ManagedInFlightOccurrence,
  ManagedLifecycleCode,
  ManagedLifecycleEventKind,
  ManagedLifecycleException,
  ManagedLifecycleGates,
  managedLifecycleIssues,
  ManagedLifecycleKind,
  ManagedLifecyclePolicy,
  ManagedLifecycleProviderFacts,
  ManagedLifecycleRequestOf,
  ManagedLifecycleResult,
  ManagedPublishNowRequest,
  ManagedResolution,
  ManagedResolveRequest,
  ManagedScheduleRequest,
  parseManagedLifecycleRequest,
  parseManagedLifecycleResponse,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';

// The owned lifecycle service, ww.managed-lifecycle.v1
// (lifecycle-root-decisions-20261105.md as amended by
// lifecycle-architecture-corrections-20261105.md). The reads (capabilities,
// release preview, lifecycle, dispatch, operation lookup, event feed), the
// acceptance of SCHEDULE and PUBLISH_NOW, the ending writes CANCEL, DELETE
// and RESOLVE, and the event port of the dispatch journal.
//
// An accepted schedule is a durable record only: a schedule, its first
// PENDING occurrence, the Post rows moved to QUEUE under a recorded
// fingerprint, one lifecycle event and the stored answer. Nothing here calls
// a provider, mints a media capability, reserves budget or admits a dispatch;
// the dispatcher does that later, rechecking everything at admission. An
// acceptance is never evidence of publication. A cancel, delete or resolution
// sends nothing either: it records what W&W's confirmed human decided, bound
// to the exact versions that human saw.
//
// Nothing is composed or mounted yet: the runtime builds this class with the
// actual repository, pinned storage, operator configuration, clock and adapter
// map, and the controller hands it the authenticated credential.

// The authenticated caller, bound by the runtime: the organization and
// credential the token matched and the scopes that credential holds
export interface ManagedLifecyclePrincipal {
  organizationId: string;
  credentialId: string;
  scopes: readonly string[];
}

// What the operator configured for an organization. The adapters' own facts
// decide what each enabled provider can do; the configuration only names them
export interface ManagedLifecycleConfiguredGates {
  organizationEnabled: boolean;
  dispatcherAvailable: boolean;
  mediaDeliveryReady: boolean;
  policy: ManagedLifecyclePolicy | null;
  providers: readonly string[];
}

// null: nothing is configured, every gate is closed
export interface ManagedLifecycleConfiguration {
  gates(organizationId: string): Promise<ManagedLifecycleConfiguredGates | null>;
}

export interface ManagedLifecycleClock {
  now(): Date;
}

// The part of a publish adapter acceptance reads: its descriptors and its
// pure prepare(), which makes no request
export type ManagedLifecycleAdapter = Pick<
  ManagedPublishAdapter,
  'identifier' | 'editor' | 'requiresMedia' | 'steps' | 'prepare' | 'maxStepUnits' | 'maxStepDeadlineMs'
>;

export type ManagedLifecycleAdapters = ReadonlyMap<string, ManagedLifecycleAdapter>;

type AcceptedKind = 'SCHEDULE' | 'PUBLISH_NOW';
type SchedulePlan = Pick<ManagedScheduleRequest, 'publishAt' | 'repeat'>;
type CancelSeries = (typeof MANAGED_CANCEL_SERIES)[number];

// the scopes of MANAGED_LIFECYCLE_ROUTES
const SCOPES: Record<ManagedLifecycleKind | 'READ', string> = {
  READ: 'posts:read',
  SCHEDULE: 'posts:schedule',
  PUBLISH_NOW: 'posts:publish',
  CANCEL: 'posts:schedule',
  DELETE: 'posts:schedule',
  RESOLVE: 'posts:publish',
};

const SCHEDULED_RELEASE_VERSION = 'ww-scheduled-release-v1';

// a lifecycle row a new schedule may follow; DISPATCHING, REVIEW and
// SCHEDULED belong to a live or unresolved schedule, DELETED to a tombstone
const SCHEDULABLE_LIFECYCLES = ['DRAFT', 'PUBLISHED', 'FAILED'];

const LIVE_SCHEDULES = ['ACTIVE', 'ENDING'];
const PUBLISHED_DISPATCHES = ['PUBLISHED', 'RESOLVED_PUBLISHED'];
// a call a provider may still be working on
const IN_FLIGHT_CALLS = ['DISPATCHING', 'PENDING_PROVIDER'];

// the dispatcher events this service records, by the dispatch status the
// journal's transition left (recovery reports a lost comment as an unknown
// outcome of a PARTIAL dispatch)
const DISPATCHER_EVENTS: Record<ManagedJournalEventKind, readonly string[]> = {
  OCCURRENCE_MATERIALIZED: ['PENDING'],
  OCCURRENCE_EXPIRED: ['EXPIRED'],
  DISPATCH_ADMITTED: ['ADMITTED'],
  DISPATCH_PROGRESSED: ['ADMITTED'],
  DISPATCH_NOT_SENT: ['NOT_SENT'],
  DISPATCH_PUBLISHED: ['PUBLISHED'],
  DISPATCH_REJECTED: ['REJECTED'],
  DISPATCH_PARTIAL: ['PARTIAL'],
  DISPATCH_OUTCOME_UNKNOWN: ['UNKNOWN', 'PARTIAL'],
};

// why lifecycleCancelScope refused the scope
const SCOPE_REFUSALS: Partial<Record<ManagedLifecycleCode, string>> = {
  DISPATCH_IN_PROGRESS: 'An affected occurrence is admitted',
  DISPATCH_UNRESOLVED: 'An affected occurrence must be resolved first',
  CANCEL_SCOPE_MISMATCH: 'The scope does not match the schedule as stored',
  LIFECYCLE_STATE_CONFLICT: 'The schedule has nothing left to cancel',
};

const memberPostIds = (dispatch: ManagedDispatch): string[] =>
  (JSON.parse(dispatch.members) as { postId: string }[]).map((member) => member.postId);

// A member once the human's outcome is recorded; a member without one stays
// exactly as it was
function resolvedMember(
  member: ManagedDispatchView['members'][number],
  confirmed: ManagedResolveRequest['members'][number]
) {
  if (!confirmed.outcome) {
    return member;
  }
  const status = lifecycleResolvedMemberStatus(confirmed);
  return {
    position: member.position,
    postId: member.postId,
    status,
    code: null,
    release:
      status === 'PUBLISHED'
        ? {
            releaseId: confirmed.releaseId,
            releaseURL: confirmed.releaseURL,
            source: 'HUMAN_RESOLUTION',
          }
        : null,
  };
}

const refuse = (code: ManagedLifecycleCode, msg: string) =>
  new ManagedLifecycleException(code, msg);

const invalidInput = (msg: string) => refuse('LIFECYCLE_INPUT_INVALID', msg);

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && MANAGED_LIFECYCLE_UUID.test(value);

// a query value: a safe integer, or its plain decimal text
function queryInt(value: unknown, min: number): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{1,16}$/.test(value)
      ? Number(value)
      : NaN;
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : null;
}

function authorize(principal: ManagedLifecyclePrincipal, scope: string) {
  if (
    !principal ||
    typeof principal.organizationId !== 'string' ||
    !principal.organizationId ||
    typeof principal.credentialId !== 'string' ||
    !principal.credentialId ||
    !Array.isArray(principal.scopes) ||
    !principal.scopes.includes(scope)
  ) {
    throw refuse('LIFECYCLE_NOT_ENABLED', `The credential does not hold ${scope}`);
  }
}

// What an adapter declares about itself. prepare() refuses a release any of
// whose steps would need more than the shared maximum (STEP_UNITS_EXCEEDED);
// the exact units of a call are its stepUnits() at admission
function adapterFacts(adapter: ManagedLifecycleAdapter): ManagedLifecycleProviderFacts {
  return {
    identifier: adapter.identifier,
    editor: adapter.editor,
    requiresMedia: adapter.requiresMedia,
    maxStepUnits: adapter.maxStepUnits,
    maxStepDeadlineMs: adapter.maxStepDeadlineMs,
  };
}

// What a schedule fixes for its occurrences, server-private and never
// answered: the reviewed release exactly as accepted (identity, approved
// settings, decoded texts, media pins) and every anchored due time. No token,
// credential, storage key, path or URL. ManagedPost.rowFingerprint is not
// kept: the transition of the same write changes it
function scheduledRelease(release: ManagedPreparedRelease, dueAts: string[]) {
  return {
    v: SCHEDULED_RELEASE_VERSION,
    dueAts,
    managedPostId: release.managedPostId,
    revision: release.revision,
    bindingGeneration: release.bindingGeneration,
    integrationId: release.integrationId,
    providerIdentifier: release.providerIdentifier,
    identityFingerprint: release.identityFingerprint,
    codec: release.codec,
    settingsHash: release.settingsHash,
    releaseHash: release.releaseHash,
    internalId: release.internalId,
    profile: release.profile,
    settings: release.settings,
    members: release.members,
  };
}

export class ManagedLifecycleService {
  constructor(
    private readonly _repository: ManagedLifecycleRepository,
    private readonly _storage: Pick<
      ManagedMediaPinnedStorage,
      'pinnedEvidence' | 'namespace' | 'versionAt'
    >,
    private readonly _configuration: ManagedLifecycleConfiguration,
    private readonly _clock: ManagedLifecycleClock,
    private readonly _adapters: ManagedLifecycleAdapters
  ) {}

  // ---- reads ------------------------------------------------------------------

  async capabilities(principal: ManagedLifecyclePrincipal) {
    authorize(principal, SCOPES.READ);
    const { gates } = await this.gates(principal.organizationId);
    const document = parseManagedLifecycleResponse(
      'CAPABILITIES',
      managedLifecycleCapabilities(gates, this._clock.now())
    );
    if (!document) {
      throw refuse('LIFECYCLE_NOT_AVAILABLE', 'The lifecycle capabilities cannot be stated');
    }
    return document;
  }

  // Exactly what would be sent now, for W&W to compare with the hash it
  // derives from its own approved payload. Point in time: the identity is the
  // one the binding recorded at this read, never an observation of the
  // account. A provider no enabled adapter declares is answered as not
  // qualified, as is everything else the builder refuses
  async releasePreview(
    principal: ManagedLifecyclePrincipal,
    managedPostId: string,
    query: { revision: unknown; codec: unknown }
  ) {
    authorize(principal, SCOPES.READ);
    const revision = queryInt(query?.revision, 1);
    const codec = query?.codec;
    if (
      !isUuid(managedPostId) ||
      revision === null ||
      typeof codec !== 'string' ||
      codec.length > 64
    ) {
      throw invalidInput('managedPostId, revision and codec are required');
    }

    const organizationId = principal.organizationId;
    const { gates } = await this.gates(organizationId);
    const observedMedia = await this.observe(organizationId, managedPostId, revision);

    return this._repository.read(organizationId, async (store) => {
      const { preview } = await buildManagedRelease(store.draft, {
        managedPostId,
        expectedRevision: revision,
        // the strict decoder answers a codec it does not know
        codec: codec as ManagedPreparedRelease['codec'],
        provider: await this.providerFacts(store, gates, managedPostId),
        mediaDeliveryReady: gates.mediaDeliveryReady,
        observedMedia,
      });
      return preview;
    });
  }

  async lifecycle(principal: ManagedLifecyclePrincipal, managedPostId: string) {
    authorize(principal, SCOPES.READ);
    if (!isUuid(managedPostId)) {
      throw refuse('NOT_FOUND', 'Managed post not found');
    }

    return this._repository.read(principal.organizationId, async (store) => {
      const post = await store.draft.getManagedPost(managedPostId);
      if (!post) {
        throw refuse('NOT_FOUND', 'Managed post not found');
      }
      return this.projection(store, post, await store.headSequence());
    });
  }

  async dispatch(principal: ManagedLifecyclePrincipal, dispatchId: string) {
    authorize(principal, SCOPES.READ);
    if (!isUuid(dispatchId)) {
      throw refuse('NOT_FOUND', 'Dispatch not found');
    }

    return this._repository.read(principal.organizationId, async (store) => {
      const row = await store.getDispatch(dispatchId);
      if (!row) {
        throw refuse('NOT_FOUND', 'Dispatch not found');
      }
      return managedDispatchView(row, await store.listCalls(row.id));
    });
  }

  // Whether a lifecycle key committed, as of the lifecycle head. A DRAFT key
  // is a typed 409, never ABSENT and never decoded here
  async operation(principal: ManagedLifecyclePrincipal, operationKey: string) {
    authorize(principal, SCOPES.READ);
    if (typeof operationKey !== 'string' || !MANAGED_OPERATION_KEY.test(operationKey)) {
      throw invalidInput('Invalid operation key');
    }

    return this._repository.read(principal.organizationId, async (store) => {
      const asOfSequence = await store.headSequence();
      const claim = await store.getClaim(operationKey);
      if (!claim) {
        const absent = parseManagedLifecycleResponse('OPERATION', {
          version: MANAGED_LIFECYCLE_VERSION,
          operationKey,
          status: 'ABSENT',
          asOfSequence,
        });
        if (!absent) {
          throw new ManagedLifecycleProjectionError();
        }
        return absent;
      }

      if (!(MANAGED_LIFECYCLE_KINDS as readonly string[]).includes(claim.kind)) {
        throw lifecycleKindMismatchException();
      }

      const row = await this.committed(store, claim);
      return managedLifecycleOperationView(
        row,
        asOfSequence,
        await store.getPost(row.managedPostId)
      );
    });
  }

  async events(principal: ManagedLifecyclePrincipal, after: unknown) {
    authorize(principal, SCOPES.READ);
    const afterSequence = queryInt(after, 0);
    if (afterSequence === null) {
      throw invalidInput('after is not a sequence');
    }

    return this._repository.read(principal.organizationId, async (store) => {
      const headSequence = await store.headSequence();
      if (afterSequence > headSequence) {
        throw invalidInput(`after is beyond the head ${headSequence}`);
      }
      return managedLifecycleEventsPage(
        afterSequence,
        headSequence,
        await store.listEvents(afterSequence, MANAGED_LIFECYCLE_LIMITS.eventsPageMax)
      );
    });
  }

  // ---- acceptance -------------------------------------------------------------

  async schedule(
    principal: ManagedLifecyclePrincipal,
    managedPostId: string,
    raw: unknown
  ): Promise<ManagedLifecycleResult> {
    authorize(principal, SCOPES.SCHEDULE);
    const { body, payloadHash } = this.request('SCHEDULE', managedPostId, raw);
    return this.accept(principal, 'SCHEDULE', managedPostId, body, payloadHash, {
      publishAt: body.publishAt,
      repeat: body.repeat,
    });
  }

  // Due at the server's time of acceptance, never repeated, and refused
  // while the post has a live schedule: cancelling it is its own operation
  async publishNow(
    principal: ManagedLifecyclePrincipal,
    managedPostId: string,
    raw: unknown
  ): Promise<ManagedLifecycleResult> {
    authorize(principal, SCOPES.PUBLISH_NOW);
    const { body, payloadHash } = this.request('PUBLISH_NOW', managedPostId, raw);
    return this.accept(principal, 'PUBLISH_NOW', managedPostId, body, payloadHash, null);
  }

  // The route target and the strict body, with the payload hash over both
  private request<K extends ManagedLifecycleKind>(kind: K, target: string, raw: unknown) {
    if (!isUuid(target)) {
      throw refuse('NOT_FOUND', kind === 'RESOLVE' ? 'Dispatch not found' : 'Managed post not found');
    }

    const body = parseManagedLifecycleRequest(kind, raw);
    if (!body) {
      throw invalidInput(
        `The ${kind} request is not valid: ${managedLifecycleIssues(kind, raw)
          .join('; ')
          .slice(0, 300)}`
      );
    }

    return {
      body: body as ManagedLifecycleRequestOf<K>,
      payloadHash: fingerprint(
        lifecyclePayloadInput(kind, target, body as Record<string, unknown>)
      ),
    };
  }

  private async accept(
    principal: ManagedLifecyclePrincipal,
    kind: AcceptedKind,
    managedPostId: string,
    body: ManagedPublishNowRequest,
    payloadHash: string,
    plan: SchedulePlan | null
  ): Promise<ManagedLifecycleResult> {
    const organizationId = principal.organizationId;

    // outside any transaction: the operator configuration and the pinned-
    // storage observation (only evidence it agrees with is released)
    const { gates, adapters } = await this.gates(organizationId);
    const observedMedia = await this.observe(
      organizationId,
      managedPostId,
      body.expectedRevision
    );

    return this._repository.mutate(organizationId, async (store) => {
      // the key first, under the organization lock: an exact replay answers
      // what was stored whatever the gates and the time are now
      const replayed = await this.replay(
        store,
        kind,
        principal.credentialId,
        body.operationKey,
        payloadHash
      );
      if (replayed) {
        return replayed;
      }

      const now = this._clock.now();
      this.gateRefusal(gates, plan, now);

      const managed = await store.draft.getManagedPost(managedPostId);
      if (!managed) {
        throw refuse('NOT_FOUND', 'Managed post not found');
      }
      const lifecycle = await store.getPost(managedPostId);
      await this.stateRefusal(store, managed, lifecycle, body);

      // the real builder and strict decoder, in this locked transaction
      const { preview, release } = await buildManagedRelease(store.draft, {
        managedPostId,
        expectedRevision: body.expectedRevision,
        codec: body.codec,
        provider: await this.providerFacts(store, gates, managedPostId),
        mediaDeliveryReady: gates.mediaDeliveryReady,
        observedMedia,
      });

      // the hash W&W derived from its approved payload is compared, never
      // adopted; contentSha256 is W&W's own digest, stored as sent
      if (preview.releaseHash !== body.releaseHash) {
        throw refuse(
          'RELEASE_HASH_MISMATCH',
          'The approved release is not what this server would send'
        );
      }
      this.adapterRefusal(adapters.get(release.providerIdentifier), release);

      return this.commit(store, {
        kind,
        credentialId: principal.credentialId,
        body,
        payloadHash,
        plan,
        managed,
        lifecycle,
        release,
        policy: gates.policy,
        now,
      });
    });
  }

  // The stored answer of an exact replay, or null for a new key. Another
  // credential, operation or payload is refused and nothing is written
  private async replay(
    store: ManagedLifecycleStore,
    kind: ManagedLifecycleKind,
    credentialId: string,
    operationKey: string,
    payloadHash: string
  ) {
    const claim = await store.getClaim(operationKey);
    if (!claim) {
      return null;
    }

    if (!(MANAGED_LIFECYCLE_KINDS as readonly string[]).includes(claim.kind)) {
      throw lifecycleKindMismatchException();
    }
    if (claim.credentialId !== credentialId) {
      throw refuse(
        'OPERATION_KEY_CREDENTIAL_MISMATCH',
        'This operation key was committed by another credential'
      );
    }
    if (claim.kind !== kind) throw lifecycleKindMismatchException();
    if (claim.payloadHash !== payloadHash) {
      throw refuse(
        'OPERATION_KEY_PAYLOAD_MISMATCH',
        'This operation key was already used with a different payload'
      );
    }

    return managedLifecycleStoredResult(await this.committed(store, claim), true);
  }

  // the lifecycle record of a lifecycle claim; both commit together, so a
  // missing or different one is stored state that can't be answered
  private async committed(
    store: ManagedLifecycleStore,
    claim: Awaited<ReturnType<ManagedLifecycleStore['getClaim']>>
  ) {
    const row = await store.getOperation(claim.operationKey);
    if (
      !row ||
      claim.sequence !== 0 ||
      row.kind !== claim.kind ||
      row.payloadHash !== claim.payloadHash ||
      row.credentialId !== claim.credentialId ||
      row.managedPostId !== claim.managedPostId ||
      row.revision !== claim.revision
    ) {
      throw new ManagedLifecycleProjectionError();
    }
    return row;
  }

  // Every write is refused unless the organization is enabled and the
  // operator's policy is open now (at most seven days, ending by the cutoff;
  // nothing configured is closed). A cancel or delete sends nothing, so it
  // does not need the dispatcher. A resolution only needs enabledRefusal
  private gateRefusal(
    gates: ManagedLifecycleGates,
    plan: SchedulePlan | null,
    now: Date,
    sends = true
  ) {
    this.enabledRefusal(gates);
    if (sends && !gates.dispatcherAvailable) {
      throw refuse('LIFECYCLE_NOT_AVAILABLE', 'No dispatcher is available for this organization');
    }

    const refusal = plan
      ? lifecycleScheduleTimeRefusal(plan, gates.policy, now)
      : lifecyclePolicyRefusal(gates.policy, now);
    if (refusal) {
      throw lifecycleTimeException(refusal);
    }
  }

  // An organization nothing enabled (or nothing configured for) is refused.
  // Cancellation, retained deletion and human resolution send no provider IO.
  // They still require organization authority and the exclusive test-access
  // cutoff, but no open publication policy or running dispatcher
  private enabledRefusal(gates: ManagedLifecycleGates) {
    if (!gates.organizationEnabled) {
      throw refuse('LIFECYCLE_NOT_ENABLED', 'Lifecycle effects are not enabled for this organization');
    }
    const now = this._clock.now().getTime();
    if (!Number.isFinite(now) || now >= MANAGED_LIFECYCLE_MAX_EXPIRY.getTime()) {
      throw lifecycleTimeException('POLICY_EXPIRED');
    }
  }

  // the post as the request bound it, with no live schedule and no dispatch
  // in progress or unresolved
  private async stateRefusal(
    store: ManagedLifecycleStore,
    managed: ManagedPostRow,
    lifecycle: ManagedPostLifecycle | null,
    body: ManagedPublishNowRequest
  ) {
    if (managed.revision !== body.expectedRevision) {
      throw refuse('REVISION_CONFLICT', `The post is at revision ${managed.revision}`);
    }
    if (managed.bindingGeneration !== body.expectedBindingGeneration) {
      throw refuse(
        'BINDING_GENERATION_MISMATCH',
        `The post is bound at generation ${managed.bindingGeneration}`
      );
    }
    if (lifecycle?.deletedAt || lifecycle?.lifecycle === 'DELETED') {
      throw refuse('POST_DELETED', 'The post was deleted');
    }

    const generation = lifecycle?.scheduleGeneration ?? 0;
    if (generation !== body.expectedScheduleGeneration) {
      throw refuse(
        'SCHEDULE_GENERATION_CONFLICT',
        `The post is at schedule generation ${generation}`
      );
    }

    if (lifecycle?.activeScheduleId) {
      const active = await store.getSchedule(lifecycle.activeScheduleId);
      throw active && ['ACTIVE', 'ENDING'].includes(active.status)
        ? refuse('SCHEDULE_ACTIVE', 'The post has a live schedule; cancel it first')
        : refuse('LIFECYCLE_STATE_CONFLICT', 'The post lifecycle is not consistent');
    }

    const dispatches = await store.listDispatches(managed.id);
    if (dispatches.some((row) => row.status === 'PENDING' || row.status === 'ADMITTED')) {
      throw refuse('DISPATCH_IN_PROGRESS', 'An occurrence of the post is in progress');
    }
    if (dispatches.some((row) => row.status === 'UNKNOWN' || row.status === 'PARTIAL')) {
      throw refuse('DISPATCH_UNRESOLVED', 'An occurrence of the post must be resolved first');
    }
    if (lifecycle && !SCHEDULABLE_LIFECYCLES.includes(lifecycle.lifecycle)) {
      throw refuse('LIFECYCLE_STATE_CONFLICT', `The post is ${lifecycle.lifecycle}`);
    }
  }

  // The adapter checks the release exactly as it would send it; prepare()
  // makes no request. A release it would refuse is never queued
  private adapterRefusal(
    adapter: ManagedLifecycleAdapter | undefined,
    release: ManagedPreparedRelease
  ) {
    if (!adapter) {
      throw refuse(
        'PROVIDER_NOT_QUALIFIED',
        `No lifecycle adapter is enabled for ${release.providerIdentifier}`
      );
    }

    try {
      adapter.prepare({
        internalId: release.internalId,
        profile: release.profile,
        settings: release.settings as Record<string, unknown>,
        members: release.members.map((member) => ({
          postId: member.postId,
          text: member.text,
          media: [...member.media],
        })),
      });
    } catch (err) {
      if (err instanceof ManagedPublishPrepareError) {
        throw refuse(
          'POST_NOT_SCHEDULABLE',
          `The ${adapter.identifier} adapter does not send this release: ${err.reason}`
        );
      }
      throw err;
    }
  }

  // Everything one acceptance writes, in the locked transaction: the next-
  // generation schedule, its PENDING occurrence 0, the Post rows moved to
  // QUEUE, the lifecycle row, one event and the claim with its stored answer
  private async commit(
    store: ManagedLifecycleStore,
    input: {
      kind: AcceptedKind;
      credentialId: string;
      body: ManagedPublishNowRequest;
      payloadHash: string;
      plan: SchedulePlan | null;
      managed: ManagedPostRow;
      lifecycle: ManagedPostLifecycle | null;
      release: ManagedPreparedRelease;
      policy: ManagedLifecyclePolicy;
      now: Date;
    }
  ): Promise<ManagedLifecycleResult> {
    const { kind, body, plan, managed, lifecycle, release, policy, now } = input;
    const committedAt = now.toISOString();

    const anchorAt = plan ? plan.publishAt : committedAt;
    const intervalDays = plan?.repeat?.intervalDays ?? null;
    const maxOccurrences = plan?.repeat?.maxOccurrences ?? 1;
    const dueAts = lifecycleOccurrenceDueAts(anchorAt, intervalDays, maxOccurrences);
    const windowEndsAt = policy.expiresAt.getTime();
    if (!dueAts.length || Date.parse(dueAts[dueAts.length - 1]) >= windowEndsAt) {
      throw lifecycleTimeException('OCCURRENCE_AT_OR_AFTER_EXPIRY');
    }

    const dueAt = new Date(dueAts[0]);
    const scheduleGeneration = (lifecycle?.scheduleGeneration ?? 0) + 1;
    const sequence = (await store.headSequence()) + 1;

    const schedule = await store.createSchedule({
      managedPostId: managed.id,
      scheduleGeneration,
      mode: kind === 'SCHEDULE' ? 'AT' : 'NOW',
      status: 'ACTIVE',
      revision: release.revision,
      bindingGeneration: release.bindingGeneration,
      integrationId: release.integrationId,
      providerIdentifier: release.providerIdentifier,
      identityFingerprint: release.identityFingerprint,
      contentSha256: body.contentSha256,
      releaseHash: release.releaseHash,
      releaseHashVersion: MANAGED_RELEASE_HASH_VERSION,
      codec: release.codec,
      release: JSON.stringify(scheduledRelease(release, dueAts)),
      anchorAt: new Date(anchorAt),
      intervalDays,
      maxOccurrences,
      lastOccurrence: maxOccurrences - 1,
      maxLatenessMs: body.maxLatenessMs,
      policyGrantedAt: policy.grantedAt,
      policyExpiresAt: policy.expiresAt,
      operationKey: body.operationKey,
      credentialId: input.credentialId,
      createdAt: now,
    });

    const dispatch = await this.materialize(
      store,
      schedule,
      0,
      release.members.map((member) => member.postId),
      sequence,
      now
    );

    // an authorized transition: ManagedPost.rowFingerprint follows the rows,
    // the revision and its snapshot do not change
    await store.transitionPostRows(managed.id, release.rowFingerprint, {
      from: ['DRAFT', 'PUBLISHED'],
      to: 'QUEUE',
      publishDate: dueAt,
    });

    const change = {
      lifecycle: 'SCHEDULED',
      scheduleGeneration,
      activeScheduleId: schedule.id,
      lastLifecycleSequence: sequence,
      lastOperationKey: body.operationKey,
    };
    if (!lifecycle) {
      await store.createPost({ managedPostId: managed.id, ...change });
    } else if (!(await store.updatePost(managed.id, lifecycle.version, change))) {
      throw new Error('The post lifecycle changed under the organization lock');
    }

    return this.conclude(store, {
      kind,
      credentialId: input.credentialId,
      operationKey: body.operationKey,
      payloadHash: input.payloadHash,
      managedPostId: managed.id,
      revision: managed.revision,
      scheduleId: schedule.id,
      dispatchId: null,
      sequence,
      now,
      event: {
        kind: kind === 'SCHEDULE' ? 'POST_SCHEDULED' : 'POST_PUBLISH_REQUESTED',
        scheduleId: schedule.id,
        dispatchId: dispatch.id,
        dispatchVersion: dispatch.version,
      },
      answered: [dispatch.id],
      detail: {},
    });
  }

  // ---- ending -------------------------------------------------------------------

  // Cancels exactly the scope W&W previewed and its human confirmed: the
  // schedule and its version, the affected occurrences (the materialized one
  // at its dispatch version), the earlier one in flight, and the hash over
  // them, all derived again here from the schedule as stored. The generation
  // never changes and the schedule version always advances; an earlier
  // occurrence that is admitted or unresolved keeps its own binding. A series
  // is only ever shortened. Nothing is sent
  async cancel(
    principal: ManagedLifecyclePrincipal,
    managedPostId: string,
    raw: unknown
  ): Promise<ManagedLifecycleResult> {
    authorize(principal, SCOPES.CANCEL);
    const { body, payloadHash } = this.request('CANCEL', managedPostId, raw);
    const { gates } = await this.gates(principal.organizationId);

    return this._repository.mutate(principal.organizationId, async (store) => {
      const replayed = await this.replay(
        store,
        'CANCEL',
        principal.credentialId,
        body.operationKey,
        payloadHash
      );
      if (replayed) {
        return replayed;
      }

      const now = this._clock.now();
      this.enabledRefusal(gates);
      const { managed, lifecycle: found } = await this.boundPost(store, managedPostId, body);
      const from =
        body.scope === 'OCCURRENCE'
          ? body.occurrence
          : body.scope === 'REMAINING'
          ? body.fromOccurrence
          : null;
      const { lifecycle, schedule, dispatches, affected, inFlight } = await this.boundScope(
        store,
        managed,
        found,
        body,
        body.scope,
        from,
        body.scope === 'REMAINING' ? body.inFlight : null
      );

      const operationKey = body.operationKey;
      const sequence = (await store.headSequence()) + 1;
      const cancelled = await this.cancelPending(
        store,
        dispatches,
        affected,
        operationKey,
        sequence,
        now
      );
      const first = affected[0].occurrence;

      // what the cancel leaves of the series: a REMAINING cancel may start
      // after occurrences still to run (pending or not yet materialized)
      let series: CancelSeries = 'ENDED';
      if (body.scope === 'OCCURRENCE' && first < schedule.lastOccurrence) {
        series = schedule.status === 'ACTIVE' ? 'CONTINUES' : 'ENDS_AFTER_REMAINING';
      } else if (body.scope === 'REMAINING') {
        const latest = Math.max(-1, ...dispatches.map((row) => row.occurrence));
        const earlier =
          latest + 1 < first ||
          dispatches.some((row) => row.status === 'PENDING' && row.occurrence < first);
        series = earlier ? 'ENDS_AFTER_REMAINING' : inFlight ? 'ENDS_AFTER_IN_FLIGHT' : 'ENDED';
      }
      const ended = series === 'ENDED';

      if (
        !(await store.updateSchedule(schedule.id, schedule.version, {
          ...(body.scope === 'REMAINING' ? { lastOccurrence: first - 1 } : {}),
          // the first end request is kept through every later cancel
          ...((ended || body.scope !== 'OCCURRENCE') && !schedule.endRequestedOperationKey
            ? { endRequestedOperationKey: operationKey, endRequestedAt: now }
            : {}),
          ...(ended
            ? { status: 'CANCELLED', endedAt: now, endedOperationKey: operationKey }
            : series === 'CONTINUES'
            ? {}
            : { status: 'ENDING' }),
        }))
      ) {
        throw new Error('The schedule changed under the organization lock');
      }

      // a skipped occurrence lets the series go on with the next anchored one
      if (body.scope === 'OCCURRENCE' && !ended) {
        await this.materialize(store, schedule, first + 1, memberPostIds(cancelled), sequence, now);
      }

      await this.follow(store, managed, lifecycle, sequence, operationKey);

      return this.conclude(store, {
        kind: 'CANCEL',
        credentialId: principal.credentialId,
        operationKey,
        payloadHash,
        managedPostId: managed.id,
        revision: managed.revision,
        scheduleId: schedule.id,
        dispatchId: null,
        sequence,
        now,
        event:
          body.scope === 'OCCURRENCE'
            ? {
                kind: 'POST_OCCURRENCE_CANCELLED',
                scheduleId: schedule.id,
                dispatchId: cancelled.id,
                dispatchVersion: cancelled.version,
              }
            : {
                kind: 'POST_SCHEDULE_CANCELLED',
                scheduleId: schedule.id,
                dispatchId: null,
                dispatchVersion: null,
              },
        answered: cancelled ? [cancelled.id] : [],
        detail: {
          cancellation: {
            scope: body.scope,
            scheduleId: schedule.id,
            cancelledOccurrences: affected.map((entry) => entry.occurrence),
            series,
            generation: 'UNCHANGED',
            scheduleVersion: 'ADVANCED',
          },
        },
      });
    });
  }

  // Retained soft deletion of the Postiz record, published or not: the actual
  // Post rows get deletedAt and are kept with the recorded fingerprint, the
  // lifecycle row gets the tombstone, and every history row stays. The
  // social-network post is never deleted and nothing is sent. Refused while
  // any occurrence is admitted, unresolved or has a call in flight. A
  // SCHEDULED post binds the occurrences the delete cancels exactly as a
  // SERIES cancel would, and its live schedule is SUPERSEDED_BY_DELETE
  async delete(
    principal: ManagedLifecyclePrincipal,
    managedPostId: string,
    raw: unknown
  ): Promise<ManagedLifecycleResult> {
    authorize(principal, SCOPES.DELETE);
    const { body, payloadHash } = this.request('DELETE', managedPostId, raw);
    const { gates } = await this.gates(principal.organizationId);

    return this._repository.mutate(principal.organizationId, async (store) => {
      const replayed = await this.replay(
        store,
        'DELETE',
        principal.credentialId,
        body.operationKey,
        payloadHash
      );
      if (replayed) {
        return replayed;
      }

      const now = this._clock.now();
      this.enabledRefusal(gates);
      const { managed, lifecycle } = await this.boundPost(store, managedPostId, body);

      const dispatches = await store.listDispatches(managed.id);
      if (dispatches.some((row) => row.status === 'ADMITTED' || row.activeCallId !== null)) {
        throw refuse('DISPATCH_IN_PROGRESS', 'An occurrence of the post is in progress');
      }
      if (dispatches.some((row) => row.status === 'UNKNOWN' || row.status === 'PARTIAL')) {
        throw refuse('DISPATCH_UNRESOLVED', 'An occurrence of the post must be resolved first');
      }
      for (const row of dispatches) {
        if ((await store.listCalls(row.id)).some((call) => IN_FLIGHT_CALLS.includes(call.status))) {
          throw refuse('DISPATCH_IN_PROGRESS', 'A provider call of the post is in flight');
        }
      }

      const current = lifecycle?.lifecycle ?? 'DRAFT';
      if (current !== body.expectedLifecycle) {
        throw refuse('LIFECYCLE_STATE_CONFLICT', `The post is ${current}`);
      }

      // the rows exactly as the managed API last left them
      const rows = await store.draft.getPostRows([managed.group]);
      const retained = rows.filter((row) => !row.deletedAt);
      if (managed.rowFingerprint !== rowFingerprint(rows)) {
        throw refuse('POST_DRIFTED', 'The post rows were changed outside the managed API');
      }
      if (!retained.length) {
        throw refuse('LIFECYCLE_STATE_CONFLICT', 'The post has no rows to retain');
      }

      const operationKey = body.operationKey;
      const sequence = (await store.headSequence()) + 1;
      let affected: ManagedAffectedOccurrence[] = [];
      let cancelled: ManagedDispatch | null = null;
      if (body.cancels) {
        const scope = await this.boundScope(store, managed, lifecycle, body.cancels, 'DELETE', null, null);
        cancelled = await this.cancelPending(
          store,
          scope.dispatches,
          scope.affected,
          operationKey,
          sequence,
          now
        );
        if (
          !(await store.updateSchedule(scope.schedule.id, scope.schedule.version, {
            status: 'SUPERSEDED_BY_DELETE',
            endedAt: now,
            endedOperationKey: operationKey,
          }))
        ) {
          throw new Error('The schedule changed under the organization lock');
        }
        affected = scope.affected;
      } else if (lifecycle?.activeScheduleId) {
        throw refuse('LIFECYCLE_STATE_CONFLICT', 'The post has a live schedule');
      }

      await store.transitionPostRows(managed.id, managed.rowFingerprint, {
        from: [...new Set(retained.map((row) => row.state as State))],
        deletedAt: now,
      });

      // the tombstone is set once; the generation and every history row stay
      const change = {
        lifecycle: 'DELETED',
        activeScheduleId: null,
        lastLifecycleSequence: sequence,
        lastOperationKey: operationKey,
        deletedAt: now,
        deletedOperationKey: operationKey,
        deletedSequence: sequence,
        deletedFromLifecycle: current,
      };
      if (!lifecycle) {
        await store.createPost({ managedPostId: managed.id, scheduleGeneration: 0, ...change });
      } else if (!(await store.updatePost(managed.id, lifecycle.version, change))) {
        throw new Error('The post lifecycle changed under the organization lock');
      }

      const latest = await store.getLatestSchedule(managed.id);
      return this.conclude(store, {
        kind: 'DELETE',
        credentialId: principal.credentialId,
        operationKey,
        payloadHash,
        managedPostId: managed.id,
        revision: managed.revision,
        scheduleId: body.cancels ? body.cancels.scheduleId : null,
        dispatchId: null,
        sequence,
        now,
        event: {
          kind: 'POST_DELETED',
          scheduleId: latest?.id ?? null,
          dispatchId: null,
          dispatchVersion: null,
        },
        answered: cancelled ? [cancelled.id] : [],
        detail: {
          deletion: {
            mode: 'RETAINED_SOFT_DELETE',
            platformPost: 'NOT_DELETED',
            wasPublished:
              current === 'PUBLISHED' ||
              dispatches.some((row) => PUBLISHED_DISPATCHES.includes(row.status)),
            retainedPostIds: retained.map((row) => row.id),
            cancelledOccurrences: affected.map((entry) => entry.occurrence),
          },
        },
      });
    });
  }

  // Records what a human observed for an UNKNOWN or PARTIAL dispatch, bound
  // to its exact version, status and generation and to every member as it
  // was shown, with HUMAN_OBSERVATION evidence between the admission and now.
  // W&W verified that human's confirmation before this credential sent it; no
  // other policy is added or weakened here. Nothing is looked up, trusted
  // from a late provider answer (it stays on its call) or sent again: only a
  // human-verified RESOLVED_PUBLISHED lets a live series go on, anything else
  // halts it
  async resolve(
    principal: ManagedLifecyclePrincipal,
    dispatchId: string,
    raw: unknown
  ): Promise<ManagedLifecycleResult> {
    authorize(principal, SCOPES.RESOLVE);
    const { body, payloadHash } = this.request('RESOLVE', dispatchId, raw);
    const { gates } = await this.gates(principal.organizationId);

    return this._repository.mutate(principal.organizationId, async (store) => {
      const replayed = await this.replay(
        store,
        'RESOLVE',
        principal.credentialId,
        body.operationKey,
        payloadHash
      );
      if (replayed) {
        return replayed;
      }

      const now = this._clock.now();
      this.enabledRefusal(gates);

      const dispatch = await store.getDispatch(dispatchId);
      if (!dispatch) {
        throw refuse('NOT_FOUND', 'Dispatch not found');
      }
      const managed = await store.draft.getManagedPost(dispatch.managedPostId);
      const lifecycle = await store.getPost(dispatch.managedPostId);
      if (!managed || !lifecycle) {
        throw new ManagedLifecycleProjectionError();
      }
      if (lifecycle.deletedAt || lifecycle.lifecycle === 'DELETED') {
        throw refuse('POST_DELETED', 'The post was deleted');
      }
      if (dispatch.scheduleGeneration !== body.expectedScheduleGeneration) {
        throw refuse(
          'SCHEDULE_GENERATION_CONFLICT',
          `The dispatch is of schedule generation ${dispatch.scheduleGeneration}`
        );
      }
      if (dispatch.status !== 'UNKNOWN' && dispatch.status !== 'PARTIAL') {
        throw refuse('DISPATCH_NOT_RESOLVABLE', `The dispatch is ${dispatch.status}`);
      }
      if (
        dispatch.version !== body.expectedDispatchVersion ||
        dispatch.status !== body.expectedStatus
      ) {
        throw refuse(
          'DISPATCH_VERSION_CONFLICT',
          `The dispatch is ${dispatch.status} at version ${dispatch.version}`
        );
      }
      const schedule = await store.getLatestSchedule(managed.id);
      if (
        schedule?.id !== dispatch.scheduleId ||
        lifecycle.scheduleGeneration !== dispatch.scheduleGeneration
      ) {
        throw refuse('LIFECYCLE_STATE_CONFLICT', "The dispatch is not of the post's latest schedule");
      }
      const calls = await store.listCalls(dispatch.id);
      if (dispatch.activeCallId !== null || calls.some((call) => IN_FLIGHT_CALLS.includes(call.status))) {
        throw refuse('DISPATCH_IN_PROGRESS', 'A provider call of the dispatch is in flight');
      }

      // every member exactly as it was shown to the human
      const view = managedDispatchView(dispatch, calls);
      if (
        body.members.length !== view.members.length ||
        body.members.some(
          (member, index) =>
            member.postId !== view.members[index].postId ||
            member.expectedStatus !== view.members[index].status
        )
      ) {
        throw refuse('RESOLVE_MEMBERS_MISMATCH', 'The members are not the ones the dispatch has');
      }
      const timing = lifecycleResolveTimeRefusal(body, view.admittedAt, now);
      if (timing) {
        throw lifecycleTimeException(timing);
      }

      // read before the transition: a halt this very dispatch caused
      const resumable =
        body.resolution === 'RESOLVED_PUBLISHED' &&
        (await this.haltedBy(store, schedule, dispatch));

      const operationKey = body.operationKey;
      const sequence = (await store.headSequence()) + 1;
      if (
        !(await store.transitionDispatch(dispatch.id, dispatch.version, {
          status: body.resolution,
          members: JSON.stringify(
            view.members.map((member, index) => resolvedMember(member, body.members[index]))
          ),
          resolution: JSON.stringify({
            resolution: body.resolution,
            previousStatus: dispatch.status,
            operationKey,
            resolvedAt: now.toISOString(),
            evidence: body.evidence,
            members: body.members,
            resend: 'NEVER',
          }),
          lastLifecycleSequence: sequence,
        }))
      ) {
        throw new Error('The dispatch changed under the organization lock');
      }

      const materialized =
        LIVE_SCHEDULES.includes(schedule.status) || resumable
          ? await this.followResolution(store, schedule, dispatch, body.resolution, operationKey, sequence, now)
          : null;
      await this.follow(store, managed, lifecycle, sequence, operationKey);

      return this.conclude(store, {
        kind: 'RESOLVE',
        credentialId: principal.credentialId,
        operationKey,
        payloadHash,
        managedPostId: managed.id,
        // the revision the dispatch was bound to
        revision: dispatch.revision,
        scheduleId: schedule.id,
        dispatchId: dispatch.id,
        sequence,
        now,
        event: {
          kind: 'DISPATCH_RESOLVED',
          scheduleId: schedule.id,
          dispatchId: dispatch.id,
          dispatchVersion: dispatch.version + 1,
        },
        answered: materialized ? [dispatch.id, materialized.id] : [dispatch.id],
        detail: { dispatchId: dispatch.id, resolution: body.resolution, resend: 'NEVER' },
      });
    });
  }

  // ---- dispatcher events --------------------------------------------------------

  // The event port of the dispatch journal (ManagedDispatchJournalPorts.event),
  // in the journal's own locked transaction after its one transition: one
  // event with the post's full validated projection, the post's lifecycle and
  // feed pointers, its QUEUE rows brought along (follow), and the dispatch's
  // feed position. The dispatch, call and schedule are never transitioned
  // again here, so the handle the journal answers stays exact. Rows changed
  // outside the managed API are left as they are rather than losing an
  // outcome already received. No provider IO
  async recordDispatchEvent(
    store: ManagedLifecycleStore,
    kind: ManagedJournalEventKind,
    dispatch: ManagedDispatch
  ): Promise<void> {
    const current = dispatch ? await store.getDispatch(dispatch.id) : null;
    if (
      !current ||
      !(DISPATCHER_EVENTS[kind] ?? []).includes(current.status) ||
      current.status !== dispatch.status ||
      current.version !== dispatch.version
    ) {
      throw new Error('The dispatch event does not follow the stored dispatch');
    }

    const managed = await store.draft.getManagedPost(current.managedPostId);
    const lifecycle = await store.getPost(current.managedPostId);
    const latest = await store.getLatestSchedule(current.managedPostId);
    if (
      !managed ||
      !lifecycle ||
      lifecycle.deletedAt ||
      latest?.id !== current.scheduleId ||
      lifecycle.scheduleGeneration !== current.scheduleGeneration
    ) {
      throw new ManagedLifecycleProjectionError();
    }

    const sequence = (await store.headSequence()) + 1;
    await this.follow(store, managed, lifecycle, sequence, null, 'KEEP');
    await this.appendProjected(store, managed.id, sequence, this._clock.now(), {
      kind,
      entityType: 'MANAGED_DISPATCH',
      entityId: current.id,
      scheduleId: current.scheduleId,
      dispatchId: current.id,
      operationKey: null,
      dispatchVersion: current.version,
    });
    if (!(await store.markDispatchSequence(current.id, current.version, sequence))) {
      throw new Error('The dispatch changed under the organization lock');
    }
  }

  // ---- ending, shared ---------------------------------------------------------

  // the post a cancel or delete names, at the revision and generation it binds
  private async boundPost(
    store: ManagedLifecycleStore,
    managedPostId: string,
    body: { expectedRevision: number; expectedScheduleGeneration: number }
  ) {
    const managed = await store.draft.getManagedPost(managedPostId);
    if (!managed) {
      throw refuse('NOT_FOUND', 'Managed post not found');
    }
    if (managed.revision !== body.expectedRevision) {
      throw refuse('REVISION_CONFLICT', `The post is at revision ${managed.revision}`);
    }
    const lifecycle = await store.getPost(managedPostId);
    if (lifecycle?.deletedAt || lifecycle?.lifecycle === 'DELETED') {
      throw refuse('POST_DELETED', 'The post was deleted');
    }
    const generation = lifecycle?.scheduleGeneration ?? 0;
    if (generation !== body.expectedScheduleGeneration) {
      throw refuse(
        'SCHEDULE_GENERATION_CONFLICT',
        `The post is at schedule generation ${generation}`
      );
    }
    return { managed, lifecycle };
  }

  // The scope a cancel (DELETE: the cancels of a delete) binds, derived again
  // from the post's live schedule as stored (lifecycleCancelScope). The
  // schedule, its version, the affected occurrences, the occurrence in flight
  // and the hash over them must all be exactly what W&W previewed
  private async boundScope(
    store: ManagedLifecycleStore,
    managed: ManagedPostRow,
    lifecycle: ManagedPostLifecycle | null,
    binding: {
      scheduleId: string;
      expectedScheduleVersion: number;
      affected: readonly ManagedAffectedOccurrence[];
      affectedHash: string;
    },
    scope: ManagedCancelScope | 'DELETE',
    from: number | null,
    inFlight: ManagedInFlightOccurrence | null
  ) {
    if (!lifecycle?.activeScheduleId) {
      throw refuse('LIFECYCLE_STATE_CONFLICT', 'The post has no live schedule');
    }
    if (binding.scheduleId !== lifecycle.activeScheduleId) {
      throw refuse('CANCEL_SCOPE_MISMATCH', "The schedule is not the post's live schedule");
    }
    const schedule = await store.getSchedule(binding.scheduleId);
    if (
      !schedule ||
      schedule.managedPostId !== managed.id ||
      schedule.scheduleGeneration !== lifecycle.scheduleGeneration ||
      !LIVE_SCHEDULES.includes(schedule.status)
    ) {
      throw new ManagedLifecycleProjectionError();
    }
    if (schedule.version !== binding.expectedScheduleVersion) {
      throw refuse('CANCEL_SCOPE_MISMATCH', `The schedule is at version ${schedule.version}`);
    }

    const dispatches = await store.listDispatches(managed.id, schedule.id);
    const derived = lifecycleCancelScope(
      managedScheduleView(schedule),
      dispatches.map((row) => ({
        dispatchId: row.id,
        occurrence: row.occurrence,
        status: row.status as ManagedDispatchStatus,
        dispatchVersion: row.version,
      })),
      scope,
      from
    );
    if (typeof derived === 'string') {
      throw refuse(derived, SCOPE_REFUSALS[derived] ?? 'The scope cannot be cancelled');
    }

    const hashOf = (bound: {
      scheduleId: string;
      expectedScheduleVersion: number;
      affected: readonly ManagedAffectedOccurrence[];
      inFlight: ManagedInFlightOccurrence | null;
    }) => fingerprint(lifecycleAffectedHashInput(scope, bound));
    const expected = hashOf({
      scheduleId: schedule.id,
      expectedScheduleVersion: schedule.version,
      affected: derived.affected,
      inFlight: derived.inFlight,
    });
    if (hashOf({ ...binding, inFlight }) !== expected || binding.affectedHash !== expected) {
      throw refuse('CANCEL_SCOPE_MISMATCH', 'The confirmed scope is not the scope as stored');
    }

    return {
      lifecycle,
      schedule,
      dispatches,
      affected: derived.affected,
      inFlight: derived.inFlight,
    };
  }

  // The materialized occurrence a cancel affects, at the version W&W bound:
  // CANCELLED by the operation, with no call ever admitted for it
  private async cancelPending(
    store: ManagedLifecycleStore,
    dispatches: readonly ManagedDispatch[],
    affected: readonly ManagedAffectedOccurrence[],
    operationKey: string,
    sequence: number,
    now: Date
  ) {
    const [first] = affected;
    if (first?.state !== 'PENDING') {
      return null;
    }
    const row = dispatches.find((item) => item.id === first.dispatchId);
    if (!row || row.activeCallId !== null || (await store.listCalls(row.id)).length) {
      throw refuse('DISPATCH_IN_PROGRESS', 'The affected occurrence has a provider call');
    }
    if (
      !(await store.transitionDispatch(row.id, first.expectedDispatchVersion, {
        status: 'CANCELLED',
        cancelledByOperationKey: operationKey,
        settledAt: now,
        nextActionAt: null,
        deferralCode: null,
        lastLifecycleSequence: sequence,
      }))
    ) {
      throw new Error('The dispatch changed under the organization lock');
    }
    return store.getDispatch(row.id);
  }

  // Whether the schedule is HALTED by the settlement (or recovery) of exactly
  // this dispatch as UNKNOWN or PARTIAL, the latest occurrence of the
  // schedule: a halt no human decided yet, which a human-verified
  // RESOLVED_PUBLISHED may resume. A halt by REJECTED, NOT_SENT, EXPIRED or
  // by a resolution never is
  private async haltedBy(
    store: ManagedLifecycleStore,
    schedule: ManagedSchedule,
    dispatch: ManagedDispatch
  ) {
    if (
      schedule.status !== 'HALTED' ||
      (schedule.endedCode !== 'UNKNOWN' && schedule.endedCode !== 'PARTIAL') ||
      schedule.endedCode !== dispatch.status ||
      schedule.endedOperationKey !== null
    ) {
      return false;
    }
    const dispatches = await store.listDispatches(dispatch.managedPostId, schedule.id);
    return !dispatches.some((row) => row.occurrence > dispatch.occurrence);
  }

  // What a resolution leaves of a live series, or of one haltedBy its
  // dispatch: only a human-verified RESOLVED_PUBLISHED materializes the next
  // anchored occurrence (a halted series live again: ENDING when its end was
  // requested, else ACTIVE), or ends the series (COMPLETED, or CANCELLED by
  // its last truncation when its end was requested). lastOccurrence, the
  // captured window and the first end request stay as they are.
  // RESOLVED_NOT_PUBLISHED and RESOLVED_ABANDONED halt a live series
  private async followResolution(
    store: ManagedLifecycleStore,
    schedule: ManagedSchedule,
    dispatch: ManagedDispatch,
    resolution: ManagedResolution,
    operationKey: string,
    sequence: number,
    now: Date
  ) {
    const next = dispatch.occurrence + 1;
    const endRequested = schedule.endRequestedOperationKey !== null;
    if (resolution === 'RESOLVED_PUBLISHED' && next <= schedule.lastOccurrence) {
      if (
        !LIVE_SCHEDULES.includes(schedule.status) &&
        !(await store.updateSchedule(schedule.id, schedule.version, {
          status: endRequested ? 'ENDING' : 'ACTIVE',
          endedAt: null,
          endedCode: null,
          endedOperationKey: null,
        }))
      ) {
        throw new Error('The schedule changed under the organization lock');
      }
      return this.materialize(store, schedule, next, memberPostIds(dispatch), sequence, now);
    }

    const end =
      resolution !== 'RESOLVED_PUBLISHED'
        ? { status: 'HALTED', endedOperationKey: operationKey }
        : endRequested
        ? { status: 'CANCELLED', endedOperationKey: await this.lastTruncation(store, schedule.id) }
        : { status: 'COMPLETED', endedOperationKey: null };
    // endedCode: what ended it, as the journal records a settlement
    if (
      !(await store.updateSchedule(schedule.id, schedule.version, {
        ...end,
        endedAt: now,
        endedCode: resolution,
      }))
    ) {
      throw new Error('The schedule changed under the organization lock');
    }
    return null;
  }

  // The last cancel that truncated a schedule, which ends it once what it
  // left has settled; it may be later than the first end request
  private async lastTruncation(store: ManagedLifecycleStore, scheduleId: string) {
    let operationKey: string | null = null;
    for (const row of await store.listScheduleOperations(scheduleId)) {
      const result = managedLifecycleStoredResult(row, false);
      if (result.kind === 'CANCEL' && result.cancellation.scope === 'REMAINING') {
        operationKey = result.operationKey;
      }
    }
    if (!operationKey) {
      throw new ManagedLifecycleProjectionError();
    }
    return operationKey;
  }

  // The post's lifecycle once its latest schedule or a dispatch of it
  // changed: lifecycleWhileScheduled while the schedule is live; once it
  // ended, REVIEW while a dispatch is unresolved, FAILED for a halt whose
  // last occurrence did not publish, else PUBLISHED when any occurrence of
  // the post was published and DRAFT when none was. Live rows still QUEUE
  // follow it: while live
  // lifecycleAdmissionRowState, once ended PUBLISHED or DRAFT by the same
  // publication history (never ERROR, which no release is built from), and
  // while unresolved they wait. Rows in any other state stay as an
  // occurrence or a write left them. Rows changed outside the managed API
  // are never written: a write is refused (REFUSE), a dispatcher event
  // leaves them as they are (KEEP)
  private async follow(
    store: ManagedLifecycleStore,
    managed: ManagedPostRow,
    lifecycle: ManagedPostLifecycle,
    sequence: number,
    operationKey: string | null,
    drifted: 'REFUSE' | 'KEEP' = 'REFUSE'
  ) {
    const schedule = await store.getLatestSchedule(managed.id);
    const dispatches = await store.listDispatches(managed.id);
    const statuses = dispatches
      .filter((row) => row.scheduleId === schedule?.id)
      .map((row) => row.status as ManagedDispatchStatus);
    const live = !!schedule && LIVE_SCHEDULES.includes(schedule.status);
    const published = dispatches.some((row) => PUBLISHED_DISPATCHES.includes(row.status));
    const next = live
      ? lifecycleWhileScheduled(statuses)
      : statuses.includes('UNKNOWN') || statuses.includes('PARTIAL')
      ? 'REVIEW'
      : schedule?.status === 'HALTED' &&
        !PUBLISHED_DISPATCHES.includes(statuses[statuses.length - 1])
      ? 'FAILED'
      : published
      ? 'PUBLISHED'
      : 'DRAFT';

    const target: State | null = live
      ? lifecycleAdmissionRowState(statuses)
      : next === 'REVIEW'
      ? null
      : published
      ? 'PUBLISHED'
      : 'DRAFT';
    if (target && target !== 'QUEUE') {
      await this.moveQueuedRows(store, managed.id, target, drifted);
    }

    if (
      !(await store.updatePost(managed.id, lifecycle.version, {
        lifecycle: next,
        activeScheduleId: live ? schedule.id : null,
        lastLifecycleSequence: sequence,
        ...(operationKey ? { lastOperationKey: operationKey } : {}),
      }))
    ) {
      throw new Error('The post lifecycle changed under the organization lock');
    }
  }

  // Live rows that are all QUEUE move to `to`, under the fingerprint the
  // managed API recorded; rows changed elsewhere are never written
  private async moveQueuedRows(
    store: ManagedLifecycleStore,
    managedPostId: string,
    to: State,
    drifted: 'REFUSE' | 'KEEP'
  ) {
    const managed = await store.draft.getManagedPost(managedPostId);
    const rows = await store.draft.getPostRows([managed.group]);
    const live = rows.filter((row) => !row.deletedAt);
    if (!live.length || live.some((row) => row.state !== 'QUEUE')) {
      return;
    }
    if (managed.rowFingerprint !== rowFingerprint(rows)) {
      if (drifted === 'KEEP') {
        return;
      }
      throw refuse('POST_DRIFTED', 'The post rows were changed outside the managed API');
    }
    await store.transitionPostRows(managedPostId, managed.rowFingerprint, { from: ['QUEUE'], to });
  }

  // ---- writing ------------------------------------------------------------------

  // The PENDING dispatch of one occurrence, with the schedule's own binding
  // and generation: due at its anchored time, admissible until the schedule's
  // tolerance and before the window it captured (exclusive) ends
  private materialize(
    store: ManagedLifecycleStore,
    schedule: ManagedSchedule,
    occurrence: number,
    postIds: readonly string[],
    sequence: number,
    now: Date
  ) {
    const dueAts = lifecycleOccurrenceDueAts(
      schedule.anchorAt.toISOString(),
      schedule.intervalDays,
      schedule.maxOccurrences
    );
    if (occurrence > schedule.lastOccurrence || !dueAts[occurrence]) {
      throw new ManagedLifecycleProjectionError();
    }
    const dueAt = new Date(dueAts[occurrence]);

    return store.createDispatch({
      managedPostId: schedule.managedPostId,
      scheduleId: schedule.id,
      occurrence,
      dueAt,
      admissibleUntil: new Date(
        Math.min(dueAt.getTime() + schedule.maxLatenessMs, schedule.policyExpiresAt.getTime() - 1)
      ),
      status: 'PENDING',
      revision: schedule.revision,
      bindingGeneration: schedule.bindingGeneration,
      scheduleGeneration: schedule.scheduleGeneration,
      contentSha256: schedule.contentSha256,
      releaseHash: schedule.releaseHash,
      members: JSON.stringify(
        postIds.map((postId, position) => ({
          position,
          postId,
          status: 'WAITING',
          code: null,
          release: null,
        }))
      ),
      nextActionAt: dueAt,
      lastLifecycleSequence: sequence,
      createdAt: now,
    });
  }

  // What every write ends with, in its locked transaction: one event with the
  // post's projection, the answer (the dispatches the write created or
  // changed) and the claim with that answer stored
  private async conclude(
    store: ManagedLifecycleStore,
    input: {
      kind: ManagedLifecycleKind;
      credentialId: string;
      operationKey: string;
      payloadHash: string;
      managedPostId: string;
      // the revision the claim binds
      revision: number;
      scheduleId: string | null;
      dispatchId: string | null;
      sequence: number;
      now: Date;
      event: {
        kind: ManagedLifecycleEventKind;
        scheduleId: string | null;
        dispatchId: string | null;
        dispatchVersion: number | null;
      };
      answered: readonly string[];
      detail: Record<string, unknown>;
    }
  ): Promise<ManagedLifecycleResult> {
    const { sequence, now } = input;
    const projection = await this.appendProjected(store, input.managedPostId, sequence, now, {
      ...input.event,
      entityType: 'MANAGED_POST',
      entityId: input.managedPostId,
      operationKey: input.operationKey,
    });

    const result = parseManagedLifecycleResponse('RESULT', {
      version: MANAGED_LIFECYCLE_VERSION,
      kind: input.kind,
      operationKey: input.operationKey,
      payloadHash: input.payloadHash,
      replayed: false,
      sequence,
      committedAt: now.toISOString(),
      managedPostId: input.managedPostId,
      revision: projection.revision,
      scheduleGeneration: projection.scheduleGeneration,
      lifecycle: projection.lifecycle,
      schedule: projection.schedule,
      dispatches: projection.dispatches.filter((dispatch) =>
        input.answered.includes(dispatch.dispatchId)
      ),
      ...input.detail,
    });
    if (!result) {
      throw new ManagedLifecycleProjectionError();
    }

    await store.createOperation({
      operationKey: input.operationKey,
      kind: input.kind,
      payloadHash: input.payloadHash,
      credentialId: input.credentialId,
      managedPostId: input.managedPostId,
      scheduleId: input.scheduleId,
      dispatchId: input.dispatchId,
      revision: input.revision,
      scheduleGeneration: projection.scheduleGeneration,
      sequence,
      result: JSON.stringify(result),
      committedAt: now,
    });

    return result;
  }

  // One event of the feed carrying the post's projection as of it, checked
  // as the feed will answer it
  private async appendProjected(
    store: ManagedLifecycleStore,
    managedPostId: string,
    sequence: number,
    now: Date,
    event: {
      kind: string;
      entityType: string;
      entityId: string;
      scheduleId: string | null;
      dispatchId: string | null;
      operationKey: string | null;
      dispatchVersion: number | null;
    }
  ) {
    const projection = await this.projection(
      store,
      await store.draft.getManagedPost(managedPostId),
      sequence
    );
    const appended = await store.appendEvent({
      ...event,
      managedPostId,
      scheduleGeneration: projection.scheduleGeneration,
      data: JSON.stringify(projection),
      createdAt: now,
    });
    if (appended !== sequence) {
      throw new Error('The lifecycle sequence moved under the organization lock');
    }
    managedLifecycleEventsPage(sequence - 1, sequence, await store.listEvents(sequence - 1, 1));
    return projection;
  }

  // ---- shared -------------------------------------------------------------------

  // The configured gates with the facts of the enabled adapters. Nothing
  // configured is every gate closed. A configuration error is not a closed
  // gate: it propagates
  private async gates(organizationId: string): Promise<{
    gates: ManagedLifecycleGates;
    adapters: ReadonlyMap<string, ManagedLifecycleAdapter>;
  }> {
    const configured = await this._configuration.gates(organizationId);
    if (!configured) {
      return { gates: MANAGED_LIFECYCLE_GATES_CLOSED, adapters: new Map() };
    }

    const adapters = new Map<string, ManagedLifecycleAdapter>();
    for (const identifier of new Set(configured.providers || [])) {
      const adapter = this._adapters.get(identifier);
      if (adapter && adapter.identifier === identifier) {
        adapters.set(identifier, adapter);
      }
    }

    return {
      gates: {
        organizationEnabled: configured.organizationEnabled === true,
        dispatcherAvailable: configured.dispatcherAvailable === true,
        mediaDeliveryReady: configured.mediaDeliveryReady === true,
        providers: [...adapters.values()].map(adapterFacts),
        policy: configured.policy ?? null,
      },
      adapters,
    };
  }

  // the facts of the enabled adapter for the channel the post is bound to
  private async providerFacts(
    store: ManagedLifecycleStore,
    gates: ManagedLifecycleGates,
    managedPostId: string
  ) {
    const managed = await store.draft.getManagedPost(managedPostId);
    const integration = managed
      ? await store.draft.getIntegration(managed.integrationId)
      : null;
    return integration
      ? gates.providers.find(
          (facts) => facts.identifier === integration.providerIdentifier
        ) ?? null
      : null;
  }

  // The pinned-storage observation of a revision's media, taken outside any
  // transaction
  private async observe(
    organizationId: string,
    managedPostId: string,
    revision: number
  ): Promise<ManagedReleaseObservedMedia> {
    const ids = await this._repository.read(organizationId, (store) =>
      managedReleaseMediaIds(store.draft, managedPostId, revision)
    );
    return observeManagedReleaseMedia(this._storage, organizationId, ids);
  }

  // The post's lifecycle view as of a sequence: its latest schedule and that
  // schedule's dispatches, through the allowlisted projections only
  private async projection(
    store: ManagedLifecycleStore,
    post: ManagedPostRow,
    asOfSequence: number
  ) {
    const lifecycle = await store.getPost(post.id);
    const latestSchedule = await store.getLatestSchedule(post.id);
    if (
      latestSchedule &&
      latestSchedule.scheduleGeneration !== lifecycle?.scheduleGeneration
    ) {
      throw new ManagedLifecycleProjectionError();
    }

    const dispatches = latestSchedule
      ? await store.listDispatches(post.id, latestSchedule.id)
      : [];
    const calls: ManagedDispatchCall[] = [];
    for (const dispatch of dispatches) {
      calls.push(...(await store.listCalls(dispatch.id)));
    }

    return managedPostLifecycleView({
      post,
      lifecycle,
      asOfSequence,
      latestSchedule,
      scheduleCount: await store.countSchedules(post.id),
      dispatches,
      calls,
    });
  }
}
