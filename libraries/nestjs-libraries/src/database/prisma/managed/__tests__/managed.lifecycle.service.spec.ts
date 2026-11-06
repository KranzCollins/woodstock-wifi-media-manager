// FAKE storage factory and sniffer for the modules managed.service.ts loads
// (the real sniffer is ESM-only); no upload, storage or network runs here
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({}));
jest.mock(
  'file-type',
  () => ({ fileTypeStream: jest.fn(), fileTypeFromBuffer: jest.fn() }),
  { virtual: true }
);

// The owned lifecycle service on the actual ManagedLifecycleRepository and
// ManagedLifecycleStore, over an explicit FAKE in-memory Prisma port (the
// models and queries those two use, a per-organization lock taken by the
// first managedOrganization.update with commit / rollback, RepeatableRead
// snapshots for reads, the lifecycle unique constraints). The release builder,
// strict text decoder, contract parsers, views, fingerprints and the
// instagram-standalone adapter's prepare() are the real ones. Pinned storage,
// operator configuration and clock are FAKE ports. No database, storage,
// provider or network is involved; the root runs the real PostgreSQL
// scenarios later
import { createHash, randomUUID } from 'crypto';
import { matches } from '@gitroom/nestjs-libraries/database/prisma/managed/__tests__/fakes/fake.prisma.db';
import {
  IntegrationIdentity,
  PostRow,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import {
  fingerprint,
  identityFingerprint,
  ManagedPostSnapshot,
  rowFingerprint,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { ManagedLifecycleRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.repository';
import { ManagedLifecycleProjectionError } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.views';
import { ManagedDispatchJournal } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.dispatch-journal';
import { InstagramStandalonePublishAdapter } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.provider';
import {
  lifecycleAffectedHashInput,
  ManagedLifecycleException,
  parseManagedLifecycleResponse,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';
import {
  ManagedLifecycleConfiguredGates,
  ManagedLifecyclePrincipal,
  ManagedLifecycleService,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.service';

// ---- FAKE Prisma port -----------------------------------------------------------

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

const MODELS = [
  'managedOrganization',
  'managedChannelBinding',
  'managedPost',
  'managedPostRevision',
  'managedOperation',
  'managedMediaEvidence',
  'managedChangeEvent',
  'integration',
  'post',
  'media',
  'managedLifecycleOrganization',
  'managedPostLifecycle',
  'managedLifecycleOperation',
  'managedLifecycleChangeEvent',
  'managedSchedule',
  'managedDispatch',
  'managedDispatchCall',
  'managedMediaCapability',
];

// the schema's unique constraints; a null never collides (Postgres)
const UNIQUES: Record<string, string[][]> = {
  managedOrganization: [['organizationId']],
  managedOperation: [['organizationId', 'operationKey']],
  managedLifecycleOrganization: [['organizationId']],
  managedPostLifecycle: [['managedPostId'], ['activeScheduleId']],
  managedLifecycleOperation: [['organizationId', 'operationKey'], ['organizationId', 'sequence']],
  managedLifecycleChangeEvent: [['organizationId', 'sequence']],
  managedSchedule: [['managedPostId', 'scheduleGeneration'], ['organizationId', 'operationKey']],
  managedDispatch: [['scheduleId', 'occurrence'], ['activeCallId']],
  managedDispatchCall: [['dispatchId', 'member', 'step', 'stage', 'attempt']],
};

// the schema's defaults
const DEFAULTS: Record<string, () => Row> = {
  managedLifecycleOrganization: () => ({ sequence: 0 }),
  managedPostLifecycle: () => ({
    lifecycle: 'DRAFT', scheduleGeneration: 0, activeScheduleId: null, version: 1,
    lastLifecycleSequence: 0, lastOperationKey: null, deletedAt: null,
    deletedOperationKey: null, deletedSequence: null, deletedFromLifecycle: null,
  }),
  managedLifecycleOperation: () => ({ dispatchId: null, scheduleId: null }),
  managedLifecycleChangeEvent: () => ({
    scheduleId: null, dispatchId: null, operationKey: null, scheduleGeneration: null, dispatchVersion: null,
  }),
  managedSchedule: () => ({
    version: 1, intervalDays: null, endRequestedOperationKey: null, endRequestedAt: null,
    endedAt: null, endedCode: null, endedOperationKey: null,
  }),
  managedDispatch: () => ({
    status: 'PENDING', version: 1, code: null, resolution: null, cancelledByOperationKey: null,
    leaseHolder: null, leaseExpiresAt: null, fencingToken: 0, activeCallId: null, nextActionAt: null,
    nextStep: null, nextMember: null, deferralCode: null, deferralCount: 0, firstDeferredAt: null,
    lastDeferredAt: null, admittedAt: null, settledAt: null,
  }),
  managedDispatchCall: () => ({
    stage: 0, code: null, consumedUnits: 0, sentLedger: null, pendingEnvelope: null, pollCount: 0,
    pollReservedUnits: 0, nextPollAt: null, pollDeadlineAt: null, lastPolledAt: null, result: null, settledAt: null,
  }),
  managedMediaCapability: () => ({ revokedAt: null, revokeReason: null }),
};

const compare = (a: any, b: any) => {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  return left < right ? -1 : left > right ? 1 : 0;
};

const pick = (row: Row, select?: Record<string, boolean>) =>
  select
    ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]))
    : { ...row };

function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
  }
  row.updatedAt = new Date();
}

interface Ctx {
  tables: Tables | null;
  release: (() => void) | null;
}

class FakeLifecycleDb {
  tables: Tables = Object.fromEntries(MODELS.map((model) => [model, []]));
  // a statement that fails as a database would
  failOn: { model: string; action: string } | null = null;
  private tails = new Map<string, Promise<void>>();

  private async lock(organizationId: string) {
    const previous = this.tails.get(organizationId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    this.tails.set(organizationId, previous.then(() => next));
    await previous;
    return release;
  }

  private delegate(model: string, ctx: Ctx) {
    const rows = () => (ctx.tables ?? this.tables)[model];
    const fail = (action: string) => {
      if (this.failOn?.model === model && this.failOn.action === action) {
        throw new Error(`FAKE database failure on ${model}.${action}`);
      }
    };
    const list = (args: any = {}) => {
      let found = rows().filter((row) => matches(row, args.where));
      const order = ([] as Row[]).concat(args.orderBy ?? []);
      found = [...found].sort((a, b) => {
        for (const entry of order) {
          const [[field, direction]] = Object.entries(entry);
          const result = compare(a[field], b[field]) * (direction === 'desc' ? -1 : 1);
          if (result) return result;
        }
        return 0;
      });
      return args.take === undefined ? found : found.slice(0, args.take);
    };
    const create = (args: any) => {
      fail('create');
      const row: Row = {
        ...(DEFAULTS[model]?.() ?? {}),
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data,
      };
      for (const fields of UNIQUES[model] ?? []) {
        if (
          fields.every((field) => row[field] !== null && row[field] !== undefined) &&
          rows().some((existing) => fields.every((field) => compare(existing[field], row[field]) === 0))
        ) {
          throw new Error(`FAKE unique constraint on ${model}(${fields.join(',')})`);
        }
      }
      rows().push(row);
      return pick(row, args.select);
    };
    return {
      findUnique: async (args: any) => {
        const row = rows().find((item) => matches(item, args.where));
        return row ? pick(row, args.select) : null;
      },
      findFirst: async (args: any) => {
        const row = list(args)[0];
        return row ? pick(row, args.select) : null;
      },
      findMany: async (args: any) => list(args).map((row) => pick(row, args?.select)),
      count: async (args: any) => list({ where: args?.where }).length,
      create: async (args: any) => create(args),
      update: async (args: any) => {
        // the organization row is the lock every lifecycle mutation takes first
        if (model === 'managedOrganization' && !ctx.release) {
          ctx.release = await this.lock(args.where.organizationId);
          ctx.tables = structuredClone(this.tables);
        }
        fail('update');
        const row = rows().find((item) => matches(item, args.where));
        if (!row) throw new Error('FAKE record to update not found');
        apply(row, args.data);
        return pick(row, args.select);
      },
      updateMany: async (args: any) => {
        fail('updateMany');
        const found = rows().filter((item) => matches(item, args.where));
        found.forEach((row) => apply(row, args.data));
        return { count: found.length };
      },
      upsert: async (args: any) => {
        const row = rows().find((item) => matches(item, args.where));
        if (row) {
          apply(row, args.update);
          return pick(row, args.select);
        }
        return create({ data: args.create, select: args.select });
      },
    };
  }

  // the object a PrismaTransaction holds as `.model`
  get model(): any {
    return {
      $transaction: async (func: (tx: any) => Promise<any>, options?: { isolationLevel?: string }) => {
        const ctx: Ctx = { tables: options?.isolationLevel ? structuredClone(this.tables) : null, release: null };
        try {
          const result = await func(Object.fromEntries(MODELS.map((model) => [model, this.delegate(model, ctx)])));
          if (ctx.release && ctx.tables) this.tables = ctx.tables;
          return result;
        } finally {
          ctx.release?.();
        }
      },
    };
  }
}

// ---- the retained draft ---------------------------------------------------------

const ORG = 'org_lifecycle_1';
const POST_ID = '5b2f7c1e-3a4d-4e8f-9b0a-1c2d3e4f5a6b';
const GROUP = 'group_lifecycle_1';
const INTEGRATION_ID = 'int_ig_1';
const NAMESPACE = 'FAKE-namespace-1';
const TOKEN = 'FAKE-provider-token-never-read';
const CREATED = new Date('2026-11-05T10:00:00.000Z');
const NOW = new Date('2026-11-05T12:00:00.000Z');
const PUBLISH_AT = '2026-11-06T09:00:00.000Z';
const SETTINGS = { post_type: 'post', collaborators: [{ label: 'partner' }] };
const POLICY = {
  grantedAt: new Date('2026-11-05T00:00:00.000Z'),
  expiresAt: new Date('2026-11-10T23:00:00.000Z'),
};
const OPEN: ManagedLifecycleConfiguredGates = {
  organizationEnabled: true,
  dispatcherAvailable: true,
  mediaDeliveryReady: true,
  policy: POLICY,
  providers: ['instagram-standalone'],
};
const PRINCIPAL: ManagedLifecyclePrincipal = {
  organizationId: ORG,
  credentialId: 'cred_ww_1',
  scopes: ['posts:read', 'posts:schedule', 'posts:publish'],
};

const sha256 = (seed: string) => createHash('sha256').update(seed).digest('hex');
const CONTENT_SHA256 = sha256('the payload W&W approved');

const LIBRARY: Record<string, { mimeType: string; ext: string; byteLength: number }> = {
  media_image: { mimeType: 'image/png', ext: 'png', byteLength: 3008 },
};
const storageKey = (mediaId: string) => `managed-${mediaId}.${LIBRARY[mediaId].ext}`;
const mediaPath = (mediaId: string) => `https://uploads.example/${storageKey(mediaId)}`;
const evidence = (mediaId: string) => ({
  id: `evidence_${mediaId}`,
  organizationId: ORG,
  mediaId,
  storedPath: mediaPath(mediaId),
  storageVersion: `FAKE-v1:${mediaId}`,
  storageKey: storageKey(mediaId),
  storageNamespace: NAMESPACE,
  sha256: sha256(`synthetic bytes of ${mediaId}`),
  byteLength: LIBRARY[mediaId].byteLength,
  mimeType: LIBRARY[mediaId].mimeType,
  method: 'UPLOAD_CAPTURE',
  sequence: 1,
});

const IDENTITY: IntegrationIdentity = {
  id: INTEGRATION_ID,
  organizationId: ORG,
  providerIdentifier: 'instagram-standalone',
  internalId: '17841400000000001',
  rootInternalId: null,
  profile: 'ww.test.acc',
  name: 'W&W test',
  customName: null,
  disabled: false,
  refreshNeeded: false,
  inBetweenSteps: false,
  deletedAt: null,
};

interface MemberSpec {
  content: string;
  delay?: number;
  media?: { mediaId: string; alt?: string }[];
}

const IMAGE_POST: MemberSpec[] = [
  { content: 'Hello &amp; welcome', media: [{ mediaId: 'media_image', alt: 'A test card' }] },
  { content: 'First comment', delay: 5 },
];

// the hash W&W derives from its own approved payload and retained upload
// binding, written out by hand; never taken from this server
const WW_RELEASE_HASH = fingerprint({
  v: 'ww-release-hash-v1',
  managedPostId: POST_ID,
  revision: 1,
  integrationId: INTEGRATION_ID,
  providerIdentifier: 'instagram-standalone',
  identityFingerprint: identityFingerprint(IDENTITY),
  codec: 'ww-plain-escape-v1',
  settingsHash: fingerprint({ collaborators: [{ label: 'partner' }], post_type: 'post' }),
  members: [
    {
      position: 0,
      delay: 0,
      text: 'Hello & welcome',
      media: [
        {
          position: 0,
          mediaId: 'media_image',
          evidenceId: 'evidence_media_image',
          sha256: sha256('synthetic bytes of media_image'),
          byteLength: 3008,
          mimeType: 'image/png',
          alt: 'A test card',
          thumbnail: null,
          thumbnailTimestampMs: null,
        },
      ],
    },
    { position: 1, delay: 5, text: 'First comment', media: [] },
  ],
});

// A managed post the way createDraft leaves it, plus a credential-bearing
// integration row the lifecycle must never read a secret from
function seed(db: FakeLifecycleDb, members: MemberSpec[], settings: Record<string, any>) {
  const t = db.tables;
  t.managedOrganization.push({ id: randomUUID(), organizationId: ORG, sequence: 5, createdAt: CREATED, updatedAt: CREATED });
  t.integration.push({ ...IDENTITY, token: TOKEN, refreshToken: TOKEN });
  t.managedChannelBinding.push({
    id: 'binding_1', organizationId: ORG, integrationId: INTEGRATION_ID, generation: 2, status: 'QUALIFIED',
    providerIdentifier: 'instagram-standalone', internalId: IDENTITY.internalId, profile: IDENTITY.profile,
    identityFingerprint: identityFingerprint(IDENTITY), qualifiedAt: CREATED, pausedAt: null,
  });
  const ids = [...new Set(members.flatMap((member) => (member.media || []).map((ref) => ref.mediaId)))];
  ids.forEach((mediaId) => {
    t.media.push({ id: mediaId, organizationId: ORG, name: `${mediaId}.png`, path: mediaPath(mediaId), status: 'ready', deletedAt: null });
    t.managedMediaEvidence.push(evidence(mediaId));
  });

  members.forEach((member, position) => {
    t.post.push({
      id: `post_${position}`, group: GROUP, organizationId: ORG, integrationId: INTEGRATION_ID,
      parentPostId: position ? `post_${position - 1}` : null, content: member.content, delay: member.delay ?? 0,
      image: JSON.stringify((member.media || []).map((ref) => ({
        id: ref.mediaId, name: `${ref.mediaId}.png`, path: mediaPath(ref.mediaId),
        ...(ref.alt !== undefined ? { alt: ref.alt } : {}),
      }))),
      settings: JSON.stringify({ ...settings, __type: 'instagram-standalone' }),
      publishDate: new Date('2026-11-08T12:00:00.000Z'), state: 'DRAFT', deletedAt: null,
      createdAt: new Date(CREATED.getTime() + position), updatedAt: CREATED,
    });
  });

  const snapshot: ManagedPostSnapshot = {
    managedPostId: POST_ID, group: GROUP, integrationId: INTEGRATION_ID, revision: 1, bindingGeneration: 2,
    state: 'DRAFT', intendedPublishDate: '2026-11-08T12:00:00.000Z', settings,
    members: members.map((member, position) => ({
      postId: `post_${position}`, position, role: position === 0 ? 'ROOT' : 'CHILD',
      parentPostId: position ? `post_${position - 1}` : null, content: member.content, delay: member.delay ?? 0,
      media: (member.media || []).map((ref, index) => {
        const row = evidence(ref.mediaId);
        return {
          position: index, mediaId: ref.mediaId, evidenceId: row.id, sha256: row.sha256,
          byteLength: row.byteLength, mimeType: row.mimeType, method: row.method,
          ...(ref.alt !== undefined ? { alt: ref.alt } : {}),
        };
      }),
    })),
    operationKey: 'ww-op-create-1', payloadHash: fingerprint({ synthetic: true }), sequence: 5,
    revisedAt: CREATED.toISOString(),
  };
  t.managedPost.push({
    id: POST_ID, organizationId: ORG, integrationId: INTEGRATION_ID, group: GROUP, revision: 1,
    bindingGeneration: 2, rowFingerprint: rowFingerprint(t.post as PostRow[]), lastSequence: 5,
    createdOperationKey: 'ww-op-create-1', lastOperationKey: 'ww-op-create-1', createdAt: CREATED, updatedAt: CREATED,
  });
  t.managedPostRevision.push({
    id: randomUUID(), managedPostId: POST_ID, organizationId: ORG, revision: 1, operationKey: 'ww-op-create-1',
    payloadHash: snapshot.payloadHash, sequence: 5, snapshot: JSON.stringify(snapshot), createdAt: CREATED,
  });
  t.managedOperation.push({
    id: randomUUID(), organizationId: ORG, operationKey: 'ww-op-create-1', kind: 'CREATE_DRAFT',
    payloadHash: snapshot.payloadHash, managedPostId: POST_ID, revision: 1, sequence: 5,
    credentialId: 'cred_ww_1', createdAt: CREATED,
  });
}

// FAKE pinned storage with the rules of ManagedLifecycleMediaStorage; bytes
// are never opened by an acceptance
class FakePinnedStorage {
  versions = new Map<string, string | null>();
  constructor(private readonly db: FakeLifecycleDb) {}

  async pinnedEvidence(organizationId: string, mediaId: string) {
    const media = this.db.tables.media.find((row) => row.id === mediaId && row.organizationId === organizationId);
    const row = this.db.tables.managedMediaEvidence.find((item) => item.mediaId === mediaId && item.storedPath === media?.path);
    if (!media || media.status !== 'ready' || !row) return null;
    return {
      mediaId, evidenceId: row.id, sha256: row.sha256, byteLength: row.byteLength, mimeType: row.mimeType,
      storageKey: row.storageKey, storageNamespace: row.storageNamespace, storageVersion: row.storageVersion,
    };
  }
  async namespace() {
    return NAMESPACE;
  }
  async versionAt(key: string) {
    return this.versions.has(key)
      ? this.versions.get(key)!
      : this.db.tables.managedMediaEvidence.find((row) => row.storageKey === key)?.storageVersion ?? null;
  }
  async openAt(): Promise<never> {
    throw new Error('an acceptance never opens media bytes');
  }
}

function harness(options: { config?: ManagedLifecycleConfiguredGates | null; members?: MemberSpec[]; settings?: Record<string, any> } = {}) {
  const db = new FakeLifecycleDb();
  seed(db, options.members ?? IMAGE_POST, options.settings ?? SETTINGS);
  const storage = new FakePinnedStorage(db);
  const clock: { at: Date; now(): Date } = { at: NOW, now: () => new Date(clock.at) };
  const state = { config: 'config' in options ? options.config : OPEN };
  const configuration = { gates: jest.fn(async () => (state.config ? { ...state.config } : null)) };
  const adapter = new InstagramStandalonePublishAdapter({ mediaOrigin: null });
  const prepare = jest.spyOn(adapter, 'prepare');
  const repository = new ManagedLifecycleRepository({ model: db.model } as any);
  const service = new ManagedLifecycleService(
    repository,
    storage,
    configuration,
    clock,
    new Map([[adapter.identifier, adapter]])
  );
  return { db, storage, clock, state, configuration, prepare, repository, service };
}

const scheduleBody = (overrides: Record<string, unknown> = {}) => ({
  version: 'ww.managed-lifecycle.v1',
  operationKey: 'ww-op-schedule-1',
  expectedRevision: 1,
  expectedBindingGeneration: 2,
  expectedScheduleGeneration: 0,
  releaseHash: WW_RELEASE_HASH,
  contentSha256: CONTENT_SHA256,
  codec: 'ww-plain-escape-v1',
  maxLatenessMs: 600000,
  publishAt: PUBLISH_AT,
  repeat: null,
  ...overrides,
});

const publishBody = (overrides: Record<string, unknown> = {}) => ({
  version: 'ww.managed-lifecycle.v1',
  operationKey: 'ww-op-publish-1',
  expectedRevision: 1,
  expectedBindingGeneration: 2,
  expectedScheduleGeneration: 0,
  releaseHash: WW_RELEASE_HASH,
  contentSha256: CONTENT_SHA256,
  codec: 'ww-plain-escape-v1',
  maxLatenessMs: 300000,
  ...overrides,
});

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ManagedLifecycleException) {
      return { code: err.code, reason: err.reason ?? null, body: JSON.stringify(err.getResponse()) };
    }
    throw err;
  }
  throw new Error('the request was not refused');
}

// the lock statement of a committed transaction only touches this timestamp
const stable = (tables: Tables) => ({
  ...tables,
  managedOrganization: tables.managedOrganization.map((row) => ({ ...row, updatedAt: null })),
});

// every refusal leaves every table exactly as it was: no claim, no event
async function refusedWithoutWrites(h: ReturnType<typeof harness>, promise: Promise<unknown>) {
  const before = structuredClone(h.db.tables);
  const refused = await refusal(promise);
  expect(h.db.tables).toEqual(before);
  return refused;
}

// a lifecycle-authorized row change, as the dispatcher would make it
function authorizedRows(h: ReturnType<typeof harness>, change: (row: Row) => void) {
  h.db.tables.post.forEach(change);
  h.db.tables.managedPost[0].rowFingerprint = rowFingerprint(h.db.tables.post as PostRow[]);
}

// ---- ending writes ----------------------------------------------------------------

const DUE_1 = '2026-11-07T09:00:00.000Z';
const DUE_2 = '2026-11-08T09:00:00.000Z';
const DUE_3 = '2026-11-09T09:00:00.000Z';
const series = (count: number) => ({
  repeat: { intervalDays: 1, maxOccurrences: count, dueAts: [PUBLISH_AT, DUE_1, DUE_2, DUE_3].slice(0, count) },
});

const pendingAt = (occurrence: number, dueAt: string, dispatchId: string, expectedDispatchVersion = 1) =>
  ({ state: 'PENDING', occurrence, dueAt, dispatchId, expectedDispatchVersion });
const notMaterialized = (occurrence: number, dueAt: string) => ({ state: 'NOT_MATERIALIZED', occurrence, dueAt });

// The scope W&W previews and its human confirms, hashed the way that
// confirmation binds it; never read back from this server's answer
function scopeOf(scope: string, scheduleId: string, expectedScheduleVersion: number, affected: Row[], inFlight: Row | null = null) {
  return {
    scheduleId,
    expectedScheduleVersion,
    affected,
    affectedHash: fingerprint(lifecycleAffectedHashInput(scope as any, { scheduleId, expectedScheduleVersion, affected: affected as any, inFlight: inFlight as any })),
  };
}

const cancelBody = (fields: Record<string, unknown>) => ({
  version: 'ww.managed-lifecycle.v1',
  operationKey: 'ww-op-cancel-1',
  expectedRevision: 1,
  expectedScheduleGeneration: 1,
  ...fields,
});

const deleteBody = (fields: Record<string, unknown> = {}) => ({
  version: 'ww.managed-lifecycle.v1',
  operationKey: 'ww-op-delete-1',
  expectedRevision: 1,
  expectedScheduleGeneration: 0,
  expectedLifecycle: 'DRAFT',
  effect: 'RETAINED_SOFT_DELETE',
  cancels: null,
  ...fields,
});

const OBSERVED = { source: 'HUMAN_OBSERVATION', observedAt: '2026-11-06T09:30:00.000Z', note: 'Checked the account by hand' };
const member = (position: number, expectedStatus: string, outcome: string | null = null, releaseURL: string | null = null) =>
  ({ position, postId: `post_${position}`, expectedStatus, outcome, releaseURL, releaseId: null });
const NOT_PUBLISHED = { resolution: 'RESOLVED_NOT_PUBLISHED', members: [member(0, 'UNKNOWN', 'NOT_PUBLISHED'), member(1, 'NOT_SENT')] };
const COMMENT_PUBLISHED = {
  resolution: 'RESOLVED_PUBLISHED',
  members: [member(0, 'PUBLISHED'), member(1, 'UNKNOWN', 'PUBLISHED', 'https://www.instagram.com/p/C0mment/')],
};

const resolveBody = (dispatch: Row, fields: Record<string, unknown>) => ({
  version: 'ww.managed-lifecycle.v1',
  operationKey: 'ww-op-resolve-1',
  expectedDispatchVersion: dispatch.version,
  expectedStatus: dispatch.status,
  expectedScheduleGeneration: 1,
  evidence: OBSERVED,
  ...fields,
});

// An occurrence as the dispatcher leaves it once it settled unresolved: the
// root lost (UNKNOWN), or the comment lost after the root published (PARTIAL)
function settleUnresolved(h: ReturnType<typeof harness>, occurrence: number, status: 'UNKNOWN' | 'PARTIAL') {
  const row = h.db.tables.managedDispatch.find((item) => item.occurrence === occurrence)!;
  const lost = { status: 'UNKNOWN', code: 'OUTCOME_UNKNOWN', release: null };
  const members = status === 'UNKNOWN'
    ? [{ position: 0, postId: 'post_0', ...lost }, { position: 1, postId: 'post_1', status: 'NOT_SENT', code: 'PREVIOUS_MEMBER_FAILED', release: null }]
    : [
        { position: 0, postId: 'post_0', status: 'PUBLISHED', code: null, release: { releaseId: '17900000000000001', releaseURL: null, source: 'PROVIDER_RESPONSE' } },
        { position: 1, postId: 'post_1', ...lost },
      ];
  Object.assign(row, {
    status, code: 'OUTCOME_UNKNOWN', members: JSON.stringify(members), version: row.version + 3,
    admittedAt: row.dueAt, settledAt: new Date(row.dueAt.getTime() + 60000), nextActionAt: null,
  });
  h.db.tables.managedPostLifecycle[0].lifecycle = 'REVIEW';
  h.clock.at = new Date('2026-11-06T10:00:00.000Z');
  return row;
}

// The schedule as the journal's settlement (endSchedule) leaves it when an
// occurrence settled as `endedCode`: HALTED with no ending operation, the end
// request and lastOccurrence kept, and the post no longer on a live schedule
function haltedBySettlement(h: ReturnType<typeof harness>, endedCode: string) {
  const schedule = h.db.tables.managedSchedule[0];
  Object.assign(schedule, {
    status: 'HALTED', endedAt: h.clock.at, endedCode, version: schedule.version + 1,
  });
  h.db.tables.managedPostLifecycle[0].activeScheduleId = null;
  return schedule;
}

// one occurrence published and the schedule completed, as the dispatcher
// would leave them
function publishedOnce(h: ReturnType<typeof harness>) {
  const at = new Date('2026-11-06T09:01:00.000Z');
  Object.assign(h.db.tables.managedSchedule[0], { status: 'COMPLETED', endedAt: at });
  Object.assign(h.db.tables.managedDispatch[0], {
    status: 'PUBLISHED', version: 4, admittedAt: new Date(PUBLISH_AT), settledAt: at, nextActionAt: null,
    members: JSON.stringify([0, 1].map((position) => ({
      position, postId: `post_${position}`, status: 'PUBLISHED', code: null,
      release: { releaseId: `1790000000000000${position}`, releaseURL: null, source: 'PROVIDER_RESPONSE' },
    }))),
  });
  Object.assign(h.db.tables.managedPostLifecycle[0], { lifecycle: 'PUBLISHED', activeScheduleId: null });
  authorizedRows(h, (row) => void (row.state = 'PUBLISHED'));
  h.clock.at = new Date('2026-11-06T10:00:00.000Z');
}

// A four-day series: occurrence 0 skipped, then truncated from 3 and again
// from 2, so occurrence 1 is still pending under the first end request
async function truncatedTwice(h: ReturnType<typeof harness>) {
  const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(4)));
  const { scheduleId } = scheduled.schedule!;
  await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
    operationKey: 'ww-op-skip-0', scope: 'OCCURRENCE', occurrence: 0,
    ...scopeOf('OCCURRENCE', scheduleId, 1, [pendingAt(0, PUBLISH_AT, scheduled.dispatches[0].dispatchId)]),
  }));
  const first = await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
    operationKey: 'ww-op-truncate-3', scope: 'REMAINING', fromOccurrence: 3, inFlight: null,
    ...scopeOf('REMAINING', scheduleId, 2, [notMaterialized(3, DUE_3)]),
  }));
  const second = await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
    operationKey: 'ww-op-truncate-2', scope: 'REMAINING', fromOccurrence: 2, inFlight: null,
    ...scopeOf('REMAINING', scheduleId, 3, [notMaterialized(2, DUE_2)]),
  }));
  const pending = h.db.tables.managedDispatch.find((row) => row.occurrence === 1)!;
  return { scheduleId, first, second, pending };
}

// The actual dispatch journal with the service as its event port. Its
// budget and release validator are FAKE ports that always admit; the
// production composition supplies the real ones. Nothing is sent
function journalOf(h: ReturnType<typeof harness>) {
  return new ManagedDispatchJournal({
    repository: h.repository,
    budget: {
      reserve: async () => true,
      reserveDetailed: async () => ({ accepted: true, code: 'RESERVED', retryAfterMs: null }),
    } as any,
    now: () => h.clock.now(),
    validate: async () => true,
    event: (store, kind, dispatch) => h.service.recordDispatchEvent(store, kind, dispatch),
  });
}

const PRIVATE = [
  TOKEN,
  'cred_ww_1',
  IDENTITY.internalId,
  IDENTITY.profile,
  'https://',
  'uploads.example',
  'managed-media',
  NAMESPACE,
  'FAKE-v1',
  '__type',
  'partner',
];

// no network: a fetch anywhere in the service fails the test
let fetchSpy: jest.SpyInstance | null = null;
beforeEach(() => {
  fetchSpy =
    typeof (globalThis as any).fetch === 'function'
      ? jest.spyOn(globalThis as any, 'fetch').mockImplementation(() => {
          throw new Error('no network in the lifecycle service');
        })
      : null;
});
afterEach(() => {
  if (fetchSpy) {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  }
});

describe('ManagedLifecycleService', () => {
  describe('capabilities', () => {
    it('closes every gate when nothing is configured', async () => {
      const { service } = harness({ config: null });
      const document = await service.capabilities(PRINCIPAL);
      expect(document.gates).toEqual({
        organization: 'NOT_ENABLED', dispatcher: 'NOT_AVAILABLE', media: 'NOT_READY',
        policy: 'CLOSED', grantedAt: null, expiresAt: null,
      });
      expect(document.publication).toEqual({ qualified: false, providers: [] });
    });

    it('states the enabled adapter from its own descriptors', async () => {
      const { service } = harness();
      const document = await service.capabilities(PRINCIPAL);
      expect(parseManagedLifecycleResponse('CAPABILITIES', document)).toEqual(document);
      expect(document.publication).toEqual({
        qualified: true,
        providers: [{
          identifier: 'instagram-standalone', editor: 'normal', requiresMedia: true,
          maxStepUnits: 21, maxStepDeadlineMs: 120000,
        }],
      });
      expect(document.gates.expiresAt).toBe('2026-11-10T23:00:00.000Z');
    });

    it.each([
      ['longer than seven days', { grantedAt: new Date('2026-11-03T00:00:00.000Z'), expiresAt: POLICY.expiresAt }],
      ['after the cutoff', { grantedAt: POLICY.grantedAt, expiresAt: new Date('2026-11-11T00:00:00.000Z') }],
    ])('qualifies nothing under a policy %s', async (_, policy) => {
      const { service } = harness({ config: { ...OPEN, policy } });
      const document = await service.capabilities(PRINCIPAL);
      expect(document.gates.policy).toBe('CLOSED');
      expect(document.publication.qualified).toBe(false);
    });

    it('lists no provider without an adapter, whatever the configuration names', async () => {
      const { service } = harness({ config: { ...OPEN, providers: ['instagram', 'x'] } });
      expect((await service.capabilities(PRINCIPAL)).publication).toEqual({ qualified: false, providers: [] });
    });
  });

  describe('scopes', () => {
    it('requires posts:schedule and posts:publish themselves, before reading anything', async () => {
      const h = harness();
      const writer = { ...PRINCIPAL, scopes: ['posts:read', 'posts:write'] };
      expect(await refusedWithoutWrites(h, h.service.schedule(writer, POST_ID, scheduleBody())))
        .toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
      expect(await refusedWithoutWrites(h, h.service.publishNow({ ...PRINCIPAL, scopes: ['posts:schedule'] }, POST_ID, publishBody())))
        .toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
      expect(await refusal(h.service.lifecycle({ ...PRINCIPAL, scopes: ['posts:schedule'] }, POST_ID)))
        .toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
      expect(h.configuration.gates).not.toHaveBeenCalled();
    });
  });

  describe('SCHEDULE', () => {
    it('accepts an AT schedule: one next-generation schedule and its pending occurrence 0, nothing sent', async () => {
      const h = harness();
      const snapshot = h.db.tables.managedPostRevision[0].snapshot;

      const result = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());

      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({
        kind: 'SCHEDULE', operationKey: 'ww-op-schedule-1', replayed: false, sequence: 1,
        committedAt: NOW.toISOString(), managedPostId: POST_ID, revision: 1, scheduleGeneration: 1,
        lifecycle: 'SCHEDULED',
      });
      expect(result.schedule).toMatchObject({
        mode: 'AT', status: 'ACTIVE', scheduleGeneration: 1, scheduleVersion: 1, releaseHash: WW_RELEASE_HASH,
        contentSha256: CONTENT_SHA256, anchorAt: PUBLISH_AT, intervalDays: null, maxOccurrences: 1,
        dueAts: [PUBLISH_AT], windowEndsAt: '2026-11-10T23:00:00.000Z', maxLatenessMs: 600000, lastOccurrence: 0,
      });
      expect(result.dispatches).toHaveLength(1);
      expect(result.dispatches[0]).toMatchObject({
        occurrence: 0, status: 'PENDING', dispatchVersion: 1, dueAt: PUBLISH_AT,
        admissibleUntil: '2026-11-06T09:10:00.000Z', scheduleGeneration: 1, continuation: null, admittedAt: null,
        members: [
          { position: 0, postId: 'post_0', status: 'WAITING', code: null, release: null },
          { position: 1, postId: 'post_1', status: 'WAITING', code: null, release: null },
        ],
      });

      // the rows are QUEUE at the due time under a recorded fingerprint; the
      // revision, its snapshot and the DRAFT feed stay
      const t = h.db.tables;
      expect(t.post.map((row) => [row.state, row.publishDate.toISOString(), row.content])).toEqual([
        ['QUEUE', PUBLISH_AT, 'Hello &amp; welcome'],
        ['QUEUE', PUBLISH_AT, 'First comment'],
      ]);
      expect(t.managedPost[0]).toMatchObject({ revision: 1, lastSequence: 5, lastOperationKey: 'ww-op-create-1' });
      expect(t.managedPost[0].rowFingerprint).toBe(rowFingerprint(t.post as PostRow[]));
      expect(t.managedPostRevision).toHaveLength(1);
      expect(t.managedPostRevision[0].snapshot).toBe(snapshot);
      expect(t.managedOrganization[0].sequence).toBe(5);
      expect(t.managedChangeEvent).toEqual([]);

      // the shared claim has no DRAFT feed position; the stored answer is
      // exactly what was answered
      expect(t.managedOperation.find((row) => row.operationKey === 'ww-op-schedule-1')).toMatchObject({
        kind: 'SCHEDULE', sequence: 0, credentialId: 'cred_ww_1', revision: 1, managedPostId: POST_ID,
      });
      expect(JSON.parse(t.managedLifecycleOperation[0].result)).toEqual(result);
      expect(t.managedLifecycleOrganization[0].sequence).toBe(1);
      expect(t.managedLifecycleChangeEvent).toHaveLength(1);
      expect(t.managedPostLifecycle[0]).toMatchObject({
        lifecycle: 'SCHEDULED', scheduleGeneration: 1, activeScheduleId: result.schedule!.scheduleId,
        lastLifecycleSequence: 1, lastOperationKey: 'ww-op-schedule-1', version: 1,
      });

      // the adapter checked the exact release; nothing admitted, no call
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(t.managedDispatchCall).toEqual([]);
      expect(t.managedDispatch[0]).toMatchObject({ leaseHolder: null, activeCallId: null, admittedAt: null });
    });

    it('keeps the private release free of credentials, tokens, paths and storage pins', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const schedule = h.db.tables.managedSchedule[0];
      const release = JSON.parse(schedule.release);
      expect(release).toMatchObject({
        v: 'ww-scheduled-release-v1', dueAts: [PUBLISH_AT], releaseHash: WW_RELEASE_HASH,
        settings: SETTINGS, internalId: IDENTITY.internalId, profile: IDENTITY.profile,
      });
      expect(release.members.map((member: any) => member.text)).toEqual(['Hello & welcome', 'First comment']);
      expect(release).not.toHaveProperty('rowFingerprint');
      for (const secret of [TOKEN, 'https://', 'uploads.example', 'managed-media', NAMESPACE, 'FAKE-v1', '__type']) {
        expect(schedule.release).not.toContain(secret);
      }
      expect(schedule).toMatchObject({
        policyGrantedAt: POLICY.grantedAt, policyExpiresAt: POLICY.expiresAt, credentialId: 'cred_ww_1',
        releaseHashVersion: 'ww-release-hash-v1', contentSha256: CONTENT_SHA256,
      });
    });

    it('captures a bounded anchored repeat and materializes only occurrence 0', async () => {
      const h = harness();
      const dueAts = ['2026-11-06T09:00:00.000Z', '2026-11-07T09:00:00.000Z', '2026-11-08T09:00:00.000Z'];
      const result = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({
        repeat: { intervalDays: 1, maxOccurrences: 3, dueAts },
      }));
      expect(result.schedule).toMatchObject({ intervalDays: 1, maxOccurrences: 3, dueAts, lastOccurrence: 2 });
      expect(result.dispatches.map((dispatch) => dispatch.occurrence)).toEqual([0]);
      expect(h.db.tables.managedDispatch).toHaveLength(1);
      expect(JSON.parse(h.db.tables.managedSchedule[0].release).dueAts).toEqual(dueAts);
    });

    it('keeps the approved content digest opaque, as sent', async () => {
      const h = harness();
      const digest = sha256('any digest W&W computed');
      const result = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({ contentSha256: digest }));
      expect(result.schedule!.contentSha256).toBe(digest);
      expect(h.db.tables.managedDispatch[0].contentSha256).toBe(digest);
    });

    it('schedules again after an older occurrence published, from PUBLISHED rows', async () => {
      const h = harness();
      const first = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      // the earlier schedule completed: as the dispatcher would leave it
      Object.assign(h.db.tables.managedSchedule[0], { status: 'COMPLETED', endedAt: new Date('2026-11-06T09:01:00.000Z') });
      Object.assign(h.db.tables.managedDispatch[0], { status: 'PUBLISHED', admittedAt: new Date(PUBLISH_AT), settledAt: new Date('2026-11-06T09:01:00.000Z') });
      Object.assign(h.db.tables.managedPostLifecycle[0], { lifecycle: 'PUBLISHED', activeScheduleId: null });
      authorizedRows(h, (row) => void (row.state = 'PUBLISHED'));
      h.clock.at = new Date('2026-11-06T10:00:00.000Z');

      const second = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({
        operationKey: 'ww-op-schedule-2', expectedScheduleGeneration: 1, publishAt: '2026-11-08T09:00:00.000Z',
      }));
      expect(second).toMatchObject({ scheduleGeneration: 2, sequence: 2, lifecycle: 'SCHEDULED' });
      expect(h.db.tables.post.map((row) => row.state)).toEqual(['QUEUE', 'QUEUE']);
      expect(h.db.tables.managedPost[0].rowFingerprint).toBe(rowFingerprint(h.db.tables.post as PostRow[]));

      const lifecycle = await h.service.lifecycle(PRINCIPAL, POST_ID);
      expect(lifecycle).toMatchObject({ scheduleGeneration: 2, scheduleCount: 2, lifecycle: 'SCHEDULED', asOfSequence: 2 });
      expect(lifecycle.dispatches.map((dispatch) => dispatch.dispatchId)).toEqual([second.dispatches[0].dispatchId]);

      expect(await h.service.operation(PRINCIPAL, first.operationKey)).toMatchObject({
        status: 'COMMITTED', ack: 'SUPERSEDED', currentScheduleGeneration: 2, currentLifecycle: 'SCHEDULED',
      });
      expect(await h.service.operation(PRINCIPAL, second.operationKey)).toMatchObject({ status: 'COMMITTED', ack: 'CURRENT' });
    });

    it('stays SCHEDULED while its series is live, even once an earlier occurrence left the rows PUBLISHED', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({
        repeat: { intervalDays: 1, maxOccurrences: 2, dueAts: [PUBLISH_AT, '2026-11-07T09:00:00.000Z'] },
      }));
      authorizedRows(h, (row) => void (row.state = 'PUBLISHED'));
      expect((await h.service.lifecycle(PRINCIPAL, POST_ID)).lifecycle).toBe('SCHEDULED');
    });
  });

  describe('PUBLISH_NOW', () => {
    it('is due at the server time of acceptance and never repeats', async () => {
      const h = harness();
      const result = await h.service.publishNow(PRINCIPAL, POST_ID, publishBody());
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({ kind: 'PUBLISH_NOW', scheduleGeneration: 1, lifecycle: 'SCHEDULED' });
      expect(result.schedule).toMatchObject({
        mode: 'NOW', anchorAt: NOW.toISOString(), dueAts: [NOW.toISOString()], intervalDays: null, maxOccurrences: 1,
      });
      expect(result.dispatches[0]).toMatchObject({
        status: 'PENDING', dueAt: NOW.toISOString(), admissibleUntil: '2026-11-05T12:05:00.000Z',
      });
      expect(h.db.tables.managedLifecycleChangeEvent[0].kind).toBe('POST_PUBLISH_REQUESTED');
      expect(h.db.tables.post.every((row) => row.state === 'QUEUE' && row.publishDate.getTime() === NOW.getTime())).toBe(true);
    });

    it('refuses a live schedule: no implicit cancel', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      expect(await refusedWithoutWrites(h, h.service.publishNow(PRINCIPAL, POST_ID, publishBody({ expectedScheduleGeneration: 1 }))))
        .toMatchObject({ code: 'SCHEDULE_ACTIVE' });
    });
  });

  describe('idempotency', () => {
    it('replays the exact stored answer, without an event, whatever the gates and time are now', async () => {
      const h = harness();
      const first = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      h.state.config = null;
      h.clock.at = new Date('2026-11-12T00:00:00.000Z');
      const before = structuredClone(h.db.tables);

      const again = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      expect(again).toEqual({ ...first, replayed: true });
      expect(stable(h.db.tables)).toEqual(stable(before));
    });

    it.each<[string, () => [ManagedLifecyclePrincipal, 'schedule' | 'publishNow', Record<string, unknown>], string]>([
      ['another credential', () => [{ ...PRINCIPAL, credentialId: 'cred_ww_2' }, 'schedule', scheduleBody()], 'OPERATION_KEY_CREDENTIAL_MISMATCH'],
      ['another body', () => [PRINCIPAL, 'schedule', scheduleBody({ maxLatenessMs: 1000 })], 'OPERATION_KEY_PAYLOAD_MISMATCH'],
      ['another operation', () => [PRINCIPAL, 'publishNow', publishBody({ operationKey: 'ww-op-schedule-1' })], 'OPERATION_KEY_KIND_MISMATCH'],
    ])('refuses the committed key with %s, before any gate', async (_, request, code) => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      h.state.config = null;
      const [principal, method, body] = request();
      expect(await refusedWithoutWrites(h, h.service[method](principal, POST_ID, body))).toMatchObject({ code });
    });

    it('refuses a DRAFT key with the typed kind mismatch', async () => {
      const h = harness();
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({ operationKey: 'ww-op-create-1' }))))
        .toMatchObject({ code: 'OPERATION_KEY_KIND_MISMATCH' });
    });

    it('never answers a stored result that does not match its record', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const row = h.db.tables.managedLifecycleOperation[0];
      row.result = JSON.stringify({ ...JSON.parse(row.result), sequence: 2 });
      await expect(h.service.schedule(PRINCIPAL, POST_ID, scheduleBody())).rejects.toBeInstanceOf(ManagedLifecycleProjectionError);
      await expect(h.service.operation(PRINCIPAL, 'ww-op-schedule-1')).rejects.toBeInstanceOf(ManagedLifecycleProjectionError);
    });

    it('serializes a race on one key: one commit, one replay', async () => {
      const h = harness();
      const [a, b] = await Promise.all([
        h.service.schedule(PRINCIPAL, POST_ID, scheduleBody()),
        h.service.schedule(PRINCIPAL, POST_ID, scheduleBody()),
      ]);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(h.db.tables.managedSchedule).toHaveLength(1);
      expect(h.db.tables.managedLifecycleChangeEvent).toHaveLength(1);
    });

    it('lets one of two racing keys win the generation', async () => {
      const h = harness();
      const outcomes = await Promise.allSettled([
        h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({ operationKey: 'ww-op-race-a' })),
        h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({ operationKey: 'ww-op-race-b' })),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const lost = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'SCHEDULE_GENERATION_CONFLICT' });
      expect(h.db.tables.managedSchedule).toHaveLength(1);
      expect(h.db.tables.managedOperation.filter((row) => row.sequence === 0)).toHaveLength(1);
    });
  });

  describe('refusals before anything is queued', () => {
    it('refuses everything while configuration is empty', async () => {
      const h = harness({ config: null });
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody())))
        .toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
      expect(await refusedWithoutWrites(h, h.service.publishNow(PRINCIPAL, POST_ID, publishBody())))
        .toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
    });

    it.each<[string, Partial<ManagedLifecycleConfiguredGates>, string, string | null]>([
      ['the organization not enabled', { organizationEnabled: false }, 'LIFECYCLE_NOT_ENABLED', null],
      ['no dispatcher', { dispatcherAvailable: false }, 'LIFECYCLE_NOT_AVAILABLE', null],
      ['no policy', { policy: null }, 'LIFECYCLE_NOT_ENABLED', 'POLICY_INVALID'],
      ['a policy over seven days', { policy: { grantedAt: new Date('2026-11-03T00:00:00.000Z'), expiresAt: POLICY.expiresAt } }, 'LIFECYCLE_NOT_ENABLED', 'POLICY_TOO_LONG'],
      ['a policy past the cutoff', { policy: { grantedAt: POLICY.grantedAt, expiresAt: new Date('2026-11-11T00:00:00.000Z') } }, 'LIFECYCLE_NOT_ENABLED', 'POLICY_AFTER_CUTOFF'],
      ['a policy not started', { policy: { grantedAt: new Date('2026-11-05T13:00:00.000Z'), expiresAt: POLICY.expiresAt } }, 'LIFECYCLE_NOT_ENABLED', 'POLICY_NOT_STARTED'],
      ['no enabled adapter', { providers: [] }, 'PROVIDER_NOT_QUALIFIED', null],
      ['media delivery not ready', { mediaDeliveryReady: false }, 'PROVIDER_NOT_QUALIFIED', null],
    ])('refuses with %s', async (_, change, code, reason) => {
      const h = harness({ config: { ...OPEN, ...change } });
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody())))
        .toMatchObject({ code, reason });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['publishAt under a minute ahead', { publishAt: '2026-11-05T12:00:30.000Z' }, 'PUBLISH_AT_TOO_SOON'],
      ['an occurrence at the policy end', { publishAt: '2026-11-09T09:00:00.000Z', repeat: { intervalDays: 1, maxOccurrences: 3, dueAts: ['2026-11-09T09:00:00.000Z', '2026-11-10T09:00:00.000Z', '2026-11-11T09:00:00.000Z'] } }, 'OCCURRENCE_AT_OR_AFTER_EXPIRY'],
    ])('refuses %s', async (_, change, reason) => {
      const h = harness();
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(change))))
        .toMatchObject({ code: 'OUTSIDE_LIFECYCLE_WINDOW', reason });
    });

    it('refuses after the policy expired', async () => {
      const h = harness();
      h.clock.at = POLICY.expiresAt;
      expect(await refusedWithoutWrites(h, h.service.publishNow(PRINCIPAL, POST_ID, publishBody())))
        .toMatchObject({ code: 'OUTSIDE_LIFECYCLE_WINDOW', reason: 'POLICY_EXPIRED' });
    });

    it.each<[string, unknown]>([
      ['an unknown key', scheduleBody({ extra: true })],
      ['a missing key', Object.fromEntries(Object.entries(scheduleBody()).filter(([key]) => key !== 'repeat'))],
      ['another version', scheduleBody({ version: 'ww.managed-lifecycle.v2' })],
      ['an unknown codec', scheduleBody({ codec: 'ww-html-v9' })],
      ['dueAts that are not anchored', scheduleBody({ repeat: { intervalDays: 1, maxOccurrences: 2, dueAts: [PUBLISH_AT, '2026-11-07T09:00:01.000Z'] } })],
      ['a 14-day repeat', scheduleBody({ repeat: { intervalDays: 7, maxOccurrences: 2, dueAts: [PUBLISH_AT, '2026-11-13T09:00:00.000Z'] } })],
    ])('refuses %s strictly', async (_, body) => {
      const h = harness();
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, body)))
        .toMatchObject({ code: 'LIFECYCLE_INPUT_INVALID' });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['another revision', { expectedRevision: 2 }, 'REVISION_CONFLICT'],
      ['another binding generation', { expectedBindingGeneration: 3 }, 'BINDING_GENERATION_MISMATCH'],
      ['another schedule generation', { expectedScheduleGeneration: 1 }, 'SCHEDULE_GENERATION_CONFLICT'],
      ['a release hash this server would not send', { releaseHash: fingerprint({ other: true }) }, 'RELEASE_HASH_MISMATCH'],
      ['the paragraph codec for plain content', { codec: 'ww-plain-paragraph-escape-v1' }, 'CODEC_REFUSED'],
    ])('refuses %s', async (_, change, code) => {
      const h = harness();
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(change))))
        .toMatchObject({ code });
    });

    it('refuses content the strict decoder refuses, without answering it', async () => {
      const h = harness({ members: [{ content: 'Tom & Jerry', media: [{ mediaId: 'media_image' }] }] });
      const refused = await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody()));
      expect(refused).toMatchObject({ code: 'CODEC_REFUSED', reason: 'ENTITY_NOT_CANONICAL' });
      expect(refused.body).not.toContain('Tom & Jerry');
    });

    it('refuses media no longer at its pinned version', async () => {
      const h = harness();
      h.storage.versions.set(storageKey('media_image'), 'FAKE-v2');
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody())))
        .toMatchObject({ code: 'MEDIA_NOT_CURRENT' });
    });

    it('refuses rows changed outside the managed API', async () => {
      const h = harness();
      h.db.tables.post[1].content = 'Edited elsewhere';
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody())))
        .toMatchObject({ code: 'POST_DRIFTED' });
    });

    it('refuses a release the adapter would not send, with the hash W&W compared', async () => {
      const h = harness({ settings: { post_type: 'story' } });
      const { releaseHash } = await h.service.releasePreview(PRINCIPAL, POST_ID, { revision: '1', codec: 'ww-plain-escape-v1' });
      const refused = await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({ releaseHash })));
      expect(refused.code).toBe('POST_NOT_SCHEDULABLE');
      expect(refused.body).toContain('TEXT_NOT_SUPPORTED');
    });

    it('refuses a deleted post', async () => {
      const h = harness();
      h.db.tables.managedPostLifecycle.push({
        id: randomUUID(), organizationId: ORG, managedPostId: POST_ID, lifecycle: 'DELETED', scheduleGeneration: 0,
        activeScheduleId: null, version: 2, lastLifecycleSequence: 0, deletedAt: CREATED,
        deletedOperationKey: 'ww-op-delete-1', createdAt: CREATED, updatedAt: CREATED,
      });
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody())))
        .toMatchObject({ code: 'POST_DELETED' });
    });

    it.each<[string, string, string]>([
      ['an unknown outcome', 'UNKNOWN', 'DISPATCH_UNRESOLVED'],
      ['a partial thread', 'PARTIAL', 'DISPATCH_UNRESOLVED'],
      ['an admitted call', 'ADMITTED', 'DISPATCH_IN_PROGRESS'],
    ])('refuses a new schedule while an earlier occurrence has %s', async (_, status, code) => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      Object.assign(h.db.tables.managedSchedule[0], { status: 'HALTED', endedAt: new Date('2026-11-06T09:30:00.000Z') });
      Object.assign(h.db.tables.managedDispatch[0], { status });
      Object.assign(h.db.tables.managedPostLifecycle[0], { lifecycle: 'REVIEW', activeScheduleId: null });
      h.clock.at = new Date('2026-11-06T10:00:00.000Z');
      for (const request of [
        () => h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({ operationKey: 'ww-op-schedule-2', expectedScheduleGeneration: 1, publishAt: '2026-11-08T09:00:00.000Z' })),
        () => h.service.publishNow(PRINCIPAL, POST_ID, publishBody({ expectedScheduleGeneration: 1 })),
      ]) {
        expect(await refusedWithoutWrites(h, request())).toMatchObject({ code });
      }
    });

    it('refuses a second schedule while the first is live', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({ operationKey: 'ww-op-schedule-2', expectedScheduleGeneration: 1 }))))
        .toMatchObject({ code: 'SCHEDULE_ACTIVE' });
    });

    it('lets a database failure fail the whole write, never a false success', async () => {
      const h = harness();
      h.db.failOn = { model: 'managedLifecycleOperation', action: 'create' };
      const before = structuredClone(h.db.tables);
      await expect(h.service.schedule(PRINCIPAL, POST_ID, scheduleBody())).rejects.toThrow('FAKE database failure');
      expect(h.db.tables).toEqual(before);
    });
  });

  describe('reads', () => {
    it('answers a never-scheduled post as DRAFT at generation 0', async () => {
      const { service } = harness();
      expect(await service.lifecycle(PRINCIPAL, POST_ID)).toEqual({
        version: 'ww.managed-lifecycle.v1', managedPostId: POST_ID, asOfSequence: 0, revision: 1,
        bindingGeneration: 2, scheduleGeneration: 0, lifecycle: 'DRAFT', deletion: null, schedule: null,
        dispatches: [], unresolvedDispatchIds: [], scheduleCount: 0,
      });
      expect(await refusal(service.lifecycle(PRINCIPAL, '00000000-0000-4000-8000-000000000000')))
        .toMatchObject({ code: 'NOT_FOUND' });
    });

    it('previews the hash W&W derives independently, as a comparison', async () => {
      const { service } = harness();
      const preview = await service.releasePreview(PRINCIPAL, POST_ID, { revision: 1, codec: 'ww-plain-escape-v1' });
      expect(preview.releaseHash).toBe(WW_RELEASE_HASH);
      for (const secret of PRIVATE) {
        expect(JSON.stringify(preview)).not.toContain(secret);
      }
    });

    it('explains an unqualified preview instead of answering one', async () => {
      const { service } = harness({ config: null });
      expect(await refusal(service.releasePreview(PRINCIPAL, POST_ID, { revision: 1, codec: 'ww-plain-escape-v1' })))
        .toMatchObject({ code: 'PROVIDER_NOT_QUALIFIED' });
      expect(await refusal(service.releasePreview(PRINCIPAL, POST_ID, { revision: 'one', codec: 'ww-plain-escape-v1' })))
        .toMatchObject({ code: 'LIFECYCLE_INPUT_INVALID' });
    });

    it('projects the lifecycle, dispatch and feed through the allowlisted views only', async () => {
      const h = harness();
      const result = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());

      const lifecycle = await h.service.lifecycle(PRINCIPAL, POST_ID);
      expect(lifecycle).toMatchObject({ asOfSequence: 1, lifecycle: 'SCHEDULED', scheduleGeneration: 1, scheduleCount: 1 });
      expect(lifecycle.schedule).toEqual(result.schedule);
      expect(lifecycle.dispatches).toEqual(result.dispatches);

      const dispatch = await h.service.dispatch(PRINCIPAL, result.dispatches[0].dispatchId);
      expect(dispatch).toEqual(result.dispatches[0]);
      expect(await refusal(h.service.dispatch(PRINCIPAL, randomUUID()))).toMatchObject({ code: 'NOT_FOUND' });

      const page = await h.service.events(PRINCIPAL, 0);
      expect(page).toMatchObject({ afterSequence: 0, headSequence: 1, nextSequence: 1, hasMore: false });
      expect(page.events).toEqual([{
        sequence: 1, kind: 'POST_SCHEDULED', managedPostId: POST_ID, scheduleId: result.schedule!.scheduleId,
        dispatchId: result.dispatches[0].dispatchId, operationKey: 'ww-op-schedule-1', at: NOW.toISOString(),
        projection: { ...lifecycle, asOfSequence: 1 },
      }]);
      expect(await h.service.events(PRINCIPAL, '1')).toMatchObject({ afterSequence: 1, nextSequence: 1, events: [], hasMore: false });
      expect(await refusal(h.service.events(PRINCIPAL, 2))).toMatchObject({ code: 'LIFECYCLE_INPUT_INVALID' });
      expect(await refusal(h.service.events(PRINCIPAL, -1))).toMatchObject({ code: 'LIFECYCLE_INPUT_INVALID' });

      const answered = JSON.stringify([result, lifecycle, dispatch, page, await h.service.operation(PRINCIPAL, 'ww-op-schedule-1')]);
      for (const secret of [...PRIVATE, 'Hello', 'First comment', 'ww-scheduled-release-v1']) {
        expect(answered).not.toContain(secret);
      }
    });

    it('pages the dense feed without looping', async () => {
      const h = harness();
      await h.service.publishNow(PRINCIPAL, POST_ID, publishBody());
      // a gap in the stored feed fails the page instead of skipping
      h.db.tables.managedLifecycleChangeEvent[0].sequence = 2;
      h.db.tables.managedLifecycleOrganization[0].sequence = 2;
      await expect(h.service.events(PRINCIPAL, 0)).rejects.toBeInstanceOf(ManagedLifecycleProjectionError);
    });

    it('looks up lifecycle keys only: ABSENT as of the head, a DRAFT key a typed 409', async () => {
      const h = harness();
      expect(await h.service.operation(PRINCIPAL, 'ww-op-unknown-1')).toEqual({
        version: 'ww.managed-lifecycle.v1', operationKey: 'ww-op-unknown-1', status: 'ABSENT', asOfSequence: 0,
      });
      const mismatch = await refusal(h.service.operation(PRINCIPAL, 'ww-op-create-1'));
      expect(mismatch).toMatchObject({ code: 'OPERATION_KEY_KIND_MISMATCH' });

      const result = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const lookup = await h.service.operation(PRINCIPAL, 'ww-op-schedule-1');
      expect(parseManagedLifecycleResponse('OPERATION', lookup)).toEqual(lookup);
      expect(lookup).toMatchObject({
        status: 'COMMITTED', asOfSequence: 1, kind: 'SCHEDULE', sequence: 1, ack: 'CURRENT',
        currentScheduleGeneration: 1, currentLifecycle: 'SCHEDULED', result,
      });
      expect(await refusal(h.service.operation(PRINCIPAL, 'short'))).toMatchObject({ code: 'LIFECYCLE_INPUT_INVALID' });
    });
  });

  describe('CANCEL', () => {
    it('cancels the pending occurrence 0 of a single post: the schedule ends CANCELLED and the rows go back to DRAFT', async () => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const snapshot = h.db.tables.managedPostRevision[0].snapshot;
      const { scheduleId } = scheduled.schedule!;
      const dispatchId = scheduled.dispatches[0].dispatchId;

      const result = await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'OCCURRENCE', occurrence: 0,
        ...scopeOf('OCCURRENCE', scheduleId, 1, [pendingAt(0, PUBLISH_AT, dispatchId)]),
      }));

      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({
        kind: 'CANCEL', operationKey: 'ww-op-cancel-1', replayed: false, sequence: 2, scheduleGeneration: 1, lifecycle: 'DRAFT',
        cancellation: {
          scope: 'OCCURRENCE', scheduleId, cancelledOccurrences: [0], series: 'ENDED',
          generation: 'UNCHANGED', scheduleVersion: 'ADVANCED',
        },
      });
      expect(result.schedule).toMatchObject({
        status: 'CANCELLED', scheduleVersion: 2, scheduleGeneration: 1, lastOccurrence: 0,
        endRequestedOperationKey: 'ww-op-cancel-1', endRequestedAt: NOW.toISOString(),
        endedOperationKey: 'ww-op-cancel-1', endedAt: NOW.toISOString(),
      });
      expect(result.dispatches).toEqual([expect.objectContaining({
        dispatchId, occurrence: 0, status: 'CANCELLED', dispatchVersion: 2, scheduleGeneration: 1,
        cancelledByOperationKey: 'ww-op-cancel-1', settledAt: NOW.toISOString(), admittedAt: null,
      })]);

      // the rows are DRAFT again under a recorded fingerprint; the revision,
      // its snapshot and the DRAFT feed stay
      const t = h.db.tables;
      expect(t.post.map((row) => [row.state, row.deletedAt])).toEqual([['DRAFT', null], ['DRAFT', null]]);
      expect(t.managedPost[0].rowFingerprint).toBe(rowFingerprint(t.post as PostRow[]));
      expect(t.managedPost[0]).toMatchObject({ revision: 1, lastSequence: 5, lastOperationKey: 'ww-op-create-1' });
      expect(t.managedPostRevision).toHaveLength(1);
      expect(t.managedPostRevision[0].snapshot).toBe(snapshot);
      expect(t.managedChangeEvent).toEqual([]);
      expect(t.managedPostLifecycle[0]).toMatchObject({
        lifecycle: 'DRAFT', scheduleGeneration: 1, activeScheduleId: null, lastLifecycleSequence: 2, lastOperationKey: 'ww-op-cancel-1',
      });
      expect(t.managedLifecycleChangeEvent.map((row) => [row.kind, row.dispatchId, row.operationKey])).toEqual([
        ['POST_SCHEDULED', dispatchId, 'ww-op-schedule-1'],
        ['POST_OCCURRENCE_CANCELLED', dispatchId, 'ww-op-cancel-1'],
      ]);
      expect(t.managedOperation.find((row) => row.operationKey === 'ww-op-cancel-1')).toMatchObject({ kind: 'CANCEL', sequence: 0 });
      expect(t.managedLifecycleOperation[1]).toMatchObject({ kind: 'CANCEL', scheduleId, scheduleGeneration: 1, sequence: 2 });

      // nothing was prepared, admitted or sent for the cancel
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(t.managedDispatchCall).toEqual([]);

      // only a new, confirmed schedule follows, as the next generation
      const again = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({ operationKey: 'ww-op-schedule-2', expectedScheduleGeneration: 1 }));
      expect(again).toMatchObject({ scheduleGeneration: 2, lifecycle: 'SCHEDULED' });
      expect(await h.service.operation(PRINCIPAL, 'ww-op-cancel-1')).toMatchObject({ status: 'COMMITTED', kind: 'CANCEL', ack: 'SUPERSEDED' });
    });

    it('skips occurrence 0 of a series: the next anchored occurrence is materialized under the same generation', async () => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(3)));
      h.clock.at = new Date('2026-11-06T08:30:00.000Z');

      const result = await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'OCCURRENCE', occurrence: 0,
        ...scopeOf('OCCURRENCE', scheduled.schedule!.scheduleId, 1, [pendingAt(0, PUBLISH_AT, scheduled.dispatches[0].dispatchId)]),
      }));
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({ lifecycle: 'SCHEDULED', scheduleGeneration: 1, cancellation: { series: 'CONTINUES', cancelledOccurrences: [0] } });
      expect(result.schedule).toMatchObject({
        status: 'ACTIVE', scheduleVersion: 2, lastOccurrence: 2, endRequestedOperationKey: null, endedOperationKey: null,
      });
      expect(result.dispatches.map((dispatch) => dispatch.occurrence)).toEqual([0]);

      // anchored at publishAt + 1 day, not a day after the cancel
      const lifecycle = await h.service.lifecycle(PRINCIPAL, POST_ID);
      expect(lifecycle.dispatches.map((dispatch) => [
        dispatch.occurrence, dispatch.status, dispatch.dueAt, dispatch.admissibleUntil, dispatch.scheduleGeneration,
      ])).toEqual([
        [0, 'CANCELLED', PUBLISH_AT, '2026-11-06T09:10:00.000Z', 1],
        [1, 'PENDING', DUE_1, '2026-11-07T09:10:00.000Z', 1],
      ]);
      expect(h.db.tables.post.map((row) => row.state)).toEqual(['QUEUE', 'QUEUE']);
      expect(h.db.tables.managedPostLifecycle[0]).toMatchObject({ lifecycle: 'SCHEDULED', scheduleGeneration: 1 });
    });

    it('truncates only future occurrences, twice, keeping the first end request, and never extends the series', async () => {
      const h = harness();
      const { scheduleId, first, second, pending } = await truncatedTwice(h);

      expect(parseManagedLifecycleResponse('RESULT', first)).toEqual(first);
      expect(first).toMatchObject({
        lifecycle: 'SCHEDULED', dispatches: [],
        cancellation: { scope: 'REMAINING', cancelledOccurrences: [3], series: 'ENDS_AFTER_REMAINING' },
      });
      expect(first.schedule).toMatchObject({
        status: 'ENDING', scheduleVersion: 3, lastOccurrence: 2, endRequestedOperationKey: 'ww-op-truncate-3', endedOperationKey: null,
      });
      expect(second).toMatchObject({ cancellation: { cancelledOccurrences: [2], series: 'ENDS_AFTER_REMAINING' } });
      expect(second.schedule).toMatchObject({
        status: 'ENDING', scheduleVersion: 4, scheduleGeneration: 1, lastOccurrence: 1,
        endRequestedOperationKey: 'ww-op-truncate-3', endRequestedAt: NOW.toISOString(), endedOperationKey: null,
      });
      // the earlier pending occurrence is untouched
      expect(pending).toMatchObject({ status: 'PENDING', version: 1, scheduleGeneration: 1, cancelledByOperationKey: null });

      expect(await refusedWithoutWrites(h, h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        operationKey: 'ww-op-truncate-x', scope: 'REMAINING', fromOccurrence: 2, inFlight: null,
        ...scopeOf('REMAINING', scheduleId, 4, [notMaterialized(2, DUE_2)]),
      })))).toMatchObject({ code: 'CANCEL_SCOPE_MISMATCH' });

      // cancelling the last occurrence left ends the series: this later cancel
      // ended it, the first one still requested the end
      const last = await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        operationKey: 'ww-op-skip-1', scope: 'OCCURRENCE', occurrence: 1,
        ...scopeOf('OCCURRENCE', scheduleId, 4, [pendingAt(1, DUE_1, pending.id)]),
      }));
      expect(parseManagedLifecycleResponse('RESULT', last)).toEqual(last);
      expect(last).toMatchObject({ lifecycle: 'DRAFT', cancellation: { series: 'ENDED', cancelledOccurrences: [1] } });
      expect(last.schedule).toMatchObject({
        status: 'CANCELLED', scheduleVersion: 5, lastOccurrence: 1,
        endRequestedOperationKey: 'ww-op-truncate-3', endedOperationKey: 'ww-op-skip-1',
      });
      expect(h.db.tables.managedDispatch).toHaveLength(2);
      expect(h.db.tables.post.map((row) => row.state)).toEqual(['DRAFT', 'DRAFT']);
    });

    it('cancels every unsettled occurrence of a SERIES, materialized or not', async () => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(3)));
      const { scheduleId } = scheduled.schedule!;
      const dispatchId = scheduled.dispatches[0].dispatchId;

      const result = await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'SERIES',
        ...scopeOf('SERIES', scheduleId, 1, [pendingAt(0, PUBLISH_AT, dispatchId), notMaterialized(1, DUE_1), notMaterialized(2, DUE_2)]),
      }));
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({ lifecycle: 'DRAFT', cancellation: { scope: 'SERIES', series: 'ENDED', cancelledOccurrences: [0, 1, 2] } });
      expect(result.schedule).toMatchObject({ status: 'CANCELLED', lastOccurrence: 2, endedOperationKey: 'ww-op-cancel-1' });
      expect(result.dispatches.map((dispatch) => [dispatch.dispatchId, dispatch.status])).toEqual([[dispatchId, 'CANCELLED']]);
      expect(h.db.tables.managedLifecycleChangeEvent[1]).toMatchObject({ kind: 'POST_SCHEDULE_CANCELLED', scheduleId, dispatchId: null });
      expect(h.db.tables.managedDispatch).toHaveLength(1);
    });

    it('cancels REMAINING from occurrence 0, leaving no last occurrence', async () => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(2)));
      const result = await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'REMAINING', fromOccurrence: 0, inFlight: null,
        ...scopeOf('REMAINING', scheduled.schedule!.scheduleId, 1, [pendingAt(0, PUBLISH_AT, scheduled.dispatches[0].dispatchId), notMaterialized(1, DUE_1)]),
      }));
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({ lifecycle: 'DRAFT', cancellation: { series: 'ENDED', cancelledOccurrences: [0, 1] } });
      expect(result.schedule).toMatchObject({ status: 'CANCELLED', lastOccurrence: null, endRequestedOperationKey: 'ww-op-cancel-1' });
    });

    it.each<[string, (scheduleId: string, dispatchId: string) => Record<string, unknown>, string]>([
      ['a stale schedule version', (s, d) => cancelBody({ scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', s, 2, [pendingAt(0, PUBLISH_AT, d)]) }), 'CANCEL_SCOPE_MISMATCH'],
      ['a stale dispatch version', (s, d) => cancelBody({ scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', s, 1, [pendingAt(0, PUBLISH_AT, d, 2)]) }), 'CANCEL_SCOPE_MISMATCH'],
      ['an affected hash over another scope', (s, d) => cancelBody({ scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', s, 1, [pendingAt(0, PUBLISH_AT, d)]), affectedHash: fingerprint({ other: true }) }), 'CANCEL_SCOPE_MISMATCH'],
      ['the hash of a SERIES preview', (s, d) => cancelBody({ scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', s, 1, [pendingAt(0, PUBLISH_AT, d)]), affectedHash: scopeOf('SERIES', s, 1, [pendingAt(0, PUBLISH_AT, d)]).affectedHash }), 'CANCEL_SCOPE_MISMATCH'],
      ['an unanchored due time', (s, d) => cancelBody({ scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', s, 1, [pendingAt(0, '2026-11-06T09:00:01.000Z', d)]) }), 'CANCEL_SCOPE_MISMATCH'],
      ['another schedule', (_, d) => cancelBody({ scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', randomUUID(), 1, [pendingAt(0, PUBLISH_AT, d)]) }), 'CANCEL_SCOPE_MISMATCH'],
      ['an occurrence beyond the series', (s) => cancelBody({ scope: 'REMAINING', fromOccurrence: 1, inFlight: null, ...scopeOf('REMAINING', s, 1, [notMaterialized(1, DUE_1)]) }), 'CANCEL_SCOPE_MISMATCH'],
      ['another schedule generation', (s, d) => cancelBody({ expectedScheduleGeneration: 2, scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', s, 1, [pendingAt(0, PUBLISH_AT, d)]) }), 'SCHEDULE_GENERATION_CONFLICT'],
      ['another revision', (s, d) => cancelBody({ expectedRevision: 2, scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', s, 1, [pendingAt(0, PUBLISH_AT, d)]) }), 'REVISION_CONFLICT'],
    ])('refuses %s, writing nothing', async (_, body, code) => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      expect(await refusedWithoutWrites(h, h.service.cancel(PRINCIPAL, POST_ID, body(scheduled.schedule!.scheduleId, scheduled.dispatches[0].dispatchId))))
        .toMatchObject({ code });
    });

    it('refuses a post without a live schedule', async () => {
      const h = harness();
      expect(await refusedWithoutWrites(h, h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        expectedScheduleGeneration: 0, scope: 'OCCURRENCE', occurrence: 0,
        ...scopeOf('OCCURRENCE', randomUUID(), 1, [pendingAt(0, PUBLISH_AT, randomUUID())]),
      })))).toMatchObject({ code: 'LIFECYCLE_STATE_CONFLICT' });
    });
  });

  describe('with an occurrence admitted by the actual dispatch journal', () => {
    async function admitted() {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(3)));
      h.clock.at = new Date(PUBLISH_AT);
      const journal = journalOf(h);
      const dispatch = h.db.tables.managedDispatch[0];
      const admission = await journal.admit(ORG, {
        dispatchId: dispatch.id, expectedVersion: dispatch.version, member: 0, step: 'POST', stage: 0, attempt: 1,
        reservedUnits: 21, deadlineMs: 120000, requestHash: fingerprint({ synthetic: 'request' }),
      });
      if (admission.status !== 'ADMITTED') {
        throw new Error('the FAKE admission was refused');
      }
      return { h, journal, handle: admission.handle, scheduleId: scheduled.schedule!.scheduleId, dispatchId: dispatch.id };
    }

    it('records each journal event with the projection and pointers, never advancing the dispatch version again', async () => {
      const { h, journal, handle, dispatchId } = await admitted();
      expect(handle.dispatchVersion).toBe(2);
      expect(h.db.tables.managedDispatch[0]).toMatchObject({ status: 'ADMITTED', version: 2, lastLifecycleSequence: 2 });
      expect(h.db.tables.managedPostLifecycle[0]).toMatchObject({
        lifecycle: 'DISPATCHING', lastLifecycleSequence: 2, lastOperationKey: 'ww-op-schedule-1',
      });
      const page = await h.service.events(PRINCIPAL, 1);
      expect(page.events).toEqual([expect.objectContaining({ sequence: 2, kind: 'DISPATCH_ADMITTED', dispatchId, operationKey: null })]);
      expect(page.events[0].projection).toMatchObject({
        lifecycle: 'DISPATCHING',
        dispatches: [expect.objectContaining({ status: 'ADMITTED', dispatchVersion: 2, continuation: expect.objectContaining({ kind: 'IN_CALL', attempt: 1 }) })],
      });
      expect(await journal.verifyAdmission(handle, new Date(handle.deadlineAt))).toBe(true);

      // the lease lapsed: UNKNOWN, never sent again, and the post is in REVIEW
      h.clock.at = new Date(Date.parse(PUBLISH_AT) + 151000);
      expect(await journal.recoverExpired(ORG, dispatchId)).toBe(true);
      expect(h.db.tables.managedDispatch[0]).toMatchObject({ status: 'UNKNOWN', version: 3, lastLifecycleSequence: 3 });
      expect(h.db.tables.managedPostLifecycle[0]).toMatchObject({ lifecycle: 'REVIEW', lastLifecycleSequence: 3 });
      expect(h.db.tables.managedLifecycleChangeEvent.map((row) => row.kind)).toEqual(['POST_SCHEDULED', 'DISPATCH_ADMITTED', 'DISPATCH_OUTCOME_UNKNOWN']);
      expect((await h.service.lifecycle(PRINCIPAL, POST_ID)).unresolvedDispatchIds).toEqual([dispatchId]);
    });

    it('refuses an event that does not follow the stored dispatch, writing nothing', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const pending = h.db.tables.managedDispatch[0];
      const before = structuredClone(h.db.tables);
      for (const [kind, dispatch] of [
        ['DISPATCH_ADMITTED', pending],
        ['DISPATCH_OUTCOME_UNKNOWN', { ...pending, status: 'UNKNOWN' }],
      ] as const) {
        await expect(h.repository.mutate(ORG, (store) => h.service.recordDispatchEvent(store, kind, dispatch as any)))
          .rejects.toThrow('does not follow the stored dispatch');
      }
      expect(h.db.tables).toEqual(before);
    });

    it.each<[string, boolean]>([
      ['brings the QUEUE rows along with a settlement', false],
      ['keeps rows changed elsewhere rather than losing a settled outcome', true],
    ])('%s', async (_, drift) => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      if (drift) {
        h.db.tables.post[1].content = 'Edited elsewhere';
      }
      const at = new Date('2026-11-06T09:01:00.000Z');
      h.clock.at = at;
      const dispatchId = h.db.tables.managedDispatch[0].id;

      // the journal's own settlement writes, then its event port, in one transaction
      await h.repository.mutate(ORG, async (store) => {
        const dispatch = (await store.getDispatch(dispatchId))!;
        const schedule = (await store.getSchedule(dispatch.scheduleId))!;
        await store.updateSchedule(schedule.id, schedule.version, { status: 'COMPLETED', endedAt: at, endedCode: 'PUBLISHED' });
        await store.transitionDispatch(dispatch.id, dispatch.version, {
          status: 'PUBLISHED', admittedAt: new Date(PUBLISH_AT), settledAt: at, nextActionAt: null,
          lastLifecycleSequence: (await store.headSequence()) + 1,
          members: JSON.stringify([0, 1].map((position) => ({
            position, postId: `post_${position}`, status: 'PUBLISHED', code: null,
            release: { releaseId: `1790000000000000${position}`, releaseURL: null, source: 'PROVIDER_RESPONSE' },
          }))),
        });
        await h.service.recordDispatchEvent(store, 'DISPATCH_PUBLISHED', (await store.getDispatch(dispatch.id))!);
      });

      const t = h.db.tables;
      expect(t.managedDispatch[0]).toMatchObject({ status: 'PUBLISHED', version: 2, lastLifecycleSequence: 2 });
      expect(t.managedPostLifecycle[0]).toMatchObject({ lifecycle: 'PUBLISHED', activeScheduleId: null, lastLifecycleSequence: 2 });
      expect(t.managedLifecycleChangeEvent[1]).toMatchObject({ kind: 'DISPATCH_PUBLISHED', dispatchId, operationKey: null });
      expect(t.post.map((row) => row.state)).toEqual(drift ? ['QUEUE', 'QUEUE'] : ['PUBLISHED', 'PUBLISHED']);
      expect(t.managedPost[0].rowFingerprint === rowFingerprint(t.post as PostRow[])).toBe(!drift);
    });

    it('cancels only the future while an earlier occurrence is admitted: the admission keeps its exact handle', async () => {
      const { h, journal, handle, scheduleId, dispatchId } = await admitted();
      const future = [notMaterialized(1, DUE_1), notMaterialized(2, DUE_2)];

      expect(await refusedWithoutWrites(h, h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', scheduleId, 1, [pendingAt(0, PUBLISH_AT, dispatchId, 2)]),
      })))).toMatchObject({ code: 'DISPATCH_IN_PROGRESS' });
      expect(await refusedWithoutWrites(h, h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'SERIES', ...scopeOf('SERIES', scheduleId, 1, future),
      })))).toMatchObject({ code: 'DISPATCH_IN_PROGRESS' });
      expect(await refusedWithoutWrites(h, h.service.delete(PRINCIPAL, POST_ID, deleteBody({
        expectedScheduleGeneration: 1, expectedLifecycle: 'SCHEDULED', cancels: scopeOf('DELETE', scheduleId, 1, future),
      })))).toMatchObject({ code: 'DISPATCH_IN_PROGRESS' });

      const inFlight = { occurrence: 0, dispatchId, expectedStatus: 'ADMITTED', expectedDispatchVersion: 2 };
      // the in-flight occurrence at another version is another scope
      const stale = { ...inFlight, expectedDispatchVersion: 1 };
      expect(await refusedWithoutWrites(h, h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'REMAINING', fromOccurrence: 1, inFlight: stale, ...scopeOf('REMAINING', scheduleId, 1, future, stale),
      })))).toMatchObject({ code: 'CANCEL_SCOPE_MISMATCH' });

      const result = await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'REMAINING', fromOccurrence: 1, inFlight, ...scopeOf('REMAINING', scheduleId, 1, future, inFlight),
      }));
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({
        lifecycle: 'DISPATCHING', scheduleGeneration: 1, dispatches: [],
        cancellation: { scope: 'REMAINING', series: 'ENDS_AFTER_IN_FLIGHT', cancelledOccurrences: [1, 2] },
      });
      expect(result.schedule).toMatchObject({ status: 'ENDING', scheduleVersion: 2, lastOccurrence: 0, endRequestedOperationKey: 'ww-op-cancel-1' });

      expect(h.db.tables.managedDispatch).toHaveLength(1);
      expect(h.db.tables.managedDispatch[0]).toMatchObject({
        status: 'ADMITTED', version: 2, scheduleGeneration: 1, cancelledByOperationKey: null,
        leaseHolder: handle.holder, fencingToken: handle.fencingToken, activeCallId: handle.callId,
      });
      expect(await journal.verifyAdmission(handle, new Date(handle.deadlineAt))).toBe(true);
    });

    it('resolves a lost call a human found not published: the series halts, late evidence stays, nothing is sent again', async () => {
      const { h, journal, handle, scheduleId, dispatchId } = await admitted();
      h.clock.at = new Date(Date.parse(PUBLISH_AT) + 151000);
      await journal.recoverExpired(ORG, dispatchId);
      // Recovery now halts the series immediately. Its retained dispatch still
      // needs resolution, but there is no live schedule left to cancel.
      expect(h.db.tables.managedSchedule[0]).toMatchObject({
        status: 'HALTED', version: 2, endedCode: 'UNKNOWN', endedOperationKey: null,
      });
      expect(h.db.tables.managedPostLifecycle[0]).toMatchObject({ lifecycle: 'REVIEW', activeScheduleId: null });
      // a stale sender's late answer is retained apart, never trusted
      expect(await journal.recordLateEvidence(handle, { releaseId: '17900000000000009', releaseURL: null })).toBe(true);
      const calls = structuredClone(h.db.tables.managedDispatchCall);

      const future = [notMaterialized(1, DUE_1), notMaterialized(2, DUE_2)];
      expect(await refusedWithoutWrites(h, h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'SERIES', ...scopeOf('SERIES', scheduleId, 1, future),
      })))).toMatchObject({ code: 'LIFECYCLE_STATE_CONFLICT' });
      expect(await refusedWithoutWrites(h, h.service.delete(PRINCIPAL, POST_ID, deleteBody({
        expectedScheduleGeneration: 1, expectedLifecycle: 'SCHEDULED', cancels: scopeOf('DELETE', scheduleId, 1, future),
      })))).toMatchObject({ code: 'DISPATCH_UNRESOLVED' });

      h.clock.at = new Date('2026-11-06T10:00:00.000Z');
      const unknown = h.db.tables.managedDispatch[0];
      const result = await h.service.resolve(PRINCIPAL, dispatchId, resolveBody(unknown, NOT_PUBLISHED));

      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({
        kind: 'RESOLVE', dispatchId, resolution: 'RESOLVED_NOT_PUBLISHED', resend: 'NEVER',
        lifecycle: 'FAILED', scheduleGeneration: 1, sequence: 4,
      });
      expect(result.schedule).toMatchObject({ status: 'HALTED', scheduleVersion: 2, lastOccurrence: 2, endedOperationKey: null });
      expect(result.dispatches).toEqual([expect.objectContaining({
        dispatchId, status: 'RESOLVED_NOT_PUBLISHED', dispatchVersion: 4, code: 'DISPATCHER_LOST',
        members: [
          { position: 0, postId: 'post_0', status: 'RESOLVED_NOT_PUBLISHED', code: null, release: null },
          { position: 1, postId: 'post_1', status: 'NOT_SENT', code: 'PREVIOUS_MEMBER_FAILED', release: null },
        ],
        resolution: {
          resolution: 'RESOLVED_NOT_PUBLISHED', previousStatus: 'UNKNOWN', operationKey: 'ww-op-resolve-1',
          resolvedAt: '2026-11-06T10:00:00.000Z', evidence: OBSERVED, members: NOT_PUBLISHED.members, resend: 'NEVER',
        },
      })]);

      const t = h.db.tables;
      expect(t.managedDispatch).toHaveLength(1);
      expect(t.managedDispatchCall).toEqual(calls);
      expect(JSON.parse(t.managedDispatchCall[0].result)).toMatchObject({ kind: 'LATE_EVIDENCE', changesOutcome: false });
      expect(t.post.map((row) => row.state)).toEqual(['DRAFT', 'DRAFT']);
      expect(t.managedPostLifecycle[0]).toMatchObject({ lifecycle: 'FAILED', activeScheduleId: null, lastOperationKey: 'ww-op-resolve-1' });
      expect(t.managedLifecycleOperation[1]).toMatchObject({ kind: 'RESOLVE', dispatchId, scheduleId, revision: 1 });

      expect(await refusedWithoutWrites(h, h.service.resolve(PRINCIPAL, dispatchId, resolveBody(unknown, { ...NOT_PUBLISHED, operationKey: 'ww-op-resolve-2' }))))
        .toMatchObject({ code: 'DISPATCH_NOT_RESOLVABLE' });
    });
  });

  describe('RESOLVE', () => {
    it('lets only a human-verified published resolution advance the series, to the next anchored occurrence', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(2)));
      const partial = settleUnresolved(h, 0, 'PARTIAL');

      const result = await h.service.resolve(PRINCIPAL, partial.id, resolveBody(partial, COMMENT_PUBLISHED));
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({
        kind: 'RESOLVE', dispatchId: partial.id, resolution: 'RESOLVED_PUBLISHED', resend: 'NEVER',
        lifecycle: 'SCHEDULED', scheduleGeneration: 1, sequence: 2,
      });
      expect(result.schedule).toMatchObject({ status: 'ACTIVE', scheduleVersion: 1 });
      expect(result.dispatches.map((dispatch) => [dispatch.occurrence, dispatch.status, dispatch.dueAt, dispatch.scheduleGeneration])).toEqual([
        [0, 'RESOLVED_PUBLISHED', PUBLISH_AT, 1],
        [1, 'PENDING', DUE_1, 1],
      ]);
      expect(result.dispatches[0].members).toEqual([
        { position: 0, postId: 'post_0', status: 'PUBLISHED', code: null, release: { releaseId: '17900000000000001', releaseURL: null, source: 'PROVIDER_RESPONSE' } },
        { position: 1, postId: 'post_1', status: 'PUBLISHED', code: null, release: { releaseId: null, releaseURL: 'https://www.instagram.com/p/C0mment/', source: 'HUMAN_RESOLUTION' } },
      ]);

      const t = h.db.tables;
      expect(t.post.map((row) => row.state)).toEqual(['PUBLISHED', 'PUBLISHED']);
      expect(t.managedPost[0].rowFingerprint).toBe(rowFingerprint(t.post as PostRow[]));
      expect(t.managedDispatchCall).toEqual([]);
      expect(t.managedLifecycleChangeEvent[1]).toMatchObject({ kind: 'DISPATCH_RESOLVED', dispatchId: partial.id, operationKey: 'ww-op-resolve-1' });

      // the next occurrence runs from PUBLISHED rows; cancelling it ends the
      // series with the post still PUBLISHED
      const next = t.managedDispatch.find((row) => row.occurrence === 1)!;
      const cancelled = await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'OCCURRENCE', occurrence: 1, ...scopeOf('OCCURRENCE', result.schedule!.scheduleId, 1, [pendingAt(1, DUE_1, next.id)]),
      }));
      expect(cancelled).toMatchObject({ lifecycle: 'PUBLISHED', cancellation: { series: 'ENDED' } });
      expect(h.db.tables.post.map((row) => row.state)).toEqual(['PUBLISHED', 'PUBLISHED']);
    });

    it('ends a truncated series CANCELLED by its last truncation once the occurrence in flight is resolved', async () => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(3)));
      const partial = settleUnresolved(h, 0, 'PARTIAL');
      const inFlight = { occurrence: 0, dispatchId: partial.id, expectedStatus: 'PARTIAL', expectedDispatchVersion: 4 };
      const truncated = await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        operationKey: 'ww-op-truncate-1', scope: 'REMAINING', fromOccurrence: 1, inFlight,
        ...scopeOf('REMAINING', scheduled.schedule!.scheduleId, 1, [notMaterialized(1, DUE_1), notMaterialized(2, DUE_2)], inFlight),
      }));
      expect(truncated).toMatchObject({ lifecycle: 'REVIEW', cancellation: { series: 'ENDS_AFTER_IN_FLIGHT' } });

      const resolved = await h.service.resolve(PRINCIPAL, partial.id, resolveBody(partial, COMMENT_PUBLISHED));
      expect(parseManagedLifecycleResponse('RESULT', resolved)).toEqual(resolved);
      expect(resolved).toMatchObject({ lifecycle: 'PUBLISHED', resolution: 'RESOLVED_PUBLISHED' });
      expect(resolved.schedule).toMatchObject({
        status: 'CANCELLED', lastOccurrence: 0, endRequestedOperationKey: 'ww-op-truncate-1',
        endedOperationKey: 'ww-op-truncate-1', endedAt: '2026-11-06T10:00:00.000Z',
      });
      expect(h.db.tables.managedDispatch).toHaveLength(1);
      expect(h.db.tables.post.map((row) => row.state)).toEqual(['PUBLISHED', 'PUBLISHED']);
      expect(h.db.tables.managedPostLifecycle[0].activeScheduleId).toBeNull();
    });

    it('halts the series on an undetermined root, abandoning it without a resend', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(2)));
      const unknown = settleUnresolved(h, 0, 'UNKNOWN');
      const result = await h.service.resolve(PRINCIPAL, unknown.id, resolveBody(unknown, {
        resolution: 'RESOLVED_ABANDONED', members: [member(0, 'UNKNOWN', 'UNDETERMINED'), member(1, 'NOT_SENT')],
      }));
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({ resolution: 'RESOLVED_ABANDONED', lifecycle: 'FAILED' });
      expect(result.schedule).toMatchObject({ status: 'HALTED', lastOccurrence: 1, endedOperationKey: 'ww-op-resolve-1' });
      expect(h.db.tables.managedDispatch).toHaveLength(1);
      expect(h.db.tables.managedDispatchCall).toEqual([]);

      // only a new, confirmed schedule follows
      const again = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody({
        operationKey: 'ww-op-schedule-2', expectedScheduleGeneration: 1, publishAt: '2026-11-08T09:00:00.000Z',
      }));
      expect(again).toMatchObject({ scheduleGeneration: 2, lifecycle: 'SCHEDULED' });
    });

    it('resumes the same series a PARTIAL settlement halted once a human finds it published, once', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(3)));
      const partial = settleUnresolved(h, 0, 'PARTIAL');
      haltedBySettlement(h, 'PARTIAL');

      const body = resolveBody(partial, COMMENT_PUBLISHED);
      const result = await h.service.resolve(PRINCIPAL, partial.id, body);
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({ resolution: 'RESOLVED_PUBLISHED', lifecycle: 'SCHEDULED', resend: 'NEVER' });
      expect(result.schedule).toMatchObject({
        status: 'ACTIVE', scheduleVersion: 3, lastOccurrence: 2, endRequestedOperationKey: null, endedAt: null, endedOperationKey: null,
      });
      expect(result.dispatches.map((dispatch) => [dispatch.occurrence, dispatch.status, dispatch.dueAt])).toEqual([
        [0, 'RESOLVED_PUBLISHED', PUBLISH_AT],
        [1, 'PENDING', DUE_1],
      ]);
      const t = h.db.tables;
      expect(t.managedSchedule[0]).toMatchObject({ status: 'ACTIVE', endedCode: null, policyExpiresAt: POLICY.expiresAt });
      expect(t.managedPostLifecycle[0]).toMatchObject({ lifecycle: 'SCHEDULED', activeScheduleId: result.schedule!.scheduleId });
      expect(t.managedDispatchCall).toEqual([]);

      // an exact replay materializes nothing again
      expect(await h.service.resolve(PRINCIPAL, partial.id, body)).toEqual({ ...result, replayed: true });
      expect(h.db.tables.managedDispatch).toHaveLength(2);
    });

    it('completes a halted series whose resolved occurrence was its last', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const partial = settleUnresolved(h, 0, 'PARTIAL');
      haltedBySettlement(h, 'PARTIAL');

      const result = await h.service.resolve(PRINCIPAL, partial.id, resolveBody(partial, COMMENT_PUBLISHED));
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({ lifecycle: 'PUBLISHED' });
      expect(result.schedule).toMatchObject({ status: 'COMPLETED', endedOperationKey: null, endedAt: '2026-11-06T10:00:00.000Z' });
      expect(h.db.tables.managedDispatch).toHaveLength(1);
      expect(h.db.tables.managedPostLifecycle[0].activeScheduleId).toBeNull();
    });

    it('ends a halted truncated series CANCELLED by its last truncation, keeping the first end request', async () => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(3)));
      const partial = settleUnresolved(h, 0, 'PARTIAL');
      const inFlight = { occurrence: 0, dispatchId: partial.id, expectedStatus: 'PARTIAL', expectedDispatchVersion: 4 };
      await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        operationKey: 'ww-op-truncate-1', scope: 'REMAINING', fromOccurrence: 1, inFlight,
        ...scopeOf('REMAINING', scheduled.schedule!.scheduleId, 1, [notMaterialized(1, DUE_1), notMaterialized(2, DUE_2)], inFlight),
      }));
      haltedBySettlement(h, 'PARTIAL');

      const resolved = await h.service.resolve(PRINCIPAL, partial.id, resolveBody(partial, COMMENT_PUBLISHED));
      expect(parseManagedLifecycleResponse('RESULT', resolved)).toEqual(resolved);
      expect(resolved.schedule).toMatchObject({
        status: 'CANCELLED', lastOccurrence: 0, endRequestedOperationKey: 'ww-op-truncate-1', endedOperationKey: 'ww-op-truncate-1',
      });
      expect(h.db.tables.managedDispatch).toHaveLength(1);
    });

    it.each<[string, string, boolean]>([
      ['a halt by a rejected occurrence', 'REJECTED', false],
      ['a halt by an occurrence never sent', 'NOT_SENT', false],
      ['a halt by an expired occurrence', 'EXPIRED', false],
      ['a halt by another unresolved status', 'UNKNOWN', false],
      ['a halt followed by a later occurrence', 'PARTIAL', true],
    ])('never resumes %s', async (_, endedCode, later) => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(3)));
      const partial = settleUnresolved(h, 0, 'PARTIAL');
      const schedule = haltedBySettlement(h, endedCode);
      if (later) {
        h.db.tables.managedDispatch.push({
          ...structuredClone(partial), id: randomUUID(), occurrence: 1, dueAt: new Date(DUE_1),
          admissibleUntil: new Date(Date.parse(DUE_1) + 600000), status: 'EXPIRED', code: 'LATE_BEYOND_TOLERANCE',
          admittedAt: null, settledAt: new Date(Date.parse(DUE_1) + 600001),
          members: JSON.stringify(JSON.parse(partial.members).map((member: { position: number; postId: string }) => ({
            position: member.position, postId: member.postId, status: 'WAITING', code: null, release: null,
          }))),
        });
      }
      const version = schedule.version;

      await h.service.resolve(PRINCIPAL, partial.id, resolveBody(partial, COMMENT_PUBLISHED));
      expect(h.db.tables.managedSchedule[0]).toMatchObject({ status: 'HALTED', endedCode, endedOperationKey: null, version });
      expect(h.db.tables.managedDispatch).toHaveLength(later ? 2 : 1);
      expect(h.db.tables.managedPostLifecycle[0].activeScheduleId).toBeNull();
    });

    it('leaves a settlement halt halted when the human found it not published', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(2)));
      const unknown = settleUnresolved(h, 0, 'UNKNOWN');
      const schedule = haltedBySettlement(h, 'UNKNOWN');
      const version = schedule.version;

      const result = await h.service.resolve(PRINCIPAL, unknown.id, resolveBody(unknown, NOT_PUBLISHED));
      expect(result).toMatchObject({ resolution: 'RESOLVED_NOT_PUBLISHED', lifecycle: 'FAILED' });
      expect(h.db.tables.managedSchedule[0]).toMatchObject({ status: 'HALTED', endedCode: 'UNKNOWN', version });
      expect(h.db.tables.managedDispatch).toHaveLength(1);
    });

    it.each<[string, Record<string, unknown>, string, string | null]>([
      ['a stale dispatch version', { expectedDispatchVersion: 3 }, 'DISPATCH_VERSION_CONFLICT', null],
      ['another schedule generation', { expectedScheduleGeneration: 2 }, 'SCHEDULE_GENERATION_CONFLICT', null],
      ['members that are not the ones shown', { members: [{ ...member(0, 'UNKNOWN', 'NOT_PUBLISHED'), postId: 'post_9' }, member(1, 'NOT_SENT')] }, 'RESOLVE_MEMBERS_MISMATCH', null],
      ['an observation in the future', { evidence: { ...OBSERVED, observedAt: '2026-11-06T11:00:00.000Z' } }, 'RESOLUTION_EVIDENCE_INVALID', 'EVIDENCE_IN_FUTURE'],
      ['an observation before the admission', { evidence: { ...OBSERVED, observedAt: '2026-11-06T08:59:59.000Z' } }, 'RESOLUTION_EVIDENCE_INVALID', 'EVIDENCE_BEFORE_ADMISSION'],
      ['evidence that is not a human observation', { evidence: { ...OBSERVED, source: 'PROVIDER_LOOKUP' } }, 'LIFECYCLE_INPUT_INVALID', null],
      ['a resolution the outcomes do not mean', { resolution: 'RESOLVED_PUBLISHED' }, 'LIFECYCLE_INPUT_INVALID', null],
    ])('refuses %s, writing nothing', async (_, change, code, reason) => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const unknown = settleUnresolved(h, 0, 'UNKNOWN');
      expect(await refusedWithoutWrites(h, h.service.resolve(PRINCIPAL, unknown.id, resolveBody(unknown, { ...NOT_PUBLISHED, ...change }))))
        .toMatchObject({ code, reason });
    });

    it('refuses a dispatch that is not unresolved or not found', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const pending = h.db.tables.managedDispatch[0];
      const body = resolveBody({ version: 1, status: 'UNKNOWN' }, NOT_PUBLISHED);
      expect(await refusedWithoutWrites(h, h.service.resolve(PRINCIPAL, pending.id, body))).toMatchObject({ code: 'DISPATCH_NOT_RESOLVABLE' });
      expect(await refusedWithoutWrites(h, h.service.resolve(PRINCIPAL, randomUUID(), body))).toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('DELETE', () => {
    it('retains a never-scheduled draft at generation 0: the rows are kept with deletedAt, nothing is sent', async () => {
      const h = harness();
      const snapshot = h.db.tables.managedPostRevision[0].snapshot;
      const result = await h.service.delete(PRINCIPAL, POST_ID, deleteBody());

      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({
        kind: 'DELETE', sequence: 1, scheduleGeneration: 0, lifecycle: 'DELETED', schedule: null, dispatches: [],
        deletion: {
          mode: 'RETAINED_SOFT_DELETE', platformPost: 'NOT_DELETED', wasPublished: false,
          retainedPostIds: ['post_0', 'post_1'], cancelledOccurrences: [],
        },
      });

      const t = h.db.tables;
      expect(t.post.map((row) => [row.id, row.state, row.deletedAt?.toISOString()])).toEqual([
        ['post_0', 'DRAFT', NOW.toISOString()],
        ['post_1', 'DRAFT', NOW.toISOString()],
      ]);
      expect(t.post.map((row) => row.content)).toEqual(['Hello &amp; welcome', 'First comment']);
      expect(t.managedPost[0].rowFingerprint).toBe(rowFingerprint(t.post as PostRow[]));
      expect(t.managedPost[0]).toMatchObject({ revision: 1, lastSequence: 5, lastOperationKey: 'ww-op-create-1' });
      expect(t.managedPostRevision[0].snapshot).toBe(snapshot);
      expect(t.managedChangeEvent).toEqual([]);
      expect(t.managedPostLifecycle[0]).toMatchObject({
        lifecycle: 'DELETED', scheduleGeneration: 0, activeScheduleId: null, deletedAt: NOW,
        deletedOperationKey: 'ww-op-delete-1', deletedSequence: 1, deletedFromLifecycle: 'DRAFT',
      });
      expect(t.managedLifecycleChangeEvent[0]).toMatchObject({ kind: 'POST_DELETED', scheduleId: null, dispatchId: null });
      expect(h.prepare).not.toHaveBeenCalled();

      expect((await h.service.lifecycle(PRINCIPAL, POST_ID)).deletion).toEqual({
        mode: 'RETAINED_SOFT_DELETE', platformPost: 'NOT_DELETED', deletedAt: NOW.toISOString(), operationKey: 'ww-op-delete-1',
      });
      expect(await refusedWithoutWrites(h, h.service.delete(PRINCIPAL, POST_ID, deleteBody({ operationKey: 'ww-op-delete-2' }))))
        .toMatchObject({ code: 'POST_DELETED' });
      expect(await refusedWithoutWrites(h, h.service.schedule(PRINCIPAL, POST_ID, scheduleBody())))
        .toMatchObject({ code: 'POST_DELETED' });
    });

    it('supersedes a live schedule, cancelling exactly the occurrences it binds', async () => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody(series(3)));
      const { scheduleId } = scheduled.schedule!;
      const dispatchId = scheduled.dispatches[0].dispatchId;
      const affected = [pendingAt(0, PUBLISH_AT, dispatchId), notMaterialized(1, DUE_1), notMaterialized(2, DUE_2)];

      // the hash of a SERIES preview is not the hash of the delete's cancels
      expect(await refusedWithoutWrites(h, h.service.delete(PRINCIPAL, POST_ID, deleteBody({
        expectedScheduleGeneration: 1, expectedLifecycle: 'SCHEDULED',
        cancels: { ...scopeOf('DELETE', scheduleId, 1, affected), affectedHash: scopeOf('SERIES', scheduleId, 1, affected).affectedHash },
      })))).toMatchObject({ code: 'CANCEL_SCOPE_MISMATCH' });
      expect(await refusedWithoutWrites(h, h.service.delete(PRINCIPAL, POST_ID, deleteBody({ expectedScheduleGeneration: 1, expectedLifecycle: 'DRAFT' }))))
        .toMatchObject({ code: 'LIFECYCLE_STATE_CONFLICT' });

      const result = await h.service.delete(PRINCIPAL, POST_ID, deleteBody({
        expectedScheduleGeneration: 1, expectedLifecycle: 'SCHEDULED', cancels: scopeOf('DELETE', scheduleId, 1, affected),
      }));
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({
        lifecycle: 'DELETED', scheduleGeneration: 1,
        deletion: { wasPublished: false, cancelledOccurrences: [0, 1, 2], retainedPostIds: ['post_0', 'post_1'] },
      });
      expect(result.schedule).toMatchObject({
        status: 'SUPERSEDED_BY_DELETE', scheduleVersion: 2, lastOccurrence: 2,
        endRequestedOperationKey: null, endedOperationKey: 'ww-op-delete-1',
      });
      expect(result.dispatches).toEqual([expect.objectContaining({ dispatchId, status: 'CANCELLED', cancelledByOperationKey: 'ww-op-delete-1' })]);

      const t = h.db.tables;
      expect(t.post.map((row) => [row.state, row.deletedAt?.toISOString()])).toEqual([['QUEUE', NOW.toISOString()], ['QUEUE', NOW.toISOString()]]);
      expect(t.managedPost[0].rowFingerprint).toBe(rowFingerprint(t.post as PostRow[]));
      expect(t.managedPostLifecycle[0]).toMatchObject({
        lifecycle: 'DELETED', scheduleGeneration: 1, activeScheduleId: null, deletedFromLifecycle: 'SCHEDULED',
      });
      expect(t.managedLifecycleChangeEvent[1]).toMatchObject({ kind: 'POST_DELETED', scheduleId, dispatchId: null });
    });

    it('retains a published record and never deletes the platform post', async () => {
      const h = harness();
      await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      publishedOnce(h);

      const result = await h.service.delete(PRINCIPAL, POST_ID, deleteBody({ expectedScheduleGeneration: 1, expectedLifecycle: 'PUBLISHED' }));
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({
        lifecycle: 'DELETED', dispatches: [],
        deletion: { platformPost: 'NOT_DELETED', wasPublished: true, cancelledOccurrences: [] },
      });
      expect(result.schedule).toMatchObject({ status: 'COMPLETED' });

      const t = h.db.tables;
      expect(t.post.map((row) => [row.state, row.deletedAt?.toISOString()])).toEqual([
        ['PUBLISHED', '2026-11-06T10:00:00.000Z'],
        ['PUBLISHED', '2026-11-06T10:00:00.000Z'],
      ]);
      expect(t.managedDispatch[0]).toMatchObject({ status: 'PUBLISHED', version: 4 });
      expect(t.managedPostLifecycle[0]).toMatchObject({ deletedFromLifecycle: 'PUBLISHED' });
    });

    it('deletes a twice-truncated series, keeping its first end request', async () => {
      const h = harness();
      const { scheduleId, pending } = await truncatedTwice(h);
      const result = await h.service.delete(PRINCIPAL, POST_ID, deleteBody({
        expectedScheduleGeneration: 1, expectedLifecycle: 'SCHEDULED',
        cancels: scopeOf('DELETE', scheduleId, 4, [pendingAt(1, DUE_1, pending.id)]),
      }));
      expect(parseManagedLifecycleResponse('RESULT', result)).toEqual(result);
      expect(result).toMatchObject({ deletion: { cancelledOccurrences: [1] } });
      expect(result.schedule).toMatchObject({
        status: 'SUPERSEDED_BY_DELETE', lastOccurrence: 1, endRequestedOperationKey: 'ww-op-truncate-3', endedOperationKey: 'ww-op-delete-1',
      });
      expect(h.db.tables.managedLifecycleChangeEvent.map((row) => row.kind)).toEqual([
        'POST_SCHEDULED', 'POST_OCCURRENCE_CANCELLED', 'POST_SCHEDULE_CANCELLED', 'POST_SCHEDULE_CANCELLED', 'POST_DELETED',
      ]);
    });

    it('refuses rows changed outside the managed API', async () => {
      const h = harness();
      h.db.tables.post[1].content = 'Edited elsewhere';
      expect(await refusedWithoutWrites(h, h.service.delete(PRINCIPAL, POST_ID, deleteBody())))
        .toMatchObject({ code: 'POST_DRIFTED' });
    });
  });

  describe('ending writes, shared rules', () => {
    it.each(['CANCEL', 'DELETE'] as const)('allows authorized %s after publication policy expiry but before test access ends', async kind => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const scheduleId = scheduled.schedule!.scheduleId;
      const affected = [pendingAt(0, PUBLISH_AT, scheduled.dispatches[0].dispatchId)];
      h.state.config = { ...OPEN, dispatcherAvailable: false,
        policy: { grantedAt: POLICY.grantedAt, expiresAt: new Date('2026-11-07T00:00:00.000Z') } };
      h.clock.at = new Date('2026-11-09T00:00:00.000Z');
      const result = kind === 'CANCEL'
        ? await h.service.cancel(PRINCIPAL, POST_ID, cancelBody({ scope: 'SERIES', ...scopeOf('SERIES', scheduleId, 1, affected) }))
        : await h.service.delete(PRINCIPAL, POST_ID, deleteBody({ expectedScheduleGeneration: 1, expectedLifecycle: 'SCHEDULED',
          cancels: scopeOf('DELETE', scheduleId, 1, affected) }));
      expect(result.lifecycle).toBe(kind === 'CANCEL' ? 'DRAFT' : 'DELETED');
      expect(h.db.tables.managedDispatchCall).toEqual([]);
    });
    it('requires posts:schedule to cancel or delete and posts:publish to resolve', async () => {
      const h = harness();
      const publisher = { ...PRINCIPAL, scopes: ['posts:read', 'posts:publish'] };
      const scheduler = { ...PRINCIPAL, scopes: ['posts:read', 'posts:schedule'] };
      expect(await refusedWithoutWrites(h, h.service.delete(publisher, POST_ID, deleteBody()))).toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
      expect(await refusedWithoutWrites(h, h.service.cancel(publisher, POST_ID, {}))).toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
      expect(await refusedWithoutWrites(h, h.service.resolve(scheduler, randomUUID(), {}))).toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
      expect(h.configuration.gates).not.toHaveBeenCalled();
    });

    it('requires enabled organization authority for ending writes; human resolution needs no open provider window or dispatcher', async () => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const { scheduleId } = scheduled.schedule!;
      const affected = [pendingAt(0, PUBLISH_AT, scheduled.dispatches[0].dispatchId)];

      h.state.config = null;
      expect(await refusedWithoutWrites(h, h.service.cancel(PRINCIPAL, POST_ID, cancelBody({
        scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', scheduleId, 1, affected),
      })))).toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
      expect(await refusedWithoutWrites(h, h.service.delete(PRINCIPAL, POST_ID, deleteBody({
        expectedScheduleGeneration: 1, expectedLifecycle: 'SCHEDULED', cancels: scopeOf('DELETE', scheduleId, 1, affected),
      })))).toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
      const unknown = settleUnresolved(h, 0, 'UNKNOWN');
      expect(await refusedWithoutWrites(h, h.service.resolve(PRINCIPAL, unknown.id, resolveBody(unknown, NOT_PUBLISHED))))
        .toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });

      h.state.config = { ...OPEN, organizationEnabled: false };
      expect(await refusedWithoutWrites(h, h.service.resolve(PRINCIPAL, unknown.id, resolveBody(unknown, NOT_PUBLISHED))))
        .toMatchObject({ code: 'LIFECYCLE_NOT_ENABLED' });
      h.state.config = { ...OPEN, dispatcherAvailable: false, policy: null };
      h.clock.at = POLICY.expiresAt;
      expect(await refusedWithoutWrites(h, h.service.resolve(PRINCIPAL, unknown.id, resolveBody(unknown, NOT_PUBLISHED))))
        .toMatchObject({ code: 'OUTSIDE_LIFECYCLE_WINDOW', reason: 'POLICY_EXPIRED' });
      h.clock.at = new Date('2026-11-09T00:00:00.000Z');
      expect(await h.service.resolve(PRINCIPAL, unknown.id, resolveBody(unknown, NOT_PUBLISHED))).toMatchObject({ resolution: 'RESOLVED_NOT_PUBLISHED' });
    });

    it('replays an ending write exactly before any gate, and refuses its key with another credential, body or kind', async () => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const body = cancelBody({
        scope: 'OCCURRENCE', occurrence: 0,
        ...scopeOf('OCCURRENCE', scheduled.schedule!.scheduleId, 1, [pendingAt(0, PUBLISH_AT, scheduled.dispatches[0].dispatchId)]),
      });
      const first = await h.service.cancel(PRINCIPAL, POST_ID, body);

      h.state.config = null;
      h.clock.at = new Date('2026-11-12T00:00:00.000Z');
      const before = structuredClone(h.db.tables);
      expect(await h.service.cancel(PRINCIPAL, POST_ID, body)).toEqual({ ...first, replayed: true });
      expect(stable(h.db.tables)).toEqual(stable(before));

      expect(await refusedWithoutWrites(h, h.service.cancel({ ...PRINCIPAL, credentialId: 'cred_ww_2' }, POST_ID, body)))
        .toMatchObject({ code: 'OPERATION_KEY_CREDENTIAL_MISMATCH' });
      expect(await refusedWithoutWrites(h, h.service.cancel(PRINCIPAL, POST_ID, { ...body, expectedRevision: 2 })))
        .toMatchObject({ code: 'OPERATION_KEY_PAYLOAD_MISMATCH' });
      expect(await refusedWithoutWrites(h, h.service.delete(PRINCIPAL, POST_ID, deleteBody({ operationKey: 'ww-op-cancel-1' }))))
        .toMatchObject({ code: 'OPERATION_KEY_KIND_MISMATCH' });
      expect(await refusedWithoutWrites(h, h.service.resolve(PRINCIPAL, scheduled.dispatches[0].dispatchId,
        resolveBody({ version: 2, status: 'UNKNOWN' }, { ...NOT_PUBLISHED, operationKey: 'ww-op-cancel-1' }))))
        .toMatchObject({ code: 'OPERATION_KEY_KIND_MISMATCH' });
      expect(await refusedWithoutWrites(h, h.service.delete(PRINCIPAL, POST_ID, deleteBody({ operationKey: 'ww-op-create-1' }))))
        .toMatchObject({ code: 'OPERATION_KEY_KIND_MISMATCH' });

      expect(await h.service.operation(PRINCIPAL, 'ww-op-cancel-1')).toMatchObject({
        status: 'COMMITTED', kind: 'CANCEL', ack: 'CURRENT', result: first,
      });
    });

    it.each<[string, string]>([
      ['cancel', 'managedLifecycleOperation'],
      ['delete', 'managedLifecycleOperation'],
      ['delete', 'post'],
    ])('rolls back the whole %s when %s fails, never a false success', async (method, model) => {
      const h = harness();
      const scheduled = await h.service.schedule(PRINCIPAL, POST_ID, scheduleBody());
      const { scheduleId } = scheduled.schedule!;
      const affected = [pendingAt(0, PUBLISH_AT, scheduled.dispatches[0].dispatchId)];
      h.db.failOn = { model, action: model === 'post' ? 'updateMany' : 'create' };
      const before = structuredClone(h.db.tables);
      const request = method === 'cancel'
        ? h.service.cancel(PRINCIPAL, POST_ID, cancelBody({ scope: 'OCCURRENCE', occurrence: 0, ...scopeOf('OCCURRENCE', scheduleId, 1, affected) }))
        : h.service.delete(PRINCIPAL, POST_ID, deleteBody({ expectedScheduleGeneration: 1, expectedLifecycle: 'SCHEDULED', cancels: scopeOf('DELETE', scheduleId, 1, affected) }));
      await expect(request).rejects.toThrow('FAKE database failure');
      expect(h.db.tables).toEqual(before);
    });
  });
});
