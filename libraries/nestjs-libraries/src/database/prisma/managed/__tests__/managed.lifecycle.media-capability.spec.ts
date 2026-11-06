jest.mock(
  'file-type',
  () => {
    // FAKE sniffer (the real one is ESM-only): the real magic numbers of the
    // synthetic objects below
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sniff = (head: Buffer) =>
      head.subarray(0, 8).equals(PNG_MAGIC)
        ? { mime: 'image/png', ext: 'png' }
        : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
        ? { mime: 'image/jpeg', ext: 'jpg' }
        : undefined;
    return {
      fileTypeFromBuffer: async (buffer: Uint8Array) => sniff(Buffer.from(buffer)),
    };
  },
  { virtual: true }
);

// The media capability service with REAL crypto (HMAC, sha256, random ids)
// and synthetic stored bytes. Only its ports are fake: a durable store with
// the same compare-and-set semantics the Prisma store must have, a private
// storage holding objects by key, the call authority, the shared budget and
// the clock. No HTTP route, database, storage or network is involved
import { createHash, randomBytes } from 'crypto';
import { Readable } from 'stream';
import { inspect } from 'util';
import { MANAGED_LIFECYCLE_MAX_EXPIRY } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';
import {
  MANAGED_MEDIA_CAPABILITY_LIMITS,
  managedMediaCapabilityMaxBytes,
  ManagedMediaActiveCall,
  ManagedMediaBudget,
  ManagedMediaCallAuthority,
  ManagedMediaCapabilityBounds,
  ManagedMediaCapabilityException,
  ManagedMediaCapabilityKeys,
  ManagedMediaCapabilityMintRequest,
  ManagedMediaCapabilityRecord,
  ManagedMediaCapabilityService,
  ManagedMediaCapabilityStore,
  ManagedMediaPin,
  ManagedMediaPinnedEvidence,
  ManagedMediaPinnedStorage,
  ManagedMediaRevokeReason,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-capability';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256)),
]);
const LENGTH = PNG.length;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const ORG = 'org_managed_1';
const DISPATCH = '0b5d8e0e-2f5a-4c1e-9a43-3d0f2b7c9a11';
const CALL = '7c1f4a2e-8d3b-4f6a-b2c5-1e9d0a6f3b22';
const STORAGE_KEY = 'managed-upload7f3a-1.png';
const NAMESPACE = 'namespace-private-91c2';
const VERSION = 'version-7f3a-0001';
const PIN: ManagedMediaPin = {
  mediaId: 'media_1',
  evidenceId: 'evidence_1',
  sha256: sha256(PNG),
  byteLength: LENGTH,
  mimeType: 'image/png',
};

const NOW = new Date('2026-11-06T12:00:00.000Z');
const MINUTE = 60 * 1000;
const POLICY = {
  grantedAt: new Date('2026-11-04T00:00:00.000Z'),
  expiresAt: new Date('2026-11-10T23:00:00.000Z'),
};

const KEY_A = { id: 'media-key-a', secret: randomBytes(32) };
const KEY_B = { id: 'media-key-b', secret: randomBytes(32) };
const KEYS: ManagedMediaCapabilityKeys = { activeKeyId: KEY_A.id, keys: [KEY_A] };

const copy = (row: ManagedMediaCapabilityRecord): ManagedMediaCapabilityRecord => ({
  ...row,
  issuedAt: new Date(row.issuedAt),
  expiresAt: new Date(row.expiresAt),
  revokedAt: row.revokedAt ? new Date(row.revokedAt) : null,
});

// Each method decides and writes without yielding, like one SQL statement
class FakeStore implements ManagedMediaCapabilityStore {
  rows = new Map<string, ManagedMediaCapabilityRecord>();
  gets = 0;
  failing = false;

  private check() {
    if (this.failing) {
      throw new Error(`database down at ${STORAGE_KEY} ${NAMESPACE}`);
    }
  }

  async create(draft: Parameters<ManagedMediaCapabilityStore['create']>[0]) {
    this.check();
    const taken =
      this.rows.has(draft.capabilityIdSha256) ||
      [...this.rows.values()].some(
        (row) =>
          row.organizationId === draft.organizationId &&
          row.callId === draft.callId &&
          row.evidenceId === draft.evidenceId
      );
    if (taken) {
      return null;
    }
    const row = { ...draft, fetchCount: 0, revokedAt: null, revokeReason: null };
    this.rows.set(draft.capabilityIdSha256, copy(row));
    return copy(row);
  }

  async get(capabilityIdSha256: string) {
    this.check();
    this.gets++;
    const row = this.rows.get(capabilityIdSha256);
    return row ? copy(row) : null;
  }

  async claimFetch(capabilityIdSha256: string, expected: number, now: Date) {
    this.check();
    const row = this.rows.get(capabilityIdSha256);
    if (
      !row ||
      row.fetchCount !== expected ||
      row.revokedAt ||
      row.expiresAt.getTime() <= now.getTime()
    ) {
      return false;
    }
    row.fetchCount = expected + 1;
    return true;
  }

  async revoke(capabilityIdSha256: string, at: Date, reason: ManagedMediaRevokeReason) {
    this.check();
    const row = this.rows.get(capabilityIdSha256);
    if (!row || row.revokedAt) {
      return 0;
    }
    row.revokedAt = new Date(at);
    row.revokeReason = reason;
    return 1;
  }

  async revokeCall(
    organizationId: string,
    callId: string,
    at: Date,
    reason: ManagedMediaRevokeReason
  ) {
    this.check();
    let revoked = 0;
    for (const row of this.rows.values()) {
      if (row.organizationId === organizationId && row.callId === callId && !row.revokedAt) {
        row.revokedAt = new Date(at);
        row.revokeReason = reason;
        revoked++;
      }
    }
    return revoked;
  }

  only() {
    const rows = [...this.rows.values()];
    expect(rows).toHaveLength(1);
    return rows[0];
  }
}

class FakeStorage implements ManagedMediaPinnedStorage {
  ns: string | null = NAMESPACE;
  objects = new Map<string, { bytes: Buffer; version: string }>([
    [STORAGE_KEY, { bytes: Buffer.from(PNG), version: VERSION }],
  ]);
  evidence: ManagedMediaPinnedEvidence | null = {
    ...PIN,
    storageKey: STORAGE_KEY,
    storageNamespace: NAMESPACE,
    storageVersion: VERSION,
  };
  keysTouched: string[] = [];
  opens = 0;
  chunkSize = 1000;
  failAfterFirstChunk = false;
  openFails = false;
  onOpen?: () => Promise<void> | void;
  onEnd?: () => void;
  // every stream handed out, how many are open now and the most at once
  streams: Readable[] = [];
  live = 0;
  mostLive = 0;
  // the next stream opened sends its first chunk, then waits for this
  stall?: Promise<void>;

  async pinnedEvidence(organizationId: string, mediaId: string) {
    return organizationId === ORG && this.evidence?.mediaId === mediaId
      ? { ...this.evidence }
      : null;
  }

  async namespace() {
    return this.ns;
  }

  async versionAt(key: string) {
    this.keysTouched.push(key);
    return this.objects.get(key)?.version ?? null;
  }

  async openAt(key: string) {
    this.keysTouched.push(key);
    this.opens++;
    if (this.openFails) {
      throw new Error(`open failed for ${key} in ${NAMESPACE} at ${VERSION}`);
    }
    await this.onOpen?.();
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }

    const chunks: Buffer[] = [];
    for (let at = 0; at < object.bytes.length; at += this.chunkSize) {
      chunks.push(Buffer.from(object.bytes.subarray(at, at + this.chunkSize)));
    }
    const fail = this.failAfterFirstChunk;
    const storage = this;
    let stall = this.stall;
    this.stall = undefined;
    let index = 0;
    const next = (readable: Readable) => {
      if (readable.destroyed) {
        return;
      }
      if (fail && index === 1) {
        readable.destroy(new Error(`storage failed reading ${key}`));
        return;
      }
      if (index === chunks.length) {
        storage.onEnd?.();
        readable.push(null);
        return;
      }
      readable.push(chunks[index++]);
    };
    const stream = new Readable({
      read() {
        if (stall && index === 1) {
          const waiting = stall;
          stall = undefined;
          void waiting.then(() => next(this));
          return;
        }
        next(this);
      },
    });
    this.streams.push(stream);
    this.mostLive = Math.max(this.mostLive, ++this.live);
    stream.once('close', () => this.live--);
    return { stream, version: object.version };
  }
}

class FakeAuthority implements ManagedMediaCallAuthority {
  call: ManagedMediaActiveCall | null = {
    organizationId: ORG,
    dispatchId: DISPATCH,
    callId: CALL,
    dispatchVersion: 3,
    active: true,
    activeUntil: new Date(NOW.getTime() + 30 * MINUTE),
    media: [{ ...PIN }],
  };
  asked: [string, string][] = [];
  failing = false;
  before?: () => Promise<void> | void;

  // answers whatever it holds: the service must compare it
  async activeCall(organizationId: string, callId: string) {
    this.asked.push([organizationId, callId]);
    if (this.failing) {
      throw new Error(`authority down for ${CALL}`);
    }
    await this.before?.();
    return this.call
      ? { ...this.call, activeUntil: new Date(this.call.activeUntil), media: this.call.media.map((media) => ({ ...media })) }
      : null;
  }
}

class FakeBudget implements ManagedMediaBudget {
  reserved: [string, number][] = [];
  allow = true;
  failing = false;

  async reserve(organizationId: string, units: number) {
    if (this.failing) {
      throw new Error('redis unavailable');
    }
    if (!this.allow) {
      return false;
    }
    this.reserved.push([organizationId, units]);
    return true;
  }
}

class FakeClock {
  at = new Date(NOW);
  now() {
    return new Date(this.at);
  }
}

function setup(
  keys: ManagedMediaCapabilityKeys | null = KEYS,
  bounds?: Partial<ManagedMediaCapabilityBounds>
) {
  const store = new FakeStore();
  const storage = new FakeStorage();
  const authority = new FakeAuthority();
  const budget = new FakeBudget();
  const clock = new FakeClock();
  const service = new ManagedMediaCapabilityService(
    {
      store,
      storage,
      authority,
      budget,
      clock,
      keys,
    },
    bounds
  );
  return { store, storage, authority, budget, clock, service };
}

type Setup = ReturnType<typeof setup>;

// another service over the same ports, with other keys
const withKeys = (t: Setup, keys: ManagedMediaCapabilityKeys | null) =>
  new ManagedMediaCapabilityService({ ...t, keys });

// another service over the same ports and keys, with lowered bounds
const withBounds = (t: Setup, bounds: Partial<ManagedMediaCapabilityBounds>) =>
  new ManagedMediaCapabilityService({ ...t, keys: KEYS }, bounds);

// lets every pending promise, timer-free callback and stream event run
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

// Holds every call of a port method after the first `from` until released;
// a held call then runs the real method late, or fails late
function hold<T extends object>(target: T, method: keyof T, from = 0) {
  const real = (target as any)[method].bind(target);
  const held: ((fail: boolean) => void)[] = [];
  let calls = 0;
  (target as any)[method] = (...args: unknown[]) =>
    calls++ < from
      ? real(...args)
      : new Promise((resolve, reject) =>
          held.push((fail) =>
            fail
              ? reject(new Error(`late failure at ${STORAGE_KEY} in ${NAMESPACE}`))
              : resolve(real(...args))
          )
        );
  return {
    held,
    release(fail = false) {
      (target as any)[method] = real;
      held.splice(0).forEach((open) => open(fail));
    },
  };
}

// how long a refusal took
async function timed(promise: Promise<unknown>) {
  const started = Date.now();
  const code = await refusal(promise);
  return { code, ms: Date.now() - started };
}

const mintRequest = (
  overrides: Partial<ManagedMediaCapabilityMintRequest> = {}
): ManagedMediaCapabilityMintRequest => ({
  organizationId: ORG,
  dispatchId: DISPATCH,
  callId: CALL,
  dispatchVersion: 3,
  media: { ...PIN },
  policy: POLICY,
  ttlMs: 10 * MINUTE,
  maxFetches: 3,
  ...overrides,
});

async function minted(
  overrides: Partial<ManagedMediaCapabilityMintRequest> = {},
  t: Setup = setup()
) {
  const grant = await t.service.mint(mintRequest(overrides));
  const token = grant.token();
  const [, id, mac] = token.split('.');
  return { ...t, grant, token, id, mac, opensAfterMint: t.storage.opens };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ManagedMediaCapabilityException) {
      return err.code;
    }
    throw err;
  }
  throw new Error('expected a refusal');
}

async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as ManagedMediaCapabilityException;
  }
  throw new Error('expected a refusal');
}

// everything a refusal could carry to a caller or a log
const exposed = (err: ManagedMediaCapabilityException) =>
  [
    JSON.stringify(err),
    err.message,
    JSON.stringify(err.getResponse()),
    String(err.stack),
    inspect(err, { depth: 10 }),
  ].join('\n');

const network = jest.fn(() => {
  throw new Error('no network in this spec');
});
const realFetch = (globalThis as any).fetch;
// a late answer or failure of a port is never left unhandled
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeAll(() => {
  (globalThis as any).fetch = network;
  process.on('unhandledRejection', onUnhandled);
});
afterAll(() => {
  (globalThis as any).fetch = realFetch;
  process.off('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  // no capability path ever fetches a URL
  expect(network).not.toHaveBeenCalled();
  await settle();
  expect(unhandled).toEqual([]);
});

describe('mint', () => {
  it('reads and verifies the whole pinned object, then records a capability without its token', async () => {
    const t = await minted();

    expect(t.token).toMatch(/^wwmc1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    for (const value of [ORG, DISPATCH, CALL, PIN.mediaId, PIN.evidenceId, PIN.sha256, STORAGE_KEY, NAMESPACE, VERSION, KEY_A.id]) {
      expect(t.token).not.toContain(value);
    }

    expect(t.storage.opens).toBe(1);
    expect(t.authority.asked).toEqual([[ORG, CALL], [ORG, CALL]]);
    // minting reads private storage only; it spends no shared budget
    expect(t.budget.reserved).toEqual([]);

    const row = t.store.only();
    expect(row).toEqual({
      capabilityIdSha256: sha256(Buffer.from(t.id, 'base64url')),
      keyId: KEY_A.id,
      organizationId: ORG,
      dispatchId: DISPATCH,
      callId: CALL,
      dispatchVersion: 3,
      ...PIN,
      storageKey: STORAGE_KEY,
      storageNamespace: NAMESPACE,
      storageVersion: VERSION,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * MINUTE),
      maxFetches: 3,
      fetchCount: 0,
      revokedAt: null,
      revokeReason: null,
    });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(t.token);
    expect(stored).not.toContain(t.id);
    expect(stored).not.toContain(t.mac);
  });

  it('hands out a grant that never serializes, spreads or prints its token', async () => {
    const t = await minted();

    expect(JSON.parse(JSON.stringify(t.grant))).toEqual({
      expiresAt: new Date(NOW.getTime() + 10 * MINUTE).toISOString(),
      maxFetches: 3,
    });
    for (const text of [
      JSON.stringify(t.grant),
      JSON.stringify({ ...t.grant }),
      inspect(t.grant, { depth: 10, showHidden: true }),
      String(t.grant),
      Object.values(t.grant).join(' '),
    ]) {
      expect(text).not.toContain(t.id);
      expect(text).not.toContain(t.mac);
    }
  });

  it('bounds the exclusive expiry by the ttl, the call, the policy and the cutoff', async () => {
    const t = setup();
    t.authority.call!.activeUntil = new Date(NOW.getTime() + 5 * MINUTE);
    expect((await t.service.mint(mintRequest({ ttlMs: 15 * MINUTE }))).expiresAt).toEqual(
      new Date(NOW.getTime() + 5 * MINUTE)
    );

    const policy = { grantedAt: new Date(NOW.getTime() - 24 * 60 * MINUTE), expiresAt: new Date(NOW.getTime() + 2 * MINUTE) };
    expect((await setup().service.mint(mintRequest({ policy, ttlMs: 15 * MINUTE }))).expiresAt).toEqual(
      policy.expiresAt
    );

    const late = setup();
    late.clock.at = new Date('2026-11-10T22:55:00.000Z');
    late.authority.call!.activeUntil = new Date('2026-11-10T23:30:00.000Z');
    expect((await late.service.mint(mintRequest({ ttlMs: 15 * MINUTE }))).expiresAt).toEqual(
      MANAGED_LIFECYCLE_MAX_EXPIRY
    );
  });

  it('refuses a closed, missing or over-long policy and anything at or after the cutoff', async () => {
    expect(await refusal(setup().service.mint(mintRequest({ policy: null })))).toBe('POLICY_CLOSED');
    expect(
      await refusal(
        setup().service.mint(
          mintRequest({ policy: { grantedAt: POLICY.grantedAt, expiresAt: new Date('2026-11-10T23:00:00.001Z') } })
        )
      )
    ).toBe('POLICY_CLOSED');
    expect(
      await refusal(
        setup().service.mint(
          mintRequest({ policy: { grantedAt: new Date('2026-11-01T00:00:00.000Z'), expiresAt: POLICY.expiresAt } })
        )
      )
    ).toBe('POLICY_CLOSED');

    const after = setup();
    after.clock.at = new Date(MANAGED_LIFECYCLE_MAX_EXPIRY);
    expect(await refusal(after.service.mint(mintRequest()))).toBe('POLICY_CLOSED');
    expect(after.store.rows.size).toBe(0);
    expect(after.storage.opens).toBe(0);
  });

  it('mints only for the active call that admitted exactly this media', async () => {
    const cases: [string, (t: Setup) => Partial<ManagedMediaCapabilityMintRequest>, string][] = [
      ['no call', (t) => ((t.authority.call = null), {}), 'CALL_INACTIVE'],
      ['inactive call', (t) => ((t.authority.call!.active = false), {}), 'CALL_INACTIVE'],
      ['call past its bound', (t) => ((t.authority.call!.activeUntil = new Date(NOW)), {}), 'CALL_INACTIVE'],
      ['another dispatch version', () => ({ dispatchVersion: 2 }), 'SCOPE_MISMATCH'],
      ['another dispatch', () => ({ dispatchId: 'another-dispatch' }), 'SCOPE_MISMATCH'],
      ['another organization', (t) => ((t.authority.call!.organizationId = 'org_other'), {}), 'SCOPE_MISMATCH'],
      ['media the call does not bind', () => ({ media: { ...PIN, evidenceId: 'evidence_2' } }), 'SCOPE_MISMATCH'],
      ['the call binds other bytes', (t) => ((t.authority.call!.media = [{ ...PIN, sha256: 'a'.repeat(64) }]), {}), 'SCOPE_MISMATCH'],
    ];

    for (const [, arrange, code] of cases) {
      const t = setup();
      const overrides = arrange(t);
      expect(await refusal(t.service.mint(mintRequest(overrides)))).toBe(code);
      expect(t.store.rows.size).toBe(0);
      expect(t.storage.keysTouched).toEqual([]);
    }
  });

  it('refuses media whose evidence is not the pinned, readable object of the declared type', async () => {
    const cases: [string, (t: Setup) => Partial<ManagedMediaCapabilityMintRequest> | undefined, string][] = [
      ['no evidence', (t) => void (t.storage.evidence = null), 'MEDIA_NOT_CURRENT'],
      ['other evidence', (t) => void (t.storage.evidence!.evidenceId = 'evidence_2'), 'MEDIA_NOT_CURRENT'],
      ['unproven type', (t) => void ((t.storage.evidence as any).mimeType = null), 'MEDIA_NOT_CURRENT'],
      ['unpinned version', (t) => void (t.storage.evidence!.storageVersion = ''), 'MEDIA_NOT_CURRENT'],
      ['object gone', (t) => void t.storage.objects.clear(), 'MEDIA_NOT_CURRENT'],
      ['other bytes', (t) => void (t.storage.objects.get(STORAGE_KEY)!.bytes[100] ^= 1), 'MEDIA_NOT_CURRENT'],
      ['other version', (t) => void (t.storage.objects.get(STORAGE_KEY)!.version = 'version-2'), 'MEDIA_NOT_CURRENT'],
      ['other namespace', (t) => void (t.storage.ns = 'namespace-other'), 'MEDIA_NOT_CURRENT'],
      ['namespace unknown', (t) => void (t.storage.ns = null), 'STORAGE_UNAVAILABLE'],
      ['open fails', (t) => void (t.storage.openFails = true), 'STORAGE_UNAVAILABLE'],
      [
        'bytes of another type than declared',
        (t) => {
          const jpeg = { ...PIN, mimeType: 'image/jpeg' };
          t.storage.evidence!.mimeType = 'image/jpeg';
          t.authority.call!.media = [jpeg];
          return { media: jpeg };
        },
        'MEDIA_NOT_CURRENT',
      ],
    ];

    for (const [, arrange, code] of cases) {
      const t = setup();
      const overrides = arrange(t) || {};
      expect(await refusal(t.service.mint(mintRequest(overrides)))).toBe(code);
      expect(t.store.rows.size).toBe(0);
    }
  });

  it('never reads a key that is a path, a URL or outside the stored-object shape', async () => {
    for (const key of [
      'https://cdn.example.com/x.png',
      'file:///srv/uploads/x.png',
      '../secret.png',
      'uploads/../x.png',
      '/etc/passwd.png',
      'C:\\uploads\\x.png',
      'x.png?download=1',
      'x.html',
    ]) {
      const t = setup();
      t.storage.evidence!.storageKey = key;
      t.storage.objects.set(key, { bytes: Buffer.from(PNG), version: VERSION });
      expect(await refusal(t.service.mint(mintRequest()))).toBe('MEDIA_NOT_CURRENT');
      expect(t.storage.keysTouched).toEqual([]);
    }
  });

  it('records at most one capability per call and evidence, revoked or not', async () => {
    const t = await minted();
    expect(await refusal(t.service.mint(mintRequest()))).toBe('ALREADY_MINTED');
    await t.service.revokeCall(ORG, CALL, 'CALL_SETTLED');
    expect(await refusal(t.service.mint(mintRequest()))).toBe('ALREADY_MINTED');
    expect(t.store.rows.size).toBe(1);
  });

  it('revokes, retains and withholds a capability whose call ended while it was written', async () => {
    const t = setup();
    let asked = 0;
    t.authority.before = () => {
      if (++asked === 2) {
        t.authority.call!.active = false;
      }
    };

    expect(await refusal(t.service.mint(mintRequest()))).toBe('CALL_INACTIVE');
    const row = t.store.only();
    expect(row.revokedAt).toEqual(NOW);
    expect(row.revokeReason).toBe('CALL_INACTIVE');
  });

  it('refuses requests outside every bound', async () => {
    const bad: Partial<ManagedMediaCapabilityMintRequest>[] = [
      { organizationId: 'org/1' },
      { callId: '' },
      { dispatchVersion: 0 },
      { dispatchVersion: 1.5 },
      // more than the record's Prisma Int column holds
      { dispatchVersion: 2 ** 31 },
      { ttlMs: 0 },
      { ttlMs: MANAGED_MEDIA_CAPABILITY_LIMITS.maxTtlMs + 1 },
      { maxFetches: 0 },
      { maxFetches: MANAGED_MEDIA_CAPABILITY_LIMITS.maxFetches + 1 },
      { media: { ...PIN, sha256: PIN.sha256.toUpperCase() } },
      { media: { ...PIN, byteLength: 0 } },
      { media: { ...PIN, mimeType: 'text/html' } },
      { media: null as any },
    ];
    for (const overrides of bad) {
      const t = setup();
      expect(await refusal(t.service.mint(mintRequest(overrides)))).toBe('INVALID_REQUEST');
      expect(t.authority.asked).toEqual([]);
      expect(t.storage.keysTouched).toEqual([]);
    }
  });

  it('bounds objects like the existing private observation: the environment lowers, never raises', async () => {
    const previous = process.env.POSTIZ_MANAGED_MAX_DIGEST_BYTES;
    try {
      delete process.env.POSTIZ_MANAGED_MAX_DIGEST_BYTES;
      expect(managedMediaCapabilityMaxBytes()).toBe(64 * 1024 * 1024);
      process.env.POSTIZ_MANAGED_MAX_DIGEST_BYTES = String(1024 * 1024 * 1024);
      expect(managedMediaCapabilityMaxBytes()).toBe(64 * 1024 * 1024);

      const t = await minted();
      process.env.POSTIZ_MANAGED_MAX_DIGEST_BYTES = String(LENGTH - 1);
      expect(managedMediaCapabilityMaxBytes()).toBe(LENGTH - 1);
      expect(await refusal(setup().service.mint(mintRequest()))).toBe('INVALID_REQUEST');
      // a capability recorded under a higher bound is not read beyond the new one
      expect(await refusal(t.service.fetch({ token: t.token }))).toBe('CAPABILITY_INVALID');
      expect(t.storage.opens).toBe(t.opensAfterMint);
    } finally {
      if (previous === undefined) {
        delete process.env.POSTIZ_MANAGED_MAX_DIGEST_BYTES;
      } else {
        process.env.POSTIZ_MANAGED_MAX_DIGEST_BYTES = previous;
      }
    }
  });
});

describe('fetch', () => {
  it('refuses a mismatched route extension before spending fetch quota or organization budget', async () => {
    const t = await minted();
    await expect(t.service.fetch({ token: t.token, expectedMimeType: 'image/jpeg' }))
      .rejects.toMatchObject({ code: 'CAPABILITY_INVALID' });
    expect(t.store.only().fetchCount).toBe(0);
    expect(t.budget.reserved).toEqual([]);
    expect((await t.service.fetch({ token: t.token, expectedMimeType: 'image/png' })).body.equals(PNG)).toBe(true);
  });
  it('answers the whole verified object with only safe headers, after claiming quota and budget', async () => {
    const t = await minted();
    const response = await t.service.fetch({ token: t.token });

    expect(response.status).toBe(200);
    expect(response.body.equals(PNG)).toBe(true);
    expect(response.headers).toEqual({
      'content-type': 'image/png',
      'content-length': String(LENGTH),
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(Object.isFrozen(response.headers)).toBe(true);
    expect(t.budget.reserved).toEqual([[ORG, 1]]);
    expect(t.store.only().fetchCount).toBe(1);

    // the answer is the verified buffer itself, allocated for this read and
    // not copied again: changing it changes nothing stored or served
    expect(response.body.byteOffset).toBe(0);
    expect(response.body.buffer.byteLength).toBe(LENGTH);
    response.body.fill(0);
    expect((await t.service.fetch({ token: t.token })).body.equals(PNG)).toBe(true);
  });

  it('answers one range, cut from the whole verified object', async () => {
    const t = await minted({ maxFetches: 8 });
    const cases: [string, number, number][] = [
      ['bytes=10-19', 10, 19],
      ['bytes=0-0', 0, 0],
      ['bytes=-8', LENGTH - 8, LENGTH - 1],
      ['bytes=-99999', 0, LENGTH - 1],
      ['bytes=3000-', 3000, LENGTH - 1],
      ['bytes=3000-99999', 3000, LENGTH - 1],
    ];

    for (const [range, start, end] of cases) {
      const response = await t.service.fetch({ token: t.token, range });
      expect(response.status).toBe(206);
      expect(response.body.equals(PNG.subarray(start, end + 1))).toBe(true);
      expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/${LENGTH}`);
      expect(response.headers['content-length']).toBe(String(end - start + 1));
    }
    // every range read the whole object
    expect(t.storage.opens).toBe(t.opensAfterMint + cases.length);
    // a range is a copy of itself alone, never a view into the object
    const copied = await minted();
    const cut = await copied.service.fetch({ token: copied.token, range: 'bytes=10-19' });
    expect(cut.body.length).toBe(10);
    cut.body.fill(0);
    expect((await copied.service.fetch({ token: copied.token, range: 'bytes=10-19' })).body.equals(PNG.subarray(10, 20))).toBe(true);

    // a byte outside the range that differs refuses the range too
    t.storage.objects.get(STORAGE_KEY)!.bytes[LENGTH - 1] ^= 1;
    expect(await refusal(t.service.fetch({ token: t.token, range: 'bytes=0-9' }))).toBe('MEDIA_CHANGED');
  });

  it('refuses several ranges and malformed or unsatisfiable ones before spending quota or reading', async () => {
    const t = await minted();
    const cases: [unknown, string][] = [
      ['bytes=0-1,4-5', 'RANGE_INVALID'],
      ['bytes=0-1, 4-5', 'RANGE_INVALID'],
      ['bytes=5-2', 'RANGE_INVALID'],
      ['bytes=-', 'RANGE_INVALID'],
      ['items=0-1', 'RANGE_INVALID'],
      [' bytes=0-1', 'RANGE_INVALID'],
      ['bytes=0-1\r\n', 'RANGE_INVALID'],
      ['bytes=0x10-20', 'RANGE_INVALID'],
      ['bytes=1234567890123456-', 'RANGE_INVALID'],
      [12, 'RANGE_INVALID'],
      [['bytes=0-1'], 'RANGE_INVALID'],
      [`bytes=${LENGTH}-`, 'RANGE_NOT_SATISFIABLE'],
      ['bytes=-0', 'RANGE_NOT_SATISFIABLE'],
    ];
    for (const [range, code] of cases) {
      expect(await refusal(t.service.fetch({ token: t.token, range }))).toBe(code);
    }
    expect(t.store.only().fetchCount).toBe(0);
    expect(t.budget.reserved).toEqual([]);
    expect(t.storage.opens).toBe(t.opensAfterMint);
  });

  it('expires exclusively at its expiry and never past the cutoff', async () => {
    const t = await minted();
    t.clock.at = new Date(t.grant.expiresAt.getTime() - 1);
    expect((await t.service.fetch({ token: t.token })).status).toBe(200);
    t.clock.at = new Date(t.grant.expiresAt);
    expect(await refusal(t.service.fetch({ token: t.token }))).toBe('CAPABILITY_EXPIRED');

    const late = setup();
    late.clock.at = new Date('2026-11-10T22:55:00.000Z');
    late.authority.call!.activeUntil = new Date('2026-11-10T23:30:00.000Z');
    const cut = await minted({ ttlMs: 15 * MINUTE }, late);
    cut.clock.at = new Date('2026-11-10T22:59:59.999Z');
    expect((await cut.service.fetch({ token: cut.token })).status).toBe(200);
    cut.clock.at = new Date(MANAGED_LIFECYCLE_MAX_EXPIRY);
    expect(await refusal(cut.service.fetch({ token: cut.token }))).toBe('CAPABILITY_EXPIRED');

    // a record that claims to outlive the cutoff or the ttl is not a capability
    cut.clock.at = new Date('2026-11-10T22:56:00.000Z');
    cut.store.only().expiresAt = new Date('2026-11-10T23:00:00.001Z');
    expect(await refusal(cut.service.fetch({ token: cut.token }))).toBe('CAPABILITY_INVALID');
    const long = await minted();
    long.store.only().expiresAt = new Date(NOW.getTime() + MANAGED_MEDIA_CAPABILITY_LIMITS.maxTtlMs + 1);
    expect(await refusal(long.service.fetch({ token: long.token }))).toBe('CAPABILITY_INVALID');
  });

  it('refuses a revoked capability and retains its record', async () => {
    const t = await minted();
    t.clock.at = new Date(NOW.getTime() + MINUTE);
    expect(await t.service.revokeCall(ORG, CALL, 'CALL_SETTLED')).toBe(1);
    expect(await refusal(t.service.fetch({ token: t.token }))).toBe('CAPABILITY_REVOKED');

    expect(await t.service.revokeCall(ORG, CALL, 'OPERATOR')).toBe(0);
    const row = t.store.only();
    expect(row.revokedAt).toEqual(new Date(NOW.getTime() + MINUTE));
    expect(row.revokeReason).toBe('CALL_SETTLED');
    expect(t.storage.opens).toBe(t.opensAfterMint);
    expect(t.budget.reserved).toEqual([]);
  });

  it('revokes without keys, and only for a closed reason', async () => {
    const t = await minted();
    const unkeyed = withKeys(t, null);
    expect(await refusal(unkeyed.revokeCall(ORG, CALL, 'SCOPE_MISMATCH' as any))).toBe('INVALID_REQUEST');
    expect(await refusal(unkeyed.revokeCall('org/1', CALL, 'OPERATOR'))).toBe('INVALID_REQUEST');
    expect(await unkeyed.revokeCall(ORG, CALL, 'OPERATOR')).toBe(1);
    expect(await refusal(t.service.fetch({ token: t.token }))).toBe('CAPABILITY_REVOKED');
  });

  it('refuses any altered, foreign or malformed token before the store is asked', async () => {
    const t = await minted();
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const flip = (value: string, at: number) =>
      value.slice(0, at) + (value[at] === 'A' ? 'B' : 'A') + value.slice(at + 1);
    // the same 32 bytes, spelled with other unused trailing bits
    const sibling = (value: string) =>
      value.slice(0, 42) + ALPHABET[ALPHABET.indexOf(value[42]) ^ 1];
    expect(Buffer.from(sibling(t.id), 'base64url').equals(Buffer.from(t.id, 'base64url'))).toBe(true);

    const other = setup({ activeKeyId: KEY_B.id, keys: [KEY_B] });
    const foreign = (await other.service.mint(mintRequest())).token();

    const tokens: unknown[] = [
      `wwmc1.${flip(t.id, 0)}.${t.mac}`,
      `wwmc1.${flip(t.id, 21)}.${t.mac}`,
      `wwmc1.${t.id}.${flip(t.mac, 0)}`,
      `wwmc1.${t.id}.${flip(t.mac, 30)}`,
      `wwmc1.${sibling(t.id)}.${t.mac}`,
      `wwmc1.${t.id}.${sibling(t.mac)}`,
      `wwmc1.${t.mac}.${t.id}`,
      `wwmc2.${t.id}.${t.mac}`,
      `${t.token}=`,
      ` ${t.token}`,
      `${t.token}\n`,
      t.token.toUpperCase(),
      foreign,
      '',
      'x'.repeat(10000),
      undefined,
      null,
      42,
      { token: t.token },
      Buffer.from(t.token),
    ];
    for (const token of tokens) {
      expect(await refusal(t.service.fetch({ token }))).toBe('CAPABILITY_INVALID');
    }
    expect(await refusal(t.service.fetch(undefined as any))).toBe('CAPABILITY_INVALID');
    expect(t.store.gets).toBe(0);
    expect(t.authority.asked).toHaveLength(2);
    expect(t.budget.reserved).toEqual([]);
  });

  it('verifies under every configured key, and only under the key the record names', async () => {
    const t = await minted({ maxFetches: 8 });

    const rotated = withKeys(t, { activeKeyId: KEY_B.id, keys: [KEY_B, KEY_A] });
    expect((await rotated.fetch({ token: t.token })).status).toBe(200);

    const retired = withKeys(t, { activeKeyId: KEY_B.id, keys: [KEY_B] });
    const gets = t.store.gets;
    expect(await refusal(retired.fetch({ token: t.token }))).toBe('CAPABILITY_INVALID');
    expect(t.store.gets).toBe(gets);

    // a record moved under another configured key is not this token's
    t.store.only().keyId = KEY_B.id;
    expect(await refusal(rotated.fetch({ token: t.token }))).toBe('CAPABILITY_INVALID');
  });

  it('refuses, and revokes for good, when the call ended or no longer binds this media', async () => {
    const cases: [string, (t: Setup) => void, string][] = [
      ['call gone', (t) => (t.authority.call = null), 'CALL_INACTIVE'],
      ['call settled', (t) => (t.authority.call!.active = false), 'CALL_INACTIVE'],
      ['call bound shortened', (t) => (t.authority.call!.activeUntil = new Date(NOW)), 'CALL_INACTIVE'],
      ['new dispatch version', (t) => (t.authority.call!.dispatchVersion = 4), 'SCOPE_MISMATCH'],
      ['another dispatch', (t) => (t.authority.call!.dispatchId = 'another-dispatch'), 'SCOPE_MISMATCH'],
      ['another organization', (t) => (t.authority.call!.organizationId = 'org_other'), 'SCOPE_MISMATCH'],
      ['another call', (t) => (t.authority.call!.callId = 'another-call'), 'SCOPE_MISMATCH'],
      ['media dropped', (t) => (t.authority.call!.media = []), 'SCOPE_MISMATCH'],
      ['other evidence bound', (t) => (t.authority.call!.media = [{ ...PIN, evidenceId: 'evidence_2' }]), 'SCOPE_MISMATCH'],
    ];

    for (const [, arrange, code] of cases) {
      const t = await minted();
      const call = { ...t.authority.call! };
      arrange(t);
      expect(await refusal(t.service.fetch({ token: t.token }))).toBe(code);
      expect(t.store.only().revokeReason).toBe(code);

      // retained: the call coming back does not reopen it
      t.authority.call = call;
      expect(await refusal(t.service.fetch({ token: t.token }))).toBe('CAPABILITY_REVOKED');
      expect(t.storage.opens).toBe(t.opensAfterMint);
      expect(t.budget.reserved).toEqual([]);
      expect(t.store.only().fetchCount).toBe(0);
    }
  });

  it('refuses and revokes when the evidence, bytes, version or namespace drifted', async () => {
    const cases: [string, (t: Setup) => void][] = [
      ['evidence replaced', (t) => (t.storage.evidence!.evidenceId = 'evidence_2')],
      ['evidence re-pinned', (t) => (t.storage.evidence!.storageVersion = 'version-2')],
      ['evidence removed', (t) => (t.storage.evidence = null)],
      ['object rewritten', (t) => (t.storage.objects.get(STORAGE_KEY)!.version = 'version-2')],
      ['bytes changed in place', (t) => (t.storage.objects.get(STORAGE_KEY)!.bytes[2000] ^= 0xff)],
      ['bytes grew', (t) => {
        const object = t.storage.objects.get(STORAGE_KEY)!;
        object.bytes = Buffer.concat([object.bytes, Buffer.from([0])]);
      }],
      ['bytes shrank', (t) => {
        const object = t.storage.objects.get(STORAGE_KEY)!;
        object.bytes = object.bytes.subarray(0, LENGTH - 1);
      }],
      ['object gone', (t) => t.storage.objects.clear()],
      ['namespace moved', (t) => (t.storage.ns = 'namespace-other')],
      ['rewritten when opened', (t) => (t.storage.onOpen = () => void (t.storage.objects.get(STORAGE_KEY)!.version = 'version-2'))],
      ['rewritten while read', (t) => (t.storage.onEnd = () => void (t.storage.objects.get(STORAGE_KEY)!.version = 'version-2'))],
      ['namespace moved while read', (t) => (t.storage.onEnd = () => void (t.storage.ns = 'namespace-other'))],
    ];

    for (const [, arrange] of cases) {
      const t = await minted();
      arrange(t);
      const err = await caught(t.service.fetch({ token: t.token }));
      expect(err.code).toBe('MEDIA_CHANGED');
      expect(exposed(err)).not.toContain('"type":"Buffer"');
      expect(t.store.only().revokeReason).toBe('MEDIA_CHANGED');
    }
  });

  it('holds a durable fetch quota, claimed atomically by concurrent fetches', async () => {
    const t = await minted({ maxFetches: 2 });
    await t.service.fetch({ token: t.token });
    await t.service.fetch({ token: t.token, range: 'bytes=0-9' });
    expect(await refusal(t.service.fetch({ token: t.token }))).toBe('CAPABILITY_EXHAUSTED');
    expect(t.storage.opens).toBe(t.opensAfterMint + 2);
    expect(t.budget.reserved).toHaveLength(2);

    const race = await minted({ maxFetches: 3 });
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => race.service.fetch({ token: race.token }))
    );
    const answered = settled.filter((result) => result.status === 'fulfilled');
    const refused = settled.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    expect(answered).toHaveLength(3);
    expect(refused.map((result) => result.reason.code)).toEqual([
      'CAPABILITY_EXHAUSTED',
      'CAPABILITY_EXHAUSTED',
      'CAPABILITY_EXHAUSTED',
    ]);
    expect(race.store.only().fetchCount).toBe(3);
    expect(race.storage.opens).toBe(race.opensAfterMint + 3);
    expect(race.budget.reserved).toHaveLength(3);
  });

  it('does not retry a claim the store refused for no visible reason', async () => {
    const t = await minted();
    t.store.claimFetch = async () => false;
    expect(await refusal(t.service.fetch({ token: t.token }))).toBe('QUOTA_CONFLICT');
    expect(t.storage.opens).toBe(t.opensAfterMint);
    expect(t.budget.reserved).toEqual([]);
  });

  it('reads nothing without a shared budget unit, and keeps the claimed fetch', async () => {
    for (const arrange of [
      (t: Setup) => (t.budget.allow = false),
      (t: Setup) => (t.budget.failing = true),
    ]) {
      const t = await minted();
      arrange(t);
      expect(await refusal(t.service.fetch({ token: t.token }))).toBe('BUDGET_EXHAUSTED');
      expect(t.storage.opens).toBe(t.opensAfterMint);
      expect(t.store.only().fetchCount).toBe(1);
      expect(t.store.only().revokedAt).toBeNull();
    }
  });

  it('answers no byte of a read that failed part way, and does not revoke for it', async () => {
    const t = await minted({ maxFetches: 8 });
    t.storage.failAfterFirstChunk = true;
    const err = await caught(t.service.fetch({ token: t.token }));
    expect(err.code).toBe('STORAGE_UNAVAILABLE');
    expect(exposed(err)).not.toContain('"type":"Buffer"');
    expect(t.store.only().revokedAt).toBeNull();

    t.storage.failAfterFirstChunk = false;
    expect((await t.service.fetch({ token: t.token })).body.equals(PNG)).toBe(true);
    expect(t.store.only().fetchCount).toBe(2);

    for (const arrange of [
      () => (t.storage.ns = null),
      () => ((t.storage.ns = NAMESPACE), (t.storage.openFails = true)),
    ]) {
      arrange();
      expect(await refusal(t.service.fetch({ token: t.token }))).toBe('STORAGE_UNAVAILABLE');
    }
    expect(t.store.only().revokedAt).toBeNull();
  });

  it('answers nothing when the capability was revoked, expired or its call ended during the read', async () => {
    const revoked = await minted();
    revoked.storage.onOpen = async () => {
      await revoked.service.revokeCall(ORG, CALL, 'CALL_SETTLED');
    };
    expect(await refusal(revoked.service.fetch({ token: revoked.token }))).toBe('CAPABILITY_REVOKED');
    expect(revoked.storage.opens).toBe(revoked.opensAfterMint + 1);

    const expired = await minted();
    expired.storage.onOpen = () => void (expired.clock.at = new Date(expired.grant.expiresAt));
    expect(await refusal(expired.service.fetch({ token: expired.token }))).toBe('CAPABILITY_EXPIRED');

    const ended = await minted();
    ended.storage.onOpen = () => void (ended.authority.call!.active = false);
    expect(await refusal(ended.service.fetch({ token: ended.token }))).toBe('CALL_INACTIVE');
    expect(ended.store.only().revokeReason).toBe('CALL_INACTIVE');

    const rebound = await minted();
    rebound.storage.onOpen = () => void (rebound.authority.call!.dispatchVersion = 4);
    expect(await refusal(rebound.service.fetch({ token: rebound.token }))).toBe('SCOPE_MISMATCH');
  });

  it('claims nothing once a revocation landed between the checks and the claim', async () => {
    const t = await minted();
    t.authority.before = async () => {
      t.authority.before = undefined;
      await t.store.revoke(t.store.only().capabilityIdSha256, NOW, 'OPERATOR');
    };
    expect(await refusal(t.service.fetch({ token: t.token }))).toBe('CAPABILITY_REVOKED');
    expect(t.store.only().fetchCount).toBe(0);
    expect(t.budget.reserved).toEqual([]);
    expect(t.storage.opens).toBe(t.opensAfterMint);
  });

  it('refuses a stored record whose pin or bounds were altered, without reading it', async () => {
    const cases: [string, (row: ManagedMediaCapabilityRecord) => void][] = [
      ['key made a URL', (row) => (row.storageKey = 'https://cdn.example.com/x.png')],
      ['key made a path', (row) => (row.storageKey = '../x.png')],
      ['quota raised', (row) => (row.maxFetches = MANAGED_MEDIA_CAPABILITY_LIMITS.maxFetches + 1)],
      ['type changed', (row) => ((row as any).mimeType = 'text/html')],
      ['digest malformed', (row) => (row.sha256 = 'not-a-digest')],
      ['dispatch version past a Prisma Int', (row) => (row.dispatchVersion = 2 ** 31)],
    ];
    for (const [, alter] of cases) {
      const t = await minted();
      const touched = t.storage.keysTouched.length;
      alter(t.store.only());
      expect(await refusal(t.service.fetch({ token: t.token }))).toBe('CAPABILITY_INVALID');
      expect(t.storage.keysTouched).toHaveLength(touched);
      expect(t.budget.reserved).toEqual([]);
    }
  });
});

describe('without authority', () => {
  it('does not hand out a token when the final admission read crosses its expiry', async () => {
    const t = setup();
    let reads = 0;
    t.authority.before = () => {
      if (++reads === 2) t.clock.at = new Date(NOW.getTime() + MINUTE);
    };
    expect(await refusal(t.service.mint(mintRequest({ ttlMs: MINUTE })))).toBe('CALL_INACTIVE');
    expect(t.store.only().revokeReason).toBe('CALL_INACTIVE');
  });

  it('does not return bytes when the final admission read crosses capability expiry', async () => {
    const t = await minted({ ttlMs: MINUTE });
    let reads = 0;
    t.authority.before = () => {
      if (++reads === 2) t.clock.at = new Date(NOW.getTime() + MINUTE);
    };
    expect(await refusal(t.service.fetch({ token: t.token }))).toBe('CAPABILITY_EXPIRED');
  });

  it('mints and fetches nothing without explicitly configured keys, touching no port', async () => {
    const configured = await minted();
    const keyrings: (ManagedMediaCapabilityKeys | null)[] = [
      null,
      undefined as any,
      { activeKeyId: KEY_A.id, keys: [] },
      { activeKeyId: KEY_A.id, keys: [{ id: KEY_A.id, secret: randomBytes(31) }] },
      { activeKeyId: KEY_A.id, keys: [{ id: KEY_A.id, secret: KEY_A.secret.toString('hex') as any }] },
      { activeKeyId: KEY_A.id, keys: [KEY_A, { id: KEY_A.id, secret: KEY_B.secret }] },
      { activeKeyId: 'media-key-z', keys: [KEY_A] },
      { activeKeyId: 'media.key', keys: [{ id: 'media.key', secret: KEY_A.secret }] },
      {
        activeKeyId: KEY_A.id,
        keys: [KEY_A, KEY_B, ...['c', 'd', 'e'].map((id) => ({ id, secret: randomBytes(32) }))],
      },
    ];

    for (const keys of keyrings) {
      const t = setup(null);
      // Exercise an explicit undefined keyring rather than setup's default.
      t.service = withKeys(t, keys);
      expect(await refusal(t.service.mint(mintRequest()))).toBe('NOT_CONFIGURED');
      expect(await refusal(t.service.fetch({ token: configured.token }))).toBe('NOT_CONFIGURED');
      expect(t.authority.asked).toEqual([]);
      expect(t.store.gets).toBe(0);
      expect(t.store.rows.size).toBe(0);
      expect(t.storage.keysTouched).toEqual([]);
      expect(t.budget.reserved).toEqual([]);

      // a valid token is refused by an unkeyed service over the same record
      const sharing = withKeys(configured, keys);
      expect(await refusal(sharing.fetch({ token: configured.token }))).toBe('NOT_CONFIGURED');
    }
    expect(configured.store.gets).toBe(0);
  });

  it('copies its keys: changing the configured secret afterwards changes nothing', async () => {
    const secret = randomBytes(32);
    const t = setup({ activeKeyId: 'media-key-c', keys: [{ id: 'media-key-c', secret }] });
    const token = (await t.service.mint(mintRequest())).token();
    secret.fill(0);
    expect((await t.service.fetch({ token })).status).toBe(200);
  });

  it('turns a failing store or authority into a closed refusal that leaks nothing', async () => {
    const t = await minted();
    const secrets = [t.token, t.id, t.mac, STORAGE_KEY, NAMESPACE, VERSION, CALL, 'database down', 'authority down', 'open failed', 'redis'];

    const failures: [() => void, string][] = [
      [() => (t.store.failing = true), 'STORE_UNAVAILABLE'],
      [() => ((t.store.failing = false), (t.authority.failing = true)), 'STORE_UNAVAILABLE'],
      [() => ((t.authority.failing = false), (t.storage.openFails = true)), 'STORAGE_UNAVAILABLE'],
    ];
    for (const [arrange, code] of failures) {
      arrange();
      const err = await caught(t.service.fetch({ token: t.token, range: 'bytes=0-9' }));
      expect(err).toBeInstanceOf(ManagedMediaCapabilityException);
      expect(err.code).toBe(code);
      expect(err.getResponse()).toEqual({ code, msg: expect.any(String) });
      expect((err as any).cause).toBeUndefined();
      const text = exposed(err);
      for (const secret of secrets) {
        expect(text).not.toContain(secret);
      }
    }
    // an outage is not a revocation
    t.storage.openFails = false;
    expect(t.store.only().revokedAt).toBeNull();

    const mint = setup();
    mint.store.failing = true;
    const err = await caught(mint.service.mint(mintRequest()));
    expect(err.code).toBe('STORE_UNAVAILABLE');
    for (const secret of secrets) {
      expect(exposed(err)).not.toContain(secret);
    }
  });
});

const lastStream = (t: Setup) => t.storage.streams[t.storage.streams.length - 1];

describe('a mint that fails once its record may exist', () => {
  it('revokes the record when the check after the insert throws, and grants nothing', async () => {
    const t = setup();
    let asked = 0;
    t.authority.before = () => {
      if (++asked === 2) {
        throw new Error(`authority down for ${CALL}`);
      }
    };
    const err = await caught(t.service.mint(mintRequest()));
    expect(err.code).toBe('STORE_UNAVAILABLE');
    expect(exposed(err)).not.toContain('authority down');
    const row = t.store.only();
    expect(row.revokedAt).toEqual(NOW);
    expect(row.revokeReason).toBe('CALL_INACTIVE');

    // revoking does not free the call's and media's unique key
    t.authority.before = undefined;
    expect(await refusal(t.service.mint(mintRequest()))).toBe('ALREADY_MINTED');
  });

  it('revokes at the last time the clock gave when the clock fails after the insert', async () => {
    const t = setup();
    let asked = 0;
    t.authority.before = () => {
      if (++asked === 2) {
        t.clock.now = () => {
          throw new Error('clock gone');
        };
      }
    };
    expect(await refusal(t.service.mint(mintRequest()))).toBe('NOT_CONFIGURED');
    expect(t.store.only().revokedAt).toEqual(NOW);
  });

  it('refuses when the revocation fails too: the token never leaves the service', async () => {
    const t = setup();
    let asked = 0;
    t.store.revoke = async () => {
      throw new Error(`database down at ${STORAGE_KEY}`);
    };
    t.authority.before = () => {
      if (++asked === 2) {
        t.authority.call!.active = false;
      }
    };
    const err = await caught(t.service.mint(mintRequest()));
    expect(err.code).toBe('CALL_INACTIVE');
    expect(exposed(err)).not.toContain('database down');
    // left live but unreachable: no token for it was ever handed out
    expect(t.store.only().revokedAt).toBeNull();
  });

  it('waits for its revocation no longer than the request deadline', async () => {
    const t = setup(KEYS, { requestDeadlineMs: 100 });
    let asked = 0;
    t.authority.before = () => {
      if (++asked === 2) {
        t.authority.call!.active = false;
      }
    };
    const revoking = hold(t.store, 'revoke');
    const { code, ms } = await timed(t.service.mint(mintRequest()));
    expect(code).toBe('CALL_INACTIVE');
    expect(ms).toBeLessThan(2000);
    expect(revoking.held).toHaveLength(1);

    revoking.release();
    await settle();
    expect(t.store.only().revokeReason).toBe('CALL_INACTIVE');
  });
});

describe('one deadline per request', () => {
  it('refuses a mint whose call authority hangs, and starts nothing after it', async () => {
    const t = setup(KEYS, { requestDeadlineMs: 50 });
    const asking = hold(t.authority, 'activeCall');
    const { code, ms } = await timed(t.service.mint(mintRequest()));
    expect(code).toBe('STORE_UNAVAILABLE');
    expect(ms).toBeLessThan(2000);

    asking.release();
    await settle();
    expect(t.storage.keysTouched).toEqual([]);
    expect(t.store.rows.size).toBe(0);
  });

  it('refuses a mint whose read stalls before the insert, destroys the stream and records nothing', async () => {
    const t = setup(KEYS, { requestDeadlineMs: 100 });
    const stalled = gate();
    t.storage.stall = stalled.promise;
    expect(await refusal(t.service.mint(mintRequest()))).toBe('STORAGE_UNAVAILABLE');
    await settle();
    expect(lastStream(t).destroyed).toBe(true);
    expect(t.storage.live).toBe(0);

    stalled.open();
    await settle();
    expect(t.store.rows.size).toBe(0);
  });

  it('revokes, by its known id, a record the store inserts after the deadline', async () => {
    const t = setup(KEYS, { requestDeadlineMs: 100 });
    const inserting = hold(t.store, 'create');
    expect(await refusal(t.service.mint(mintRequest()))).toBe('STORE_UNAVAILABLE');
    expect(t.store.rows.size).toBe(0);
    // no grant: the call was not even confirmed again
    expect(t.authority.asked).toHaveLength(1);

    // the statement was not cancelled: it commits after the refusal
    inserting.release();
    await settle();
    const row = t.store.only();
    expect(row.revokedAt).toEqual(NOW);
    expect(row.revokeReason).toBe('CALL_INACTIVE');
    // and it still holds the call's and media's unique key
    expect(await refusal(withBounds(t, {}).mint(mintRequest()))).toBe('ALREADY_MINTED');
  });

  it('revokes the record when the check after the insert outlives the deadline', async () => {
    const t = setup(KEYS, { requestDeadlineMs: 100 });
    const confirming = hold(t.authority, 'activeCall', 1);
    expect(await refusal(t.service.mint(mintRequest()))).toBe('STORE_UNAVAILABLE');
    await settle();
    expect(t.store.only().revokeReason).toBe('CALL_INACTIVE');

    // the active answer that comes late grants nothing
    confirming.release();
    await settle();
    expect(t.store.only().revokedAt).toEqual(NOW);
  });

  it('refuses a fetch whose port hangs at any step, ignores the late answer and starts nothing after it', async () => {
    const steps = (t: Setup) => ({
      gets: t.store.gets,
      asked: t.authority.asked.length,
      fetchCount: t.store.only().fetchCount,
      reserved: t.budget.reserved.length,
      keysTouched: t.storage.keysTouched.length,
      opens: t.storage.opens,
    });
    type Steps = ReturnType<typeof steps>;
    // what the held call itself does once released, and nothing else
    const cases: [string, (t: Setup) => ReturnType<typeof hold>, string, Partial<Steps>][] = [
      ['record', (t) => hold(t.store, 'get'), 'STORE_UNAVAILABLE', { gets: 1 }],
      ['call', (t) => hold(t.authority, 'activeCall'), 'STORE_UNAVAILABLE', { asked: 1 }],
      // the late claim commits: a refused fetch may still have spent quota
      ['quota claim', (t) => hold(t.store, 'claimFetch'), 'STORE_UNAVAILABLE', { fetchCount: 1 }],
      ['budget', (t) => hold(t.budget, 'reserve'), 'BUDGET_EXHAUSTED', { reserved: 1 }],
      ['evidence', (t) => hold(t.storage, 'pinnedEvidence'), 'STORAGE_UNAVAILABLE', {}],
      ['namespace', (t) => hold(t.storage, 'namespace'), 'STORAGE_UNAVAILABLE', {}],
      ['version', (t) => hold(t.storage, 'versionAt'), 'STORAGE_UNAVAILABLE', { keysTouched: 1 }],
      ['open', (t) => hold(t.storage, 'openAt'), 'STORAGE_UNAVAILABLE', { keysTouched: 1, opens: 1 }],
      ['version after the read', (t) => hold(t.storage, 'versionAt', 1), 'STORAGE_UNAVAILABLE', { keysTouched: 1 }],
      ['final record', (t) => hold(t.store, 'get', 1), 'STORE_UNAVAILABLE', { gets: 1 }],
      ['final call', (t) => hold(t.authority, 'activeCall', 1), 'STORE_UNAVAILABLE', { asked: 1 }],
    ];

    for (const [name, arrange, expected, late] of cases) {
      const t = await minted();
      const slow = withBounds(t, { requestDeadlineMs: 50 });
      const held = arrange(t);
      const { code, ms } = await timed(slow.fetch({ token: t.token }));
      expect([name, code]).toEqual([name, expected]);
      expect(ms).toBeLessThan(2000);
      expect(held.held).toHaveLength(1);

      const before = steps(t);
      held.release();
      await settle();
      const after: Steps = { ...before };
      for (const [key, delta] of Object.entries(late) as [keyof Steps, number][]) {
        after[key] += delta;
      }
      expect([name, steps(t)]).toEqual([name, after]);
      // an outage is not a revocation
      expect(t.store.only().revokedAt).toBeNull();
      if (name === 'open') {
        // opened after the deadline: destroyed unread
        expect(lastStream(t).destroyed).toBe(true);
      }
    }
  });

  it('destroys a stream that stalls past the deadline and frees its read', async () => {
    const t = await minted({ maxFetches: 8 });
    await settle();
    const slow = withBounds(t, { requestDeadlineMs: 50, maxConcurrentReads: 1 });
    const stalled = gate();
    t.storage.stall = stalled.promise;
    expect(await refusal(slow.fetch({ token: t.token }))).toBe('STORAGE_UNAVAILABLE');
    await settle();
    expect(lastStream(t).destroyed).toBe(true);
    expect(t.storage.live).toBe(0);
    // the claimed fetch stays spent; an outage is not a revocation
    expect(t.store.only().fetchCount).toBe(1);
    expect(t.store.only().revokedAt).toBeNull();

    stalled.open();
    await settle();
    // its one slot is free again
    expect((await slow.fetch({ token: t.token })).body.equals(PNG)).toBe(true);
  });

  it('drops late failures of its ports without an unhandled rejection', async () => {
    const t = await minted();
    const slow = withBounds(t, { requestDeadlineMs: 30 });
    for (const arrange of [
      () => hold(t.store, 'get'),
      () => hold(t.storage, 'openAt'),
      () => hold(t.budget, 'reserve'),
    ]) {
      const held = arrange();
      const err = await caught(slow.fetch({ token: t.token }));
      expect(exposed(err)).not.toContain('late failure');
      held.release(true);
      await settle();
    }
    expect(unhandled).toEqual([]);
  });

  it('bounds a revocation by the same deadline, without pretending the statement did not run', async () => {
    const t = await minted();
    const revoking = hold(t.store, 'revokeCall');
    const slow = withBounds(t, { requestDeadlineMs: 30 });
    expect((await timed(slow.revokeCall(ORG, CALL, 'CALL_SETTLED'))).code).toBe('STORE_UNAVAILABLE');

    revoking.release();
    await settle();
    expect(t.store.only().revokeReason).toBe('CALL_SETTLED');
  });
});

describe('read capacity', () => {
  it('reads at most the bounded number at once, queues a bounded few in order and refuses the rest', async () => {
    const t = await minted({ maxFetches: 8 });
    await settle();
    const one = withBounds(t, { maxConcurrentReads: 1, maxQueuedReads: 1 });
    const stalled = gate();
    t.storage.stall = stalled.promise;
    const first = one.fetch({ token: t.token });
    await until(() => t.storage.live === 1);
    const second = one.fetch({ token: t.token, range: 'bytes=0-9' });
    await settle();
    expect(t.storage.opens).toBe(t.opensAfterMint + 1);

    // the queue is full: refused at once, claiming nothing
    expect(await refusal(one.fetch({ token: t.token }))).toBe('CAPACITY_UNAVAILABLE');
    // a read whose deadline passes while it waits gives up its place
    const waited = withBounds(t, { requestDeadlineMs: 50, maxConcurrentReads: 1 });
    const { code, ms } = await timed(waited.fetch({ token: t.token }));
    expect(code).toBe('CAPACITY_UNAVAILABLE');
    expect(ms).toBeLessThan(2000);
    expect(t.store.only().fetchCount).toBe(1);

    stalled.open();
    expect((await first).body.equals(PNG)).toBe(true);
    expect((await second).body.equals(PNG.subarray(0, 10))).toBe(true);
    expect(t.storage.mostLive).toBe(1);
    expect(t.store.only().fetchCount).toBe(2);
    expect(t.budget.reserved).toHaveLength(2);
  });

  it('reserves the object and its range copy before anything is claimed, opened or allocated', async () => {
    const t = await minted({ maxFetches: 8 });
    const tight = withBounds(t, { maxReadBytes: LENGTH + 9 });
    expect((await tight.fetch({ token: t.token })).status).toBe(200);
    expect((await tight.fetch({ token: t.token, range: 'bytes=0-8' })).status).toBe(206);
    const opens = t.storage.opens;
    expect(await refusal(tight.fetch({ token: t.token, range: 'bytes=0-9' }))).toBe('CAPACITY_UNAVAILABLE');
    expect(t.storage.opens).toBe(opens);
    expect(t.store.only().fetchCount).toBe(2);
    expect(t.budget.reserved).toHaveLength(2);

    const small = setup(KEYS, { maxReadBytes: LENGTH - 1 });
    expect(await refusal(small.service.mint(mintRequest()))).toBe('CAPACITY_UNAVAILABLE');
    expect(small.storage.opens).toBe(0);
    expect(small.store.rows.size).toBe(0);
  });

  it('reads the clock again after waiting: a capability that expired in the queue claims nothing', async () => {
    const t = await minted({ maxFetches: 8 });
    await settle();
    const one = withBounds(t, { maxConcurrentReads: 1 });
    const stalled = gate();
    t.storage.stall = stalled.promise;
    const first = one.fetch({ token: t.token });
    await until(() => t.storage.live === 1);
    const waiting = one.fetch({ token: t.token });
    await settle();

    t.clock.at = new Date(t.grant.expiresAt);
    stalled.open();
    expect(await refusal(first)).toBe('CAPABILITY_EXPIRED');
    expect(await refusal(waiting)).toBe('CAPABILITY_EXPIRED');
    expect(t.store.only().fetchCount).toBe(1);
    expect(t.budget.reserved).toHaveLength(1);
  });
});

describe('bounds', () => {
  it('runs at fixed production limits that configuration may only lower', async () => {
    const LIMITS = MANAGED_MEDIA_CAPABILITY_LIMITS;
    expect(Object.isFrozen(LIMITS)).toBe(true);
    expect(LIMITS).toMatchObject({
      ceilingBytes: 64 * 1024 * 1024,
      requestDeadlineMs: 60 * 1000,
      maxConcurrentReads: 2,
      maxReadBytes: 128 * 1024 * 1024,
      maxQueuedReads: 8,
    });
    // two whole objects at the ceiling fit at once, and nothing more
    expect(LIMITS.maxReadBytes).toBe(LIMITS.maxConcurrentReads * LIMITS.ceilingBytes);

    const configured = await minted();
    for (const lowered of [
      { requestDeadlineMs: LIMITS.requestDeadlineMs + 1 },
      { maxConcurrentReads: LIMITS.maxConcurrentReads + 1 },
      { maxReadBytes: LIMITS.maxReadBytes + 1 },
      { maxQueuedReads: LIMITS.maxQueuedReads + 1 },
      { requestDeadlineMs: 0 },
      { requestDeadlineMs: 1.5 },
      { maxConcurrentReads: NaN },
      { maxReadBytes: String(LENGTH) as any },
    ]) {
      const t = setup(KEYS, lowered);
      expect(await refusal(t.service.mint(mintRequest()))).toBe('NOT_CONFIGURED');
      expect(await refusal(withBounds(configured, lowered).fetch({ token: configured.token }))).toBe('NOT_CONFIGURED');
      expect(t.authority.asked).toEqual([]);
      expect(t.storage.keysTouched).toEqual([]);
    }
    expect(configured.store.gets).toBe(0);
  });
});
