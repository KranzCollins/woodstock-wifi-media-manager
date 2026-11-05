// the controller's collaborators touch storage and providers; only its route
// metadata is used here
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({
  captureUploadOptions: () => ({}),
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/managed/managed.service', () => ({
  ManagedService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service', () => ({
  ManagedMediaService: class {},
}));

import express from 'express';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ManagedAuthMiddleware } from '@gitroom/backend/services/auth/managed.auth.middleware';
import { ManagedController } from '@gitroom/backend/managed-api/routes/v1/managed.controller';
import { ThrottlerManagedCredentialGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import {
  MANAGED_SCOPE_KEY,
  ManagedScopeGuard,
} from '@gitroom/backend/services/auth/managed.scope.guard';
import {
  MANAGED_AUTH_ATTEMPTS_PER_HOUR,
  MANAGED_AUTH_FAILURES_PER_HOUR,
  sha256Hex,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

const ORG = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'FAKE-managed-token-0123456789abcdef-0123456789';

// FAKE express request / response
const request = (headers: Record<string, string> = {}, extra: any = {}) =>
  ({ headers, cookies: {}, ...extra } as any);

const response = () => {
  const res: any = { statusCode: 0, body: undefined };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
};

// FAKE throttler storage with the semantics of the Redis one: hits per key,
// blocked once over the limit
const fakeThrottlerStorage = () => {
  const hits = new Map<string, number>();
  return {
    hits,
    increment: jest.fn(async (key: string, ttl: number, limit: number) => {
      const totalHits = (hits.get(key) || 0) + 1;
      hits.set(key, totalHits);
      return {
        totalHits,
        timeToExpire: ttl,
        isBlocked: totalHits > limit,
        timeToBlockExpire: totalHits > limit ? ttl : 0,
      };
    }),
  };
};

describe('ManagedAuthMiddleware', () => {
  let storage: ReturnType<typeof fakeThrottlerStorage>;
  let middleware: ManagedAuthMiddleware;

  beforeEach(() => {
    storage = fakeThrottlerStorage();
    middleware = new ManagedAuthMiddleware(storage as any);
  });

  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
    process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([
      {
        id: 'ww-local',
        organizationId: ORG,
        tokenSha256: sha256Hex(TOKEN),
        scopes: ['posts:read'],
      },
    ]);
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
    delete process.env.POSTIZ_MANAGED_CREDENTIALS;
  });

  const call = async (req: any) => {
    const res = response();
    const next = jest.fn();
    await middleware.use(req, res, next);
    return { res, next, req };
  };

  it('binds the request to the credential organization only', async () => {
    const { next, req } = await call(request({ authorization: `Bearer ${TOKEN}` }));

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.managedCredential).toMatchObject({
      id: 'ww-local',
      organizationId: ORG,
      scopes: ['posts:read'],
    });
    // no dashboard / public-API organization session is created
    expect(req.org).toBeUndefined();
  });

  it('does not exist while managed mode is disabled', async () => {
    delete process.env.POSTIZ_MANAGED_MODE;
    const { res, next } = await call(request({ authorization: `Bearer ${TOKEN}` }));
    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  const FAILURES_KEY = 'managed_auth_failures';
  const addressKeys = () => [...storage.hits.keys()].filter((key) => key !== FAILURES_KEY);
  const from = (ip: unknown, authorization: string, headers: Record<string, string> = {}) =>
    request({ authorization, ...headers }, { ip });

  it('bounds attempts per address before any outcome is answered', async () => {
    for (let i = 0; i < MANAGED_AUTH_ATTEMPTS_PER_HOUR; i++) {
      const { res } = await call(from('203.0.113.7', `Bearer ${TOKEN}${i}`));
      expect(res.statusCode).toBe(401);
    }

    // over the bound even the right token gets no answer of its own
    const blocked = await call(from('203.0.113.7', `Bearer ${TOKEN}`));
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.body.code).toBe('TOO_MANY_ATTEMPTS');
    expect(blocked.next).not.toHaveBeenCalled();

    // another address has its own bound
    const other = await call(from('198.51.100.2', `Bearer ${TOKEN}`));
    expect(other.next).toHaveBeenCalledTimes(1);
  });

  it.each([
    'x-forwarded-for',
    'x-real-ip',
    'forwarded',
    'cf-connecting-ip',
    'true-client-ip',
    'x-client-ip',
  ])('ignores a caller-set %s header: rotating it does not escape the bound', async (header) => {
    for (let i = 0; i < MANAGED_AUTH_ATTEMPTS_PER_HOUR; i++) {
      await call(from('203.0.113.7', `Bearer ${TOKEN}${i}`, { [header]: `198.51.100.${i % 250}` }));
    }

    const blocked = await call(
      from('203.0.113.7', `Bearer ${TOKEN}`, { [header]: '192.0.2.1' })
    );
    expect(blocked.res.statusCode).toBe(429);
    expect(addressKeys()).toHaveLength(1);
  });

  it('keys on a fixed-length digest of the address, never on caller-chosen text', async () => {
    const hostile = [
      '203.0.113.7',
      '::ffff:203.0.113.7',
      '2001:DB8::1',
      '2001:db8::1',
      'x'.repeat(16000),
      '203.0.113.7, 198.51.100.1',
      undefined,
    ];
    for (const ip of hostile) {
      await call(from(ip, `Bearer ${TOKEN}x`));
    }

    const keys = addressKeys();
    // an IPv4-mapped address is the IPv4 one, hex case is one address, and
    // anything that is not an address shares one bucket
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).toMatch(/^managed_auth_[a-f0-9]{64}$/);
    }
    expect(keys.join()).not.toContain('203.0.113.7');
  });

  it('end to end with Express req.ip: a direct caller forging forwarding headers stays in its own bucket', async () => {
    // a real Express request with the runtime's default (trust no proxy) and
    // with a trusted proxy address the caller is not
    for (const trust of [false, ['10.0.0.5']]) {
      storage = fakeThrottlerStorage();
      middleware = new ManagedAuthMiddleware(storage as any);
      const app = express();
      app.set('trust proxy', trust);
      const forged = (i: number) =>
        Object.defineProperties(Object.create(app.request), {
          headers: {
            value: {
              authorization: `Bearer ${TOKEN}${i}`,
              'x-forwarded-for': `198.51.100.${i % 250}, 10.0.0.5`,
            },
          },
          socket: { value: { remoteAddress: '203.0.113.7' } },
          cookies: { value: {} },
        });

      for (let i = 0; i < MANAGED_AUTH_ATTEMPTS_PER_HOUR; i++) {
        expect((await call(forged(i))).res.statusCode).toBe(401);
      }
      expect((await call(forged(-1))).res.statusCode).toBe(429);
      expect(addressKeys()).toEqual([`managed_auth_${sha256Hex('203.0.113.7')}`]);
    }
  });

  it('bounds failures across addresses without creating more keys, and never counts a valid credential there', async () => {
    const address = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

    // a valid credential does not take from the global failure bound
    expect((await call(from('192.0.2.10', `Bearer ${TOKEN}`))).next).toHaveBeenCalled();
    expect(storage.hits.get(FAILURES_KEY)).toBeUndefined();

    for (let i = 0; i < MANAGED_AUTH_FAILURES_PER_HOUR; i++) {
      expect((await call(from(address(i), `Bearer ${TOKEN}x`))).res.statusCode).toBe(401);
    }
    const keys = storage.hits.size;

    // over the global bound a failure from a new address is refused before
    // an address counter exists for it
    const refused = await call(from('192.0.2.99', `Bearer ${TOKEN}x`));
    expect(refused.res.statusCode).toBe(429);
    expect(storage.hits.size).toBe(keys);

    // the organization's own traffic still authenticates
    const valid = await call(from('192.0.2.10', `Bearer ${TOKEN}`));
    expect(valid.next).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the attempt counter is unavailable', async () => {
    storage.increment.mockRejectedValueOnce(new Error('FAKE redis down'));
    const { res, next } = await call(request({ authorization: `Bearer ${TOKEN}` }));
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();

    storage.increment.mockRejectedValueOnce(new Error('FAKE redis down'));
    const failing = await call(request({ authorization: `Bearer ${TOKEN}x` }));
    expect(failing.res.statusCode).toBe(503);
  });

  it('refuses a body nested deeper than the bound', async () => {
    let settings: any = {};
    const body = { settings };
    for (let i = 0; i < 20; i++) {
      settings.next = {};
      settings = settings.next;
    }

    const { res, next } = await call(
      request({ authorization: `Bearer ${TOKEN}` }, { body })
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(next).not.toHaveBeenCalled();

    const shallow = await call(
      request({ authorization: `Bearer ${TOKEN}` }, { body: { settings: { a: { b: 1 } } } })
    );
    expect(shallow.next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a session cookie', request({}, { cookies: { auth: 'FAKE-session-jwt' } })],
    ['the auth header', request({ auth: 'FAKE-session-jwt' })],
    ['a Postiz API key', request({ authorization: 'FAKE-org-api-key-0123456789abcdef0123' })],
    ['an OAuth app token', request({ authorization: 'pos_FAKE0123456789abcdef0123456789' })],
    ['a wrong bearer token', request({ authorization: `Bearer ${TOKEN}x` })],
    ['the token digest', request({ authorization: `Bearer ${sha256Hex(TOKEN)}` })],
    ['nothing', request()],
  ])('refuses %s', async (_label, req) => {
    const { res, next } = await call(req);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['x-postiz-org', 'showorg', 'impersonate'])(
    'refuses the %s organization override',
    async (header) => {
      const { res, next } = await call(
        request({ authorization: `Bearer ${TOKEN}`, [header]: ORG })
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('ORGANIZATION_OVERRIDE_REFUSED');
      expect(next).not.toHaveBeenCalled();
    }
  );

  it('refuses a credential whose organization left the allowlist', async () => {
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = '99999999-9999-4999-8999-999999999999';
    const { res, next } = await call(request({ authorization: `Bearer ${TOKEN}` }));
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('ThrottlerManagedCredentialGuard on the managed controller', () => {
  const handlers = [
    'listChannels',
    'inventory',
    'createDraft',
    'changes',
    'reserveMediaUpload',
    'mediaUploadContent',
    'mediaUploadStatus',
    'recoverMediaUpload',
    'operationStatus',
    'capabilities',
  ] as const;

  const context = (
    handler: (typeof handlers)[number],
    credentialId: string,
    organizationId = ORG
  ) => {
    const res = { header: jest.fn() };
    return {
      getClass: () => ManagedController,
      getHandler: () => (ManagedController.prototype as any)[handler],
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          managedCredential: { id: credentialId, organizationId },
        }),
        getResponse: () => res,
      }),
    } as any;
  };

  const createGuard = async (storage: ReturnType<typeof fakeThrottlerStorage>) => {
    // the module default is far higher; the controller's 200 / hour applies
    const guard = new ThrottlerManagedCredentialGuard(
      { throttlers: [{ ttl: 3600000, limit: 100000 }] },
      storage as any,
      new Reflector()
    );
    await guard.onModuleInit();
    return guard;
  };

  it('gives every organization a budget of its own', async () => {
    const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
    const storage = fakeThrottlerStorage();
    const guard = await createGuard(storage);

    for (let i = 0; i < 200; i++) {
      await guard.canActivate(context(handlers[i % handlers.length], 'ww-a'));
    }
    await expect(guard.canActivate(context('listChannels', 'ww-a'))).rejects.toBeInstanceOf(
      ThrottlerException
    );

    // one organization over its budget does not block another
    expect(await guard.canActivate(context('listChannels', 'ww-z', OTHER_ORG))).toBe(true);
    expect(storage.hits.size).toBe(2);
    expect([...storage.hits.keys()].every((key) => key.startsWith('managed_org_'))).toBe(
      true
    );
  });

  it('shares one budget of at most 200 / hour across every route and credential of an organization', async () => {
    const storage = fakeThrottlerStorage();
    const guard = await createGuard(storage);

    for (let i = 0; i < 200; i++) {
      expect(
        await guard.canActivate(
          context(handlers[i % handlers.length], i % 2 ? 'ww-a' : 'ww-b')
        )
      ).toBe(true);
    }

    await expect(guard.canActivate(context('getPost' as any, 'ww-c'))).rejects.toBeInstanceOf(
      ThrottlerException
    );
    // one key for the organization, whatever the route or the credential
    expect(storage.hits.size).toBe(1);
  });
});

describe('ManagedScopeGuard', () => {
  const context = (scope: string | undefined, scopes: string[]) => {
    const handler = (): undefined => undefined;
    if (scope) {
      Reflect.defineMetadata(MANAGED_SCOPE_KEY, scope, handler);
    }
    return {
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => ({ managedCredential: { scopes } }),
      }),
    } as any;
  };

  const guard = new ManagedScopeGuard(new Reflector());

  it('allows a route whose scope the credential has', () => {
    expect(guard.canActivate(context('posts:read', ['posts:read']))).toBe(true);
  });

  it('refuses a missing scope', () => {
    expect(() => guard.canActivate(context('posts:write', ['posts:read']))).toThrow(
      ForbiddenException
    );
  });

  it.each([
    'reserveMediaUpload',
    'mediaUploadStatus',
    'mediaUploadContent',
    'recoverMediaUpload',
  ])('reserved upload route %s needs media:upload, which media:write does not grant', (handler) => {
    const route = (scopes: string[]) =>
      ({
        getHandler: () => (ManagedController.prototype as any)[handler],
        switchToHttp: () => ({
          getRequest: () => ({ managedCredential: { scopes } }),
        }),
      } as any);

    expect(guard.canActivate(route(['media:upload']))).toBe(true);
    // a revoked scope: the credential keeps every other scope
    expect(() =>
      guard.canActivate(route(['media:write', 'posts:write', 'posts:read']))
    ).toThrow(ForbiddenException);
  });

  it('fails closed on a route that declares no scope', () => {
    expect(() => guard.canActivate(context(undefined, ['posts:read']))).toThrow(
      ForbiddenException
    );
  });
});
