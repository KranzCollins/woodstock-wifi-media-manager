// The managed publish transport with FAKE ports only: a provider fetch that
// never reaches a network, an admission check and a durable attempt record
// that log their order, and the clock. Every request is synthetic and the
// access token is a FAKE that must never appear in an error or the ledger
import { inspect } from 'util';
import { MANAGED_RATE_LIMIT_MAX } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import {
  ManagedPublishTransport,
  ManagedPublishTransportError,
  ManagedPublishTransportPorts,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.transport';

const SECRET = 'FAKE-ig-access-token-0123456789abcdef';
const IG_USER = '17841400000000001';
const CONTAINER = '17900000000000002';
const CHILD = '17900000000000003';
const MEDIA = '17900000000000004';
const GRAPH = 'https://graph.instagram.com/v21.0';
const TOKEN = `access_token=${SECRET}`;
const CREATE = `${GRAPH}/${IG_USER}/media?image_url=https%3A%2F%2Fmedia.ww.test%2Fa.png&${TOKEN}`;
// the pinned upstream media_publish request
const PUBLISH = `${GRAPH}/${IG_USER}/media_publish?creation_id=${CONTAINER}&${TOKEN}&field=id`;
const STATUS = `${GRAPH}/${CONTAINER}?fields=status_code&${TOKEN}`;
const KIB = 1024;

const NOTHING_SENT = {
  attemptedRequests: 0,
  attemptedMutations: 0,
  completedRequests: 0,
  mutationMayHaveLeft: false,
};

// FAKE provider answer; its headers must never reach the adapter
const answer = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'text/javascript; charset=UTF-8',
      'x-fb-trace-id': 'FAKE-trace',
      'www-authenticate': `OAuth "${SECRET}"`,
    },
  });

// FAKE answer the Response constructor would not build (a status or header a
// broken provider or fetch could still hand over)
const rawAnswer = (
  status: number,
  headers: Record<string, string> = {},
  body: ReadableStream<Uint8Array> | null = null
) => ({ status, headers: new Headers(headers), body } as unknown as Response);

// FAKE body that never ends: one more chunk for every read
const endlessBody = () => {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled++;
      controller.enqueue(new Uint8Array(16 * KIB));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
};

// FAKE body that sends its first bytes and then stalls; its cancellation may
// stall too
const stalledBody = (cancelStalls = false) => {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":'));
    },
    cancel() {
      state.cancelled = true;
      return cancelStalls ? new Promise<void>(() => undefined) : undefined;
    },
  });
  return { body, state };
};

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const refusal = async (pending: Promise<unknown>) => {
  const error = await pending.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(ManagedPublishTransportError);
  return error as ManagedPublishTransportError;
};

const constructionRefusal = (build: () => unknown) => {
  let error: unknown;
  try {
    build();
  } catch (thrown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(ManagedPublishTransportError);
  return error as ManagedPublishTransportError;
};

const expectNoSecret = (value: unknown) => {
  expect(inspect(value, { depth: 10, showHidden: true })).not.toContain(SECRET);
};

// FAKE promise that rejects later; records whether anyone handles it
const lateRejection = <T>(afterMs: number) => {
  const promise = new Promise<T>((_resolve, reject) =>
    setTimeout(() => reject(new Error(`late ${SECRET}`)), afterMs)
  );
  const then = jest.spyOn(promise, 'then');
  return {
    promise,
    handled: () => then.mock.calls.some(([, onRejected]) => typeof onRejected === 'function'),
  };
};

const createPorts = (
  overrides: Partial<Pick<ManagedPublishTransportPorts, 'reservedUnits' | 'deadlineAt' | 'now'>> = {}
) => {
  const events: string[] = [];
  const verifyAdmission = jest.fn(async (_deadlineAt: Date) => {
    events.push('verify');
    return true;
  });
  const recordAttempt = jest.fn(async (ordinal: number, mutation: boolean) => {
    events.push(`record ${ordinal} ${mutation ? 'mutation' : 'read'}`);
    return true;
  });
  const providerFetch = jest.fn<Promise<Response>, Parameters<typeof globalThis.fetch>>(
    async (_input, init) => {
      events.push(`fetch ${init?.method}`);
      return answer({ id: CONTAINER });
    }
  );
  const ports: ManagedPublishTransportPorts = {
    reservedUnits: 4,
    deadlineAt: new Date(Date.now() + 30_000),
    now: () => new Date(),
    verifyAdmission,
    recordAttempt,
    fetch: providerFetch,
    ...overrides,
  };
  return { events, verifyAdmission, recordAttempt, providerFetch, ports };
};

const setup = (overrides: Parameters<typeof createPorts>[0] = {}) => {
  const context = createPorts(overrides);
  return { ...context, transport: new ManagedPublishTransport(context.ports) };
};

describe('ManagedPublishTransport', () => {
  describe('an admitted step', () => {
    it('checks the admission, records the attempt and checks again before every request', async () => {
      const { transport, events, verifyAdmission, recordAttempt, providerFetch, ports } = setup();
      const deadline = ports.deadlineAt.getTime();

      const responses = [
        await transport.fetch(CREATE, { method: 'POST' }),
        await transport.fetch(STATUS),
        await transport.fetch(PUBLISH, { method: 'POST' }),
      ];

      expect(events).toEqual([
        'verify', 'record 1 mutation', 'verify', 'fetch POST',
        'verify', 'record 2 read', 'verify', 'fetch GET',
        'verify', 'record 3 mutation', 'verify', 'fetch POST',
      ]);
      // the exact call row is checked through the deadline of this step, each
      // time on a fresh copy the port cannot use to move the deadline
      const checked = verifyAdmission.mock.calls.map(([deadlineAt]) => deadlineAt);
      expect(checked.map((deadlineAt) => deadlineAt.getTime())).toEqual(Array(6).fill(deadline));
      expect(checked.every((deadlineAt) => deadlineAt !== ports.deadlineAt)).toBe(true);
      expect(new Set(checked).size).toBe(checked.length);
      expect(recordAttempt.mock.calls).toEqual([[1, true], [2, false], [3, true]]);
      expect(providerFetch.mock.calls.map(([input]) => input)).toEqual(
        [CREATE, STATUS, PUBLISH].map((url) => new URL(url).href)
      );
      // the transport owns every option of the outgoing request
      for (const [, init] of providerFetch.mock.calls) {
        expect(Object.keys(init ?? {}).sort()).toEqual(['credentials', 'method', 'redirect', 'signal']);
        expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      }
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: CONTAINER });
      }
      expect(transport.ledger()).toEqual({
        attemptedRequests: 3,
        attemptedMutations: 2,
        completedRequests: 3,
        mutationMayHaveLeft: true,
        failure: null,
      });
    });

    it('hands over only the bounded body as JSON, without provider headers or URL', async () => {
      const { transport } = setup();

      const response = await transport.fetch(STATUS);

      const names: string[] = [];
      response.headers.forEach((_value, name) => names.push(name));
      expect(names).toEqual(['content-type']);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.url).toBe('');
      expectNoSecret(response);
    });

    it('does not count a read-only step as a mutation', async () => {
      const { transport } = setup();

      await transport.fetch(STATUS);
      await transport.fetch(STATUS, { method: 'GET' });

      expect(transport.ledger()).toEqual({
        attemptedRequests: 2,
        attemptedMutations: 0,
        completedRequests: 2,
        mutationMayHaveLeft: false,
        failure: null,
      });
    });

    it('returns an answer without content without a body', async () => {
      const { transport, providerFetch } = setup();
      providerFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const response = await transport.fetch(STATUS);

      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    });

    it('returns the HTTP refusal of a mutation bounded, counts it as possibly sent and halts the step', async () => {
      const { transport, providerFetch, verifyAdmission } = setup();
      const refused = { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } };
      providerFetch.mockResolvedValueOnce(answer(refused, 400));

      const response = await transport.fetch(CREATE, { method: 'POST' });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(refused);
      expect(response.headers.get('www-authenticate')).toBeNull();
      expect(transport.ledger()).toEqual({
        attemptedRequests: 1,
        attemptedMutations: 1,
        completedRequests: 1,
        mutationMayHaveLeft: true,
        failure: 'PROVIDER_REJECTED',
      });
      // no later request of the step leaves, not even a read
      expect((await refusal(transport.fetch(STATUS))).code).toBe('PROVIDER_REJECTED');
      expect((await refusal(transport.fetch(PUBLISH, { method: 'POST' }))).code).toBe('PROVIDER_REJECTED');
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(verifyAdmission).toHaveBeenCalledTimes(2);
    });
  });

  describe('the adapter', () => {
    it('receives one frozen function bound to the step, which shares the ledger', async () => {
      const { transport, providerFetch } = setup();
      const send = transport.adapterFetch();

      expect(transport.adapterFetch()).toBe(send);
      expect(Object.isFrozen(send)).toBe(true);
      expect(Reflect.ownKeys(send).filter((key) => key !== 'length' && key !== 'name')).toEqual([]);
      expect(Reflect.set(send, 'transport', {})).toBe(false);

      // detached from the transport, as an adapter holds it
      const detached = send;
      const response = await detached(STATUS);

      expect(response.status).toBe(200);
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(transport.ledger()).toMatchObject({ attemptedRequests: 1, completedRequests: 1 });
    });

    it('cannot reach the ports, the provider fetch or the ledger state through the transport', () => {
      const { transport } = setup();

      expect(Reflect.ownKeys(transport)).toEqual([]);
      expect(Object.keys(transport)).toEqual([]);
      for (const name of ['ports', 'state', 'tail', 'fetch', 'providerFetch']) {
        expect(Object.getOwnPropertyDescriptor(transport, name)).toBeUndefined();
      }
      expect(inspect(transport, { depth: 10, showHidden: true })).not.toContain('mockConstructor');
    });

    it('cannot pass the transport to the provider fetch as its receiver', async () => {
      const { transport, providerFetch } = setup();
      const receivers: unknown[] = [];
      providerFetch.mockImplementationOnce(function (this: unknown) {
        receivers.push(this);
        return Promise.resolve(answer({ id: CONTAINER }));
      });

      await transport.fetch(STATUS);

      expect(receivers).toEqual([undefined]);
    });
  });

  describe('the ports', () => {
    it('are snapshotted: later changes to the ports object change nothing', async () => {
      const { transport, ports, providerFetch, verifyAdmission, recordAttempt } = setup({ reservedUnits: 1 });
      const deadline = ports.deadlineAt.getTime();
      const otherFetch = jest.fn();
      const otherCheck = jest.fn(async () => true);

      ports.reservedUnits = MANAGED_RATE_LIMIT_MAX;
      ports.deadlineAt.setTime(deadline + 60_000);
      ports.deadlineAt = new Date(deadline + 90_000);
      ports.fetch = otherFetch;
      ports.verifyAdmission = otherCheck;
      ports.recordAttempt = otherCheck;

      await transport.fetch(STATUS);
      expect((await refusal(transport.fetch(STATUS))).code).toBe('RESERVATION_EXHAUSTED');

      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(verifyAdmission).toHaveBeenCalledTimes(2);
      expect(recordAttempt).toHaveBeenCalledTimes(1);
      expect(otherFetch).not.toHaveBeenCalled();
      expect(otherCheck).not.toHaveBeenCalled();
      expect(verifyAdmission.mock.calls.map(([deadlineAt]) => deadlineAt.getTime())).toEqual([
        deadline,
        deadline,
      ]);
    });

    it('cannot move the deadline through the copy the admission check receives', async () => {
      const { transport, verifyAdmission, ports } = setup();
      const deadline = ports.deadlineAt.getTime();
      const received: number[] = [];
      verifyAdmission.mockImplementation(async (deadlineAt: Date) => {
        received.push(deadlineAt.getTime());
        deadlineAt.setTime(deadline + 3_600_000);
        return true;
      });

      await transport.fetch(STATUS);
      await transport.fetch(STATUS);

      // every check sees the step's own deadline, whatever an earlier check did
      expect(received).toEqual(Array(4).fill(deadline));
      expect(new Set(verifyAdmission.mock.calls.map(([deadlineAt]) => deadlineAt)).size).toBe(4);
    });

    it('are read with their own receiver, as a DB implementation needs', async () => {
      const { ports } = createPorts();
      const receivers: unknown[] = [];
      const portsObject: ManagedPublishTransportPorts = {
        ...ports,
        async verifyAdmission() {
          receivers.push(this);
          return true;
        },
        async recordAttempt() {
          receivers.push(this);
          return true;
        },
      };

      await new ManagedPublishTransport(portsObject).fetch(STATUS);

      expect(receivers).toEqual([portsObject, portsObject, portsObject]);
    });

    it.each<[string, Partial<Record<keyof ManagedPublishTransportPorts, unknown>>]>([
      ['a deadline that is not a Date', { deadlineAt: { getTime: () => Date.now() + 30_000 } }],
      ['a clock that is not a function', { now: new Date() }],
      ['no admission check', { verifyAdmission: undefined }],
      ['no attempt record', { recordAttempt: true }],
      ['no provider fetch', { fetch: null }],
    ])('refuse %s', (_name, override) => {
      const { ports } = createPorts();
      expect(
        constructionRefusal(
          () => new ManagedPublishTransport({ ...ports, ...override } as ManagedPublishTransportPorts)
        ).code
      ).toBe('REQUEST_REFUSED');
    });
  });

  describe('concurrent sub-requests (Promise.all in an adapter)', () => {
    it('are sent one at a time, each after the answer of the one before was read', async () => {
      const { transport, providerFetch, recordAttempt } = setup();
      const answers: Array<(response: Response) => void> = [];
      providerFetch.mockImplementation(() => new Promise<Response>((resolve) => answers.push(resolve)));

      const all = Promise.all([
        transport.fetch(STATUS),
        transport.fetch(STATUS),
        transport.fetch(PUBLISH, { method: 'POST' }),
      ]);

      for (let n = 1; n <= 3; n++) {
        await flush();
        expect(providerFetch).toHaveBeenCalledTimes(n);
        answers[n - 1](answer({ n }));
      }

      const responses = await all;
      expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
        { n: 1 },
        { n: 2 },
        { n: 3 },
      ]);
      expect(recordAttempt.mock.calls).toEqual([[1, false], [2, false], [3, true]]);
    });

    it('stop at the first failure: the later ones never leave and the first mutation is kept', async () => {
      const { transport, providerFetch, recordAttempt } = setup();
      providerFetch.mockRejectedValueOnce(new TypeError(`fetch failed ${CREATE}`));

      const results = await Promise.allSettled([
        transport.fetch(CREATE, { method: 'POST' }),
        transport.fetch(STATUS),
        transport.fetch(PUBLISH, { method: 'POST' }),
      ]);

      expect(
        results.map(
          (result) => result.status === 'rejected' && (result.reason as ManagedPublishTransportError).code
        )
      ).toEqual(['TRANSPORT_FAILED', 'TRANSPORT_FAILED', 'TRANSPORT_FAILED']);
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(recordAttempt).toHaveBeenCalledTimes(1);
      // a connection failure is no proof that nothing left
      expect(transport.ledger()).toEqual({
        attemptedRequests: 1,
        attemptedMutations: 1,
        completedRequests: 0,
        mutationMayHaveLeft: true,
        failure: 'TRANSPORT_FAILED',
      });
    });

    it('stop after a refused mutation: its answer is handed over, the later ones never leave', async () => {
      const { transport, providerFetch } = setup();
      providerFetch.mockResolvedValueOnce(answer({ error: { code: 9007 } }, 400));

      const results = await Promise.allSettled([
        transport.fetch(CREATE, { method: 'POST' }),
        transport.fetch(STATUS),
        transport.fetch(PUBLISH, { method: 'POST' }),
      ]);

      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 400 } });
      expect(
        results.slice(1).map((result) => result.status === 'rejected' && result.reason.code)
      ).toEqual(['PROVIDER_REJECTED', 'PROVIDER_REJECTED']);
      expect(providerFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('the sent ledger', () => {
    it('never forgets an earlier mutation when a later read fails', async () => {
      const { transport, providerFetch } = setup();
      await transport.fetch(CREATE, { method: 'POST' });
      providerFetch.mockRejectedValueOnce(new Error('socket hang up'));

      expect((await refusal(transport.fetch(STATUS))).code).toBe('TRANSPORT_FAILED');

      expect(transport.ledger()).toEqual({
        attemptedRequests: 2,
        attemptedMutations: 1,
        completedRequests: 1,
        mutationMayHaveLeft: true,
        failure: 'TRANSPORT_FAILED',
      });
    });

    it('shows no possible mutation only when none was attempted', async () => {
      const { transport, providerFetch } = setup();
      providerFetch.mockRejectedValueOnce(new Error('socket hang up'));

      expect((await refusal(transport.fetch(STATUS))).code).toBe('TRANSPORT_FAILED');

      expect(transport.ledger()).toEqual({
        attemptedRequests: 1,
        attemptedMutations: 0,
        completedRequests: 0,
        mutationMayHaveLeft: false,
        failure: 'TRANSPORT_FAILED',
      });
    });

    it('is an immutable snapshot an adapter cannot rewrite', async () => {
      const { transport } = setup();
      const before = transport.ledger();

      await transport.fetch(CREATE, { method: 'POST' });
      const after = transport.ledger();

      expect(Object.isFrozen(before)).toBe(true);
      expect(Object.isFrozen(after)).toBe(true);
      expect(before).toEqual({ ...NOTHING_SENT, failure: null });
      expect(Reflect.set(after, 'mutationMayHaveLeft', false)).toBe(false);
      expect(Reflect.set(after, 'attemptedMutations', 0)).toBe(false);
      expect(transport.ledger()).toMatchObject({ attemptedMutations: 1, mutationMayHaveLeft: true });
    });

    it('cannot be given a code by a provider or port error', async () => {
      const { transport, providerFetch } = setup();
      providerFetch.mockRejectedValueOnce(new ManagedPublishTransportError('REQUEST_REFUSED'));

      expect((await refusal(transport.fetch(CREATE, { method: 'POST' }))).code).toBe('TRANSPORT_FAILED');
      expect(transport.ledger()).toMatchObject({ mutationMayHaveLeft: true, failure: 'TRANSPORT_FAILED' });
    });
  });

  describe('the reserved units', () => {
    it('bound the requests of the step; one more is refused before any check', async () => {
      const { transport, providerFetch, verifyAdmission, recordAttempt } = setup({ reservedUnits: 2 });
      await transport.fetch(CREATE, { method: 'POST' });
      await transport.fetch(STATUS);

      expect((await refusal(transport.fetch(STATUS))).code).toBe('RESERVATION_EXHAUSTED');

      expect(providerFetch).toHaveBeenCalledTimes(2);
      expect(verifyAdmission).toHaveBeenCalledTimes(4);
      expect(recordAttempt).toHaveBeenCalledTimes(2);
      expect(transport.ledger()).toEqual({
        attemptedRequests: 2,
        attemptedMutations: 1,
        completedRequests: 2,
        mutationMayHaveLeft: true,
        failure: 'RESERVATION_EXHAUSTED',
      });
      // the step stays failed
      expect((await refusal(transport.fetch(STATUS))).code).toBe('RESERVATION_EXHAUSTED');
      expect(providerFetch).toHaveBeenCalledTimes(2);
    });

    it('bound concurrent sub-requests too', async () => {
      const { transport, providerFetch } = setup({ reservedUnits: 2 });

      const results = await Promise.allSettled([STATUS, STATUS, STATUS].map((url) => transport.fetch(url)));

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
      expect(providerFetch).toHaveBeenCalledTimes(2);
    });

    it.each([0, -1, 1.5, Number.NaN, MANAGED_RATE_LIMIT_MAX + 1])(
      'refuse a step reserving %p units',
      (reservedUnits) => {
        const { ports } = setup();
        expect(() => new ManagedPublishTransport({ ...ports, reservedUnits })).toThrow(
          ManagedPublishTransportError
        );
      }
    );

    it('refuse a step without a valid deadline', () => {
      const { ports } = setup();
      expect(
        () => new ManagedPublishTransport({ ...ports, deadlineAt: new Date(Number.NaN) })
      ).toThrow(ManagedPublishTransportError);
    });
  });

  describe('the admission', () => {
    it('lost before the first mutation stops it before the attempt is recorded', async () => {
      const { transport, verifyAdmission, recordAttempt, providerFetch } = setup();
      verifyAdmission.mockResolvedValueOnce(false);

      expect((await refusal(transport.fetch(CREATE, { method: 'POST' }))).code).toBe('ADMISSION_LOST');

      expect(recordAttempt).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
      expect(transport.ledger()).toEqual({ ...NOTHING_SENT, failure: 'ADMISSION_LOST' });
    });

    it('lost while the attempt was recorded stops the request before it leaves', async () => {
      const { transport, verifyAdmission, recordAttempt, providerFetch } = setup();
      verifyAdmission.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      expect((await refusal(transport.fetch(CREATE, { method: 'POST' }))).code).toBe('ADMISSION_LOST');

      expect(recordAttempt.mock.calls).toEqual([[1, true]]);
      expect(providerFetch).not.toHaveBeenCalled();
      expect(transport.ledger()).toEqual({ ...NOTHING_SENT, failure: 'ADMISSION_LOST' });
    });

    it('lost before the second mutation stops it and keeps the first', async () => {
      const { transport, verifyAdmission, providerFetch } = setup();
      await transport.fetch(CREATE, { method: 'POST' });
      verifyAdmission.mockResolvedValueOnce(false);

      expect((await refusal(transport.fetch(PUBLISH, { method: 'POST' }))).code).toBe('ADMISSION_LOST');

      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(transport.ledger()).toEqual({
        attemptedRequests: 1,
        attemptedMutations: 1,
        completedRequests: 1,
        mutationMayHaveLeft: true,
        failure: 'ADMISSION_LOST',
      });
      expect((await refusal(transport.fetch(STATUS))).code).toBe('ADMISSION_LOST');
      expect(providerFetch).toHaveBeenCalledTimes(1);
    });

    it('that cannot be checked counts as lost', async () => {
      const { transport, verifyAdmission, recordAttempt, providerFetch } = setup();
      verifyAdmission.mockRejectedValueOnce(new Error(`deadlock detected ${SECRET}`));

      const error = await refusal(transport.fetch(CREATE, { method: 'POST' }));

      expect(error.code).toBe('ADMISSION_LOST');
      expectNoSecret(error);
      expect(recordAttempt).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
    });

    it.each<[string, unknown]>([
      ['a truthy string', 'true'],
      ['a number', 1],
      ['an object', {}],
      ['nothing', undefined],
    ])('answered with %s instead of true counts as lost', async (_name, admitted) => {
      const { transport, verifyAdmission, recordAttempt, providerFetch } = setup();
      verifyAdmission.mockResolvedValueOnce(admitted as boolean);

      expect((await refusal(transport.fetch(CREATE, { method: 'POST' }))).code).toBe('ADMISSION_LOST');

      expect(recordAttempt).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
    });
  });

  describe('the durable attempt record', () => {
    it('refused keeps the request from leaving', async () => {
      const { transport, recordAttempt, providerFetch } = setup();
      recordAttempt.mockResolvedValueOnce(false);

      expect((await refusal(transport.fetch(CREATE, { method: 'POST' }))).code).toBe('ADMISSION_LOST');

      expect(providerFetch).not.toHaveBeenCalled();
      expect(transport.ledger()).toEqual({ ...NOTHING_SENT, failure: 'ADMISSION_LOST' });
    });

    it('answered with a truthy value other than true keeps the request from leaving', async () => {
      const { transport, recordAttempt, providerFetch } = setup();
      recordAttempt.mockResolvedValueOnce('ok' as unknown as boolean);

      expect((await refusal(transport.fetch(CREATE, { method: 'POST' }))).code).toBe('ADMISSION_LOST');
      expect(providerFetch).not.toHaveBeenCalled();
    });

    it('failing keeps the request from leaving', async () => {
      const { transport, recordAttempt, providerFetch } = setup();
      recordAttempt.mockRejectedValueOnce(new Error(`could not serialize access ${SECRET}`));

      const error = await refusal(transport.fetch(CREATE, { method: 'POST' }));

      expect(error.code).toBe('ADMISSION_LOST');
      expectNoSecret(error);
      expect(providerFetch).not.toHaveBeenCalled();
      expect(transport.ledger()).toEqual({ ...NOTHING_SENT, failure: 'ADMISSION_LOST' });
    });

    it('failing after an earlier mutation keeps that mutation', async () => {
      const { transport, recordAttempt, providerFetch } = setup();
      await transport.fetch(CREATE, { method: 'POST' });
      recordAttempt.mockRejectedValueOnce(new Error('connection terminated'));

      expect((await refusal(transport.fetch(PUBLISH, { method: 'POST' }))).code).toBe('ADMISSION_LOST');

      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(transport.ledger()).toEqual({
        attemptedRequests: 1,
        attemptedMutations: 1,
        completedRequests: 1,
        mutationMayHaveLeft: true,
        failure: 'ADMISSION_LOST',
      });
    });
  });

  describe('redirects, provider errors and retries', () => {
    it('a redirect the fetch refuses fails the step once, without a second request', async () => {
      const { transport, providerFetch } = setup();
      providerFetch.mockRejectedValueOnce(
        new TypeError('fetch failed', { cause: new Error(`redirect mode is set to error: ${CREATE}`) })
      );

      const error = await refusal(transport.fetch(CREATE, { method: 'POST' }));

      expect(error.code).toBe('TRANSPORT_FAILED');
      expectNoSecret(error);
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(transport.ledger()).toMatchObject({ attemptedMutations: 1, mutationMayHaveLeft: true });
    });

    it('a redirect answer to a read is never followed and its location never handed over', async () => {
      const { transport, providerFetch } = setup();
      providerFetch.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: `https://evil.test/${SECRET}` } })
      );

      const response = await transport.fetch(STATUS);

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBeNull();
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(transport.ledger().failure).toBeNull();
    });

    it.each([302, 400, 401, 404, 429, 500, 503])(
      'a mutation answered %p is handed over once, never retried, and halts the step',
      async (status) => {
        const { transport, providerFetch, recordAttempt } = setup();
        providerFetch.mockResolvedValueOnce(
          status === 302
            ? new Response(null, { status, headers: { location: `https://evil.test/${SECRET}` } })
            : answer({ error: { code: 2, is_transient: true } }, status)
        );

        const response = await transport.fetch(PUBLISH, { method: 'POST' });

        expect(response.status).toBe(status);
        expect(response.headers.get('location')).toBeNull();
        expect(transport.ledger()).toEqual({
          attemptedRequests: 1,
          attemptedMutations: 1,
          completedRequests: 1,
          mutationMayHaveLeft: true,
          failure: 'PROVIDER_REJECTED',
        });
        // the adapter asking again is refused before anything leaves
        expect((await refusal(transport.fetch(PUBLISH, { method: 'POST' }))).code).toBe(
          'PROVIDER_REJECTED'
        );
        expect((await refusal(transport.fetch(STATUS))).code).toBe('PROVIDER_REJECTED');
        expect(providerFetch).toHaveBeenCalledTimes(1);
        expect(recordAttempt).toHaveBeenCalledTimes(1);
      }
    );

    it.each([429, 500, 503])(
      'a read answered %p is handed over once, never retried, and halts the step',
      async (status) => {
        const { transport, providerFetch } = setup();
        providerFetch.mockResolvedValueOnce(answer({ error: { code: 4 } }, status));

        const response = await transport.fetch(STATUS);

        expect(response.status).toBe(status);
        expect(transport.ledger()).toEqual({
          attemptedRequests: 1,
          attemptedMutations: 0,
          completedRequests: 1,
          mutationMayHaveLeft: false,
          failure: 'PROVIDER_REJECTED',
        });
        expect((await refusal(transport.fetch(STATUS))).code).toBe('PROVIDER_REJECTED');
        expect(providerFetch).toHaveBeenCalledTimes(1);
      }
    );

    it.each([400, 404])('a read answered %p is handed over and the step goes on', async (status) => {
      const { transport, providerFetch } = setup();
      providerFetch.mockResolvedValueOnce(answer({ error: { code: 100 } }, status));

      expect((await transport.fetch(STATUS)).status).toBe(status);
      expect((await transport.fetch(PUBLISH, { method: 'POST' })).status).toBe(200);

      expect(providerFetch).toHaveBeenCalledTimes(2);
      expect(transport.ledger().failure).toBeNull();
    });

    it.each([200, 201])('a mutation answered %p lets the step go on', async (status) => {
      const { transport, providerFetch } = setup();
      providerFetch.mockResolvedValueOnce(answer({ id: CONTAINER }, status));

      await transport.fetch(CREATE, { method: 'POST' });
      await transport.fetch(STATUS);

      expect(providerFetch).toHaveBeenCalledTimes(2);
      expect(transport.ledger().failure).toBeNull();
    });
  });

  describe('the closed set of requests', () => {
    // every request the pinned InstagramProvider sends to graph.instagram.com
    const ALLOWED: Array<[string, string, 'GET' | 'POST']> = [
      ['a container status', STATUS, 'GET'],
      ['a container status with its message', `${GRAPH}/${CONTAINER}?${TOKEN}&fields=status_code,status`, 'GET'],
      ['a permalink', `${GRAPH}/${MEDIA}?fields=permalink&${TOKEN}`, 'GET'],
      ['the newest media probe', `${GRAPH}/${IG_USER}/media?fields=id&limit=1&${TOKEN}`, 'GET'],
      ['an image container', CREATE, 'POST'],
      [
        'an image container with every image option',
        `${GRAPH}/${IG_USER}/media?image_url=https://media.ww.test/a.png&alt_text=a%20cat&collaborators=%5B%22ww%22%5D&${TOKEN}&caption=hello%20world`,
        'POST',
      ],
      [
        'a reel with a cover',
        `${GRAPH}/${IG_USER}/media?video_url=https://media.ww.test/a.mp4&media_type=REELS&cover_url=https%3A%2F%2Fmedia.ww.test%2Fc.png&trial_params=%7B%7D&${TOKEN}&caption=`,
        'POST',
      ],
      [
        'a carousel video item',
        `${GRAPH}/${IG_USER}/media?video_url=https://media.ww.test/a.mp4&media_type=VIDEO&thumb_offset=0&is_carousel_item=true&${TOKEN}`,
        'POST',
      ],
      ['a story', `${GRAPH}/${IG_USER}/media?image_url=https://media.ww.test/a.png&media_type=STORIES&${TOKEN}`, 'POST'],
      [
        'a carousel container',
        `${GRAPH}/${IG_USER}/media?caption=hi&media_type=CAROUSEL&children=${CONTAINER}%2C${CHILD}&${TOKEN}`,
        'POST',
      ],
      ['a publish', PUBLISH, 'POST'],
      ['a comment', `${GRAPH}/${MEDIA}/comments?message=nice&${TOKEN}`, 'POST'],
    ];

    it.each(ALLOWED)('sends %s', async (_name, input, method) => {
      const { transport, providerFetch, recordAttempt } = setup();

      await transport.fetch(input, method === 'POST' ? { method } : {});

      expect(providerFetch.mock.calls).toEqual([[new URL(input).href, expect.objectContaining({ method })]]);
      expect(recordAttempt.mock.calls).toEqual([[1, method === 'POST']]);
    });

    const OUTSIDE: Array<[string, string, RequestInit]> = [
      ['no URL', 'graph.instagram.com/v21.0/me', {}],
      ['a relative URL', '//graph.instagram.com/v21.0/me', {}],
      ['plain http', `http://graph.instagram.com/v21.0/me?access_token=${SECRET}`, {}],
      ['a local file', 'file:///v21.0/me', {}],
      ['another Graph host', `https://graph.facebook.com/v21.0/me?access_token=${SECRET}`, {}],
      ['the Facebook Graph host with a valid route', STATUS.replace('graph.instagram.com', 'graph.facebook.com'), {}],
      ['a look-alike host', 'https://graph.instagram.com.evil.test/v21.0/me', {}],
      ['an upper-case host', STATUS.replace('graph.instagram.com', 'GRAPH.instagram.com'), {}],
      ['an address', 'https://127.0.0.1/v21.0/me', {}],
      ['a port', 'https://graph.instagram.com:8443/v21.0/me', {}],
      ['the default port written out', STATUS.replace('graph.instagram.com', 'graph.instagram.com:443'), {}],
      ['credentials in the URL', 'https://ig:pw@graph.instagram.com/v21.0/me', {}],
      ['a fragment', `https://graph.instagram.com/v21.0/me#access_token=${SECRET}`, {}],
      ['an empty fragment', `${STATUS}#`, {}],
      ['an unversioned path', 'https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token', {}],
      ['a path leaving the version', 'https://graph.instagram.com/v21.0/../oauth/access_token', {}],
      ['a dot segment', `${GRAPH}/./${CONTAINER}?fields=status_code&${TOKEN}`, {}],
      ['a backslash', `${GRAPH}\\${CONTAINER}?fields=status_code&${TOKEN}`, {}],
      ['a tab in the path', `${GRAPH}/${CONTAINER.slice(0, 4)}\t${CONTAINER.slice(4)}?fields=status_code&${TOKEN}`, {}],
      ['a newline in the query', `${STATUS}\n&fields=permalink`, {}],
      ['a space', `${GRAPH}/${CONTAINER}?fields=status_code&${TOKEN}&caption=a b`, {}],
      ['an encoded separator', 'https://graph.instagram.com/v21.0/me%2Fmedia', {}],
      ['a file name', 'https://graph.instagram.com/v21.0/me/media.json', {}],
      ['an empty path', 'https://graph.instagram.com/v21.0/', {}],
      ['a named node', `${GRAPH}/me?fields=status_code&${TOKEN}`, {}],
      ['an empty node', `${GRAPH}//media?image_url=https://media.ww.test/a.png&${TOKEN}`, {}],
      ['a trailing slash', `${GRAPH}/${CONTAINER}/?fields=status_code&${TOKEN}`, {}],
      ['a malformed version', `https://graph.instagram.com/v21/${CONTAINER}?fields=status_code&${TOKEN}`, {}],
      ['an extra edge', `${GRAPH}/${IG_USER}/media/${CONTAINER}?fields=id&limit=1&${TOKEN}`, {}],
      ['an edge after comments', `${GRAPH}/${MEDIA}/comments/${CONTAINER}?message=x&${TOKEN}`, { method: 'POST' }],
      ['another edge', `${GRAPH}/${IG_USER}/insights?metric=reach&${TOKEN}`, {}],
      ['the token refresh', `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&${TOKEN}`, {}],
      ['an overlong URL', `${STATUS}&q=${'a'.repeat(1024 * KIB)}`, {}],
      // methods per route
      ['DELETE', PUBLISH, { method: 'DELETE' }],
      ['DELETE of a media', `${GRAPH}/${MEDIA}?${TOKEN}`, { method: 'DELETE' }],
      ['PUT', PUBLISH, { method: 'PUT' }],
      ['HEAD', STATUS, { method: 'HEAD' }],
      ['a lower-case method', STATUS, { method: 'post' }],
      ['a POST to a node', `${GRAPH}/${MEDIA}?fields=permalink&${TOKEN}`, { method: 'POST' }],
      ['a GET of media_publish', PUBLISH, {}],
      ['a GET of comments', `${GRAPH}/${MEDIA}/comments?message=nice&${TOKEN}`, {}],
      ['a GET of a container creation', CREATE, {}],
      ['a POST to the newest media probe', `${GRAPH}/${IG_USER}/media?fields=id&limit=1&${TOKEN}`, { method: 'POST' }],
      // query keys and values
      ['no token', `${GRAPH}/${CONTAINER}?fields=status_code`, {}],
      ['an empty token', `${GRAPH}/${CONTAINER}?fields=status_code&access_token=`, {}],
      ['a second token', `${STATUS}&access_token=other`, {}],
      ['an encoded second token', `${STATUS}&acc%65ss_token=other`, {}],
      ['a second field list', `${STATUS}&fields=permalink`, {}],
      ['no query', `${GRAPH}/${CONTAINER}`, {}],
      ['other node fields', `${GRAPH}/${CONTAINER}?fields=id,username&${TOKEN}`, {}],
      ['no node fields', `${GRAPH}/${CONTAINER}?${TOKEN}`, {}],
      ['an unknown key', `${STATUS}&debug=all`, {}],
      ['a key from the prototype', `${STATUS}&constructor=x`, {}],
      ['a prototype key', `${STATUS}&__proto__=x`, {}],
      ['a wider newest media probe', `${GRAPH}/${IG_USER}/media?fields=id&limit=2&${TOKEN}`, {}],
      ['a newest media probe without limit', `${GRAPH}/${IG_USER}/media?fields=id&${TOKEN}`, {}],
      ['a newest media probe for captions', `${GRAPH}/${IG_USER}/media?fields=id,caption&limit=1&${TOKEN}`, {}],
      ['a paged newest media probe', `${GRAPH}/${IG_USER}/media?fields=id&limit=1&after=x&${TOKEN}`, {}],
      ['a creation without token', `${GRAPH}/${IG_USER}/media?image_url=https://media.ww.test/a.png`, { method: 'POST' }],
      ['an audio configuration', `${CREATE}&audio_configuration=%7B%7D`, { method: 'POST' }],
      ['another media type', `${CREATE}&media_type=IMAGE`, { method: 'POST' }],
      ['a carousel flag value', `${CREATE}&is_carousel_item=1`, { method: 'POST' }],
      ['a single carousel child', `${GRAPH}/${IG_USER}/media?media_type=CAROUSEL&children=${CHILD}&${TOKEN}`, { method: 'POST' }],
      ['named carousel children', `${GRAPH}/${IG_USER}/media?media_type=CAROUSEL&children=a%2Cb&${TOKEN}`, { method: 'POST' }],
      ['a duplicate caption', `${CREATE}&caption=a&caption=b`, { method: 'POST' }],
      ['a publish without field', `${GRAPH}/${IG_USER}/media_publish?creation_id=${CONTAINER}&${TOKEN}`, { method: 'POST' }],
      ['a publish of other fields', `${PUBLISH.replace('field=id', 'field=permalink')}`, { method: 'POST' }],
      ['a publish without container', `${GRAPH}/${IG_USER}/media_publish?${TOKEN}&field=id`, { method: 'POST' }],
      ['a publish of a named container', `${GRAPH}/${IG_USER}/media_publish?creation_id=me&${TOKEN}&field=id`, { method: 'POST' }],
      ['a publish with a caption', `${PUBLISH}&caption=x`, { method: 'POST' }],
      ['a comment without message', `${GRAPH}/${MEDIA}/comments?${TOKEN}`, { method: 'POST' }],
      ['a comment reply option', `${GRAPH}/${MEDIA}/comments?message=x&${TOKEN}&reply_to=1`, { method: 'POST' }],
      // request options
      ['a body', CREATE, { method: 'POST', body: 'caption=hello' }],
      ['headers', STATUS, { headers: { authorization: `Bearer ${SECRET}` } }],
      ['empty headers', STATUS, { headers: {} }],
      ['a redirect mode', STATUS, { redirect: 'follow' }],
      ['a credentials mode', STATUS, { credentials: 'include' }],
      ['a caller signal', STATUS, { signal: new AbortController().signal }],
      ['keepalive', STATUS, { keepalive: true }],
      ['a cache mode', STATUS, { cache: 'no-store' }],
    ];

    // Review finding P1 (2026-11-05), closed: the Graph API documents a
    // `method` query parameter and batching, so the verb the transport
    // classifies (GET = read) would not be the verb the provider runs
    const OVERRIDES: Array<[string, string, RequestInit]> = [
      ['a GET the provider would run as a POST', `${STATUS}&method=post`, {}],
      ['a POST the provider would run as a DELETE', `${PUBLISH}&method=delete`, { method: 'POST' }],
      ['an upper-case override', `${STATUS}&METHOD=POST`, {}],
      ['an underscore override', `${PUBLISH}&_method=DELETE`, { method: 'POST' }],
      ['a mixed-case underscore override', `${STATUS}&_Method=post`, {}],
      ['an encoded override', `${STATUS}&%6Dethod=post`, {}],
      ['an override before the token', `${GRAPH}/${CONTAINER}?method=delete&fields=status_code&${TOKEN}`, {}],
      ['a batch', `${GRAPH}/${IG_USER}/media_publish?batch=%5B%5D&${TOKEN}&field=id&creation_id=${CONTAINER}`, { method: 'POST' }],
      ['an upper-case batch', `${PUBLISH}&BATCH=%5B%5D`, { method: 'POST' }],
    ];

    it.each([...OUTSIDE, ...OVERRIDES])(
      'refuses %s with no check, record or outbound request, for the rest of the step',
      async (_name, input, options) => {
        const { transport, verifyAdmission, recordAttempt, providerFetch } = setup();

        const error = await refusal(transport.fetch(input, options));

        expect(error.code).toBe('REQUEST_REFUSED');
        expectNoSecret(error);
        expect(verifyAdmission).not.toHaveBeenCalled();
        expect(recordAttempt).not.toHaveBeenCalled();
        expect(providerFetch).not.toHaveBeenCalled();
        expect(transport.ledger()).toEqual({ ...NOTHING_SENT, failure: 'REQUEST_REFUSED' });
        expect((await refusal(transport.fetch(STATUS))).code).toBe('REQUEST_REFUSED');
        expect(providerFetch).not.toHaveBeenCalled();
      }
    );

    it.each<[string, unknown, unknown]>([
      ['a URL object', new URL(STATUS), {}],
      ['a request object', { url: STATUS }, {}],
      ['no input', undefined, {}],
      ['null options', STATUS, null],
      ['string options', STATUS, 'POST'],
      [
        'options that throw',
        STATUS,
        new Proxy(
          {},
          {
            get() {
              throw new Error(SECRET);
            },
          }
        ),
      ],
      [
        'options that list keys by throwing',
        STATUS,
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error(SECRET);
            },
          }
        ),
      ],
    ])('refuses %s without letting an error escape', async (_name, input, options) => {
      const { transport, providerFetch, verifyAdmission } = setup();

      const error = await refusal(
        transport.fetch(input as string, options as RequestInit)
      );

      expect(error.code).toBe('REQUEST_REFUSED');
      expectNoSecret(error);
      expect(verifyAdmission).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
    });
  });

  describe('a provider or port error', () => {
    const FAILURES: Array<[string, (context: ReturnType<typeof setup>) => void, string]> = [
      [
        'a rejected fetch',
        ({ providerFetch }) => providerFetch.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${CREATE}`)),
        'TRANSPORT_FAILED',
      ],
      [
        'a fetch that throws',
        ({ providerFetch }) =>
          providerFetch.mockImplementationOnce(() => {
            throw new Error(SECRET);
          }),
        'TRANSPORT_FAILED',
      ],
      [
        'a fetch that answers nothing',
        ({ providerFetch }) => providerFetch.mockResolvedValueOnce(undefined as unknown as Response),
        'TRANSPORT_FAILED',
      ],
      [
        'a status no answer may have',
        ({ providerFetch }) => providerFetch.mockResolvedValueOnce(rawAnswer(101, { 'x-token': SECRET })),
        'TRANSPORT_FAILED',
      ],
      [
        'headers that throw',
        ({ providerFetch }) =>
          providerFetch.mockResolvedValueOnce({
            status: 200,
            headers: {
              get: () => {
                throw new Error(SECRET);
              },
            },
            body: null,
          } as unknown as Response),
        'TRANSPORT_FAILED',
      ],
      [
        'a body that cannot be opened',
        ({ providerFetch }) =>
          providerFetch.mockResolvedValueOnce({
            status: 200,
            headers: new Headers(),
            body: {
              getReader: () => {
                throw new Error(SECRET);
              },
            },
          } as unknown as Response),
        'TRANSPORT_FAILED',
      ],
      [
        'a body that fails while read',
        ({ providerFetch }) =>
          providerFetch.mockResolvedValueOnce(
            rawAnswer(
              200,
              {},
              new ReadableStream<Uint8Array>({
                pull: (controller) => controller.error(new Error(SECRET)),
              })
            )
          ),
        'TRANSPORT_FAILED',
      ],
      [
        'a body that yields something other than bytes',
        ({ providerFetch }) =>
          providerFetch.mockResolvedValueOnce(
            rawAnswer(
              200,
              {},
              new ReadableStream({
                start: (controller) => controller.enqueue(SECRET),
              }) as ReadableStream<Uint8Array>
            )
          ),
        'TRANSPORT_FAILED',
      ],
      [
        'a failing admission check',
        ({ verifyAdmission }) => verifyAdmission.mockRejectedValueOnce(new Error(SECRET)),
        'ADMISSION_LOST',
      ],
      [
        'an admission check that throws',
        ({ verifyAdmission }) =>
          verifyAdmission.mockImplementationOnce(() => {
            throw new Error(SECRET);
          }),
        'ADMISSION_LOST',
      ],
      [
        'a failing attempt record',
        ({ recordAttempt }) => recordAttempt.mockRejectedValueOnce(new Error(SECRET)),
        'ADMISSION_LOST',
      ],
    ];

    it.each(FAILURES)('%s never escapes raw and never carries the token', async (_name, arrange, code) => {
      const context = setup();
      arrange(context);

      const error = await refusal(context.transport.fetch(CREATE, { method: 'POST' }));

      expect(error.code).toBe(code);
      expect(error.message).toBe(code);
      expect(error.cause).toBeUndefined();
      expectNoSecret(error);
      expectNoSecret(context.transport.ledger());
    });
  });

  describe('the answer size', () => {
    it('hands over an answer within the bound intact', async () => {
      const { transport, providerFetch } = setup();
      const bytes = new Uint8Array(16 * KIB).map((_, i) => i % 251);
      providerFetch.mockResolvedValueOnce(new Response(bytes));

      const response = await transport.fetch(STATUS);

      expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    });

    it('refuses an answer that announces more than the bound, without handing anything over, and cancels its body', async () => {
      const { transport, providerFetch } = setup();
      const { body, state } = endlessBody();
      providerFetch.mockResolvedValueOnce(rawAnswer(200, { 'content-length': String(1024 * KIB) }, body));

      expect((await refusal(transport.fetch(STATUS))).code).toBe('RESPONSE_TOO_LARGE');

      expect(transport.ledger()).toEqual({
        attemptedRequests: 1,
        attemptedMutations: 0,
        completedRequests: 0,
        mutationMayHaveLeft: false,
        failure: 'RESPONSE_TOO_LARGE',
      });
      await flush();
      expect(state.cancelled).toBe(true);
    });

    it('cancels the body of an answer refused for its status', async () => {
      const { transport, providerFetch } = setup();
      const { body, state } = endlessBody();
      providerFetch.mockResolvedValueOnce(rawAnswer(101, {}, body));

      expect((await refusal(transport.fetch(STATUS))).code).toBe('TRANSPORT_FAILED');

      await flush();
      expect(state.cancelled).toBe(true);
    });

    it.each(['1e3', '-1', '0x10', '1.5', '99999999999999999'])(
      'refuses an answer with a content-length of %p',
      async (length) => {
        const { transport, providerFetch } = setup();
        providerFetch.mockResolvedValueOnce(rawAnswer(200, { 'content-length': length }));

        expect((await refusal(transport.fetch(STATUS))).code).toBe('RESPONSE_TOO_LARGE');
      }
    );

    it('stops reading an answer that does not end, and cancels it', async () => {
      const { transport, providerFetch } = setup();
      const { body, state } = endlessBody();
      providerFetch.mockResolvedValueOnce(new Response(body));

      expect((await refusal(transport.fetch(STATUS))).code).toBe('RESPONSE_TOO_LARGE');

      await flush();
      expect(state.cancelled).toBe(true);
      // far fewer chunks than the 1 MiB a reader without a bound would take
      expect(state.pulled).toBeLessThan(64);
      expect(transport.ledger().completedRequests).toBe(0);
    });

    it('bounds the HTTP error answer of a mutation the same way', async () => {
      const { transport, providerFetch } = setup();
      providerFetch.mockResolvedValueOnce(new Response(new Uint8Array(1024 * KIB), { status: 500 }));

      expect((await refusal(transport.fetch(PUBLISH, { method: 'POST' }))).code).toBe(
        'RESPONSE_TOO_LARGE'
      );

      expect(transport.ledger()).toMatchObject({
        attemptedMutations: 1,
        completedRequests: 0,
        mutationMayHaveLeft: true,
        failure: 'RESPONSE_TOO_LARGE',
      });
    });
  });

  describe('the deadline', () => {
    const NOW = new Date('2026-11-05T12:00:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it.each<[string, number]>([
      ['has passed', -1],
      ['is now', 0],
      ['lies just beyond the bound of one step', 120_001],
      ['lies far beyond the bound of one step', 3_600_000],
    ])('refuses a step whose deadline %s when it is built, with no check or outbound request', (_name, offset) => {
      const { ports, verifyAdmission, recordAttempt, providerFetch } = createPorts();

      const error = constructionRefusal(
        () => new ManagedPublishTransport({ ...ports, deadlineAt: new Date(NOW.getTime() + offset) })
      );

      expect(error.code).toBe('DEADLINE_EXPIRED');
      expect(verifyAdmission).not.toHaveBeenCalled();
      expect(recordAttempt).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
    });

    it.each([1, 120_000])('accepts a step whose deadline lies %pms ahead', async (offset) => {
      const { transport, providerFetch } = setup({ deadlineAt: new Date(NOW.getTime() + offset) });

      await transport.fetch(STATUS);

      expect(providerFetch).toHaveBeenCalledTimes(1);
    });

    it('refuses a step whose deadline passed after it was built, with no check or outbound request', async () => {
      const { transport, verifyAdmission, providerFetch, ports } = setup();
      jest.setSystemTime(ports.deadlineAt.getTime());

      expect((await refusal(transport.fetch(CREATE, { method: 'POST' }))).code).toBe('DEADLINE_EXPIRED');

      expect(verifyAdmission).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
      expect(transport.ledger()).toEqual({ ...NOTHING_SENT, failure: 'DEADLINE_EXPIRED' });
    });

    it.each<[string, () => Date]>([
      ['cannot be read', () => new Date(Number.NaN)],
      ['throws', () => {
        throw new Error(SECRET);
      }],
      ['is not a Date', () => ({ getTime: () => NOW.getTime() } as unknown as Date)],
    ])('refuses a step whose clock %s', (_name, now) => {
      const { ports, providerFetch } = createPorts({ now });

      const error = constructionRefusal(() => new ManagedPublishTransport(ports));

      expect(error.code).toBe('DEADLINE_EXPIRED');
      expectNoSecret(error);
      expect(providerFetch).not.toHaveBeenCalled();
    });

    it('stops a step whose clock fails later', async () => {
      let readable = true;
      const { transport, providerFetch } = setup({
        now: () => (readable ? new Date() : new Date(Number.NaN)),
      });
      readable = false;

      expect((await refusal(transport.fetch(STATUS))).code).toBe('DEADLINE_EXPIRED');
      expect(providerFetch).not.toHaveBeenCalled();
    });

    it('that passes while the admission is checked stops the step before the attempt is recorded', async () => {
      const { transport, verifyAdmission, recordAttempt, providerFetch, ports } = setup();
      verifyAdmission.mockImplementationOnce(async () => {
        jest.setSystemTime(ports.deadlineAt.getTime() + 1);
        return true;
      });

      expect((await refusal(transport.fetch(CREATE, { method: 'POST' }))).code).toBe('DEADLINE_EXPIRED');

      expect(recordAttempt).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
    });

    it('that passes while the attempt is recorded stops the request before it leaves', async () => {
      const { transport, recordAttempt, providerFetch, ports } = setup();
      recordAttempt.mockImplementationOnce(async () => {
        jest.setSystemTime(ports.deadlineAt.getTime() + 1);
        return true;
      });

      expect((await refusal(transport.fetch(CREATE, { method: 'POST' }))).code).toBe('DEADLINE_EXPIRED');

      expect(providerFetch).not.toHaveBeenCalled();
      expect(transport.ledger()).toEqual({ ...NOTHING_SENT, failure: 'DEADLINE_EXPIRED' });
    });

    it.each<[string, (context: ReturnType<typeof setup>) => void, number]>([
      ['the first admission check', ({ verifyAdmission }) =>
        verifyAdmission.mockImplementationOnce(() => new Promise<boolean>(() => undefined)), 0],
      ['the attempt record', ({ recordAttempt }) =>
        recordAttempt.mockImplementationOnce(() => new Promise<boolean>(() => undefined)), 1],
      ['the second admission check', ({ verifyAdmission }) =>
        verifyAdmission
          .mockImplementationOnce(async () => true)
          .mockImplementationOnce(() => new Promise<boolean>(() => undefined)), 1],
    ])('ends %s that never answers at the deadline, before anything leaves', async (_name, arrange, records) => {
      const context = setup();
      arrange(context);

      let settled = false;
      const pending = context.transport.fetch(CREATE, { method: 'POST' });
      const refused = refusal(pending);
      pending.then(() => (settled = true), () => (settled = true));
      await flush();

      await jest.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      expect((await refused).code).toBe('DEADLINE_EXPIRED');
      expect(context.recordAttempt).toHaveBeenCalledTimes(records);
      expect(context.providerFetch).not.toHaveBeenCalled();
      expect(context.transport.ledger()).toEqual({ ...NOTHING_SENT, failure: 'DEADLINE_EXPIRED' });
    });

    it('handles an admission check that fails after the deadline', async () => {
      const { transport, verifyAdmission, recordAttempt } = setup();
      const late = lateRejection<boolean>(31_000);
      verifyAdmission.mockReturnValueOnce(late.promise);

      const refused = refusal(transport.fetch(CREATE, { method: 'POST' }));
      await flush();
      await jest.advanceTimersByTimeAsync(30_000);
      const error = await refused;
      await jest.advanceTimersByTimeAsync(1_000);

      expect(error.code).toBe('DEADLINE_EXPIRED');
      expect(late.handled()).toBe(true);
      expect(recordAttempt).not.toHaveBeenCalled();
      expectNoSecret(error);
    });

    it('handles a fetch that fails after the deadline', async () => {
      const { transport, providerFetch } = setup();
      const late = lateRejection<Response>(31_000);
      providerFetch.mockReturnValueOnce(late.promise);

      const refused = refusal(transport.fetch(CREATE, { method: 'POST' }));
      await flush();
      await jest.advanceTimersByTimeAsync(30_000);
      const error = await refused;
      await jest.advanceTimersByTimeAsync(1_000);

      expect(error.code).toBe('DEADLINE_EXPIRED');
      expect(late.handled()).toBe(true);
      expect(transport.ledger()).toMatchObject({ mutationMayHaveLeft: true, failure: 'DEADLINE_EXPIRED' });
    });

    it('aborts a fetch that never answers, and counts the mutation as possibly sent', async () => {
      const { transport, providerFetch } = setup();
      providerFetch.mockImplementationOnce(() => new Promise<Response>(() => undefined));

      let settled = false;
      const pending = transport.fetch(CREATE, { method: 'POST' });
      const refused = refusal(pending);
      const settle = () => {
        settled = true;
      };
      pending.then(settle, settle);
      await flush();
      expect(providerFetch).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      expect((await refused).code).toBe('DEADLINE_EXPIRED');
      expect(providerFetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(transport.ledger()).toEqual({
        attemptedRequests: 1,
        attemptedMutations: 1,
        completedRequests: 0,
        mutationMayHaveLeft: true,
        failure: 'DEADLINE_EXPIRED',
      });
    });

    it('measures the deadline from the step, not from the request: slow checks shorten the fetch', async () => {
      const { transport, verifyAdmission, providerFetch } = setup();
      verifyAdmission.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20_000))
      );
      providerFetch.mockImplementationOnce(() => new Promise<Response>(() => undefined));

      let settled = false;
      const pending = transport.fetch(STATUS);
      const refused = refusal(pending);
      pending.then(() => (settled = true), () => (settled = true));
      await flush();

      await jest.advanceTimersByTimeAsync(20_000);
      await flush();
      expect(providerFetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      expect((await refused).code).toBe('DEADLINE_EXPIRED');
    });

    it('cancels the body of an answer that arrives after the deadline', async () => {
      const { transport, providerFetch } = setup();
      const { body, state } = stalledBody();
      providerFetch.mockImplementationOnce(
        () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(body)), 31_000))
      );

      const refused = refusal(transport.fetch(STATUS));
      await flush();
      await jest.advanceTimersByTimeAsync(30_000);
      expect((await refused).code).toBe('DEADLINE_EXPIRED');

      await jest.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(state.cancelled).toBe(true);
    });

    it('reports the deadline, not the abort error of a fetch that honours the signal', async () => {
      const { transport, providerFetch } = setup();
      providerFetch.mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException(`aborted ${SECRET}`, 'AbortError'))
            );
          })
      );

      const refused = refusal(transport.fetch(STATUS));
      await flush();
      await jest.advanceTimersByTimeAsync(30_000);

      const error = await refused;
      expect(error.code).toBe('DEADLINE_EXPIRED');
      expectNoSecret(error);
    });

    it('aborts an answer whose body stalls, and cancels the body', async () => {
      const { transport, providerFetch } = setup();
      const { body, state } = stalledBody();
      providerFetch.mockResolvedValueOnce(new Response(body));

      const refused = refusal(transport.fetch(STATUS));
      await flush();
      await jest.advanceTimersByTimeAsync(30_000);

      expect((await refused).code).toBe('DEADLINE_EXPIRED');
      await flush();
      expect(state.cancelled).toBe(true);
      expect(transport.ledger()).toEqual({
        attemptedRequests: 1,
        attemptedMutations: 0,
        completedRequests: 0,
        mutationMayHaveLeft: false,
        failure: 'DEADLINE_EXPIRED',
      });
    });

    it('does not wait for a body cancellation that stalls', async () => {
      const { transport, providerFetch } = setup();
      const { body, state } = stalledBody(true);
      providerFetch.mockResolvedValueOnce(new Response(body));

      let settled = false;
      const pending = transport.fetch(STATUS);
      const refused = refusal(pending);
      pending.then(() => (settled = true), () => (settled = true));
      await flush();
      await jest.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      expect((await refused).code).toBe('DEADLINE_EXPIRED');
      await flush();
      expect(state.cancelled).toBe(true);
    });

    it('does not hand over an answer that arrived after the deadline', async () => {
      const { transport, providerFetch, ports } = setup();
      providerFetch.mockImplementationOnce(async () => {
        jest.setSystemTime(ports.deadlineAt.getTime() + 1);
        return answer({ id: CONTAINER });
      });

      expect((await refusal(transport.fetch(PUBLISH, { method: 'POST' }))).code).toBe('DEADLINE_EXPIRED');

      expect(transport.ledger()).toEqual({
        attemptedRequests: 1,
        attemptedMutations: 1,
        completedRequests: 0,
        mutationMayHaveLeft: true,
        failure: 'DEADLINE_EXPIRED',
      });
    });
  });
});
