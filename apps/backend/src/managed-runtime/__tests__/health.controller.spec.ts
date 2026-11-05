// local.storage requires file-type (ESM-only) at load; no byte is sniffed here
jest.mock(
  'file-type',
  () => ({ fileTypeStream: jest.fn(), fileTypeFromBuffer: jest.fn() }),
  { virtual: true }
);
// FAKE Redis client in place of the shared ioRedis
const mockRedis = { ping: jest.fn(), get: jest.fn() };
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: mockRedis,
}));

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { ManagedRuntimeHealthController } from '@gitroom/backend/managed-runtime/health.controller';
import {
  MANAGED_RUNTIME_LEASE_KEY,
  MANAGED_RUNTIME_READY_CACHE_MS,
  MANAGED_STORAGE_MARKER,
  managedStorageNamespace,
} from '@gitroom/backend/managed-runtime/managed-runtime.config';

const KEYS = [
  'POSTIZ_MANAGED_MODE',
  'POSTIZ_MANAGED_ORGANIZATIONS',
  'STORAGE_PROVIDER',
  'UPLOAD_DIRECTORY',
  'FRONTEND_URL',
];

let scratch: string;
let uploads: string;
let saved: Record<string, string | undefined>;
let namespace: string;
let enrolled: jest.Mock;

function response() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.setHeader = jest.fn(() => res);
  return res;
}

async function ready(controller: ManagedRuntimeHealthController) {
  const res = response();
  await controller.ready(res);
  return {
    status: res.status.mock.calls[0][0],
    body: res.json.mock.calls[0][0],
    headers: Object.fromEntries(res.setHeader.mock.calls),
  };
}

function controller(state = { instanceId: 'instance-a', storageNamespace: namespace }) {
  // FAKE Prisma: only the read assertManagedEnrollment makes
  return new ManagedRuntimeHealthController(
    { managedOrganization: { findMany: enrolled } } as any,
    state
  );
}

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  scratch = mkdtempSync(join(tmpdir(), 'ww-mrt-health-'));
  uploads = join(scratch, 'uploads');
  mkdirSync(uploads);
  chmodSync(uploads, 0o700);
  writeFileSync(join(uploads, MANAGED_STORAGE_MARKER), 'synthetic volume\n');
  Object.assign(process.env, {
    POSTIZ_MANAGED_MODE: 'enabled',
    POSTIZ_MANAGED_ORGANIZATIONS: 'org-a',
    STORAGE_PROVIDER: 'local',
    UPLOAD_DIRECTORY: uploads,
    FRONTEND_URL: 'http://managed-storage.invalid',
  });
  namespace = await managedStorageNamespace(uploads);
  enrolled = jest.fn(async () => [{ organizationId: 'org-a' }]);
  mockRedis.ping.mockReset().mockResolvedValue('PONG');
  mockRedis.get
    .mockReset()
    .mockImplementation(async (key: string) =>
      key === MANAGED_RUNTIME_LEASE_KEY ? 'instance-a' : null
    );
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe('managed runtime health', () => {
  it('liveness answers without contacting the database or Redis', () => {
    expect(controller().health()).toEqual({ status: 'ok' });
    expect(enrolled).not.toHaveBeenCalled();
    expect(mockRedis.ping).not.toHaveBeenCalled();
  });

  it('is ready when enrollment, Redis, the lease and the volume all check out', async () => {
    const { status, body } = await ready(controller());
    expect(status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      checks: { enrollment: 'ok', redis: 'ok', lease: 'ok', storage: 'ok' },
    });
    // names and ok / error only: no organization, count or namespace
    expect(JSON.stringify(body)).not.toContain('org-a');
    expect(JSON.stringify(body)).not.toContain(namespace);
  });

  it('is not ready when a durable enrollment is not enrolled in this process', async () => {
    enrolled.mockResolvedValue([{ organizationId: 'org-a' }, { organizationId: 'org-b' }]);
    const { status, body } = await ready(controller());
    expect(status).toBe(503);
    expect(body.checks).toEqual({ enrollment: 'error', redis: 'ok', lease: 'ok', storage: 'ok' });
    expect(JSON.stringify(body)).not.toContain('org-b');
  });

  it('is not ready when the managed schema cannot be read', async () => {
    enrolled.mockRejectedValue(new Error('relation "ManagedOrganization" does not exist'));
    const { status, body } = await ready(controller());
    expect(status).toBe(503);
    expect(body.checks.enrollment).toBe('error');
    expect(JSON.stringify(body)).not.toContain('relation');
  });

  it('is not ready when Redis fails or does not answer in time', async () => {
    mockRedis.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await ready(controller())).body.checks.redis).toBe('error');

    mockRedis.ping.mockReturnValueOnce(new Promise(() => undefined));
    const { status, body } = await ready(controller());
    expect(status).toBe(503);
    expect(body.checks.redis).toBe('error');
  }, 10000);

  it('is not ready when another instance holds the lease', async () => {
    mockRedis.get.mockResolvedValue('instance-b');
    const { status, body } = await ready(controller());
    expect(status).toBe(503);
    expect(body.checks.lease).toBe('error');
  });

  it('is not ready when the volume is gone or is another one', async () => {
    expect(
      (await ready(controller({ instanceId: 'instance-a', storageNamespace: 'local:another' })))
        .body.checks.storage
    ).toBe('error');

    rmSync(join(uploads, MANAGED_STORAGE_MARKER));
    const { status, body } = await ready(controller());
    expect(status).toBe(503);
    expect(body.checks.storage).toBe('error');
  });

  it('is never cached by a proxy and does not log on every probe', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    try {
      const { status, headers } = await ready(controller());
      expect(status).toBe(200);
      expect(headers).toEqual({ 'Cache-Control': 'no-store' });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('answers concurrent and repeated probes from one check until it expires', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000000);
    try {
      const health = controller();
      const results = await Promise.all(Array.from({ length: 20 }, () => ready(health)));
      expect(results.every(({ status }) => status === 200)).toBe(true);
      expect(enrolled).toHaveBeenCalledTimes(1);
      expect(mockRedis.ping).toHaveBeenCalledTimes(1);

      // a failure is seen once the result expired, not before
      mockRedis.ping.mockRejectedValue(new Error('ECONNREFUSED'));
      now.mockReturnValue(1000000 + MANAGED_RUNTIME_READY_CACHE_MS - 1);
      expect((await ready(health)).status).toBe(200);
      now.mockReturnValue(1000000 + MANAGED_RUNTIME_READY_CACHE_MS);
      const { status, body } = await ready(health);
      expect(status).toBe(503);
      expect(body.checks.redis).toBe('error');
      expect(enrolled).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});
