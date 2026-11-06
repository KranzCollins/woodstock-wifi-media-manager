// ManagedService (loaded for identityFingerprint and the qualify step) pulls
// in the media helpers; no storage or sniffer is used in this spec
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({}));
jest.mock(
  'file-type',
  () => ({ fileTypeStream: jest.fn(), fileTypeFromBuffer: jest.fn() }),
  { virtual: true }
);

import { createHash } from 'crypto';
import { FakePrismaDb } from './fakes/fake.prisma.db';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import {
  identityFingerprint,
  ManagedService,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { managedWriteFence } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.write.fence';
import { ManagedWriteRefusedError } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';
import { ManagedConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.repository';
import {
  MANAGED_CONNECTION_LEASE_MS,
  ManagedConnectionService,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.service';
import {
  ManagedConnectionGrant,
  ManagedConnectionProvider,
  ManagedConnectionProviderError,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.provider';
import { InstagramStandaloneConnectionAdapter } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.instagram';
import { CreateManagedConnectionIntentDto } from '@gitroom/nestjs-libraries/dtos/managed/managed.connection.dto';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const PROVIDER = 'fake-social';

// FAKE credentials: the AI-facing one and W&W's server relay
const AI = { id: 'ww-mcp', organizationId: ORG, scopes: ['channels:connect'] } as any;
const RELAY = {
  id: 'ww-relay',
  organizationId: ORG,
  scopes: ['channels:connect-callback'],
} as any;
const OTHER_RELAY = { ...RELAY, organizationId: OTHER_ORG } as any;

// FAKE secrets: none may appear in a response, an intent / attempt row or
// an event
const TOKEN = 'FAKE-ACCESS-TOKEN-never-returned';
const CODE = 'FAKE-CODE-never-stored';
const APP_SECRET = 'FAKE-APP-SECRET-never-logged';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err: any) {
    return { status: err.getStatus?.(), code: err.getResponse?.()?.code };
  }
  throw new Error('expected a refusal');
}

async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!check()) {
    throw new Error('condition not reached');
  }
}

function grant(account: Partial<ManagedConnectionGrant['account']> = {}): ManagedConnectionGrant {
  return {
    account: {
      internalId: 'ig-1',
      profile: 'ww.test.acc',
      displayName: 'W&W test',
      ...account,
    },
    credential: {
      accessToken: TOKEN,
      refreshToken: TOKEN,
      expiresInSeconds: 5184000,
    },
    grantedScopes: ['instagram_business_basic'],
  };
}

// FAKE provider: records every exchange; each test decides the answer
class FakeProvider implements ManagedConnectionProvider {
  identifier = PROVIDER;
  configured = true;
  codes: string[] = [];
  signals: AbortSignal[] = [];
  answer: (code: string, signal: AbortSignal) => Promise<ManagedConnectionGrant> =
    async () => grant();

  available() {
    return this.configured;
  }

  authorizationUrl(state: string) {
    return `https://provider.example/authorize?state=${state}`;
  }

  exchange(code: string, signal: AbortSignal) {
    this.codes.push(code);
    this.signals.push(signal);
    return this.answer(code, signal);
  }
}

// The FAKE in-memory Prisma with the two connection models (defaults as in
// schema.prisma), and Integration writes sent through the REAL write fence
// the way PrismaService registers it
function connectionDb() {
  const db = new FakePrismaDb();
  db.tables.managedConnectionIntent = [];
  db.tables.managedConnectionAttempt = [];

  const withDefaults = (delegate: any, defaults: Record<string, any>) => ({
    ...delegate,
    create: (args: any) =>
      delegate.create({ ...args, data: { ...defaults, ...args.data } }),
  });

  let fence: ReturnType<typeof managedWriteFence>;
  const base = (db as any).client.bind(db);
  (db as any).client = (ctx: any) => {
    const client = base(ctx);
    const integration = client.integration;
    const fenced =
      (action: string) =>
      (args: any) => {
        db.integrationSelects.push(args.select);
        return fence(
          { model: 'Integration', action, args, dataPath: [], runInTransaction: false } as any,
          (params: any) => integration[action](params.args)
        );
      };

    return {
      ...client,
      integration: {
        ...integration,
        create: fenced('create'),
        update: fenced('update'),
        upsert: fenced('upsert'),
      },
      managedConnectionIntent: withDefaults(
        (db as any).delegate('managedConnectionIntent', ctx),
        {
          status: 'PENDING',
          attempt: 0,
          leaseExpiresAt: null,
          failureCode: null,
          integrationId: null,
          bindingGeneration: null,
          bindingStatus: null,
          completedSequence: null,
        }
      ),
      managedConnectionAttempt: withDefaults(
        (db as any).delegate('managedConnectionAttempt', ctx),
        {
          outcome: 'ISSUED',
          codeDigest: null,
          callbackCredentialId: null,
          claimedAt: null,
          failureCode: null,
          observedInternalId: null,
          observedProfile: null,
          observedAt: null,
          providerExpiresIn: null,
          grantedScopes: null,
        }
      ),
    };
  };
  fence = managedWriteFence(db.model);

  return db;
}

describe('ManagedConnectionService (FAKE Prisma, FAKE provider, real repository, service and write fence)', () => {
  let db: FakePrismaDb;
  let managedRepository: ManagedRepository;
  let repository: ManagedConnectionRepository;
  let service: ManagedConnectionService;
  let managed: ManagedService;
  let provider: FakeProvider;
  // every answer but the relay's authorization URL, and every state issued
  let responses: unknown[];
  let states: string[];

  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = `${ORG},${OTHER_ORG}`;
    process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS = PROVIDER;
    db = connectionDb();
    managedRepository = new ManagedRepository(
      { model: db.model } as any,
      { model: db.model } as any
    );
    repository = new ManagedConnectionRepository(managedRepository, {
      model: db.model,
    } as any);
    provider = new FakeProvider();
    service = new ManagedConnectionService(repository, [provider]);
    managed = new ManagedService(managedRepository, {} as any);
    responses = [];
    states = [];
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
    delete process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS;
    jest.restoreAllMocks();
  });

  const keep = <T>(value: T) => {
    responses.push(value);
    return value;
  };

  const connectBody = (
    overrides: Partial<CreateManagedConnectionIntentDto> = {}
  ): CreateManagedConnectionIntentDto => ({
    operationKey: 'ww:connect:ig:1',
    providerIdentifier: PROVIDER,
    mode: 'CONNECT',
    expectedAccount: { profile: 'ww.test.acc' },
    ...overrides,
  });

  async function create(overrides: Partial<CreateManagedConnectionIntentDto> = {}) {
    return keep(await service.createIntent(ORG, AI.id, connectBody(overrides)));
  }

  async function authorize(intentId: string, relay = RELAY) {
    const answer = await service.authorize(relay, intentId);
    const state = new URL(answer.authorizationUrl).searchParams.get('state')!;
    states.push(state);
    return { answer, state };
  }

  async function callback(intentId: string, body: any, relay = RELAY) {
    return keep(await service.callback(relay, intentId, body));
  }

  function seedChannel(overrides: Record<string, any> = {}) {
    return db.insert('integration', {
      organizationId: ORG,
      name: 'W&W test',
      customName: null,
      providerIdentifier: PROVIDER,
      type: 'social',
      internalId: 'ig-1',
      rootInternalId: 'ig-1',
      profile: 'ww.test.acc',
      disabled: false,
      refreshNeeded: false,
      inBetweenSteps: false,
      deletedAt: null,
      token: 'OLD-TOKEN',
      refreshToken: 'OLD-REFRESH',
      ...overrides,
    });
  }

  // a channel W&W listed and qualified: binding generation 2
  async function qualifiedChannel() {
    const row = seedChannel();
    await managed.listChannels(ORG);
    const [channel] = await managed.listChannels(ORG);
    await managed.qualifyChannel(ORG, AI.id, row.id, {
      expectedGeneration: 1,
      identityFingerprint: channel.identityFingerprint,
    } as any);
    return row;
  }

  function reconnectBody(integrationId: string, generation: number) {
    return {
      operationKey: 'ww:reconnect:ig:1',
      mode: 'RECONNECT' as const,
      integrationId,
      expectedBindingGeneration: generation,
      expectedAccount: { profile: 'ww.test.acc' },
    };
  }

  // No token, code or app secret in an answer, an intent / attempt row or an
  // event; no state outside the relay's authorization answer; no digest,
  // URL or scope list in an answer
  function expectNoSecrets() {
    const stored = JSON.stringify([
      db.tables.managedConnectionIntent,
      db.tables.managedConnectionAttempt,
      db.tables.managedChangeEvent,
    ]);
    const answered = JSON.stringify(responses);

    for (const secret of [TOKEN, CODE, APP_SECRET, ...states]) {
      expect(stored).not.toContain(secret);
      expect(answered).not.toContain(secret);
    }
    expect(answered).not.toMatch(
      /stateDigest|codeDigest|authorizationUrl|grantedScopes|token/i
    );
  }

  describe('default-disabled provider', () => {
    it('refuses an intent while the provider is not listed, or not configured, and writes nothing', async () => {
      delete process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS;
      expect(await refusal(create())).toEqual({
        status: 409,
        code: 'CONNECT_PROVIDER_UNAVAILABLE',
      });

      process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS = PROVIDER;
      provider.configured = false;
      expect(await refusal(create())).toEqual({
        status: 409,
        code: 'CONNECT_PROVIDER_UNAVAILABLE',
      });

      expect(db.tables.managedConnectionIntent).toHaveLength(0);
      expect(provider.codes).toHaveLength(0);
    });

    it('holds a callback without claiming it when the provider was switched off after the authorization', async () => {
      const intent = await create();
      const { state } = await authorize(intent.intentId);

      delete process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS;
      expect(await refusal(callback(intent.intentId, { state, code: CODE }))).toEqual({
        status: 409,
        code: 'CONNECT_PROVIDER_UNAVAILABLE',
      });
      expect(db.tables.managedConnectionAttempt[0].outcome).toBe('ISSUED');
      expect(provider.codes).toHaveLength(0);
    });

    it('refuses an authorization whose configuration disappeared while the URL was built, and keeps the open one', async () => {
      const intent = await create();
      const { state } = await authorize(intent.intentId);

      provider.authorizationUrl = () => {
        throw new Error(`FAKE provider failure ${APP_SECRET}`);
      };
      const err: any = await service.authorize(RELAY, intent.intentId).catch((e) => e);
      expect({ status: err.getStatus(), code: err.getResponse().code }).toEqual({
        status: 409,
        code: 'CONNECT_PROVIDER_UNAVAILABLE',
      });
      expect(JSON.stringify(err.getResponse())).not.toContain(APP_SECRET);

      // rolled back: no new attempt, the earlier one is still the open one
      expect(db.tables.managedConnectionAttempt).toHaveLength(1);
      expect(db.tables.managedConnectionAttempt[0]).toMatchObject({
        outcome: 'ISSUED',
        stateDigest: sha(state),
      });
      expect(db.tables.managedConnectionIntent[0]).toMatchObject({
        status: 'PENDING',
        attempt: 1,
      });
      expect(provider.codes).toHaveLength(0);
    });
  });

  describe('connect', () => {
    it('binds the expected account once, with a pending-qualification binding and point-in-time evidence', async () => {
      const intent = await create();
      expect(intent).toMatchObject({
        status: 'PENDING',
        mode: 'CONNECT',
        attempt: 0,
        replayed: false,
        receipt: null,
      });
      expect(intent).not.toHaveProperty('authorizationUrl');

      const { answer, state } = await authorize(intent.intentId);
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(answer.attempt).toBe(1);

      const done = await callback(intent.intentId, { state, code: CODE });
      expect(done).toMatchObject({
        status: 'COMPLETED',
        failure: null,
        replayed: false,
        receipt: {
          account: { internalId: 'ig-1', profile: 'ww.test.acc' },
          identityEvidence: 'PROVIDER_ACCOUNT_AT_EXCHANGE',
          binding: { generation: 1, status: 'PENDING_QUALIFICATION' },
          qualification: 'REQUIRED',
        },
      });
      expect(provider.codes).toEqual([CODE]);

      const [integration] = db.tables.integration;
      expect(done.receipt!.integrationId).toBe(integration.id);
      expect(integration).toMatchObject({
        organizationId: ORG,
        providerIdentifier: PROVIDER,
        internalId: 'ig-1',
        rootInternalId: 'ig-1',
        profile: 'ww.test.acc',
        name: 'W&W test',
        token: TOKEN,
        inBetweenSteps: false,
        refreshNeeded: false,
      });
      // the provider's expires_in, not an assumption
      expect(integration.tokenExpiration.getTime()).toBeGreaterThan(
        Date.now() + 5184000 * 1000 - 60000
      );

      const [attempt] = db.tables.managedConnectionAttempt;
      expect(attempt).toMatchObject({
        outcome: 'COMPLETED',
        stateDigest: sha(state),
        codeDigest: sha(CODE),
        relayCredentialId: RELAY.id,
        callbackCredentialId: RELAY.id,
        observedInternalId: 'ig-1',
        observedProfile: 'ww.test.acc',
        providerExpiresIn: 5184000,
        grantedScopes: '["instagram_business_basic"]',
      });

      expect(
        db.tables.managedChangeEvent.map((event) => [event.sequence, event.kind])
      ).toEqual([
        [1, 'CHANNEL_BINDING_CREATED'],
        [2, 'CHANNEL_CONNECTED'],
      ]);
      expect(done.receipt!.sequence).toBe(2);
      expect(db.tables.managedOrganization[0].sequence).toBe(2);

      // the integration was only ever read or written with the identity select
      expect(db.integrationSelects.length).toBeGreaterThan(0);
      for (const select of db.integrationSelects) {
        expect(select).toBeDefined();
        for (const secret of [
          'token',
          'refreshToken',
          'customInstanceDetails',
          'additionalSettings',
          'picture',
        ]) {
          expect(select).not.toHaveProperty(secret);
        }
      }

      expectNoSecrets();
    });

    it('never qualifies: the existing qualify step still needs the generation and the fingerprint', async () => {
      const intent = await create();
      const { state } = await authorize(intent.intentId);
      await callback(intent.intentId, { state, code: CODE });

      const [channel] = await managed.listChannels(ORG);
      expect(channel.binding).toMatchObject({
        generation: 1,
        status: 'PENDING_QUALIFICATION',
      });

      expect(
        await refusal(
          managed.qualifyChannel(ORG, AI.id, channel.integrationId, {
            expectedGeneration: 1,
            identityFingerprint: 'sha256:other',
          } as any)
        )
      ).toEqual({ status: 409, code: 'IDENTITY_FINGERPRINT_MISMATCH' });

      const qualified = await managed.qualifyChannel(ORG, AI.id, channel.integrationId, {
        expectedGeneration: 1,
        identityFingerprint: channel.identityFingerprint,
      } as any);
      expect(qualified.binding).toMatchObject({ generation: 2, status: 'QUALIFIED' });
    });

    it('replays the intent for the same key and payload, and refuses another payload or credential', async () => {
      const first = await create();
      const again = await create();
      expect(again).toMatchObject({ intentId: first.intentId, replayed: true });

      expect(
        await refusal(create({ expectedAccount: { profile: 'someone.else' } }))
      ).toEqual({ status: 409, code: 'OPERATION_KEY_PAYLOAD_MISMATCH' });
      expect(
        await refusal(service.createIntent(ORG, 'ww-other', connectBody()))
      ).toEqual({ status: 409, code: 'OPERATION_KEY_CREDENTIAL_MISMATCH' });
      expect(
        await refusal(service.getIntent(ORG, 'ww-other', first.intentId))
      ).toEqual({ status: 409, code: 'OPERATION_KEY_CREDENTIAL_MISMATCH' });

      expect(db.tables.managedConnectionIntent).toHaveLength(1);
    });

    it('validates the mode shape', async () => {
      expect(
        await refusal(create({ expectedAccount: {} }))
      ).toEqual({ status: 400, code: 'INVALID_INPUT' });
      expect(
        await refusal(create({ integrationId: 'abc' }))
      ).toEqual({ status: 400, code: 'INVALID_INPUT' });
      expect(
        await refusal(
          service.createIntent(ORG, AI.id, {
            ...connectBody(),
            mode: 'RECONNECT',
          })
        )
      ).toEqual({ status: 400, code: 'INVALID_INPUT' });
    });

    it('refuses CONNECT onto an account that already has a row, deleted ones included', async () => {
      seedChannel({ deletedAt: new Date() });

      expect(
        await refusal(create({ expectedAccount: { internalId: 'ig-1' } }))
      ).toEqual({ status: 409, code: 'ALREADY_CONNECTED' });

      // expected by profile only: refused with the provider's answer, nothing written
      const intent = await create();
      const { state } = await authorize(intent.intentId);
      const done = await callback(intent.intentId, { state, code: CODE });
      expect(done).toMatchObject({
        status: 'FAILED',
        failure: { code: 'ALREADY_CONNECTED', retryable: false },
        receipt: null,
      });
      expect(db.tables.integration).toHaveLength(1);
      expect(db.tables.integration[0].token).toBe('OLD-TOKEN');
      // retained as deleted: never restored
      expect(db.tables.integration[0].deletedAt).not.toBeNull();
      expect(db.tables.managedChannelBinding).toHaveLength(0);

      // the refusal says a deleted channel cannot come back through this API
      const err: any = await service
        .createIntent(ORG, AI.id, {
          ...connectBody({ expectedAccount: { internalId: 'ig-1' } }),
          operationKey: 'ww:connect:ig:2',
        })
        .catch((e) => e);
      expect(err.getResponse().msg).toContain(
        'a deleted channel cannot be connected, reconnected or restored through this API'
      );
    });

    it('takes the expected profile byte for byte when the provider has no profile rule', async () => {
      const intent = await create({ expectedAccount: { profile: '@WW.Test.Acc' } });
      expect(intent.expectedAccount).toEqual({
        internalId: null,
        profile: '@WW.Test.Acc',
      });
    });
  });

  describe('expected profile of the Instagram adapter (FAKE fetch, no network)', () => {
    const IG_ENV = {
      INSTAGRAM_APP_ID: '1234567890',
      INSTAGRAM_APP_SECRET: APP_SECRET,
      POSTIZ_MANAGED_INSTAGRAM_REDIRECT_URI:
        'https://connect.ww.example/integrations/social/instagram-standalone',
    };
    let fetch: jest.Mock;

    beforeEach(() => {
      process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS = 'instagram-standalone';
      fetch = jest.fn();
      service = new ManagedConnectionService(repository, [
        new InstagramStandaloneConnectionAdapter(fetch, IG_ENV as any),
      ]);
    });

    const igBody = (profile: string, mode: 'CONNECT' | 'RECONNECT' = 'CONNECT') =>
      ({
        operationKey: `ww:${mode.toLowerCase()}:ig:1`,
        providerIdentifier: 'instagram-standalone',
        mode,
        ...(mode === 'RECONNECT'
          ? { integrationId: 'any', expectedBindingGeneration: 1 }
          : {}),
        expectedAccount: { profile },
      }) as CreateManagedConnectionIntentDto;

    it.each([
      '@ww.test.acc',
      'WW.test.acc',
      'ww.Test.acc',
      ' ww.test.acc',
      'ww.test.acc ',
      'ww test.acc',
    ])('refuses %j before any intent, authorization or exchange', async (profile) => {
      for (const mode of ['CONNECT', 'RECONNECT'] as const) {
        const err: any = await service
          .createIntent(ORG, AI.id, igBody(profile, mode))
          .catch((e) => e);
        expect({ status: err.getStatus(), code: err.getResponse().code }).toEqual({
          status: 400,
          code: 'INVALID_INPUT',
        });
        // a safe message: the input is not echoed
        expect(err.getResponse().msg).not.toContain(profile.trim());
      }

      expect(db.tables.managedConnectionIntent).toHaveLength(0);
      expect(db.tables.managedConnectionAttempt).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('keeps a canonical profile exactly as sent', async () => {
      const intent = await service.createIntent(ORG, AI.id, igBody('ww.test_acc.1'));
      expect(intent.expectedAccount.profile).toBe('ww.test_acc.1');
      expect(db.tables.managedConnectionIntent[0].expectedProfile).toBe(
        'ww.test_acc.1'
      );
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('identity gate', () => {
    it.each([
      ['profile', { profile: 'not.ww' }],
      ['internal id', { internalId: 'ig-other' }],
    ])('never binds an account whose %s differs from the expected one', async (_, account) => {
      const intent = await create({
        expectedAccount: { internalId: 'ig-1', profile: 'ww.test.acc' },
      });
      const { state } = await authorize(intent.intentId);
      provider.answer = async () => grant(account);

      const done = await callback(intent.intentId, { state, code: CODE });
      expect(done).toMatchObject({
        status: 'FAILED',
        failure: { code: 'ACCOUNT_MISMATCH', retryable: false },
        receipt: null,
      });
      // the provider's answer is kept as evidence, not exposed
      expect(db.tables.managedConnectionAttempt[0]).toMatchObject({
        outcome: 'FAILED',
        observedInternalId: (account as any).internalId || 'ig-1',
      });
      expect(JSON.stringify(done)).not.toContain('not.ww');
      expect(JSON.stringify(done)).not.toContain('ig-other');

      expect(db.tables.integration).toHaveLength(0);
      expect(db.tables.managedChannelBinding).toHaveLength(0);
      expect(db.tables.managedChangeEvent).toHaveLength(0);

      // a token was issued and dropped: a new intent is a new decision
      expect(
        await refusal(service.retryIntent(ORG, AI.id, intent.intentId))
      ).toEqual({ status: 409, code: 'INTENT_NOT_RETRYABLE' });
      expectNoSecrets();
    });
  });

  describe('provider failures', () => {
    it('records a denied consent without an exchange, and allows a bounded retry with a new state', async () => {
      const intent = await create();
      const first = await authorize(intent.intentId);

      const denied = await callback(intent.intentId, {
        state: first.state,
        error: 'access_denied',
      });
      expect(denied).toMatchObject({
        status: 'FAILED',
        failure: { code: 'PROVIDER_DENIED', retryable: true },
      });
      expect(provider.codes).toHaveLength(0);

      // the same denial again is a replay
      expect(
        await callback(intent.intentId, { state: first.state, error: 'access_denied' })
      ).toMatchObject({ status: 'FAILED', replayed: true });

      expect(await service.retryIntent(ORG, AI.id, intent.intentId)).toMatchObject({
        status: 'PENDING',
        failure: null,
      });
      expect(
        await refusal(callback(intent.intentId, { state: first.state, code: CODE }))
      ).toEqual({ status: 409, code: 'AUTHORIZATION_NOT_ISSUED' });

      const second = await authorize(intent.intentId);
      expect(second.answer.attempt).toBe(2);
      expect(
        await refusal(callback(intent.intentId, { state: first.state, code: CODE }))
      ).toEqual({ status: 409, code: 'STATE_MISMATCH' });

      expect(
        await callback(intent.intentId, { state: second.state, code: CODE })
      ).toMatchObject({ status: 'COMPLETED' });
      expect(provider.codes).toEqual([CODE]);
    });

    it.each([
      ['NOT_SENT', 'FAILED', 'EXCHANGE_NOT_SENT', true],
      ['REFUSED', 'FAILED', 'EXCHANGE_REFUSED', true],
      ['SCOPES_MISSING', 'FAILED', 'SCOPES_MISSING', false],
    ] as const)('maps a provider %s to %s %s', async (kind, status, code, retryable) => {
      const intent = await create();
      const { state } = await authorize(intent.intentId);
      provider.answer = async () => {
        throw new ManagedConnectionProviderError(kind);
      };

      expect(await callback(intent.intentId, { state, code: CODE })).toMatchObject({
        status,
        failure: { code, retryable },
        receipt: null,
      });
      expect(db.tables.integration).toHaveLength(0);
    });

    it('keeps any other error UNKNOWN and never logs or returns what it carried', async () => {
      const logged = [
        jest.spyOn(console, 'log').mockImplementation(() => undefined),
        jest.spyOn(console, 'error').mockImplementation(() => undefined),
        jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      ];
      const intent = await create();
      const { state } = await authorize(intent.intentId);
      provider.answer = async () => {
        throw new Error(
          `GET https://graph.example/access_token?client_secret=${APP_SECRET}&access_token=${TOKEN}`
        );
      };

      const done = await callback(intent.intentId, { state, code: CODE });
      expect(done).toMatchObject({
        status: 'UNKNOWN',
        failure: { code: 'EXCHANGE_OUTCOME_UNKNOWN', retryable: false },
      });
      for (const spy of logged) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(
        await refusal(service.retryIntent(ORG, AI.id, intent.intentId))
      ).toEqual({ status: 409, code: 'INTENT_NOT_RETRYABLE' });
      expectNoSecrets();
    });

    it('stops a hanging exchange at the deadline as UNKNOWN and never adopts its late answer', async () => {
      service.exchangeDeadlineMs = 20;
      let resolveLate!: (value: ManagedConnectionGrant) => void;
      provider.answer = () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        });

      const intent = await create();
      const { state } = await authorize(intent.intentId);
      const done = await callback(intent.intentId, { state, code: CODE });

      expect(done).toMatchObject({
        status: 'UNKNOWN',
        failure: { code: 'EXCHANGE_TIMEOUT', retryable: false },
      });
      expect(provider.signals[0].aborted).toBe(true);

      resolveLate(grant());
      await new Promise((resolve) => setImmediate(resolve));
      expect(db.tables.integration).toHaveLength(0);

      // the same callback again is answered from the record, never re-exchanged
      expect(await callback(intent.intentId, { state, code: CODE })).toMatchObject({
        status: 'UNKNOWN',
        replayed: true,
      });
      expect(provider.codes).toEqual([CODE]);
    });

    it('keeps a lost terminal transaction UNKNOWN without binding', async () => {
      const real = repository.mutate.bind(repository);
      jest
        .spyOn(repository, 'mutate')
        .mockImplementationOnce(real)
        .mockImplementationOnce(real)
        .mockImplementationOnce(real)
        .mockImplementationOnce(async () => {
          throw new Error('connection lost');
        });

      const intent = await create();
      const { state } = await authorize(intent.intentId);
      const done = await callback(intent.intentId, { state, code: CODE });

      expect(done).toMatchObject({
        status: 'UNKNOWN',
        failure: { code: 'RECORD_FAILED', retryable: false },
      });
      expect(db.tables.integration).toHaveLength(0);
      expect(db.tables.managedChannelBinding).toHaveLength(0);
    });
  });

  describe('claims, restarts and concurrency', () => {
    it('lets one of many concurrent callbacks exchange; the others are refused or replayed', async () => {
      provider.answer = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return grant();
      };
      const intent = await create();
      const { state } = await authorize(intent.intentId);

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          service.callback(RELAY, intent.intentId, { state, code: CODE })
        )
      );

      expect(provider.codes).toEqual([CODE]);
      expect(db.tables.integration).toHaveLength(1);
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled'
      );
      expect(fulfilled.filter((result) => !result.value.replayed)).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason.getResponse().code).toBe('EXCHANGE_IN_PROGRESS');
        } else {
          expect(result.value.status).toBe('COMPLETED');
        }
      }
    });

    it('binds only one of two intents racing for the same account', async () => {
      const first = await create({ operationKey: 'ww:connect:ig:a' });
      const second = await create({ operationKey: 'ww:connect:ig:b' });
      const a = await authorize(first.intentId);
      const b = await authorize(second.intentId);

      const [one, two] = await Promise.all([
        callback(first.intentId, { state: a.state, code: CODE }),
        callback(second.intentId, { state: b.state, code: `${CODE}-2` }),
      ]);

      expect([one.status, two.status].sort()).toEqual(['COMPLETED', 'FAILED']);
      expect([one, two].find((item) => item.status === 'FAILED')!.failure!.code).toBe(
        'ALREADY_CONNECTED'
      );
      expect(db.tables.integration).toHaveLength(1);
    });

    it('holds a claim whose process died until its lease ran out, then recovers it as UNKNOWN without an exchange', async () => {
      let resolveLate!: (value: ManagedConnectionGrant) => void;
      provider.answer = () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        });
      const intent = await create();
      const { state } = await authorize(intent.intentId);

      // the "dead" exchange: claimed, never answered while we look
      const running = service.callback(RELAY, intent.intentId, { state, code: CODE });
      await until(() => provider.codes.length === 1);

      expect(await refusal(callback(intent.intentId, { state, code: CODE }))).toEqual({
        status: 409,
        code: 'EXCHANGE_IN_PROGRESS',
      });
      expect(
        await refusal(service.recoverIntent(ORG, AI.id, intent.intentId))
      ).toEqual({ status: 409, code: 'EXCHANGE_IN_PROGRESS' });

      const later = Date.now() + MANAGED_CONNECTION_LEASE_MS + 1000;
      jest.spyOn(Date, 'now').mockReturnValue(later);

      expect(await refusal(callback(intent.intentId, { state, code: CODE }))).toEqual({
        status: 409,
        code: 'EXCHANGE_NEEDS_RECOVERY',
      });
      expect(await service.recoverIntent(ORG, AI.id, intent.intentId)).toMatchObject({
        status: 'UNKNOWN',
        failure: { code: 'EXCHANGE_OUTCOME_UNKNOWN', retryable: false },
      });

      // the stale exchange answers after all: its token is not adopted
      resolveLate(grant());
      expect(await running).toMatchObject({ status: 'UNKNOWN' });
      expect(db.tables.integration).toHaveLength(0);
      expect(provider.codes).toEqual([CODE]);
    });
  });

  describe('expiry, organizations and the relay boundary', () => {
    it('expires an intent durably and an authorization on its own', async () => {
      const intent = await create();
      const { state } = await authorize(intent.intentId);
      const start = Date.now();

      // past the authorization (10 min), not the intent (30 min)
      jest.spyOn(Date, 'now').mockReturnValue(start + 11 * 60 * 1000);
      expect(await refusal(callback(intent.intentId, { state, code: CODE }))).toEqual({
        status: 409,
        code: 'AUTHORIZATION_EXPIRED',
      });
      expect(db.tables.managedConnectionAttempt[0].outcome).toBe('EXPIRED');
      const second = await authorize(intent.intentId);
      expect(second.answer.attempt).toBe(2);

      jest.spyOn(Date, 'now').mockReturnValue(start + 31 * 60 * 1000);
      expect(
        (await service.getIntent(ORG, AI.id, intent.intentId)).status
      ).toBe('EXPIRED');
      expect(
        await refusal(callback(intent.intentId, { state: second.state, code: CODE }))
      ).toEqual({ status: 409, code: 'INTENT_EXPIRED' });
      expect(db.tables.managedConnectionIntent[0].status).toBe('EXPIRED');
      expect(await refusal(authorize(intent.intentId))).toEqual({
        status: 409,
        code: 'INTENT_EXPIRED',
      });
      expect(provider.codes).toHaveLength(0);
    });

    it('bounds authorizations per intent; each one replaces the URL before it', async () => {
      const intent = await create();
      const states = [];
      for (let i = 0; i < 3; i++) {
        states.push((await authorize(intent.intentId)).state);
      }
      expect(await refusal(authorize(intent.intentId))).toEqual({
        status: 409,
        code: 'AUTHORIZATION_LIMIT_REACHED',
      });
      expect(new Set(states).size).toBe(3);
      expect(
        db.tables.managedConnectionAttempt.map((attempt) => attempt.outcome)
      ).toEqual(['REPLACED', 'REPLACED', 'ISSUED']);
      expect(await refusal(callback(intent.intentId, { state: states[0], code: CODE }))).toEqual({
        status: 409,
        code: 'STATE_MISMATCH',
      });
    });

    it('cancels a pending intent and its open authorization', async () => {
      const intent = await create();
      const { state } = await authorize(intent.intentId);

      expect(await service.cancelIntent(ORG, AI.id, intent.intentId)).toMatchObject({
        status: 'CANCELLED',
      });
      expect(await service.cancelIntent(ORG, AI.id, intent.intentId)).toMatchObject({
        status: 'CANCELLED',
      });
      expect(await refusal(callback(intent.intentId, { state, code: CODE }))).toEqual({
        status: 409,
        code: 'INTENT_NOT_PENDING',
      });
      expect(provider.codes).toHaveLength(0);
    });

    it('never shows an intent to another organization', async () => {
      const intent = await create();
      const { state } = await authorize(intent.intentId);

      expect(await refusal(service.authorize(OTHER_RELAY, intent.intentId))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(
        await refusal(service.callback(OTHER_RELAY, intent.intentId, { state, code: CODE }))
      ).toEqual({ status: 404, code: 'NOT_FOUND' });
      expect(
        await refusal(service.getIntent(OTHER_ORG, AI.id, intent.intentId))
      ).toEqual({ status: 404, code: 'NOT_FOUND' });
      expect(provider.codes).toHaveLength(0);
    });

    it('gives an authorization URL and takes a callback only from the separate relay credential', async () => {
      const intent = await create();
      const both = { ...RELAY, scopes: ['channels:connect', 'channels:connect-callback'] };

      for (const credential of [AI, both]) {
        expect(await refusal(service.authorize(credential, intent.intentId))).toEqual({
          status: 403,
          code: 'RELAY_CREDENTIAL_REQUIRED',
        });
      }

      const { state } = await authorize(intent.intentId);
      for (const credential of [AI, both]) {
        expect(
          await refusal(service.callback(credential, intent.intentId, { state, code: CODE }))
        ).toEqual({ status: 403, code: 'RELAY_CREDENTIAL_REQUIRED' });
      }

      // another relay credential of the organization did not get this state
      expect(
        await refusal(
          service.callback({ ...RELAY, id: 'ww-relay-2' }, intent.intentId, {
            state,
            code: CODE,
          })
        )
      ).toEqual({ status: 409, code: 'RELAY_CREDENTIAL_MISMATCH' });
      expect(provider.codes).toHaveLength(0);
    });

    it('refuses a callback carrying both or neither of code and error', async () => {
      const intent = await create();
      const { state } = await authorize(intent.intentId);
      expect(await refusal(callback(intent.intentId, { state }))).toEqual({
        status: 400,
        code: 'INVALID_INPUT',
      });
      expect(
        await refusal(callback(intent.intentId, { state, code: CODE, error: 'access_denied' }))
      ).toEqual({ status: 400, code: 'INVALID_INPUT' });
    });
  });

  describe('reconnect', () => {
    it('reconnects only the exact channel at the expected generation, keeps history, and requires qualification again', async () => {
      const row = await qualifiedChannel();
      const eventsBefore = db.tables.managedChangeEvent.map((event) => ({ ...event }));

      expect(
        await refusal(
          service.createIntent(ORG, AI.id, {
            ...reconnectBody(row.id, 1),
            providerIdentifier: PROVIDER,
          })
        )
      ).toEqual({ status: 409, code: 'BINDING_GENERATION_MISMATCH' });

      const intent = keep(
        await service.createIntent(ORG, AI.id, {
          ...reconnectBody(row.id, 2),
          providerIdentifier: PROVIDER,
        })
      );
      expect(intent).toMatchObject({
        mode: 'RECONNECT',
        target: { integrationId: row.id, expectedBindingGeneration: 2 },
        expectedAccount: { internalId: 'ig-1', profile: 'ww.test.acc' },
      });

      const { state } = await authorize(intent.intentId);
      const done = await callback(intent.intentId, { state, code: CODE });
      expect(done).toMatchObject({
        status: 'COMPLETED',
        receipt: {
          integrationId: row.id,
          binding: { generation: 3, status: 'PENDING_QUALIFICATION' },
          qualification: 'REQUIRED',
        },
      });

      // same row, new credential, nothing else of it rewritten
      expect(db.tables.integration).toHaveLength(1);
      expect(db.tables.integration[0]).toMatchObject({
        id: row.id,
        token: TOKEN,
        name: 'W&W test',
        internalId: 'ig-1',
      });

      // earlier events are untouched; the reconnect is appended
      expect(db.tables.managedChangeEvent.slice(0, eventsBefore.length)).toEqual(
        eventsBefore
      );
      const events = db.tables.managedChangeEvent;
      expect(events[events.length - 1]).toMatchObject({
        kind: 'CHANNEL_RECONNECTED',
        entityId: row.id,
        bindingGeneration: 3,
        operationKey: 'ww:reconnect:ig:1',
      });

      // the existing qualify step lifts it, at the new generation only
      const [channel] = await managed.listChannels(ORG);
      expect(channel.binding).toMatchObject({ generation: 3, status: 'PENDING_QUALIFICATION' });
      expect(
        await refusal(
          managed.qualifyChannel(ORG, AI.id, row.id, {
            expectedGeneration: 2,
            identityFingerprint: channel.identityFingerprint,
          } as any)
        )
      ).toEqual({ status: 409, code: 'BINDING_GENERATION_MISMATCH' });
      expect(
        (
          await managed.qualifyChannel(ORG, AI.id, row.id, {
            expectedGeneration: 3,
            identityFingerprint: channel.identityFingerprint,
          } as any)
        ).binding
      ).toMatchObject({ generation: 4, status: 'QUALIFIED' });
      expectNoSecrets();
    });

    it('fails before the exchange when the generation moved after the intent was created', async () => {
      const row = await qualifiedChannel();
      const intent = await service.createIntent(ORG, AI.id, {
        ...reconnectBody(row.id, 2),
        providerIdentifier: PROVIDER,
      });
      const { state } = await authorize(intent.intentId);

      // W&W requalified meanwhile: generation 3
      const [channel] = await managed.listChannels(ORG);
      await managed.qualifyChannel(ORG, AI.id, row.id, {
        expectedGeneration: 2,
        identityFingerprint: channel.identityFingerprint,
      } as any);

      expect(await callback(intent.intentId, { state, code: CODE })).toMatchObject({
        status: 'FAILED',
        failure: { code: 'BINDING_GENERATION_MISMATCH', retryable: false },
      });
      expect(provider.codes).toHaveLength(0);
      expect(db.tables.integration[0].token).toBe('OLD-TOKEN');
    });

    it('never binds another account to the channel', async () => {
      const row = await qualifiedChannel();
      const intent = await service.createIntent(ORG, AI.id, {
        ...reconnectBody(row.id, 2),
        providerIdentifier: PROVIDER,
        expectedAccount: {},
      });
      const { state } = await authorize(intent.intentId);
      provider.answer = async () => grant({ internalId: 'ig-2' });

      expect(await callback(intent.intentId, { state, code: CODE })).toMatchObject({
        status: 'FAILED',
        failure: { code: 'TARGET_IDENTITY_MISMATCH' },
      });
      expect(db.tables.integration).toHaveLength(1);
      expect(db.tables.integration[0]).toMatchObject({ token: 'OLD-TOKEN', internalId: 'ig-1' });
      expect(
        (await managed.listChannels(ORG))[0].binding
      ).toMatchObject({ generation: 2, status: 'QUALIFIED' });
    });

    it('pauses the binding at a new generation when the recorded handle changed', async () => {
      const row = await qualifiedChannel();
      // the identity the binding was qualified with
      const before = identityFingerprint(db.tables.integration[0] as any);
      const intent = await service.createIntent(ORG, AI.id, {
        ...reconnectBody(row.id, 2),
        providerIdentifier: PROVIDER,
        expectedAccount: {},
      });
      const { state } = await authorize(intent.intentId);
      provider.answer = async () => grant({ profile: 'ww.renamed' });

      expect(await callback(intent.intentId, { state, code: CODE })).toMatchObject({
        status: 'COMPLETED',
        receipt: { binding: { generation: 3, status: 'PAUSED_IDENTITY_CHANGED' } },
      });
      const [paused, reconnected] = db.tables.managedChangeEvent.slice(-2);
      expect([paused.kind, reconnected.kind]).toEqual([
        'CHANNEL_PAUSED_IDENTITY_CHANGED',
        'CHANNEL_RECONNECTED',
      ]);
      expect(reconnected.sequence).toBe(paused.sequence + 1);
      expect(JSON.parse(paused.data)).toEqual({
        boundIdentityFingerprint: before,
        recordedIdentityFingerprint: identityFingerprint(db.tables.integration[0] as any),
      });
    });

    // Not a duplicate: the reconnect moves the binding to a new generation,
    // and this event is the only one that records it paused at that generation
    it('records the pause again, at the new generation, when an already paused channel is reconnected', async () => {
      const row = await qualifiedChannel();
      db.tables.integration[0].profile = 'ww.renamed';
      const [drifted] = await managed.listChannels(ORG);
      expect(drifted.binding).toMatchObject({
        generation: 3,
        status: 'PAUSED_IDENTITY_CHANGED',
      });

      const intent = await service.createIntent(ORG, AI.id, {
        ...reconnectBody(row.id, 3),
        providerIdentifier: PROVIDER,
        expectedAccount: {},
      });
      const { state } = await authorize(intent.intentId);
      provider.answer = async () => grant({ profile: 'ww.renamed' });

      expect(await callback(intent.intentId, { state, code: CODE })).toMatchObject({
        status: 'COMPLETED',
        receipt: { binding: { generation: 4, status: 'PAUSED_IDENTITY_CHANGED' } },
      });
      const pauses = db.tables.managedChangeEvent.filter(
        (event) => event.kind === 'CHANNEL_PAUSED_IDENTITY_CHANGED'
      );
      expect(pauses.map((event) => event.bindingGeneration)).toEqual([3, 4]);
      expect(db.tables.managedChangeEvent.slice(-1)[0]).toMatchObject({
        kind: 'CHANNEL_RECONNECTED',
        bindingGeneration: 4,
      });
    });

    it('refuses a deleted, unknown or other-provider channel', async () => {
      const deleted = seedChannel({ deletedAt: new Date() });
      const other = seedChannel({ internalId: 'x-1', providerIdentifier: 'other' });

      for (const integrationId of [deleted.id, other.id, 'no-such-channel']) {
        expect(
          await refusal(
            service.createIntent(ORG, AI.id, {
              ...reconnectBody(integrationId, 1),
              providerIdentifier: PROVIDER,
            })
          )
        ).toEqual({ status: 409, code: 'INTEGRATION_NOT_RECONNECTABLE' });
      }
    });
  });

  describe('write fence', () => {
    it('refuses the same Integration write outside the managed writer, so the connection path is not a bypass', async () => {
      await expect(
        db.model.integration.create({
          data: {
            organizationId: ORG,
            internalId: 'ig-9',
            name: 'x',
            providerIdentifier: PROVIDER,
            type: 'social',
            token: TOKEN,
          },
        })
      ).rejects.toBeInstanceOf(ManagedWriteRefusedError);
      expect(db.tables.integration).toHaveLength(0);
    });
  });
});
