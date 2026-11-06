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

// The shared managed request budget against a FAKE throttler storage with the
// semantics of the installed Redis storage (@nest-lab/throttler-storage-redis):
// one atomic count per key and window, and a block of blockDuration once a
// count goes over the limit the caller passes. The HTTP guard is the REAL
// ThrottlerManagedCredentialGuard on the REAL managed controller, so provider
// requests and W&W HTTP requests are proven to land on one key. No Redis,
// database or network is involved
import { inspect } from 'util';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { ManagedController } from '@gitroom/backend/managed-api/routes/v1/managed.controller';
import { ThrottlerManagedCredentialGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import {
  MANAGED_RATE_LIMIT_MAX,
  managedRateLimit,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import {
  MANAGED_REQUEST_RESERVATION_TIMEOUT_MS,
  MANAGED_REQUEST_WINDOW_MS,
  managedRequestBudgetKey,
  SharedManagedRequestBudget,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.request.budget';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const HANDLERS = ['listChannels', 'inventory', 'capabilities', 'operationStatus'];

// FAKE throttler storage. Like the Redis Lua script, a hit is counted and the
// block decided in one step (nothing awaits in between), a count lives for ttl
// from its first hit, and a block lasts blockDuration from the hit that went
// over the limit, whatever the window
const fakeThrottlerStorage = (now: () => number = () => Date.now()) => {
  const windows = new Map<string, { totalHits: number; expiresAt: number }>();
  const blocks = new Map<string, number>();
  const increment = jest.fn(
    async (key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) => {
      const id = `{${key}:${throttlerName}}`;
      const at = now();
      const current = windows.get(id);
      const window = current && current.expiresAt > at ? current : { totalHits: 0, expiresAt: at + ttl };
      window.totalHits++;
      windows.set(id, window);
      let blockedUntil = blocks.get(id) ?? 0;
      if (blockedUntil <= at && window.totalHits > limit) {
        blockedUntil = at + blockDuration;
        blocks.set(id, blockedUntil);
      }
      const isBlocked = blockedUntil > at;
      return {
        totalHits: window.totalHits,
        timeToExpire: Math.ceil((window.expiresAt - at) / 1000),
        isBlocked,
        timeToBlockExpire: isBlocked ? Math.ceil((blockedUntil - at) / 1000) : 0,
      };
    }
  );
  const hits = (organizationId: string) =>
    windows.get(`{${managedRequestBudgetKey(organizationId)}:default}`)?.totalHits ?? 0;
  return { increment, windows, hits };
};

// FAKE request of an authenticated managed credential, as the auth middleware
// leaves it for the guard
const httpRequest = (handler: string, organizationId = ORG) => {
  const res = { header: jest.fn() };
  return {
    getClass: () => ManagedController,
    getHandler: () => (ManagedController.prototype as any)[handler],
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {},
        managedCredential: { id: 'ww-local', organizationId },
      }),
      getResponse: () => res,
    }),
  } as any;
};

const createGuard = async (storage: ReturnType<typeof fakeThrottlerStorage>) => {
  // the module default is far higher; the controller's own limit applies
  const guard = new ThrottlerManagedCredentialGuard(
    { throttlers: [{ ttl: 3600000, limit: 100000 }] },
    storage as any,
    new Reflector()
  );
  await guard.onModuleInit();
  return guard;
};

const admitted = (guard: ThrottlerManagedCredentialGuard, handler: string, organizationId = ORG) =>
  guard.canActivate(httpRequest(handler, organizationId)).then(
    () => true,
    (error) => {
      expect(error).toBeInstanceOf(ThrottlerException);
      return false;
    }
  );

describe('SharedManagedRequestBudget and the managed HTTP guard', () => {
  it('increments exactly the key, window, limit, block and throttler of the HTTP guard', async () => {
    const storage = fakeThrottlerStorage();
    const guard = await createGuard(storage);
    const budget = new SharedManagedRequestBudget(storage);

    for (const handler of HANDLERS) {
      expect(await admitted(guard, handler)).toBe(true);
    }
    expect(await budget.reserve(ORG, 1)).toBe(true);

    const calls = storage.increment.mock.calls;
    expect(calls).toHaveLength(HANDLERS.length + 1);
    // every route and the provider reservation: one and the same call
    for (const call of calls) {
      expect(call).toEqual(calls[calls.length - 1]);
    }
    expect(calls[0]).toEqual([
      managedRequestBudgetKey(ORG),
      MANAGED_REQUEST_WINDOW_MS,
      managedRateLimit(),
      MANAGED_REQUEST_WINDOW_MS,
      'default',
    ]);
    expect(storage.windows.size).toBe(1);
    expect(storage.hits(ORG)).toBe(HANDLERS.length + 1);
  });

  it('never lets the organization budget exceed the 200 / hour ceiling', () => {
    expect(managedRateLimit()).toBeLessThanOrEqual(MANAGED_RATE_LIMIT_MAX);
    expect(MANAGED_RATE_LIMIT_MAX).toBe(200);
  });

  it('spends provider units from the budget the HTTP requests use', async () => {
    const storage = fakeThrottlerStorage();
    const guard = await createGuard(storage);
    const budget = new SharedManagedRequestBudget(storage);
    const limit = managedRateLimit();
    const units = Math.floor(limit / 4);

    for (let i = 0; i < limit - units; i++) {
      expect(await admitted(guard, HANDLERS[i % HANDLERS.length])).toBe(true);
    }
    expect(await budget.reserve(ORG, units)).toBe(true);

    expect(await admitted(guard, 'listChannels')).toBe(false);
    expect(await budget.reserve(ORG, 1)).toBe(false);
  });

  it('refuses HTTP requests once provider reservations used the budget', async () => {
    const storage = fakeThrottlerStorage();
    const guard = await createGuard(storage);
    const budget = new SharedManagedRequestBudget(storage);

    expect(await budget.reserve(ORG, managedRateLimit())).toBe(true);
    expect(await admitted(guard, 'capabilities')).toBe(false);
  });

  it('admits exactly the limit when HTTP requests and reservations race', async () => {
    const storage = fakeThrottlerStorage();
    const guard = await createGuard(storage);
    const budget = new SharedManagedRequestBudget(storage);
    const limit = managedRateLimit();

    const results = await Promise.all([
      ...Array.from({ length: 150 }, () => budget.reserve(ORG, 1)),
      ...Array.from({ length: 100 }, (_, i) => admitted(guard, HANDLERS[i % HANDLERS.length])),
    ]);

    expect(results.filter(Boolean)).toHaveLength(Math.min(limit, 250));
    expect(storage.hits(ORG)).toBe(250);
  });

  it('never admits two concurrent reservations that together exceed the budget, and refunds neither', async () => {
    const storage = fakeThrottlerStorage();
    const budget = new SharedManagedRequestBudget(storage);
    const limit = managedRateLimit();
    const units = Math.ceil((limit * 3) / 4);

    const results = await Promise.all([budget.reserve(ORG, units), budget.reserve(ORG, units)]);

    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
    // each failing reservation stops at its first refused unit
    expect(storage.increment.mock.calls.length).toBeLessThanOrEqual(limit + 2);
    // the units both consumed stay consumed
    expect(storage.hits(ORG)).toBeGreaterThan(limit);
    expect(await budget.reserve(ORG, 1)).toBe(false);
  });

  it('keeps a partial reservation: the units that fit stay spent, the step is refused', async () => {
    const storage = fakeThrottlerStorage();
    const guard = await createGuard(storage);
    const budget = new SharedManagedRequestBudget(storage);
    const limit = managedRateLimit();

    for (let i = 0; i < limit - 5; i++) {
      await admitted(guard, HANDLERS[i % HANDLERS.length]);
    }
    storage.increment.mockClear();

    expect(await budget.reserve(ORG, 10)).toBe(false);
    // five units fit, the sixth went over; the loop stopped there
    expect(storage.increment).toHaveBeenCalledTimes(6);
    expect(storage.hits(ORG)).toBe(limit + 1);
    expect(await budget.reserve(ORG, 1)).toBe(false);
    expect(await admitted(guard, 'listChannels')).toBe(false);
  });

  it('blocks the organization for the block duration after a reservation that did not fit, past the end of its window', async () => {
    let clock = 0;
    const storage = fakeThrottlerStorage(() => clock);
    const budget = new SharedManagedRequestBudget(storage);
    const limit = managedRateLimit();

    expect(await budget.reserve(ORG, limit - 1)).toBe(true);
    clock = MANAGED_REQUEST_WINDOW_MS / 2;
    expect(await budget.reserve(ORG, 2)).toBe(false);

    // the window of the first hit has ended; the block has not
    clock = MANAGED_REQUEST_WINDOW_MS;
    expect(await budget.reserve(ORG, 1)).toBe(false);

    clock = MANAGED_REQUEST_WINDOW_MS * 1.5;
    expect(await budget.reserve(ORG, 1)).toBe(true);
  });

  it('gives every organization its own budget', async () => {
    const storage = fakeThrottlerStorage();
    const guard = await createGuard(storage);
    const budget = new SharedManagedRequestBudget(storage);

    expect(await budget.reserve(ORG, managedRateLimit())).toBe(true);
    expect(await budget.reserve(ORG, 1)).toBe(false);
    expect(await admitted(guard, 'listChannels')).toBe(false);

    expect(storage.hits(OTHER_ORG)).toBe(0);
    expect(await admitted(guard, 'listChannels', OTHER_ORG)).toBe(true);
    expect(await budget.reserve(OTHER_ORG, 1)).toBe(true);
    expect(storage.hits(OTHER_ORG)).toBe(2);
  });

  it.each([
    ['an empty id', ''],
    ['a path', `${ORG}/other`],
    ['a space', `${ORG} `],
    ['a Redis hash tag', `{${ORG}}`],
    ['a key separator', `${ORG}:default`],
    ['a non-ASCII id', 'organizaçao'],
    ['an overlong id', 'a'.repeat(65)],
  ])('refuses %s as organization without counting anything', async (_name, organizationId) => {
    const storage = fakeThrottlerStorage();
    const budget = new SharedManagedRequestBudget(storage);

    expect(await budget.reserve(organizationId, 1)).toBe(false);
    expect(storage.increment).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MANAGED_RATE_LIMIT_MAX + 1])(
    'refuses %p units without counting anything',
    async (units) => {
      const storage = fakeThrottlerStorage();
      const budget = new SharedManagedRequestBudget(storage);

      expect(await budget.reserve(ORG, units)).toBe(false);
      expect(storage.increment).not.toHaveBeenCalled();
    }
  );

  it.each([0, -1, 1.5, Number.NaN, MANAGED_RATE_LIMIT_MAX + 1])(
    'refuses everything under a limit of %p without counting anything',
    async (limit) => {
      const storage = fakeThrottlerStorage();
      const budget = new SharedManagedRequestBudget(storage, () => limit);

      expect(await budget.reserve(ORG, 1)).toBe(false);
      expect(storage.increment).not.toHaveBeenCalled();
    }
  );

  describe('an unavailable or inconsistent storage admits nothing', () => {
    it('when Redis rejects', async () => {
      const storage = { increment: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
      expect(await new SharedManagedRequestBudget(storage).reserve(ORG, 1)).toBe(false);
    });

    it('when the storage throws before answering (no Redis command, as with the mock client)', async () => {
      const storage = {
        increment: jest.fn(() => {
          throw new TypeError('this.redis.call is not a function');
        }),
      };
      expect(await new SharedManagedRequestBudget(storage).reserve(ORG, 3)).toBe(false);
      expect(storage.increment).toHaveBeenCalledTimes(1);
    });

    it('when Redis fails part way, keeping the units already counted', async () => {
      const real = fakeThrottlerStorage();
      let calls = 0;
      const storage = {
        increment: jest.fn((...args: Parameters<typeof real.increment>) => {
          if (++calls === 3) {
            return Promise.reject(new Error('READONLY'));
          }
          return real.increment(...args);
        }),
      };

      expect(await new SharedManagedRequestBudget(storage).reserve(ORG, 5)).toBe(false);
      expect(storage.increment).toHaveBeenCalledTimes(3);
      expect(real.hits(ORG)).toBe(2);
    });

    it.each<[string, unknown, string, number | null]>([
      ['no answer', undefined, 'BUDGET_UNAVAILABLE', null],
      ['an empty answer', {}, 'BUDGET_UNAVAILABLE', null],
      ['a count that is not a number', { totalHits: Number.NaN, isBlocked: false }, 'BUDGET_UNAVAILABLE', null],
      ['a zero count', { totalHits: 0, isBlocked: false }, 'BUDGET_UNAVAILABLE', null],
      ['no block flag', { totalHits: 1 }, 'BUDGET_UNAVAILABLE', null],
      ['a block flag that is not a boolean', { totalHits: 1, isBlocked: 'false' }, 'BUDGET_UNAVAILABLE', null],
      [
        'a count over the limit it did not block',
        { totalHits: MANAGED_RATE_LIMIT_MAX + 1, isBlocked: false },
        'BUDGET_UNAVAILABLE',
        null,
      ],
      // a block outlives its window: a fresh window may count one hit and
      // still be blocked; with no expiry it gets the longest backoff
      ['a block within the limit', { totalHits: 1, isBlocked: true }, 'BUDGET_EXHAUSTED', MANAGED_REQUEST_WINDOW_MS + 1_000],
    ])('when the storage returns %s', async (_name, result, code, retryAfterMs) => {
      const storage = { increment: jest.fn().mockResolvedValue(result) };
      const budget = new SharedManagedRequestBudget(storage);

      expect(await budget.reserve(ORG, 1)).toBe(false);
      expect(await budget.reserveDetailed(ORG, 1)).toEqual({ accepted: false, code, retryAfterMs });
    });

    it('when the limit cannot be read, without counting anything', async () => {
      const storage = fakeThrottlerStorage();
      const budget = new SharedManagedRequestBudget(storage, () => {
        throw new Error('POSTIZ_MANAGED_RATE_LIMIT unreadable');
      });

      expect(await budget.reserve(ORG, 1)).toBe(false);
      expect(await budget.reserveDetailed(ORG, 1)).toEqual({
        accepted: false,
        code: 'BUDGET_UNAVAILABLE',
        retryAfterMs: null,
      });
      expect(storage.increment).not.toHaveBeenCalled();
    });
  });

  describe('the detailed reservation', () => {
    it('reports an accepted reservation with nothing else in it', async () => {
      const storage = fakeThrottlerStorage();
      const result = await new SharedManagedRequestBudget(storage).reserveDetailed(ORG, 3);

      expect(result).toEqual({ accepted: true, code: 'RESERVED', retryAfterMs: null });
      expect(Object.keys(result).sort()).toEqual(['accepted', 'code', 'retryAfterMs']);
      expect(Object.isFrozen(result)).toBe(true);
      expect(inspect(result)).not.toContain(ORG);
      expect(storage.hits(ORG)).toBe(3);
    });

    it('agrees with reserve, which the media port keeps using', async () => {
      const storage = fakeThrottlerStorage();
      const budget = new SharedManagedRequestBudget(storage, () => 4);

      expect(await budget.reserve(ORG, 3)).toBe(true);
      expect((await budget.reserveDetailed(ORG, 1)).accepted).toBe(true);
      expect(await budget.reserve(ORG, 1)).toBe(false);
      expect((await budget.reserveDetailed(ORG, 1)).accepted).toBe(false);
    });

    it.each<[string, unknown]>([
      ['a number', 1234],
      ['null', null],
      ['undefined', undefined],
      ['an object that prints as an id', { toString: () => ORG }],
      ['an array holding an id', [ORG]],
    ])('refuses %s as organization without counting anything', async (_name, organizationId) => {
      const storage = fakeThrottlerStorage();
      const budget = new SharedManagedRequestBudget(storage);

      expect(await budget.reserve(organizationId as string, 1)).toBe(false);
      expect(await budget.reserveDetailed(organizationId as string, 1)).toEqual({
        accepted: false,
        code: 'INVALID_REQUEST',
        retryAfterMs: null,
      });
      expect(storage.increment).not.toHaveBeenCalled();
    });

    it('refuses more units than the configured limit without counting anything', async () => {
      const storage = fakeThrottlerStorage();
      const budget = new SharedManagedRequestBudget(storage, () => 50);

      expect(await budget.reserveDetailed(ORG, 51)).toEqual({
        accepted: false,
        code: 'INVALID_REQUEST',
        retryAfterMs: null,
      });
      expect(storage.increment).not.toHaveBeenCalled();
      expect((await budget.reserveDetailed(ORG, 50)).accepted).toBe(true);
    });

    it('reports a backoff that outlasts the block and no more, after a reservation that did not fit', async () => {
      let clock = 0;
      const storage = fakeThrottlerStorage(() => clock);
      const budget = new SharedManagedRequestBudget(storage);
      const limit = managedRateLimit();

      expect(await budget.reserve(ORG, limit - 1)).toBe(true);
      clock = MANAGED_REQUEST_WINDOW_MS / 2;
      const refused = await budget.reserveDetailed(ORG, 2);

      // the block started now and lasts the block duration
      expect(refused).toEqual({
        accepted: false,
        code: 'BUDGET_EXHAUSTED',
        retryAfterMs: MANAGED_REQUEST_WINDOW_MS,
      });
      clock += refused.retryAfterMs! - 1;
      expect(await budget.reserve(ORG, 1)).toBe(false);

      const fresh = fakeThrottlerStorage(() => clock);
      clock = 0;
      const again = new SharedManagedRequestBudget(fresh);
      expect(await again.reserve(ORG, limit - 1)).toBe(true);
      clock = MANAGED_REQUEST_WINDOW_MS / 2;
      const { retryAfterMs } = await again.reserveDetailed(ORG, 2);
      clock += retryAfterMs!;
      expect(await again.reserve(ORG, 1)).toBe(true);
    });

    it('reports only the rest of the block when the fresh window holds few hits', async () => {
      let clock = 0;
      const storage = fakeThrottlerStorage(() => clock);
      const budget = new SharedManagedRequestBudget(storage);
      const limit = managedRateLimit();

      expect(await budget.reserve(ORG, limit)).toBe(true);
      clock = MANAGED_REQUEST_WINDOW_MS / 2;
      expect(await budget.reserve(ORG, 1)).toBe(false);

      // the first window ended; the block runs until 1.5 windows
      clock = MANAGED_REQUEST_WINDOW_MS;
      const refused = await budget.reserveDetailed(ORG, 1);

      expect(refused).toEqual({
        accepted: false,
        code: 'BUDGET_EXHAUSTED',
        retryAfterMs: MANAGED_REQUEST_WINDOW_MS / 2,
      });
      clock += refused.retryAfterMs!;
      expect(await budget.reserve(ORG, 1)).toBe(true);
    });

    it('reports the end of the window too when hits counted during the block would block again', async () => {
      let clock = 0;
      const storage = fakeThrottlerStorage(() => clock);
      const guard = await createGuard(storage);
      const budget = new SharedManagedRequestBudget(storage);
      const limit = managedRateLimit();

      expect(await budget.reserve(ORG, limit)).toBe(true);
      clock = MANAGED_REQUEST_WINDOW_MS / 2;
      expect(await budget.reserve(ORG, 1)).toBe(false);

      // a fresh window during the block, filled by refused HTTP requests
      clock = MANAGED_REQUEST_WINDOW_MS;
      for (let i = 0; i < limit; i++) {
        expect(await admitted(guard, 'listChannels')).toBe(false);
      }
      const refused = await budget.reserveDetailed(ORG, 1);

      expect(refused).toEqual({
        accepted: false,
        code: 'BUDGET_EXHAUSTED',
        retryAfterMs: MANAGED_REQUEST_WINDOW_MS,
      });
      clock += refused.retryAfterMs!;
      expect(await budget.reserve(ORG, 1)).toBe(true);
    });

    it.each<[string, Record<string, unknown>, number]>([
      ['a block expiry in seconds', { timeToBlockExpire: 90 }, 90_000],
      ['a fractional expiry', { timeToBlockExpire: 0.0004 }, 1_000],
      ['a zero expiry', { timeToBlockExpire: 0 }, MANAGED_REQUEST_WINDOW_MS + 1_000],
      ['a negative expiry', { timeToBlockExpire: -5 }, MANAGED_REQUEST_WINDOW_MS + 1_000],
      ['an expiry that is not a number', { timeToBlockExpire: '90' }, MANAGED_REQUEST_WINDOW_MS + 1_000],
      ['an infinite expiry', { timeToBlockExpire: Number.POSITIVE_INFINITY }, MANAGED_REQUEST_WINDOW_MS + 1_000],
      ['an expiry beyond the window', { timeToBlockExpire: 86_400 }, MANAGED_REQUEST_WINDOW_MS + 1_000],
      [
        'a full window with a later end',
        { totalHits: MANAGED_RATE_LIMIT_MAX + 3, timeToBlockExpire: 60, timeToExpire: 1_200 },
        1_200_000,
      ],
      [
        'a full window without a readable end',
        { totalHits: MANAGED_RATE_LIMIT_MAX + 3, timeToBlockExpire: 60, timeToExpire: undefined },
        MANAGED_REQUEST_WINDOW_MS + 1_000,
      ],
      ['a window with room ending later', { totalHits: 2, timeToBlockExpire: 60, timeToExpire: 1_200 }, 60_000],
    ])('bounds the backoff of a block with %s', async (_name, record, retryAfterMs) => {
      const storage = {
        increment: jest.fn().mockResolvedValue({ totalHits: 1, isBlocked: true, timeToExpire: 1, ...record }),
      };

      expect(await new SharedManagedRequestBudget(storage).reserveDetailed(ORG, 1)).toEqual({
        accepted: false,
        code: 'BUDGET_EXHAUSTED',
        retryAfterMs,
      });
    });
  });

  describe('the reservation deadline', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const settledFlag = <T>(pending: Promise<T>) => {
      const state = { settled: false };
      pending.then(
        () => (state.settled = true),
        () => (state.settled = true)
      );
      return state;
    };

    it('defaults to five seconds for the whole reservation', () => {
      expect(MANAGED_REQUEST_RESERVATION_TIMEOUT_MS).toBe(5_000);
    });

    it('admits nothing when Redis never answers', async () => {
      const storage = { increment: jest.fn(() => new Promise<never>(() => undefined)) };
      const pending = new SharedManagedRequestBudget(storage).reserveDetailed(ORG, 3);
      const state = settledFlag(pending);

      await jest.advanceTimersByTimeAsync(4_999);
      expect(state.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      expect(await pending).toEqual({ accepted: false, code: 'BUDGET_UNAVAILABLE', retryAfterMs: null });
      // no unit is sent after the first went unanswered
      expect(storage.increment).toHaveBeenCalledTimes(1);
    });

    it('bounds all units together, keeps the units counted late and sends no unit after the deadline', async () => {
      const real = fakeThrottlerStorage();
      const storage = {
        increment: jest.fn(
          (...args: Parameters<typeof real.increment>) =>
            new Promise<Awaited<ReturnType<typeof real.increment>>>((resolve) =>
              setTimeout(() => resolve(real.increment(...args)), 2_000)
            )
        ),
      };

      const pending = new SharedManagedRequestBudget(storage).reserveDetailed(ORG, 5);
      await jest.advanceTimersByTimeAsync(5_000);

      expect(await pending).toEqual({ accepted: false, code: 'BUDGET_UNAVAILABLE', retryAfterMs: null });
      expect(storage.increment).toHaveBeenCalledTimes(3);

      // the third unit is counted after the deadline and stays counted
      await jest.advanceTimersByTimeAsync(2_000);
      expect(real.hits(ORG)).toBe(3);
      expect(storage.increment).toHaveBeenCalledTimes(3);
    });

    it('handles a storage that fails after the deadline', async () => {
      const late = new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Connection is closed.')), 6_000)
      );
      const then = jest.spyOn(late, 'then');
      const storage = { increment: jest.fn(() => late) };

      const pending = new SharedManagedRequestBudget(storage).reserveDetailed(ORG, 1);
      await jest.advanceTimersByTimeAsync(5_000);
      expect((await pending).code).toBe('BUDGET_UNAVAILABLE');
      await jest.advanceTimersByTimeAsync(1_000);

      expect(then.mock.calls.some(([, onRejected]) => typeof onRejected === 'function')).toBe(true);
    });

    it('can be shortened for a caller', async () => {
      const storage = { increment: jest.fn(() => new Promise<never>(() => undefined)) };
      const pending = new SharedManagedRequestBudget(storage, managedRateLimit, 100).reserveDetailed(ORG, 1);
      const state = settledFlag(pending);

      await jest.advanceTimersByTimeAsync(99);
      expect(state.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect((await pending).code).toBe('BUDGET_UNAVAILABLE');
    });

    it('lets an answering storage finish without waiting for the deadline', async () => {
      const storage = fakeThrottlerStorage();
      const result = await new SharedManagedRequestBudget(storage).reserveDetailed(ORG, 5);

      expect(result.accepted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });

    it.each([0, -1, 1.5, Number.NaN, MANAGED_REQUEST_RESERVATION_TIMEOUT_MS + 1])(
      'refuses everything under a deadline of %p without counting anything',
      async (timeoutMs) => {
        const storage = fakeThrottlerStorage();
        const budget = new SharedManagedRequestBudget(storage, managedRateLimit, timeoutMs);

        expect(await budget.reserveDetailed(ORG, 1)).toEqual({
          accepted: false,
          code: 'BUDGET_UNAVAILABLE',
          retryAfterMs: null,
        });
        expect(storage.increment).not.toHaveBeenCalled();
      }
    );
  });

  describe('the default limit', () => {
    const original = process.env.POSTIZ_MANAGED_RATE_LIMIT;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.POSTIZ_MANAGED_RATE_LIMIT;
      } else {
        process.env.POSTIZ_MANAGED_RATE_LIMIT = original;
      }
    });

    it('follows a lowered managed rate limit', async () => {
      process.env.POSTIZ_MANAGED_RATE_LIMIT = '50';
      const storage = fakeThrottlerStorage();
      const budget = new SharedManagedRequestBudget(storage);

      expect(await budget.reserve(ORG, 50)).toBe(true);
      expect(await budget.reserve(ORG, 1)).toBe(false);
      expect(storage.increment.mock.calls.every(([, , limit]) => limit === 50)).toBe(true);
    });

    it('is never raised above the ceiling', async () => {
      process.env.POSTIZ_MANAGED_RATE_LIMIT = '100000';
      const storage = fakeThrottlerStorage();
      const budget = new SharedManagedRequestBudget(storage);

      expect(await budget.reserve(ORG, MANAGED_RATE_LIMIT_MAX)).toBe(true);
      expect(await budget.reserve(ORG, 1)).toBe(false);
      expect(
        storage.increment.mock.calls.every(([, , limit]) => limit === MANAGED_RATE_LIMIT_MAX)
      ).toBe(true);
    });
  });
});
