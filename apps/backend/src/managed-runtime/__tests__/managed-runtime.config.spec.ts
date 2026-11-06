// local.storage requires file-type (ESM-only) at load; no byte is sniffed here
jest.mock(
  'file-type',
  () => ({ fileTypeStream: jest.fn(), fileTypeFromBuffer: jest.fn() }),
  { virtual: true }
);

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import {
  acquireManagedRuntimeLease,
  assertManagedRuntimeSchema,
  holdsManagedRuntimeLease,
  loadManagedRuntimeConfig,
  MANAGED_RUNTIME_LEASE_ATTEMPTS,
  MANAGED_RUNTIME_LEASE_KEY,
  MANAGED_RUNTIME_LEASE_RETRY_MS,
  MANAGED_RUNTIME_LEASE_SECONDS,
  MANAGED_STORAGE_MARKER,
  ManagedRuntimeConfigError,
  managedStorageNamespace,
  managedTrustProxy,
  refreshManagedRuntimeLease,
  releaseManagedRuntimeLease,
  waitForManagedRuntimeLease,
  withTimeout,
} from '@gitroom/backend/managed-runtime/managed-runtime.config';
import { sha256Hex } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

const SECRET = 'synthetic-secret-never-live';
// a raw token an operator might paste in place of its digest
const RAW_TOKEN = 'synthetic-raw-token-never-live-0123456789abcdef';

const credential = (over: Record<string, unknown> = {}) => ({
  id: 'ww-runtime',
  organizationId: 'org-a',
  tokenSha256: sha256Hex(RAW_TOKEN),
  scopes: ['posts:read'],
  ...over,
});

const KEYS = [
  'POSTIZ_MANAGED_MODE',
  'POSTIZ_MANAGED_ORGANIZATIONS',
  'POSTIZ_MANAGED_CREDENTIALS',
  'DATABASE_URL',
  'REDIS_URL',
  'STORAGE_PROVIDER',
  'FRONTEND_URL',
  'UPLOAD_DIRECTORY',
  'PORT',
  'MCP_ONLY',
  'POSTIZ_MANAGED_RUNTIME_HOST',
  'POSTIZ_MANAGED_TRUST_PROXY',
];

let scratch: string;
let uploads: string;
let saved: Record<string, string | undefined>;

function privateVolume(path: string) {
  mkdirSync(path);
  chmodSync(path, 0o700);
  writeFileSync(join(path, MANAGED_STORAGE_MARKER), 'synthetic volume\n');
  return path;
}

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  scratch = mkdtempSync(join(tmpdir(), 'ww-mrt-spec-'));
  uploads = privateVolume(join(scratch, 'uploads'));
  setEnv({
    POSTIZ_MANAGED_MODE: 'enabled',
    POSTIZ_MANAGED_ORGANIZATIONS: 'org-a',
    POSTIZ_MANAGED_CREDENTIALS: JSON.stringify([credential()]),
    DATABASE_URL: `postgresql://postiz:${SECRET}@db.invalid:5432/postiz`,
    REDIS_URL: `redis://:${SECRET}@redis.invalid:6379`,
    STORAGE_PROVIDER: 'local',
    FRONTEND_URL: 'http://managed-storage.invalid',
    UPLOAD_DIRECTORY: uploads,
    PORT: '3100',
    MCP_ONLY: undefined,
    POSTIZ_MANAGED_RUNTIME_HOST: undefined,
    POSTIZ_MANAGED_TRUST_PROXY: undefined,
  });
});

afterEach(() => {
  setEnv(saved);
  rmSync(scratch, { recursive: true, force: true });
});

function refusal() {
  try {
    loadManagedRuntimeConfig();
  } catch (err) {
    expect(err).toBeInstanceOf(ManagedRuntimeConfigError);
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).not.toContain(RAW_TOKEN);
    expect((err as Error).message).not.toContain(sha256Hex(RAW_TOKEN));
    return (err as Error).message;
  }
  throw new Error('the configuration was accepted');
}

describe('managed runtime configuration', () => {
  it('accepts a complete configuration with a private, marked volume', () => {
    expect(loadManagedRuntimeConfig()).toEqual({
      host: '127.0.0.1',
      port: 3100,
      uploadDirectory: uploads,
      trustProxy: false,
    });
  });

  it.each([
    ['an empty list', [], 'has no usable credential'],
    ['an entry for an organization off the allowlist', [credential({ organizationId: 'org-b' })], 'entry 1 names an organization'],
    ['an uppercase digest', [credential({ tokenSha256: sha256Hex(RAW_TOKEN).toUpperCase() })], 'entry 1 has no tokenSha256'],
    ['a raw token in place of the digest', [credential({ tokenSha256: RAW_TOKEN })], 'entry 1 has no tokenSha256'],
    ['a raw token next to the digest', [credential({ token: RAW_TOKEN })], 'entry 1 has a field other than'],
    ['an unknown scope', [credential({ scopes: ['posts:read', 'admin'] })], 'entry 1 has an unknown scope'],
    ['no known scope', [credential({ scopes: ['admin'] })], 'entry 1 has no known scope'],
    ['an invalid entry beside a valid one', [credential(), { id: 'ww-broken' }], 'entry 2 names an organization'],
    ['a shared digest', [credential(), credential({ id: 'ww-copy' })], 'entry 1 shares its id or tokenSha256 with entry 2'],
    ['a shared id', [credential(), credential({ tokenSha256: sha256Hex(`${RAW_TOKEN}-other`) })], 'entry 2 shares its id or tokenSha256 with entry 1'],
    ['an object instead of a list', credential(), 'must be a JSON array'],
  ])('refuses credentials with %s, naming positions only', (_label, value, message) => {
    process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify(value);
    const reason = refusal();
    expect(reason).toContain('POSTIZ_MANAGED_CREDENTIALS');
    expect(reason).toContain(message);
    expect(reason).not.toContain('ww-runtime');
  });

  it('refuses a credential list that is not JSON', () => {
    process.env.POSTIZ_MANAGED_CREDENTIALS = `[${RAW_TOKEN}`;
    expect(refusal()).toContain('is not valid JSON');
  });

  it('takes the trusted proxy topology from POSTIZ_MANAGED_TRUST_PROXY', () => {
    process.env.POSTIZ_MANAGED_TRUST_PROXY = '10.0.0.5, 192.168.10.0/24';
    expect(loadManagedRuntimeConfig().trustProxy).toEqual(['10.0.0.5', '192.168.10.0/24']);

    process.env.POSTIZ_MANAGED_TRUST_PROXY = 'true';
    expect(refusal()).toContain('POSTIZ_MANAGED_TRUST_PROXY must be unset');
  });

  it('takes the bind address from POSTIZ_MANAGED_RUNTIME_HOST', () => {
    process.env.POSTIZ_MANAGED_RUNTIME_HOST = '0.0.0.0';
    expect(loadManagedRuntimeConfig().host).toBe('0.0.0.0');
  });

  it.each([
    ['POSTIZ_MANAGED_MODE', undefined, 'POSTIZ_MANAGED_MODE must be "enabled"'],
    ['POSTIZ_MANAGED_MODE', 'disabled', 'POSTIZ_MANAGED_MODE must be "enabled"'],
    ['MCP_ONLY', 'true', 'MCP_ONLY must not be set'],
    ['POSTIZ_MANAGED_ORGANIZATIONS', undefined, 'POSTIZ_MANAGED_ORGANIZATIONS is empty'],
    ['POSTIZ_MANAGED_ORGANIZATIONS', 'org a', 'invalid entries'],
    ['POSTIZ_MANAGED_CREDENTIALS', undefined, 'POSTIZ_MANAGED_CREDENTIALS is not set'],
    ['DATABASE_URL', undefined, 'DATABASE_URL is not set'],
    ['REDIS_URL', undefined, 'REDIS_URL is not set'],
    ['STORAGE_PROVIDER', undefined, 'STORAGE_PROVIDER must be exactly "local"'],
    ['STORAGE_PROVIDER', 'cloudflare', 'STORAGE_PROVIDER must be exactly "local"'],
    ['FRONTEND_URL', undefined, 'FRONTEND_URL must be an absolute URL'],
    ['FRONTEND_URL', 'not a url', 'FRONTEND_URL must be an absolute URL'],
    ['UPLOAD_DIRECTORY', undefined, 'UPLOAD_DIRECTORY must be an absolute path'],
    ['UPLOAD_DIRECTORY', 'relative/uploads', 'UPLOAD_DIRECTORY must be an absolute path'],
    ['PORT', '70000', 'PORT must be an integer'],
    ['PORT', 'http', 'PORT must be an integer'],
  ])('refuses %s=%s without naming a configured value', (key, value, message) => {
    setEnv({ [key]: value });
    expect(refusal()).toContain(message);
  });

  it('refuses an upload directory that does not exist', () => {
    process.env.UPLOAD_DIRECTORY = join(scratch, 'absent');
    expect(refusal()).toContain('UPLOAD_DIRECTORY does not exist');
  });

  it('refuses a file or a symlink in place of the upload directory', () => {
    const file = join(scratch, 'file');
    writeFileSync(file, '');
    process.env.UPLOAD_DIRECTORY = file;
    expect(refusal()).toContain('must be a directory');

    const link = join(scratch, 'link');
    symlinkSync(uploads, link);
    process.env.UPLOAD_DIRECTORY = link;
    expect(refusal()).toContain('must be a directory');
  });

  it.each([0o750, 0o705, 0o755, 0o777])(
    'refuses an upload directory with mode %o',
    (mode) => {
      chmodSync(uploads, mode);
      expect(refusal()).toContain('must not be accessible by group or others');
    }
  );

  it('refuses a volume without the storage marker (not mounted / not initialized)', () => {
    process.env.UPLOAD_DIRECTORY = join(scratch, 'empty');
    mkdirSync(process.env.UPLOAD_DIRECTORY);
    chmodSync(process.env.UPLOAD_DIRECTORY, 0o700);
    expect(refusal()).toContain('the persistent volume is not mounted or was not initialized');
  });

  it('refuses a marker that is a directory or a symlink', () => {
    rmSync(join(uploads, MANAGED_STORAGE_MARKER));
    mkdirSync(join(uploads, MANAGED_STORAGE_MARKER));
    expect(refusal()).toContain('must be a regular file');

    rmSync(join(uploads, MANAGED_STORAGE_MARKER), { recursive: true });
    const elsewhere = join(scratch, 'elsewhere');
    writeFileSync(elsewhere, '');
    symlinkSync(elsewhere, join(uploads, MANAGED_STORAGE_MARKER));
    expect(refusal()).toContain('must be a regular file');
  });
});

describe('managed runtime storage namespace', () => {
  it('is the local storage namespace of the configured directory, stable across reads', async () => {
    const first = await managedStorageNamespace(uploads);
    expect(first).toMatch(/^local:[a-f0-9]{64}$/);
    expect(await managedStorageNamespace(uploads)).toBe(first);

    const other = privateVolume(join(scratch, 'other'));
    process.env.UPLOAD_DIRECTORY = other;
    expect(await managedStorageNamespace(other)).not.toBe(first);
  });

  it('rejects once the marker is gone', async () => {
    rmSync(join(uploads, MANAGED_STORAGE_MARKER));
    await expect(managedStorageNamespace(uploads)).rejects.toBeInstanceOf(
      ManagedRuntimeConfigError
    );
  });
});

// FAKE Redis: SET NX / GET and atomic compare-and-renew/delete. Real expiry/ownership is also tested against isolated Redis.
class FakeLeaseRedis {
  store = new Map<string, string>();
  expired: string[] = [];

  async set(key: string, value: string, _ex: string, _seconds: number, nx?: string) {
    if (nx === 'NX' && this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
    return 'OK';
  }

  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  beforeEval?: () => void;
  async eval(script: string, keyCount: number, key: string, owner: string, seconds?: number) {
    expect(keyCount).toBe(1);
    this.beforeEval?.();
    if (this.store.get(key) !== owner) return 0;
    if (script.includes("redis.call('expire'")) return this.expire(key, seconds!);
    if (script.includes("redis.call('del'")) return this.del(key);
    throw new Error('Unexpected Redis lease script');
  }

  async expire(key: string, seconds: number) {
    this.expired.push(`${key}:${seconds}`);
    return this.store.has(key) ? 1 : 0;
  }

  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }
}

describe('managed runtime single-instance lease', () => {
  it('admits one instance per Redis and only lets the holder renew or release it', async () => {
    const redis = new FakeLeaseRedis() as any;

    expect(await acquireManagedRuntimeLease(redis, 'a')).toBe(true);
    expect(await acquireManagedRuntimeLease(redis, 'b')).toBe(false);
    expect(await holdsManagedRuntimeLease(redis, 'a')).toBe(true);
    expect(await holdsManagedRuntimeLease(redis, 'b')).toBe(false);

    expect(await refreshManagedRuntimeLease(redis, 'b')).toBe(false);
    expect(redis.expired).toEqual([]);
    expect(await refreshManagedRuntimeLease(redis, 'a')).toBe(true);
    expect(redis.expired).toEqual([
      `${MANAGED_RUNTIME_LEASE_KEY}:${MANAGED_RUNTIME_LEASE_SECONDS}`,
    ]);

    await releaseManagedRuntimeLease(redis, 'b');
    expect(await holdsManagedRuntimeLease(redis, 'a')).toBe(true);
    await releaseManagedRuntimeLease(redis, 'a');
    expect(redis.store.has(MANAGED_RUNTIME_LEASE_KEY)).toBe(false);
    expect(await acquireManagedRuntimeLease(redis, 'b')).toBe(true);
  });

  it('does not mutate a successor that took ownership immediately before the atomic command', async () => {
    const redis = new FakeLeaseRedis() as any;
    await acquireManagedRuntimeLease(redis, 'old');
    redis.beforeEval = () => redis.store.set(MANAGED_RUNTIME_LEASE_KEY, 'successor');
    expect(await refreshManagedRuntimeLease(redis, 'old')).toBe(false);
    await releaseManagedRuntimeLease(redis, 'old');
    expect(redis.store.get(MANAGED_RUNTIME_LEASE_KEY)).toBe('successor');
    expect(redis.expired).toEqual([]);
  });

  it('a lease that expired or was taken over is lost, not renewed', async () => {
    const redis = new FakeLeaseRedis() as any;
    await acquireManagedRuntimeLease(redis, 'a');

    redis.store.delete(MANAGED_RUNTIME_LEASE_KEY);
    expect(await refreshManagedRuntimeLease(redis, 'a')).toBe(false);

    await acquireManagedRuntimeLease(redis, 'b');
    expect(await refreshManagedRuntimeLease(redis, 'a')).toBe(false);
    expect(redis.store.get(MANAGED_RUNTIME_LEASE_KEY)).toBe('b');
    expect(redis.expired).toEqual([]);
  });
});

describe('withTimeout', () => {
  it('rejects a call that does not answer in time and passes an answer through', async () => {
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toThrow('timeout');
    await expect(withTimeout(Promise.resolve('PONG'), 1000)).resolves.toBe('PONG');
  });
});

describe('managed runtime trusted proxy topology', () => {
  // a real Express request: req.ip is what the auth bound keys on
  const resolvedIp = (trust: unknown, remoteAddress: string, forwardedFor?: string) => {
    const app = express();
    app.set('trust proxy', trust);
    return Object.defineProperties(Object.create(app.request), {
      headers: { value: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} },
      socket: { value: { remoteAddress } },
    }).ip;
  };

  it('trusts no proxy unless one is configured', () => {
    expect(managedTrustProxy(undefined)).toBe(false);
    expect(managedTrustProxy('  ')).toBe(false);
    expect(resolvedIp(false, '203.0.113.9', '198.51.100.1')).toBe('203.0.113.9');
  });

  it.each([
    ['1', 1],
    ['3', 3],
    ['10.0.0.5', ['10.0.0.5']],
    ['10.0.0.0/8, fd00:1234::/32', ['10.0.0.0/8', 'fd00:1234::/32']],
    ['::ffff:10.0.0.5', ['::ffff:10.0.0.5']],
  ])('accepts %s, which Express compiles', (raw, parsed) => {
    expect(managedTrustProxy(raw)).toEqual(parsed);
    expect(() => resolvedIp(parsed, '10.0.0.5', '198.51.100.1')).not.toThrow();
  });

  it.each([
    'true',
    'false',
    '0',
    '4',
    '*',
    'loopback',
    'uniquelocal',
    '0.0.0.0/0',
    '0.0.0.0/1',
    '10.0.0.0/7',
    '::/0',
    '2001:db8::/31',
    '10.0.0.0/33',
    '10.0.0.0/abc',
    '10.0.0.0/8/8',
    'fe80::1%eth0',
    '10.0.0.5,',
    'proxy.internal',
    Array.from({ length: 17 }, (_, i) => `10.0.0.${i + 1}`).join(','),
  ])('refuses %s without naming the value', (raw) => {
    let message = '';
    try {
      managedTrustProxy(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(ManagedRuntimeConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('POSTIZ_MANAGED_TRUST_PROXY');
    if (raw.length > 3) {
      expect(message).not.toContain(raw);
    }
  });

  it('with an address list, a caller that bypasses the proxy is keyed on its own address', () => {
    const trust = managedTrustProxy('10.0.0.5');
    // through the proxy: the address the proxy appended
    expect(resolvedIp(trust, '10.0.0.5', 'spoofed, 198.51.100.7')).toBe('198.51.100.7');
    // direct: the forged header is ignored
    expect(resolvedIp(trust, '203.0.113.9', '198.51.100.7')).toBe('203.0.113.9');
  });

  it('with one hop, only the entry the proxy appended is used, not the caller-set prefix', () => {
    const trust = managedTrustProxy('1');
    expect(resolvedIp(trust, '10.0.0.5', '1.1.1.1, 2.2.2.2, 198.51.100.7')).toBe('198.51.100.7');
  });
});

describe('managed runtime lease wait', () => {
  it('waits for a crashed runtime lease to expire, then takes it', async () => {
    const redis = new FakeLeaseRedis() as any;
    await acquireManagedRuntimeLease(redis, 'crashed');
    let attempts = 0;
    const set = redis.set.bind(redis);
    redis.set = async (...args: any[]) => {
      if (++attempts === 3) {
        redis.store.delete(MANAGED_RUNTIME_LEASE_KEY); // expiry
      }
      return set(...args);
    };

    expect(await waitForManagedRuntimeLease(redis, 'new', () => false, 1)).toBe(true);
    expect(attempts).toBe(3);
    expect(redis.store.get(MANAGED_RUNTIME_LEASE_KEY)).toBe('new');
  });

  it('never takes a lease that is still renewed, and gives up after the bounded attempts', async () => {
    const redis = new FakeLeaseRedis() as any;
    await acquireManagedRuntimeLease(redis, 'live');
    const set = jest.spyOn(redis, 'set');

    expect(await waitForManagedRuntimeLease(redis, 'new', () => false, 1, 4)).toBe(false);
    expect(set).toHaveBeenCalledTimes(4);
    expect(redis.store.get(MANAGED_RUNTIME_LEASE_KEY)).toBe('live');
  });

  it('waits longer than a lease lives by default', () => {
    expect(MANAGED_RUNTIME_LEASE_ATTEMPTS * MANAGED_RUNTIME_LEASE_RETRY_MS).toBeGreaterThan(
      MANAGED_RUNTIME_LEASE_SECONDS * 1000
    );
  });

  it('stops waiting when the process is asked to stop', async () => {
    const redis = new FakeLeaseRedis() as any;
    await acquireManagedRuntimeLease(redis, 'live');
    let stopped = false;
    const set = jest.spyOn(redis, 'set');
    const waiting = waitForManagedRuntimeLease(redis, 'new', () => stopped, 5, 1000);
    await new Promise((done) => setTimeout(done, 20));
    stopped = true;
    expect(await waiting).toBe(false);
    expect(set.mock.calls.length).toBeLessThan(1000);

    // stopped before the first attempt: nothing is taken
    redis.store.delete(MANAGED_RUNTIME_LEASE_KEY);
    expect(await waitForManagedRuntimeLease(redis, 'new', () => true, 1)).toBe(false);
    expect(redis.store.has(MANAGED_RUNTIME_LEASE_KEY)).toBe(false);
  });

  it('rejects when Redis fails, so startup refuses', async () => {
    const redis = new FakeLeaseRedis() as any;
    redis.set = async () => {
      throw new Error('FAKE ECONNREFUSED');
    };
    await expect(waitForManagedRuntimeLease(redis, 'new', () => false, 1)).rejects.toThrow();
  });
});

describe('managed runtime schema check', () => {
  const MODELS = ['ManagedOrganization', 'ManagedMediaUpload', 'ManagedChangeEvent'];

  // FAKE Prisma delegates: a full projection fails like a missing table or column
  const client = (failing?: string) =>
    Object.fromEntries(
      MODELS.map((model) => [
        model.charAt(0).toLowerCase() + model.slice(1),
        {
          findFirst: jest.fn(async (args?: unknown) => {
            expect(args).toBeUndefined(); // no select: every column is read
            if (model === failing) {
              throw new Error('FAKE column "data" does not exist at db.invalid:5432');
            }
            return null;
          }),
        },
      ])
    );

  it('reads every managed model with its full projection', async () => {
    const fake = client();
    await assertManagedRuntimeSchema(fake, MODELS);
    for (const delegate of Object.values(fake)) {
      expect(delegate.findFirst).toHaveBeenCalledTimes(1);
    }
  });

  it.each(MODELS)('refuses when %s is missing or incomplete, without the driver text', async (model) => {
    const result = assertManagedRuntimeSchema(client(model), MODELS);
    await expect(result).rejects.toBeInstanceOf(ManagedRuntimeConfigError);
    await expect(result).rejects.toThrow(`no complete ${model} table`);
    await expect(result).rejects.not.toThrow('db.invalid');
  });

  it('refuses a model the client has but the database lacks entirely', async () => {
    const fake = client();
    delete fake.managedChangeEvent;
    await expect(assertManagedRuntimeSchema(fake, MODELS)).rejects.toThrow(
      'no complete ManagedChangeEvent table'
    );
  });

  it('refuses a client without any managed model (the FAKE client has no dmmf)', async () => {
    await expect(assertManagedRuntimeSchema(client())).rejects.toThrow('no managed model');
  });
});
