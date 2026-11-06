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

// Settlement of an admitted provider mutation by the actual
// ManagedDispatchJournal, ManagedLifecycleRepository / ManagedLifecycleStore
// and ManagedPublishTransport, over an explicit FAKE in-memory Prisma port
// (the lifecycle models these use, a per-organization lock taken by the first
// managedOrganization.update with commit / rollback, the schema's unique
// constraints). The contract parsers and views are the real ones. Clock,
// budget, validator, event writer and the provider fetch behind the transport
// are FAKE ports: no database, Redis, provider, storage or network is
// involved, and nothing is published, scheduled or deleted anywhere. The root
// runs the real PostgreSQL crash scenarios separately
import { createHash, randomUUID } from 'crypto';
import { matches } from '@gitroom/nestjs-libraries/database/prisma/managed/__tests__/fakes/fake.prisma.db';
import { ManagedLifecycleRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.repository';
import {
  ManagedDispatchHandle,
  ManagedDispatchJournal,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.dispatch-journal';
import {
  managedDispatchView,
  managedScheduleView,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.views';
import {
  ManagedPublishContinuation,
  ManagedPublishOutcome,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.provider';
import { ManagedPublishTransport } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.transport';
import {
  lifecycleNextPollAt,
  MANAGED_LIFECYCLE_TIMING,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';

// ---- FAKE Prisma port -----------------------------------------------------------

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

const MODELS = [
  'managedOrganization',
  'managedPost',
  'post',
  'managedLifecycleOrganization',
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
  managedLifecycleOrganization: [['organizationId']],
  managedLifecycleOperation: [['organizationId', 'operationKey'], ['organizationId', 'sequence']],
  managedLifecycleChangeEvent: [['organizationId', 'sequence']],
  managedSchedule: [['managedPostId', 'scheduleGeneration'], ['organizationId', 'operationKey']],
  managedDispatch: [['scheduleId', 'occurrence'], ['activeCallId']],
  managedDispatchCall: [['dispatchId', 'member', 'step', 'stage', 'attempt']],
  managedMediaCapability: [['capabilityIdSha256'], ['organizationId', 'callId', 'mediaId']],
};

// the schema's defaults
const DEFAULTS: Record<string, () => Row> = {
  managedLifecycleChangeEvent: () => ({
    scheduleId: null, dispatchId: null, operationKey: null, scheduleGeneration: null, dispatchVersion: null,
  }),
  managedDispatchCall: () => ({
    stage: 0, code: null, consumedUnits: 0, sentLedger: null, pendingEnvelope: null, pollCount: 0,
    pollReservedUnits: 0, nextPollAt: null, pollDeadlineAt: null, lastPolledAt: null, result: null, settledAt: null,
  }),
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
        const row = rows().find((item) => matches(item, args.where));
        if (!row) throw new Error('FAKE record to update not found');
        apply(row, args.data);
        return pick(row, args.select);
      },
      updateMany: async (args: any) => {
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

// ---- FAKE provider behind the real transport -------------------------------------

const TOKEN = 'FAKE-ig-access-token-never-real-0123';
const GRAPH = 'https://graph.instagram.com/v22.0';
const IG_USER = '17841400000000001';
const MEDIA_ID = '17950000000000031';
const COMMENT_ID = '17960000000000041';
const PERMALINK = 'https://www.instagram.com/p/DFakePost01/';
const MUTATION = `${GRAPH}/${IG_USER}/media?access_token=${TOKEN}&image_url=https://media.ww.test/fixture.png`;
const READ = `${GRAPH}/${MEDIA_ID}?fields=permalink&access_token=${TOKEN}`;

type Reply = { status: number; body: unknown } | Error;
const ok = (body: unknown): Reply => ({ status: 200, body });

class FakeProvider {
  replies: Reply[] = [];
  fetch = jest.fn(async (_url: string) => {
    const reply = this.replies.shift();
    if (!reply) throw new Error('FAKE provider has no scripted reply');
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
}

// ---- the admitted occurrence ------------------------------------------------------

const ORG = 'org_journal_1';
const POST_ID = '5b2f7c1e-3a4d-4e8f-9b0a-1c2d3e4f5a6b';
const SCHEDULE_ID = '6c3f8d2e-4b5e-4f90-8c1b-2d3e4f5a6b7c';
const DISPATCH_ID = '7d4a9e3f-5c6f-4a01-9d2c-3e4f5a6b7c8d';
const HASH = `sha256:${'a'.repeat(64)}`;
const CREATED = new Date('2026-11-05T10:00:00.000Z');
const CANCEL_AT = new Date('2026-11-05T11:00:00.000Z');
const NOW = new Date('2026-11-06T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const SEALED = JSON.stringify({ v: 'FAKE-pending-v1', containers: ['17900000000000011'] });

type Step = 'POST' | 'COMMENT' | 'FINALIZE';

interface Seed {
  // the delay of every member, in minutes
  delays?: number[];
  // where the dispatch waits: a PENDING root POST, or an admitted later step
  at?: { step: Step; member: number };
  occurrence?: number;
  maxOccurrences?: number;
  schedule?: Row;
}

function harness(seed: Seed = {}) {
  const db = new FakeLifecycleDb();
  const clock = { at: NOW, now: () => new Date(clock.at) };
  const state = { valid: true, appendEvents: true };
  const seen: Row[] = [];
  const validate = jest.fn(async () => state.valid);
  // FAKE event writer: what it sees, then one storage-only event
  const event = jest.fn(async (store: any, kind: string, dispatch: Row) => {
    if (!state.appendEvents) return;
    seen.push({
      kind, dispatch: { ...dispatch }, head: await store.headSequence(),
      schedule: await store.getSchedule(dispatch.scheduleId), calls: await store.listCalls(dispatch.id),
    });
    await store.appendEvent({
      kind, entityType: 'DISPATCH', entityId: dispatch.id, managedPostId: dispatch.managedPostId,
      scheduleId: dispatch.scheduleId, dispatchId: dispatch.id, scheduleGeneration: dispatch.scheduleGeneration,
      dispatchVersion: dispatch.version, data: '{"fixture":"journal-only"}',
    });
  });
  const budget = {
    reserve: jest.fn(async () => true),
    reserveDetailed: jest.fn(async () => ({ accepted: true, code: 'RESERVED', retryAfterMs: null })),
  };
  const journal = new ManagedDispatchJournal({
    repository: new ManagedLifecycleRepository({ model: db.model } as any),
    budget: budget as any, now: () => clock.now(), validate, event,
  });

  const delays = seed.delays ?? [0, 5];
  const at = seed.at ?? { step: 'POST', member: 0 };
  const occurrence = seed.occurrence ?? 0;
  const maxOccurrences = seed.maxOccurrences ?? 1;
  const started = at.step !== 'POST';
  const t = db.tables;
  t.managedOrganization.push({ id: randomUUID(), organizationId: ORG, sequence: 5, createdAt: CREATED, updatedAt: CREATED });
  t.managedLifecycleOrganization.push({ id: randomUUID(), organizationId: ORG, sequence: 10 });
  t.managedSchedule.push({
    id: SCHEDULE_ID, organizationId: ORG, managedPostId: POST_ID, scheduleGeneration: 1, mode: 'AT', status: 'ACTIVE',
    version: 1, revision: 1, bindingGeneration: 2, integrationId: 'int_ig_1', providerIdentifier: 'instagram-standalone',
    identityFingerprint: HASH, contentSha256: 'b'.repeat(64), releaseHash: HASH, releaseHashVersion: 'ww-release-hash-v1',
    codec: 'ww-plain-escape-v1',
    release: JSON.stringify({ v: 'ww-scheduled-release-v1', members: delays.map((delay, position) => ({
      postId: `post_${position}`, position, delay, text: `text ${position}`, media: [],
    })) }),
    anchorAt: new Date(NOW.getTime() - occurrence * DAY), intervalDays: maxOccurrences > 1 ? 1 : null,
    maxOccurrences, lastOccurrence: maxOccurrences - 1, maxLatenessMs: 600000,
    policyGrantedAt: new Date('2026-11-05T00:00:00.000Z'), policyExpiresAt: new Date('2026-11-10T23:00:00.000Z'),
    operationKey: 'ww-op-schedule-1', credentialId: 'cred_ww_1', endRequestedOperationKey: null, endRequestedAt: null,
    endedAt: null, endedCode: null, endedOperationKey: null, createdAt: CREATED, updatedAt: CREATED,
    ...seed.schedule,
  });
  t.managedDispatch.push({
    id: DISPATCH_ID, organizationId: ORG, managedPostId: POST_ID, scheduleId: SCHEDULE_ID, occurrence,
    dueAt: NOW, admissibleUntil: new Date(NOW.getTime() + 600000), status: started ? 'ADMITTED' : 'PENDING',
    version: started ? 4 : 1, code: null, revision: 1, bindingGeneration: 2, scheduleGeneration: 1,
    contentSha256: 'b'.repeat(64), releaseHash: HASH,
    members: JSON.stringify(delays.map((_, position) => ({
      position, postId: `post_${position}`,
      status: position < at.member ? 'PUBLISHED' : position === at.member && at.step === 'FINALIZE' ? 'PENDING_PROVIDER' : 'WAITING',
      code: null,
      release: position < at.member ? { releaseId: `1795000000000000${position}`, releaseURL: null, source: 'PROVIDER_RESPONSE' } : null,
    }))),
    resolution: null, cancelledByOperationKey: null, leaseHolder: null, leaseExpiresAt: null,
    fencingToken: started ? 2 : 0, activeCallId: null, nextActionAt: NOW, nextStep: started ? at.step : null,
    nextMember: started ? at.member : null, deferralCode: null, deferralCount: 0, firstDeferredAt: null,
    lastDeferredAt: null, admittedAt: started ? new Date(NOW.getTime() - 10 * MINUTE) : null, settledAt: null,
    lastLifecycleSequence: 10, createdAt: CREATED, updatedAt: CREATED,
  });
  return { db, clock, state, seen, validate, event, budget, journal, provider: new FakeProvider() };
}
type Harness = ReturnType<typeof harness>;

const dispatchRow = (t: Harness) => t.db.tables.managedDispatch.find((row) => row.id === DISPATCH_ID)!;
const scheduleRow = (t: Harness) => t.db.tables.managedSchedule.find((row) => row.id === SCHEDULE_ID)!;
const callRow = (t: Harness, id: string) => t.db.tables.managedDispatchCall.find((row) => row.id === id)!;
const members = (t: Harness) => JSON.parse(dispatchRow(t).members);
const calls = (t: Harness) => t.db.tables.managedDispatchCall.filter((row) => row.dispatchId === DISPATCH_ID);
const view = (t: Harness) => managedDispatchView(dispatchRow(t) as any, calls(t) as any);
// every durable row but the organization lock row, whose updatedAt each
// mutate touches
const durable = (t: Harness) =>
  structuredClone(Object.fromEntries(Object.entries(t.db.tables).filter(([model]) => model !== 'managedOrganization')));

async function admitted(t: Harness, step: Step, member: number, overrides: Row = {}): Promise<ManagedDispatchHandle> {
  const result = await t.journal.admit(ORG, {
    dispatchId: DISPATCH_ID, expectedVersion: dispatchRow(t).version, member, step, stage: 0, attempt: 1,
    reservedUnits: 2, deadlineMs: 60_000, requestHash: HASH, ...overrides,
  });
  if (result.status !== 'ADMITTED') throw new Error(`FAKE admission refused: ${result.status}`);
  return result.handle;
}

// the real transport of one admitted step, journaled by the real journal
const transportFor = (t: Harness, handle: ManagedDispatchHandle) =>
  new ManagedPublishTransport({
    reservedUnits: 2, deadlineAt: new Date(handle.deadlineAt), now: () => t.clock.now(),
    verifyAdmission: (deadlineAt) => t.journal.verifyAdmission(handle, deadlineAt),
    recordAttempt: (ordinal, mutation) => t.journal.recordAttempt(handle, ordinal, mutation),
    fetch: t.provider.fetch as unknown as typeof fetch,
  });

async function send(transport: ManagedPublishTransport, ...requests: ('mutation' | 'read')[]) {
  for (const request of requests) {
    await transport
      .adapterFetch()(request === 'mutation' ? MUTATION : READ, { method: request === 'mutation' ? 'POST' : 'GET' })
      .catch(() => undefined);
  }
}

// a capability minted for the call; never a usable token
function grant(t: Harness, callId: string) {
  t.db.tables.managedMediaCapability.push({
    capabilityIdSha256: createHash('sha256').update(`FAKE capability ${callId}`).digest('hex'),
    keyId: 'FAKE-key', organizationId: ORG, dispatchId: DISPATCH_ID, callId, dispatchVersion: dispatchRow(t).version,
    mediaId: 'media_image', evidenceId: 'evidence_media_image', sha256: 'c'.repeat(64), byteLength: 3008,
    mimeType: 'image/png', storageKey: 'FAKE-key.png', storageNamespace: 'FAKE-namespace', storageVersion: 'FAKE-v1',
    issuedAt: NOW, expiresAt: new Date(NOW.getTime() + 30 * MINUTE), maxFetches: 3, fetchCount: 0,
    revokedAt: null, revokeReason: null,
  });
}
const capability = (t: Harness, callId: string) =>
  t.db.tables.managedMediaCapability.find((row) => row.callId === callId)!;

const later = (t: Harness, ms: number) => (t.clock.at = new Date(t.clock.at.getTime() + ms));

const published = (releaseId = MEDIA_ID, releaseURL: string | null = PERMALINK): ManagedPublishOutcome =>
  ({ status: 'success', releaseId, releaseURL });

// The root's FINALIZE answered with the publication's id and permalink
async function publishRoot(t: Harness, outcome = published()) {
  const handle = await admitted(t, 'FINALIZE', 0);
  grant(t, handle.callId);
  later(t, 1000);
  const transport = transportFor(t, handle);
  t.provider.replies.push(ok({ id: MEDIA_ID }), ok({ permalink: PERMALINK }));
  await send(transport, 'mutation', 'read');
  return { handle, transport, settled: await t.journal.settle(handle, outcome, transport) };
}

beforeAll(() => {
  // nothing here may reach a network: the only fetch is the FAKE provider's
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('External HTTP is forbidden in this spec');
  });
});
afterEach(() => expect(globalThis.fetch).not.toHaveBeenCalled());
afterAll(() => jest.restoreAllMocks());

// ---- success ------------------------------------------------------------------------

describe('a published member', () => {
  it('waits the next comment’s stored delay, then the last comment publishes the dispatch and completes the schedule', async () => {
    const t = harness({ delays: [0, 5], at: { step: 'FINALIZE', member: 0 } });
    const { handle, settled } = await publishRoot(t);
    const settledAt = new Date(t.clock.at);

    expect(settled).toEqual({ status: 'SETTLED', call: 'OK', dispatch: 'ADMITTED', next: 'COMMENT' });
    const call = callRow(t, handle.callId);
    expect(call).toMatchObject({
      status: 'OK', code: null, settledAt, holder: handle.holder,
      dispatchVersion: handle.dispatchVersion, fencingToken: handle.fencingToken,
    });
    expect(JSON.parse(call.result)).toEqual({ releaseId: MEDIA_ID, releaseURL: PERMALINK });
    expect(JSON.parse(call.sentLedger)).toEqual({
      attemptedRequests: 2, attemptedMutations: 1, completedRequests: 2, mutationMayHaveLeft: true, failure: null,
    });
    expect(dispatchRow(t)).toMatchObject({
      status: 'ADMITTED', version: handle.dispatchVersion + 1, fencingToken: handle.fencingToken,
      activeCallId: null, leaseHolder: null, leaseExpiresAt: null, nextStep: 'COMMENT', nextMember: 1,
      nextActionAt: new Date(settledAt.getTime() + 5 * MINUTE), settledAt: null,
    });
    expect(members(t)).toEqual([
      { position: 0, postId: 'post_0', status: 'PUBLISHED', code: null,
        release: { releaseId: MEDIA_ID, releaseURL: PERMALINK, source: 'PROVIDER_RESPONSE' } },
      { position: 1, postId: 'post_1', status: 'WAITING', code: null, release: null },
    ]);
    expect(capability(t, handle.callId)).toMatchObject({ revokedAt: settledAt, revokeReason: 'CALL_SETTLED' });
    expect(scheduleRow(t)).toMatchObject({ status: 'ACTIVE', version: 1, scheduleGeneration: 1, endedAt: null });
    expect(view(t).continuation).toEqual({
      kind: 'NEXT_STEP', member: 1, nextStep: 'COMMENT', attempt: 1,
      nextActionAt: new Date(settledAt.getTime() + 5 * MINUTE).toISOString(),
    });

    // the callback saw the dispatch after its one transition, and its event
    // took exactly the sequence the transition recorded
    const progressed = t.seen[t.seen.length - 1];
    expect(progressed.kind).toBe('DISPATCH_PROGRESSED');
    expect(progressed.dispatch.version).toBe(dispatchRow(t).version);
    expect(progressed.dispatch.lastLifecycleSequence).toBe(progressed.head + 1);
    expect(progressed.calls.find((row: Row) => row.id === handle.callId).status).toBe('OK');
    expect(t.db.tables.managedLifecycleOrganization[0].sequence).toBe(progressed.head + 1);

    // the comment is not due before its delay
    later(t, 1000);
    expect((await t.journal.admit(ORG, {
      dispatchId: DISPATCH_ID, expectedVersion: dispatchRow(t).version, member: 1, step: 'COMMENT', stage: 0,
      attempt: 1, reservedUnits: 2, deadlineMs: 60_000, requestHash: HASH,
    })).status).toBe('STATE_REFUSED');

    t.clock.at = new Date(dispatchRow(t).nextActionAt);
    const comment = await admitted(t, 'COMMENT', 1);
    later(t, 1000);
    const transport = transportFor(t, comment);
    t.provider.replies.push(ok({ id: COMMENT_ID }), ok({ permalink: PERMALINK }));
    await send(transport, 'mutation', 'read');
    const done = await t.journal.settle(comment, published(COMMENT_ID, null), transport);
    const doneAt = new Date(t.clock.at);

    expect(done).toEqual({ status: 'SETTLED', call: 'OK', dispatch: 'PUBLISHED', next: null });
    expect(dispatchRow(t)).toMatchObject({
      status: 'PUBLISHED', code: null, settledAt: doneAt, activeCallId: null, leaseHolder: null,
      nextActionAt: null, nextStep: null, nextMember: null,
    });
    expect(members(t)[1]).toEqual({ position: 1, postId: 'post_1', status: 'PUBLISHED', code: null,
      release: { releaseId: COMMENT_ID, releaseURL: null, source: 'PROVIDER_RESPONSE' } });
    expect(scheduleRow(t)).toMatchObject({
      status: 'COMPLETED', version: 2, scheduleGeneration: 1, endedAt: doneAt, endedCode: 'PUBLISHED',
      endedOperationKey: null, endRequestedOperationKey: null,
    });
    expect(t.seen[t.seen.length - 1].kind).toBe('DISPATCH_PUBLISHED');
    // the callback already sees the schedule it ended
    expect(t.seen[t.seen.length - 1].schedule.status).toBe('COMPLETED');
    expect(view(t).status).toBe('PUBLISHED');
    expect(managedScheduleView(scheduleRow(t) as any).status).toBe('COMPLETED');
  });

  it.each([
    ['the canonical Instagram permalink', PERMALINK, PERMALINK],
    ['a plain http URL', 'http://www.instagram.com/p/DFakePost01/', null],
    ['a query', 'https://www.instagram.com/p/DFakePost01/?igsh=FAKE', null],
    ['a fragment', 'https://www.instagram.com/p/DFakePost01/#x', null],
    ['credentials', 'https://user:pw@www.instagram.com/p/DFakePost01/', null],
    ['a port', 'https://www.instagram.com:8443/p/DFakePost01/', null],
    ['a spelling the parser changes', 'https://WWW.instagram.com/p/DFakePost01/', null],
    ['an oversized URL', `https://www.instagram.com/p/${'a'.repeat(2100)}/`, null],
    ['no URL', null, null],
  ])('answers %s as the release URL it may be', async (_name, releaseURL, expected) => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 } });
    expect((await publishRoot(t, published(MEDIA_ID, releaseURL))).settled.call).toBe('OK');
    expect(members(t)[0].release).toEqual({ releaseId: MEDIA_ID, releaseURL: expected, source: 'PROVIDER_RESPONSE' });
    expect(view(t).status).toBe('PUBLISHED');
  });
});

// ---- pending ------------------------------------------------------------------------

describe('a pending answer', () => {
  it('keeps the sealed continuation and the call’s capability authority, with a fixed poll deadline and no sender lease', async () => {
    const t = harness({ delays: [0, 5] });
    const handle = await admitted(t, 'POST', 0);
    grant(t, handle.callId);
    const leaseExpiresAt = callRow(t, handle.callId).leaseExpiresAt;
    later(t, 2000);
    const transport = transportFor(t, handle);
    t.provider.replies.push(ok({ id: '17900000000000011' }));
    await send(transport, 'mutation');
    const settled = await t.journal.settle(handle,
      { status: 'pending', continuation: new ManagedPublishContinuation(SEALED) }, transport);
    const pendingSince = new Date(t.clock.at);
    const nextPollAt = new Date(lifecycleNextPollAt(pendingSince.toISOString(), null, 0));

    expect(settled).toEqual({ status: 'SETTLED', call: 'PENDING_PROVIDER', dispatch: 'ADMITTED', next: 'POLL' });
    expect(nextPollAt.getTime()).toBe(pendingSince.getTime() + MANAGED_LIFECYCLE_TIMING.pollInitialDelayMs);
    expect(callRow(t, handle.callId)).toMatchObject({
      status: 'PENDING_PROVIDER', code: null, pendingEnvelope: SEALED, pollCount: 0, lastPolledAt: null, nextPollAt,
      pollDeadlineAt: new Date(pendingSince.getTime() + 30 * MINUTE), settledAt: null, result: null,
      // what the capability authority binds stays exactly as admitted
      holder: handle.holder, dispatchVersion: handle.dispatchVersion, fencingToken: handle.fencingToken, leaseExpiresAt,
    });
    expect(dispatchRow(t)).toMatchObject({
      status: 'ADMITTED', version: handle.dispatchVersion + 1, activeCallId: handle.callId,
      leaseHolder: null, leaseExpiresAt: null, nextActionAt: nextPollAt, nextStep: null, nextMember: null,
    });
    expect(members(t)[0]).toEqual({ position: 0, postId: 'post_0', status: 'PENDING_PROVIDER', code: null, release: null });
    expect(members(t)[1].status).toBe('WAITING');
    expect(capability(t, handle.callId)).toMatchObject({ revokedAt: null, revokeReason: null });
    expect(scheduleRow(t)).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(t.seen[t.seen.length - 1].kind).toBe('DISPATCH_PROGRESSED');

    const projected = view(t);
    expect(projected.continuation).toEqual({
      kind: 'PROVIDER_PENDING', member: 0, step: 'POST', callId: handle.callId,
      pendingSince: pendingSince.toISOString(), pollCount: 0, lastPolledAt: null,
      nextPollAt: nextPollAt.toISOString(), pollDeadlineAt: new Date(pendingSince.getTime() + 30 * MINUTE).toISOString(),
    });
    // no continuation, URL or token in the public projection, and no token or
    // request URL anywhere durable
    const text = JSON.stringify(projected);
    expect(text).not.toContain('FAKE-pending');
    expect(text).not.toContain('https://');
    expect(JSON.stringify(t.db.tables)).not.toContain(TOKEN);
    expect(JSON.stringify(t.db.tables)).not.toContain('media.ww.test');

    // settled once: the same answer again changes nothing
    const before = durable(t);
    expect(await t.journal.settle(handle,
      { status: 'pending', continuation: new ManagedPublishContinuation(SEALED) }, transport))
      .toEqual({ status: 'STALE', lateEvidence: false });
    expect(durable(t)).toEqual(before);

    // no lease to expire, no next step to admit; polling is a later job
    t.clock.at = new Date(pendingSince.getTime() + 20 * MINUTE);
    expect(await t.journal.recoverExpired(ORG, DISPATCH_ID)).toBe(false);
    t.clock.at = new Date(nextPollAt);
    expect((await t.journal.admit(ORG, {
      dispatchId: DISPATCH_ID, expectedVersion: dispatchRow(t).version, member: 0, step: 'FINALIZE', stage: 0,
      attempt: 1, reservedUnits: 2, deadlineMs: 60_000, requestHash: HASH,
    })).status).toBe('STATE_REFUSED');
    expect(durable(t)).toEqual(before);
  });
});

// ---- what may not become NOT_SENT or published -------------------------------------

describe('an answer the ledger does not support', () => {
  it('is UNKNOWN, never NOT_SENT, after a mutation may have left', async () => {
    const t = harness({ delays: [0, 5] });
    const handle = await admitted(t, 'POST', 0);
    grant(t, handle.callId);
    later(t, 1000);
    const transport = transportFor(t, handle);
    t.provider.replies.push(new Error('FAKE socket reset after the request was written'));
    await send(transport, 'mutation');
    expect(transport.ledger()).toMatchObject({ attemptedMutations: 1, mutationMayHaveLeft: true, completedRequests: 0 });

    const settled = await t.journal.settle(handle, { status: 'not_sent', code: 'REQUEST_NOT_SENT' }, transport);
    expect(settled).toEqual({ status: 'SETTLED', call: 'UNKNOWN', dispatch: 'UNKNOWN', next: null });
    expect(callRow(t, handle.callId)).toMatchObject({ status: 'UNKNOWN', code: 'OUTCOME_UNKNOWN' });
    expect(dispatchRow(t)).toMatchObject({ status: 'UNKNOWN', code: 'OUTCOME_UNKNOWN', activeCallId: null, nextActionAt: null });
    expect(members(t).map((member: Row) => [member.status, member.code])).toEqual([
      ['UNKNOWN', 'OUTCOME_UNKNOWN'], ['NOT_SENT', 'PREVIOUS_MEMBER_FAILED'],
    ]);
    expect(scheduleRow(t)).toMatchObject({ status: 'HALTED', endedCode: 'UNKNOWN', endedAt: t.clock.at, scheduleGeneration: 1 });
    expect(capability(t, handle.callId).revokeReason).toBe('CALL_SETTLED');
    expect(t.seen[t.seen.length - 1].kind).toBe('DISPATCH_OUTCOME_UNKNOWN');
    expect(view(t).status).toBe('UNKNOWN');
    expect(managedScheduleView(scheduleRow(t) as any).status).toBe('HALTED');

    // never sent again
    expect((await t.journal.admit(ORG, {
      dispatchId: DISPATCH_ID, expectedVersion: dispatchRow(t).version, member: 0, step: 'POST', stage: 0,
      attempt: 2, reservedUnits: 2, deadlineMs: 60_000, requestHash: HASH,
    })).status).toBe('STATE_REFUSED');
    expect(t.provider.fetch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, ('mutation' | 'read')[], Reply[], unknown]>([
    ['ready, which only answers a poll', ['mutation'], [ok({ id: MEDIA_ID })],
      { status: 'ready', continuation: new ManagedPublishContinuation(SEALED) }],
    ['poll_failed, which only answers a poll', ['mutation'], [ok({ id: MEDIA_ID })], { status: 'poll_failed' }],
    ['success after nothing but a read', ['read'], [ok({ permalink: PERMALINK })], published()],
    ['success whose only mutation was never answered', ['read', 'mutation'],
      [ok({ permalink: PERMALINK }), new Error('FAKE timeout')], published()],
    ['success without a printable release id', ['mutation'], [ok({ id: MEDIA_ID })], published('not printable\n')],
    ['pending without the adapter’s sealed continuation', ['mutation'], [ok({ id: MEDIA_ID })],
      { status: 'pending', continuation: { sealed: () => SEALED } }],
    ['pending after a failed request', ['mutation', 'read'], [ok({ id: MEDIA_ID }), new Error('FAKE reset')],
      { status: 'pending', continuation: new ManagedPublishContinuation(SEALED) }],
    ['a rejection nobody answered', ['read'], [new Error('FAKE reset')], { status: 'rejected', code: 'PROVIDER_REJECTED' }],
    ['NOT_SENT with a code the adapter never answers', [], [], { status: 'not_sent', code: 'WINDOW_CLOSED' }],
    ['an unknown status', ['mutation'], [ok({ id: MEDIA_ID })], { status: 'published' }],
  ])('%s is UNKNOWN', async (_name, requests, replies, outcome) => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 } });
    const handle = await admitted(t, 'FINALIZE', 0);
    later(t, 1000);
    const transport = transportFor(t, handle);
    t.provider.replies.push(...replies);
    await send(transport, ...requests);
    expect(await t.journal.settle(handle, outcome as ManagedPublishOutcome, transport))
      .toEqual({ status: 'SETTLED', call: 'UNKNOWN', dispatch: 'UNKNOWN', next: null });
    expect(callRow(t, handle.callId)).toMatchObject({ status: 'UNKNOWN', code: 'OUTCOME_UNKNOWN', pendingEnvelope: null, result: null });
    expect(members(t)[0]).toMatchObject({ status: 'UNKNOWN', release: null });
    expect(scheduleRow(t).status).toBe('HALTED');
    expect(view(t).status).toBe('UNKNOWN');
  });

  it('is UNKNOWN when the transport ledger is not the durable pre-send record', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 } });
    const handle = await admitted(t, 'FINALIZE', 0);
    later(t, 1000);
    t.provider.replies.push(ok({ id: MEDIA_ID }));
    await send(transportFor(t, handle), 'mutation');
    // another transport, which never sent the journaled mutation
    const settled = await t.journal.settle(handle, published(), transportFor(t, handle));
    expect(settled).toEqual({ status: 'SETTLED', call: 'UNKNOWN', dispatch: 'UNKNOWN', next: null });
    // the durable pre-send record is kept, not replaced by the other ledger
    expect(JSON.parse(callRow(t, handle.callId).sentLedger)).toMatchObject({ attemptedRequests: 1, attemptedMutations: 1 });
    expect(members(t)[0].release).toBeNull();
  });

  it('refuses a ledger that is not a step transport before anything is written', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 } });
    const handle = await admitted(t, 'FINALIZE', 0);
    const before = durable(t);
    await expect(t.journal.settle(handle, published(), {
      ledger: () => ({ attemptedRequests: 0, attemptedMutations: 0, completedRequests: 0, mutationMayHaveLeft: false, failure: null }),
    } as any)).rejects.toThrow('Settlement needs the step transport');
    expect(durable(t)).toEqual(before);
  });
});

// ---- NOT_SENT -------------------------------------------------------------------------

describe('a proved NOT_SENT', () => {
  it('earns exactly one second attempt, as a new call with its own reservation, then ends NOT_SENT', async () => {
    const t = harness({ delays: [0, 5] });
    const first = await admitted(t, 'POST', 0);
    grant(t, first.callId);
    later(t, 1000);
    const transport = transportFor(t, first);
    // a read answered 429: nothing that mutates ever left
    t.provider.replies.push({ status: 429, body: { error: { code: 4 } } });
    await send(transport, 'read');
    expect(transport.ledger()).toEqual({
      attemptedRequests: 1, attemptedMutations: 0, completedRequests: 1, mutationMayHaveLeft: false, failure: 'PROVIDER_REJECTED',
    });
    const retry = await t.journal.settle(first, { status: 'not_sent', code: 'REQUEST_NOT_SENT' }, transport);
    const settledAt = new Date(t.clock.at);

    expect(retry).toEqual({ status: 'SETTLED', call: 'NOT_SENT', dispatch: 'ADMITTED', next: 'RETRY' });
    expect(callRow(t, first.callId)).toMatchObject({ status: 'NOT_SENT', code: 'REQUEST_NOT_SENT', settledAt });
    expect(capability(t, first.callId).revokeReason).toBe('CALL_SETTLED');
    expect(dispatchRow(t)).toMatchObject({
      status: 'ADMITTED', activeCallId: null, leaseHolder: null, nextStep: 'POST', nextMember: 0, nextActionAt: settledAt,
    });
    expect(members(t)[0]).toEqual({ position: 0, postId: 'post_0', status: 'WAITING', code: null, release: null });
    expect(view(t).continuation).toEqual({
      kind: 'NEXT_STEP', member: 0, nextStep: 'POST', attempt: 2, nextActionAt: settledAt.toISOString(),
    });
    expect(scheduleRow(t).status).toBe('ACTIVE');

    // attempt 1 again is refused; attempt 2 is a new admission
    expect((await t.journal.admit(ORG, {
      dispatchId: DISPATCH_ID, expectedVersion: dispatchRow(t).version, member: 0, step: 'POST', stage: 0,
      attempt: 1, reservedUnits: 2, deadlineMs: 60_000, requestHash: HASH,
    })).status).toBe('STATE_REFUSED');
    const second = await admitted(t, 'POST', 0, { attempt: 2 });
    expect(second.callId).not.toBe(first.callId);
    expect(t.budget.reserveDetailed).toHaveBeenCalledTimes(3);
    expect(callRow(t, second.callId)).toMatchObject({ attempt: 2, status: 'DISPATCHING' });

    later(t, 1000);
    const done = await t.journal.settle(second, { status: 'not_sent', code: 'REQUEST_NOT_SENT' }, transportFor(t, second));
    expect(done).toEqual({ status: 'SETTLED', call: 'NOT_SENT', dispatch: 'NOT_SENT', next: null });
    expect(dispatchRow(t)).toMatchObject({ status: 'NOT_SENT', code: 'REQUEST_NOT_SENT', settledAt: t.clock.at, nextActionAt: null });
    expect(members(t).map((member: Row) => [member.status, member.code])).toEqual([
      ['NOT_SENT', 'REQUEST_NOT_SENT'], ['NOT_SENT', 'PREVIOUS_MEMBER_FAILED'],
    ]);
    expect(scheduleRow(t)).toMatchObject({ status: 'HALTED', endedCode: 'NOT_SENT' });
    expect(t.seen.map((seen) => seen.kind)).toEqual([
      'DISPATCH_ADMITTED', 'DISPATCH_PROGRESSED', 'DISPATCH_PROGRESSED', 'DISPATCH_NOT_SENT',
    ]);
    expect(view(t).status).toBe('NOT_SENT');
    expect(t.provider.fetch).toHaveBeenCalledTimes(1);
  });

  it('of media is final at once', async () => {
    const t = harness({ delays: [0, 5] });
    const handle = await admitted(t, 'POST', 0);
    const settled = await t.journal.settle(handle, { status: 'not_sent', code: 'MEDIA_CHANGED' }, transportFor(t, handle));
    expect(settled).toEqual({ status: 'SETTLED', call: 'NOT_SENT', dispatch: 'NOT_SENT', next: null });
    expect(dispatchRow(t)).toMatchObject({ status: 'NOT_SENT', code: 'MEDIA_CHANGED' });
    expect(view(t).status).toBe('NOT_SENT');
  });
});

// ---- ownership ----------------------------------------------------------------------

describe('a settlement that is not the current admission', () => {
  it.each<[string, (handle: ManagedDispatchHandle) => ManagedDispatchHandle]>([
    ['another holder', (handle) => ({ ...handle, holder: randomUUID() })],
    ['another dispatch version', (handle) => ({ ...handle, dispatchVersion: handle.dispatchVersion + 1 })],
    ['another fence', (handle) => ({ ...handle, fencingToken: handle.fencingToken + 1 })],
    ['another call', (handle) => ({ ...handle, callId: randomUUID() })],
    ['another deadline', (handle) => ({ ...handle, deadlineAt: handle.deadlineAt + 1 })],
  ])('with %s changes nothing', async (_name, change) => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 } });
    const handle = await admitted(t, 'FINALIZE', 0);
    later(t, 1000);
    const transport = transportFor(t, handle);
    t.provider.replies.push(ok({ id: MEDIA_ID }));
    await send(transport, 'mutation');
    const before = durable(t);
    const events = t.event.mock.calls.length;
    expect(await t.journal.settle(change(handle), published(), transport)).toEqual({ status: 'STALE', lateEvidence: false });
    expect(durable(t)).toEqual(before);
    expect(t.event).toHaveBeenCalledTimes(events);
  });

  it('after its deadline never publishes; recovery makes it UNKNOWN and the success is kept only as late evidence', async () => {
    const t = harness({ delays: [0, 5], at: { step: 'FINALIZE', member: 0 } });
    const handle = await admitted(t, 'FINALIZE', 0);
    later(t, 1000);
    const transport = transportFor(t, handle);
    t.provider.replies.push(ok({ id: MEDIA_ID }));
    await send(transport, 'mutation');

    t.clock.at = new Date(handle.deadlineAt);
    const before = durable(t);
    expect(await t.journal.settle(handle, published(), transport)).toEqual({ status: 'STALE', lateEvidence: false });
    expect(durable(t)).toEqual(before);
    expect(callRow(t, handle.callId).status).toBe('DISPATCHING');

    t.clock.at = new Date(dispatchRow(t).leaseExpiresAt.getTime() + 1);
    expect(await t.journal.recoverExpired(ORG, DISPATCH_ID)).toBe(true);
    expect(await t.journal.settle(handle, published(MEDIA_ID, `${PERMALINK}?igsh=FAKE`), transport))
      .toEqual({ status: 'STALE', lateEvidence: true });
    const call = callRow(t, handle.callId);
    expect(call).toMatchObject({ status: 'UNKNOWN', code: 'DISPATCHER_LOST' });
    expect(JSON.parse(call.result)).toEqual({
      kind: 'LATE_EVIDENCE', observedAt: t.clock.at.toISOString(), releaseId: MEDIA_ID, releaseURL: null, changesOutcome: false,
    });
    expect(dispatchRow(t)).toMatchObject({ status: 'UNKNOWN', code: 'DISPATCHER_LOST' });
    expect(members(t)[0]).toMatchObject({ status: 'UNKNOWN', release: null });
    // the evidence slot is taken once
    expect(await t.journal.settle(handle, published('another-id', null), transport))
      .toEqual({ status: 'STALE', lateEvidence: false });
  });

  it('is not refused because the send authority closed after the request', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 } });
    const handle = await admitted(t, 'FINALIZE', 0);
    later(t, 1000);
    const transport = transportFor(t, handle);
    t.provider.replies.push(ok({ id: MEDIA_ID }));
    await send(transport, 'mutation');
    t.state.valid = false;
    // nothing more may be sent, but what was answered is recorded
    expect(await t.journal.verifyAdmission(handle, new Date(handle.deadlineAt))).toBe(false);
    const validated = t.validate.mock.calls.length;
    expect((await t.journal.settle(handle, published(), transport)).dispatch).toBe('PUBLISHED');
    expect(t.validate).toHaveBeenCalledTimes(validated);
  });

  it('settles once; the same answer again is stale and changes nothing', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 } });
    const { handle, transport, settled } = await publishRoot(t);
    expect(settled.status).toBe('SETTLED');
    const before = durable(t);
    const events = t.event.mock.calls.length;
    expect(await t.journal.settle(handle, published(), transport)).toEqual({ status: 'STALE', lateEvidence: false });
    expect(durable(t)).toEqual(before);
    expect(t.event).toHaveBeenCalledTimes(events);
  });

  it('rolls back entirely when the event writer appends no event', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 } });
    const handle = await admitted(t, 'FINALIZE', 0);
    later(t, 1000);
    const transport = transportFor(t, handle);
    t.provider.replies.push(ok({ id: MEDIA_ID }));
    await send(transport, 'mutation');
    const before = durable(t);
    t.state.appendEvents = false;
    await expect(t.journal.settle(handle, published(), transport)).rejects.toThrow('exactly one lifecycle event');
    expect(durable(t)).toEqual(before);
    expect(callRow(t, handle.callId).status).toBe('DISPATCHING');
  });
});

// ---- PARTIAL ------------------------------------------------------------------------

describe('a failed comment', () => {
  it.each<[string, Reply, ManagedPublishOutcome, string, string]>([
    ['rejected', { status: 400, body: { error: { code: 100 } } }, { status: 'rejected', code: 'PROVIDER_REJECTED' }, 'REJECTED', 'PROVIDER_REJECTED'],
    ['unknown', new Error('FAKE reset'), { status: 'unknown', code: 'LEASE_LOST' }, 'UNKNOWN', 'LEASE_LOST'],
  ])('%s leaves the dispatch PARTIAL and halts the series', async (_name, reply, outcome, status, code) => {
    const t = harness({ delays: [0, 5, 5], at: { step: 'COMMENT', member: 1 } });
    const handle = await admitted(t, 'COMMENT', 1);
    grant(t, handle.callId);
    later(t, 1000);
    const transport = transportFor(t, handle);
    t.provider.replies.push(reply);
    await send(transport, 'mutation');
    expect(await t.journal.settle(handle, outcome, transport))
      .toEqual({ status: 'SETTLED', call: status, dispatch: 'PARTIAL', next: null });
    expect(dispatchRow(t)).toMatchObject({ status: 'PARTIAL', code, settledAt: t.clock.at, activeCallId: null });
    expect(members(t).map((member: Row) => [member.status, member.code])).toEqual([
      ['PUBLISHED', null], [status, code], ['NOT_SENT', 'PREVIOUS_MEMBER_FAILED'],
    ]);
    expect(members(t)[0].release).not.toBeNull();
    expect(scheduleRow(t)).toMatchObject({ status: 'HALTED', endedCode: 'PARTIAL' });
    expect(capability(t, handle.callId).revokeReason).toBe('CALL_SETTLED');
    expect(t.seen[t.seen.length - 1].kind).toBe('DISPATCH_PARTIAL');
    expect(view(t).status).toBe('PARTIAL');
  });
});

// ---- the schedule ---------------------------------------------------------------------

// The stored answer of the REMAINING cancel that truncated the series to end
// after occurrence 1, as the lifecycle service keeps it
function truncatedBy(t: Harness, operationKey: string) {
  const schedule = managedScheduleView(scheduleRow(t) as any);
  const result = {
    version: 'ww.managed-lifecycle.v1', kind: 'CANCEL', operationKey, payloadHash: HASH, replayed: false,
    sequence: 9, committedAt: CANCEL_AT.toISOString(), managedPostId: POST_ID, revision: 1, scheduleGeneration: 1,
    lifecycle: 'DISPATCHING', schedule, dispatches: [],
    cancellation: {
      scope: 'REMAINING', scheduleId: SCHEDULE_ID, cancelledOccurrences: [2], series: 'ENDS_AFTER_IN_FLIGHT',
      generation: 'UNCHANGED', scheduleVersion: 'ADVANCED',
    },
  };
  t.db.tables.managedLifecycleOperation.push({
    id: randomUUID(), organizationId: ORG, operationKey, kind: 'CANCEL', payloadHash: HASH, credentialId: 'cred_ww_1',
    managedPostId: POST_ID, dispatchId: null, scheduleId: SCHEDULE_ID, revision: 1, scheduleGeneration: 1, sequence: 9,
    result: JSON.stringify(result), committedAt: CANCEL_AT, createdAt: CANCEL_AT,
  });
}

const ENDING = {
  status: 'ENDING', version: 2, lastOccurrence: 1,
  endRequestedOperationKey: 'ww-op-cancel-1', endRequestedAt: CANCEL_AT,
};

describe('a settled occurrence', () => {
  it('published before the last leaves the series live and materializes nothing', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 }, occurrence: 0, maxOccurrences: 3 });
    expect((await publishRoot(t)).settled.dispatch).toBe('PUBLISHED');
    expect(scheduleRow(t)).toMatchObject({ status: 'ACTIVE', version: 1, endedAt: null, lastOccurrence: 2 });
    expect(t.db.tables.managedDispatch).toHaveLength(1);
  });

  it('published as the last of a series completes it', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 }, occurrence: 2, maxOccurrences: 3 });
    await publishRoot(t);
    expect(scheduleRow(t)).toMatchObject({ status: 'COMPLETED', version: 2, endedCode: 'PUBLISHED', endedOperationKey: null });
    expect(managedScheduleView(scheduleRow(t) as any).status).toBe('COMPLETED');
  });

  it('published as the last of a truncated series cancels it, keeping its first end request', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 }, occurrence: 1, maxOccurrences: 3, schedule: ENDING });
    truncatedBy(t, 'ww-op-cancel-1');
    await publishRoot(t);
    expect(scheduleRow(t)).toMatchObject({
      status: 'CANCELLED', version: 3, scheduleGeneration: 1, endedAt: t.clock.at, endedCode: 'PUBLISHED',
      endRequestedOperationKey: 'ww-op-cancel-1', endRequestedAt: CANCEL_AT, endedOperationKey: 'ww-op-cancel-1',
      lastOccurrence: 1,
    });
    expect(managedScheduleView(scheduleRow(t) as any).status).toBe('CANCELLED');
  });

  it('finds the retained truncation after a later non-truncating schedule version', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 }, occurrence: 1, maxOccurrences: 3, schedule: ENDING });
    truncatedBy(t, 'ww-op-cancel-1');
    // The durable operation history still proves the exact last occurrence.
    scheduleRow(t).version = 3;
    expect((await publishRoot(t)).settled.dispatch).toBe('PUBLISHED');
    expect(scheduleRow(t)).toMatchObject({ status: 'CANCELLED', version: 4, endedOperationKey: 'ww-op-cancel-1',
      endRequestedOperationKey: 'ww-op-cancel-1' });
  });

  it('retains a known publication without guessing the owner of an unprovable truncation', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 }, occurrence: 1, maxOccurrences: 3, schedule: ENDING });
    truncatedBy(t, 'ww-op-cancel-1');
    t.db.tables.managedLifecycleOperation[0].result = '{}';
    scheduleRow(t).version = 3;
    expect((await publishRoot(t)).settled.dispatch).toBe('PUBLISHED');
    expect(scheduleRow(t)).toMatchObject({ status: 'ENDING', version: 3, endedAt: null, endedOperationKey: null });
  });

  it('failed in a truncated series halts it, keeping its first end request', async () => {
    const t = harness({ delays: [0], at: { step: 'FINALIZE', member: 0 }, occurrence: 1, maxOccurrences: 3, schedule: ENDING });
    const handle = await admitted(t, 'FINALIZE', 0);
    later(t, 1000);
    const transport = transportFor(t, handle);
    t.provider.replies.push({ status: 400, body: { error: { code: 100 } } });
    await send(transport, 'mutation');
    expect((await t.journal.settle(handle, { status: 'rejected', code: 'PROVIDER_REJECTED' }, transport)).dispatch)
      .toBe('REJECTED');
    expect(scheduleRow(t)).toMatchObject({
      status: 'HALTED', version: 3, endedAt: t.clock.at, endedCode: 'REJECTED', endedOperationKey: null,
      endRequestedOperationKey: 'ww-op-cancel-1', endRequestedAt: CANCEL_AT, scheduleGeneration: 1,
    });
    expect(managedScheduleView(scheduleRow(t) as any).status).toBe('HALTED');
    expect(t.seen[t.seen.length - 1].kind).toBe('DISPATCH_REJECTED');
    expect(view(t).status).toBe('REJECTED');
  });
});
