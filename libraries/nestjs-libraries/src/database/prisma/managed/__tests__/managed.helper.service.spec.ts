// the helper service loads ManagedService (for identityFingerprint), which
// pulls in the media helpers; no storage or sniffer is used here
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({}));
jest.mock(
  'file-type',
  () => ({ fileTypeStream: jest.fn(), fileTypeFromBuffer: jest.fn() }),
  { virtual: true }
);

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HttpException } from '@nestjs/common';
import { ProviderResponse } from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';
import { identityFingerprint } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { ManagedHelperService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.service';
import {
  HelperChannel,
  HelperChannelWithToken,
  HelperIntegrationRow,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.repository';
import { defaultManagedHelperAdapters } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.provider';
import { BindingRow } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { ManagedHelperRequestDto } from '@gitroom/nestjs-libraries/dtos/managed/managed.helper.dto';

// FAKE organization, credential, channel and token; no provider is reached
const ORG = 'org-test-001';
const TOKEN = 'FAKE-CHANNEL-TOKEN-abcdef';
const NOW = new Date('2026-11-05T12:00:00.000Z');
const HELPER_CREDENTIAL = { id: 'ww-helper', organizationId: ORG, tokenSha256: 'x', scopes: ['helpers:read'] } as any;

const ENV = {
  POSTIZ_MANAGED_MODE: 'enabled',
  POSTIZ_MANAGED_ORGANIZATIONS: ORG,
  POSTIZ_MANAGED_HELPER_ORGANIZATIONS: ORG,
  POSTIZ_MANAGED_HELPERS: 'tiktok-business.music-search.v1,instagram.audio-search.v1,linkedin.mention-search.v1',
  POSTIZ_MANAGED_HELPER_EXPIRES_AT: '2026-11-10T23:00:00.000Z',
};
const saved: Record<string, string | undefined> = {};

function integration(overrides: Partial<HelperIntegrationRow> = {}): HelperIntegrationRow {
  return {
    id: 'int1',
    organizationId: ORG,
    providerIdentifier: 'tiktok-business',
    internalId: '7000000000000000001',
    rootInternalId: null,
    profile: 'ww.test.acc',
    name: 'W&W test',
    customName: null,
    disabled: false,
    refreshNeeded: false,
    inBetweenSteps: false,
    deletedAt: null,
    tokenExpiration: new Date('2026-12-01T00:00:00.000Z'),
    ...overrides,
  };
}

function binding(row: HelperIntegrationRow, overrides: Partial<BindingRow> = {}): BindingRow {
  return {
    id: 'b1',
    organizationId: ORG,
    integrationId: row.id,
    generation: 2,
    status: 'QUALIFIED',
    providerIdentifier: row.providerIdentifier,
    internalId: row.internalId,
    profile: row.profile,
    identityFingerprint: identityFingerprint(row),
    qualifiedAt: NOW,
    pausedAt: null,
    ...overrides,
  };
}

function channel(row = integration(), bound: BindingRow | null = binding(row)): HelperChannelWithToken {
  return { integration: row, binding: bound, token: TOKEN };
}

function respond(status: number, payload: unknown): ProviderResponse {
  const parts = [Buffer.from(JSON.stringify(payload))];
  return {
    status,
    body: {
      getReader: () => ({
        read: async () => (parts.length ? { done: false, value: parts.shift() } : { done: true }),
        cancel: async () => undefined,
      }),
    },
  };
}

const MUSIC = { code: 0, data: { list: [{ full_duration_song_clip: { song_clip_id: 'c1' }, commercial_music_name: 'Song', artist: 'A', duration: 20 }] } };

function setup(before: HelperChannelWithToken, after: HelperChannel = before, answer = respond(200, MUSIC)) {
  // only the two reads exist: a helper call has no way to write
  const repository = {
    readChannelWithToken: jest.fn(async () => before),
    readChannel: jest.fn(async () => after),
  };
  const transport = jest.fn(async () => answer);
  const service = new ManagedHelperService(repository as any, defaultManagedHelperAdapters(), transport);
  service.now = () => NOW;
  return { service, repository, transport };
}

const MUSIC_BODY = {
  helper: 'tiktok-business.music-search.v1',
  integrationId: 'int1',
  expectedBindingGeneration: 2,
} as ManagedHelperRequestDto;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    const response = (err as HttpException).getResponse() as any;
    expect(JSON.stringify(response)).not.toContain(TOKEN);
    return response.code;
  }
  throw new Error('expected a refusal');
}

describe('ManagedHelperService', () => {
  beforeEach(() => {
    for (const key of Object.keys(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = (ENV as any)[key];
    }
  });
  afterEach(() => {
    for (const key of Object.keys(ENV)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('answers a qualified channel with the typed, bounded result', async () => {
    const { service, transport, repository } = setup(channel());
    expect(await service.run(HELPER_CREDENTIAL, MUSIC_BODY)).toEqual({
      schemaVersion: 1,
      helper: 'tiktok-business.music-search.v1',
      integrationId: 'int1',
      provider: 'tiktok-business',
      bindingGeneration: 2,
      observedAt: NOW.toISOString(),
      coverage: { partial: true, reasons: ['PROVIDER_PAGE'], returned: 1, limit: 50 },
      items: [{ kind: 'AUDIO', id: 'c1', title: 'Song', artist: 'A', durationMs: 20000 }],
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(repository.readChannelWithToken).toHaveBeenCalledWith(ORG, 'int1');
    expect(repository.readChannel).toHaveBeenCalledWith(ORG, 'int1');
  });

  describe('operator qualification (fail closed, nothing read or called)', () => {
    it.each([
      ['no helper list', { POSTIZ_MANAGED_HELPERS: '' }, 'HELPER_NOT_ENABLED'],
      ['another helper only', { POSTIZ_MANAGED_HELPERS: 'instagram.audio-search.v1' }, 'HELPER_NOT_ENABLED'],
      ['no helper organization', { POSTIZ_MANAGED_HELPER_ORGANIZATIONS: '' }, 'HELPER_ORGANIZATION_NOT_ENABLED'],
      ['organization not managed', { POSTIZ_MANAGED_ORGANIZATIONS: 'other' }, 'HELPER_ORGANIZATION_NOT_ENABLED'],
      ['mode off', { POSTIZ_MANAGED_MODE: 'disabled' }, 'HELPER_ORGANIZATION_NOT_ENABLED'],
      ['no expiry', { POSTIZ_MANAGED_HELPER_EXPIRES_AT: '' }, 'HELPER_ACCESS_EXPIRED'],
      ['expiry past the cap', { POSTIZ_MANAGED_HELPER_EXPIRES_AT: '2026-11-11T00:00:00Z' }, 'HELPER_ACCESS_EXPIRED'],
      ['expired', { POSTIZ_MANAGED_HELPER_EXPIRES_AT: '2026-11-05T11:59:59Z' }, 'HELPER_ACCESS_EXPIRED'],
      ['garbage expiry', { POSTIZ_MANAGED_HELPER_EXPIRES_AT: 'soon' }, 'HELPER_ACCESS_EXPIRED'],
    ])('%s', async (_, env, code) => {
      Object.assign(process.env, env);
      const { service, transport, repository } = setup(channel());
      expect(await refusal(service.run(HELPER_CREDENTIAL, MUSIC_BODY))).toBe(code);
      expect(repository.readChannelWithToken).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    });

    it('refuses a credential that holds any other scope', async () => {
      const { service, transport } = setup(channel());
      for (const scopes of [['helpers:read', 'posts:write'], ['posts:read'], []]) {
        expect(await refusal(service.run({ ...HELPER_CREDENTIAL, scopes }, MUSIC_BODY))).toBe(
          'HELPER_CREDENTIAL_NOT_DEDICATED'
        );
      }
      expect(transport).not.toHaveBeenCalled();
    });

    it('refuses an input field the helper does not take', async () => {
      const { service, transport } = setup(channel());
      expect(await refusal(service.run(HELPER_CREDENTIAL, { ...MUSIC_BODY, query: 'x' }))).toBe('HELPER_INPUT_INVALID');
      expect(
        await refusal(
          service.run(HELPER_CREDENTIAL, { ...MUSIC_BODY, helper: 'linkedin.mention-search.v1', query: '   ' })
        )
      ).toBe('HELPER_INPUT_INVALID');
      expect(transport).not.toHaveBeenCalled();
    });
  });

  describe('channel gate (no provider call)', () => {
    const row = integration();
    it.each([
      ['missing / foreign organization', { integration: null, binding: null, token: null }, 'INTEGRATION_NOT_FOUND'],
      ['deleted', channel(integration({ deletedAt: NOW })), 'CHANNEL_NOT_QUALIFIED'],
      ['deleted after qualifying', channel(integration({ deletedAt: NOW }), binding(row)), 'CHANNEL_NOT_QUALIFIED'],
      ['disabled', channel(integration({ disabled: true })), 'CHANNEL_NOT_QUALIFIED'],
      ['unbound', channel(row, null), 'CHANNEL_NOT_QUALIFIED'],
      ['pending', channel(row, binding(row, { status: 'PENDING_QUALIFICATION' })), 'CHANNEL_NOT_QUALIFIED'],
      ['paused', channel(row, binding(row, { status: 'PAUSED_IDENTITY_CHANGED' })), 'CHANNEL_IDENTITY_CHANGED'],
      ['identity moved', channel(integration({ internalId: '7000000000000000002' }), binding(row)), 'CHANNEL_IDENTITY_CHANGED'],
      ['other generation', channel(row, binding(row, { generation: 3 })), 'BINDING_GENERATION_MISMATCH'],
      ['refresh needed', channel(integration({ refreshNeeded: true })), 'RECONNECT_REQUIRED'],
      ['token expired', channel(integration({ tokenExpiration: NOW })), 'RECONNECT_REQUIRED'],
      ['no token', { ...channel(), token: '' }, 'RECONNECT_REQUIRED'],
    ])('%s', async (_, before, code) => {
      const { service, transport } = setup(before as HelperChannelWithToken);
      expect(await refusal(service.run(HELPER_CREDENTIAL, MUSIC_BODY))).toBe(code);
      expect(transport).not.toHaveBeenCalled();
    });

    it('refuses a provider the helper was not grounded for (instagram-standalone has no audioSearch)', async () => {
      const standalone = integration({ providerIdentifier: 'instagram-standalone' });
      const { service, transport } = setup(channel(standalone));
      expect(
        await refusal(
          service.run(HELPER_CREDENTIAL, {
            helper: 'instagram.audio-search.v1',
            integrationId: 'int1',
            expectedBindingGeneration: 2,
            kind: 'music',
          })
        )
      ).toBe('HELPER_NOT_SUPPORTED_FOR_PROVIDER');
      expect(transport).not.toHaveBeenCalled();
    });

    it('serves linkedin-page through the inherited mention request', async () => {
      const page = integration({ providerIdentifier: 'linkedin-page', internalId: '90001' });
      const { service, transport } = setup(
        channel(page),
        channel(page),
        respond(200, { elements: [{ id: 5, localizedName: 'Acme' }] })
      );
      const result = await service.run(HELPER_CREDENTIAL, {
        helper: 'linkedin.mention-search.v1',
        integrationId: 'int1',
        expectedBindingGeneration: 2,
        query: 'acme',
      });
      expect(result.provider).toBe('linkedin-page');
      expect(result.items).toEqual([{ kind: 'MENTION', id: '5', label: 'Acme', mention: '@[Acme](urn:li:organization:5)' }]);
      expect(transport).toHaveBeenCalledTimes(1);
    });
  });

  describe('after the provider answered', () => {
    const row = integration();
    it.each([
      ['rebound to the next generation', channel(row, binding(row, { generation: 3 }))],
      ['paused', channel(row, binding(row, { status: 'PAUSED_IDENTITY_CHANGED' }))],
      ['marked refreshNeeded', channel(integration({ refreshNeeded: true }))],
      ['deleted', { integration: null, binding: null }],
    ])('discards the answer when the channel was %s meanwhile', async (_, after) => {
      const { service, transport } = setup(channel(), after as HelperChannel);
      expect(await refusal(service.run(HELPER_CREDENTIAL, MUSIC_BODY))).toBe('BINDING_CHANGED_DURING_CALL');
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it('turns a refused token into RECONNECT_REQUIRED, once, without a refresh or a write', async () => {
      const { service, transport, repository } = setup(
        channel(),
        channel(),
        respond(200, { code: 40105, message: 'access_token_invalid' })
      );
      expect(await refusal(service.run(HELPER_CREDENTIAL, MUSIC_BODY))).toBe('RECONNECT_REQUIRED');
      expect(transport).toHaveBeenCalledTimes(1);
      expect(Object.keys(repository)).toEqual(['readChannelWithToken', 'readChannel']);
    });

    it('reports a provider failure by reason only', async () => {
      const { service } = setup(channel(), channel(), respond(500, { error: TOKEN }));
      try {
        await service.run(HELPER_CREDENTIAL, MUSIC_BODY);
        throw new Error('expected a refusal');
      } catch (err) {
        expect((err as HttpException).getStatus()).toBe(502);
        expect((err as HttpException).getResponse()).toEqual({
          code: 'PROVIDER_CALL_FAILED',
          msg: 'The provider lookup gave no usable answer; nothing was retried',
          reason: 'PROVIDER_ERROR',
        });
      }
    });

    it.each(['open', 'read'])('replaces an unexpected stream %s error without exposing provider secrets', async (failure) => {
      const sensitive = `https://graph.synthetic.invalid/search?access_token=${TOKEN}`;
      const answer = {
        status: 200,
        body: { getReader: () => {
          if (failure === 'open') throw new Error(sensitive);
          return { read: async () => { throw new Error(sensitive); }, cancel: async () => undefined };
        } },
      } as ProviderResponse;
      const { service, repository, transport } = setup(channel(), channel(), answer);
      try {
        await service.run(HELPER_CREDENTIAL, MUSIC_BODY);
        throw new Error('expected a refusal');
      } catch (err) {
        const error = err as HttpException;
        expect(error.getStatus()).toBe(502);
        expect(error.getResponse()).toEqual({ code: 'PROVIDER_CALL_FAILED',
          msg: 'The provider lookup gave no usable answer; nothing was retried', reason: 'NETWORK' });
        expect(`${String(err)}${error.stack}${JSON.stringify(error.getResponse())}`).not.toContain(TOKEN);
        expect(`${String(err)}${error.stack}`).not.toContain('graph.synthetic.invalid');
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      }
      expect(transport).toHaveBeenCalledTimes(1);
      expect(repository.readChannel).not.toHaveBeenCalled();
    });

    it('stops the provider call when the client goes away', async () => {
      const repository = {
        readChannelWithToken: jest.fn(async () => channel()),
        readChannel: jest.fn(async () => channel()),
      };
      const transport = jest.fn(
        (url: string, request: any) =>
          new Promise<ProviderResponse>((resolve, reject) =>
            request.signal.addEventListener('abort', () => reject(new Error(url)))
          )
      );
      const service = new ManagedHelperService(repository as any, defaultManagedHelperAdapters(), transport);
      service.now = () => NOW;
      const client = new AbortController();
      const pending = service.run(HELPER_CREDENTIAL, MUSIC_BODY, client.signal);
      setTimeout(() => client.abort(), 5);
      expect(await refusal(pending)).toBe('PROVIDER_CALL_FAILED');
      expect(repository.readChannel).not.toHaveBeenCalled();
    });
  });
});

describe('ManagedHelperRequestDto', () => {
  const errorsOf = async (body: object) =>
    (
      await validate(plainToInstance(ManagedHelperRequestDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    ).map((error) => error.property);

  it('accepts the closed helper input', async () => {
    expect(await errorsOf({ ...MUSIC_BODY, genre: 'POP' })).toEqual([]);
    expect(
      await errorsOf({ helper: 'instagram.audio-search.v1', integrationId: 'int1', expectedBindingGeneration: 1, kind: 'original_sound', query: 'lofi' })
    ).toEqual([]);
  });

  it('refuses caller URLs, method names, credentials, providers and unknown helpers', async () => {
    for (const extra of [
      { url: 'https://graph.facebook.com/' },
      { methodName: 'audioSearch' },
      { name: 'mention' },
      { accessToken: TOKEN },
      { providerIdentifier: 'instagram' },
      { organizationId: 'other' },
    ]) {
      expect(await errorsOf({ ...MUSIC_BODY, ...extra })).toEqual([Object.keys(extra)[0]]);
    }
    expect(await errorsOf({ ...MUSIC_BODY, helper: 'instagram.audioSearch' })).toEqual(['helper']);
    expect(await errorsOf({ ...MUSIC_BODY, helper: 'tiktok.function' })).toEqual(['helper']);
  });

  it('refuses malformed values', async () => {
    expect(await errorsOf({ ...MUSIC_BODY, expectedBindingGeneration: 0 })).toEqual(['expectedBindingGeneration']);
    expect(await errorsOf({ ...MUSIC_BODY, integrationId: '../x' })).toEqual(['integrationId']);
    expect(await errorsOf({ ...MUSIC_BODY, genre: 'pop&x=1' })).toEqual(['genre']);
    expect(await errorsOf({ ...MUSIC_BODY, query: 'a\nb' })).toEqual(['query']);
    expect(await errorsOf({ ...MUSIC_BODY, query: 'a'.repeat(101) })).toEqual(['query']);
    expect(await errorsOf({ ...MUSIC_BODY, kind: 'video' })).toEqual(['kind']);
  });
});
