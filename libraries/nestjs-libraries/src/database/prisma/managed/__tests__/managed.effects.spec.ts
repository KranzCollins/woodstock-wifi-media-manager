// External-effect entry points refuse a W&W managed organization before the
// FAKE provider / AI / processor / feed is reached, and still reach it for an
// unmanaged organization. The services' own code runs; their collaborators
// are FAKE modules.
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }), { virtual: true });
jest.mock(
  '@temporalio/common',
  () => ({
    TypedSearchAttributes: class {},
    ApplicationFailure: class extends Error {
      constructor(message: string, public type?: string, public nonRetryable?: boolean) {
        super(message);
      }
    },
  }),
  { virtual: true }
);
jest.mock('@langchain/langgraph', () => ({ END: 'END', START: 'START', StateGraph: class {} }), {
  virtual: true,
});
jest.mock('@langchain/openai', () => ({ ChatOpenAI: class {}, DallEAPIWrapper: class {} }), {
  virtual: true,
});
jest.mock('@langchain/core/messages', () => ({}), { virtual: true });
jest.mock('@langchain/core/prompts', () => ({ ChatPromptTemplate: class {} }), { virtual: true });
jest.mock('rss-parser', () => class {}, { virtual: true });
jest.mock('jsdom', () => ({ JSDOM: class {} }), { virtual: true });
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock('@gitroom/nestjs-libraries/integrations/social/social.integrations.interface', () => ({}));
jest.mock('@gitroom/nestjs-libraries/integrations/social.abstract', () => ({
  NotEnoughScopes: class extends Error {},
  RefreshToken: class extends Error {},
  truncateForTemporal: (message: string) => message,
}));
jest.mock('@gitroom/nestjs-libraries/integrations/refresh.integration.service', () => ({
  RefreshIntegrationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository', () => ({
  IntegrationRepository: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/autopost/autopost.repository', () => ({
  AutopostRepository: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/notifications/notification.service', () => ({
  NotificationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/media/media.repository', () => ({
  MediaRepository: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/clipping/clipping.repository', () => ({
  ClippingRepository: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.repository', () => ({
  SubscriptionRepository: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/organizations/organization.service', () => ({
  OrganizationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/posts/posts.service', () => ({
  PostsService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/openai/openai.service', () => ({ OpenaiService: class {} }));
jest.mock('@gitroom/nestjs-libraries/openai/generation.error', () => ({
  generationError: (err: any) => err,
}));
jest.mock('@gitroom/nestjs-libraries/deepgram/deepgram.service', () => ({
  DeepgramService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/videos/video.manager', () => ({ VideoManager: class {} }));
jest.mock('@gitroom/nestjs-libraries/videos/video.interface', () => ({ VideoAbstract: class {} }));
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator', () => ({
  IsSafeWebhookUrl: () => () => undefined,
  isSafePublicHttpsUrl: jest.fn(),
}));
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: {
    createStorage: () => ({}),
    createProcessor: (): null => null,
    createIngestProcessor: (): null => null,
    createClipProcessor: (): null => null,
  },
}));
jest.mock('@gitroom/nestjs-libraries/upload/custom.upload.validation', () => ({
  getMaxSize: () => 1024,
  uploadStreamToStorage: jest.fn(),
}));
jest.mock('@gitroom/nestjs-libraries/upload/media.processor.interface', () => ({}));
jest.mock('@gitroom/nestjs-libraries/upload/clipping.processor.interface', () => ({}));
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher', () => ({
  ssrfSafeDispatcher: {},
}));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({ ioRedis: {} }));
jest.mock('@gitroom/nestjs-libraries/temporal/temporal.search.attribute', () => ({
  organizationId: {},
}));
jest.mock('@gitroom/nestjs-libraries/services/make.is', () => ({ makeId: () => 'FAKE-id' }));
jest.mock('@gitroom/helpers/utils/timer', () => ({ timer: async () => undefined }));
jest.mock('@gitroom/backend/services/auth/permissions/permission.exception.class', () => ({
  AuthorizationActions: {},
  Sections: {},
  SubscriptionException: class extends Error {},
}));
jest.mock('@gitroom/backend/services/auth/permissions/permissions.ability', () => ({
  CheckPolicies: () => () => undefined,
}));
// FAKE connect helpers: each call would reach Telegram / Moltbook
const mockTelegramGetBotId = jest.fn(async () => ({ id: 'FAKE-bot' }));
const mockMoltbookRegister = jest.fn(async () => ({ api_key: 'FAKE-key' }));
const mockMoltbookStatus = jest.fn(async () => ({ status: 'claimed' }));
jest.mock('@gitroom/nestjs-libraries/integrations/social/telegram.provider', () => ({
  TelegramProvider: class {
    getBotId = mockTelegramGetBotId;
  },
}));
jest.mock('@gitroom/nestjs-libraries/integrations/social/moltbook.provider', () => ({
  MoltbookProvider: class {
    registerAgent = mockMoltbookRegister;
    checkAgentStatus = mockMoltbookStatus;
  },
}));

import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ClippingService } from '@gitroom/nestjs-libraries/database/prisma/clipping/clipping.service';
import { AutopostService } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.service';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { IntegrationsController } from '@gitroom/backend/api/routes/integrations.controller';
import {
  ManagedEffectRefusedError,
  ManagedWriteRefusedError,
  refuseManagedEffect,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';

const MANAGED = '11111111-1111-4111-8111-111111111111';
const UNMANAGED = '99999999-9999-4999-8999-999999999999';

// a service instance without its constructor: only the FAKE fields it uses
const instance = <T>(type: { prototype: T }, fields: Record<string, any>): any =>
  Object.assign(Object.create(type.prototype), fields);

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err: any) {
    return { status: err.getStatus?.(), code: err.getResponse?.()?.code, message: err.message };
  }
  throw new Error('expected a refusal');
}

describe('external effects of a managed organization', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = MANAGED;
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
    // none of these paths may reach the network for a managed organization
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refuseManagedEffect only refuses managed organizations', () => {
    expect(() => refuseManagedEffect(MANAGED, 'x')).toThrow(ManagedEffectRefusedError);
    expect(() => refuseManagedEffect(UNMANAGED, 'x')).not.toThrow();
    expect(() => refuseManagedEffect(undefined, 'x')).not.toThrow();

    delete process.env.POSTIZ_MANAGED_MODE;
    expect(() => refuseManagedEffect(MANAGED, 'x')).not.toThrow();
  });

  describe('IntegrationService', () => {
    // FAKE provider: every call would be an external effect
    const provider = () => ({
      refreshToken: jest.fn(async () => ({
        accessToken: 'FAKE-access',
        refreshToken: 'FAKE-rotated',
        expiresIn: 100,
      })),
      fetchPageInformation: jest.fn(),
      autoRepost: jest.fn(async () => true),
    });

    it('the refresh command never refreshes (or rotates) a managed channel', async () => {
      const fake = provider();
      const service = instance(IntegrationService, {
        _integrationRepository: {
          needsToBeRefreshed: async () => [
            { organizationId: MANAGED, providerIdentifier: 'x', refreshToken: 'FAKE-managed' },
            { organizationId: UNMANAGED, providerIdentifier: 'x', refreshToken: 'FAKE-unmanaged' },
          ],
          refreshNeeded: jest.fn(),
        },
        _integrationManager: { getSocialIntegration: jest.fn(() => fake) },
      });
      service.createOrUpdateIntegration = jest.fn(async () => undefined);

      await service.refreshTokens();

      expect(fake.refreshToken).toHaveBeenCalledTimes(1);
      expect(fake.refreshToken).toHaveBeenCalledWith('FAKE-unmanaged');
      expect(service.createOrUpdateIntegration).toHaveBeenCalledTimes(1);
      expect(service.createOrUpdateIntegration.mock.calls[0][2]).toBe(UNMANAGED);
    });

    it('page selection is refused before the provider is asked', async () => {
      const fake = provider();
      const repository = { getIntegrationById: jest.fn() };
      const service = instance(IntegrationService, {
        _integrationRepository: repository,
        _integrationManager: { getSocialIntegration: jest.fn(() => fake) },
      });

      expect(await refusal(service.saveProviderPage(MANAGED, 'int-1', {}))).toMatchObject({
        status: 403,
        code: 'MANAGED_EFFECT_REFUSED',
      });
      expect(repository.getIntegrationById).not.toHaveBeenCalled();
      expect(fake.fetchPageInformation).not.toHaveBeenCalled();
    });

    it('global plugs of a managed channel never run', async () => {
      const fake = provider();
      const plug = (organizationId: string) => ({
        integration: { organizationId, providerIdentifier: 'x' },
        plugFunction: 'autoRepost',
        data: '[]',
      });
      const getPlug = jest.fn();
      const service = instance(IntegrationService, {
        _integrationRepository: { getPlug },
        _integrationManager: { getSocialIntegration: jest.fn(() => fake) },
      });
      const run = { plugId: 'p', postId: 'post', delay: 0, totalRuns: 3, currentRun: 1 };

      getPlug.mockResolvedValueOnce(plug(MANAGED));
      expect(await service.processPlugs(run)).toBe(true);
      expect(fake.autoRepost).not.toHaveBeenCalled();

      getPlug.mockResolvedValueOnce(plug(UNMANAGED));
      await service.processPlugs(run);
      expect(fake.autoRepost).toHaveBeenCalledTimes(1);
    });
  });

  describe('MediaService', () => {
    const fakes = () => ({
      processor: {
        submit: jest.fn(async () => 'FAKE-job'),
        status: jest.fn(),
      },
      storage: {
        signDownloadUrl: jest.fn(async () => 'https://FAKE-signed/download'),
        signUploadUrl: jest.fn(async () => 'https://FAKE-signed/upload'),
        removeFile: jest.fn(),
      },
      _mediaRepository: {
        getMediaById: jest.fn(),
        finishProcessing: jest.fn(),
        startProcessing: jest.fn(),
      },
      _subscriptionService: { useCredit: jest.fn(), checkCredits: jest.fn() },
      _openAi: { generateImage: jest.fn(), generatePromptForPicture: jest.fn() },
      _videoManager: { getVideoByName: jest.fn() },
    });

    it('never submits a managed organization media to the processor (in-place rewrite)', async () => {
      const fields = fakes();
      const service = instance(MediaService, fields);
      fields._mediaRepository.getMediaById.mockResolvedValue({
        id: 'm',
        organizationId: MANAGED,
        name: 'clip.mp4',
        path: 'https://FAKE/clip.mp4',
        status: 'processing',
      });

      expect(await service.submitProcessing('m')).toBeNull();
      expect(await service.checkProcessing('m', 'FAKE-job')).toBe(true);
      await service.failProcessing('m', 'x');

      expect(fields.processor.submit).not.toHaveBeenCalled();
      expect(fields.processor.status).not.toHaveBeenCalled();
      expect(fields.storage.signUploadUrl).not.toHaveBeenCalled();
      expect(fields._mediaRepository.finishProcessing).not.toHaveBeenCalled();
    });

    it('still submits an unmanaged organization media', async () => {
      const fields = fakes();
      const service = instance(MediaService, fields);
      fields._mediaRepository.getMediaById.mockResolvedValue({
        id: 'm',
        organizationId: UNMANAGED,
        name: 'clip.mp4',
        path: 'https://FAKE/clip.mp4',
        status: 'processing',
      });

      expect(await service.submitProcessing('m')).toBe('FAKE-job');
      expect(fields.processor.submit).toHaveBeenCalledTimes(1);
    });

    it('refuses URL uploads and paid generation before any fetch or credit', async () => {
      const fields = fakes();
      const service = instance(MediaService, fields);
      const org = { id: MANAGED, isTrailing: false } as any;

      for (const attempt of [
        service.uploadFromUrl(MANAGED, 'https://FAKE.example/a.png'),
        service.generateImage('prompt', org),
        service.generateVideo(org, { type: 'x' } as any),
        service.startGenerateVideo(org, { type: 'x' } as any),
        service.videoFunction(MANAGED, 'FAKE-video', 'loadVoices', {}),
      ]) {
        expect(await refusal(attempt)).toMatchObject({
          status: 403,
          code: 'MANAGED_EFFECT_REFUSED',
        });
      }

      expect(fields._subscriptionService.useCredit).not.toHaveBeenCalled();
      expect(fields._subscriptionService.checkCredits).not.toHaveBeenCalled();
      expect(fields._openAi.generateImage).not.toHaveBeenCalled();
      expect(fields._videoManager.getVideoByName).not.toHaveBeenCalled();
    });

    it('still resolves the video helper for an unmanaged organization', async () => {
      const fields = fakes();
      const service = instance(MediaService, fields);

      // the FAKE manager knows no video, so the lookup itself is the proof
      await service
        .videoFunction(UNMANAGED, 'FAKE-video', 'loadVoices', {})
        .catch(() => undefined);
      expect(fields._videoManager.getVideoByName).toHaveBeenCalledWith('FAKE-video');
    });
  });

  describe('ClippingService', () => {
    const fakes = () => ({
      ingest: { submit: jest.fn(), status: jest.fn() },
      clipper: { submit: jest.fn(), status: jest.fn() },
      storage: {
        signDownloadUrl: jest.fn(async () => 'https://FAKE-signed'),
        signUploadUrl: jest.fn(async () => 'https://FAKE-signed'),
        readFile: jest.fn(async () => '[]'),
      },
      _clippingRepository: {
        getClippingById: jest.fn(async () => ({
          id: 'c',
          organizationId: MANAGED,
          url: 'https://youtube.com/watch?v=FAKE',
          status: 'pending',
          clips: [],
        })),
        getClipById: jest.fn(async () => ({
          id: 'clip',
          clippingId: 'c',
          start: 0,
          end: 30,
          clipping: { organizationId: MANAGED, url: 'https://youtube.com/watch?v=FAKE' },
        })),
        updateClipping: jest.fn(),
      },
      _subscriptionService: { checkCredits: jest.fn(), chargeCredits: jest.fn() },
      _deepgram: { transcribeUrl: jest.fn() },
      _openAi: { pickClips: jest.fn() },
    });

    it('refuses every paid step before the ingest, transcriber, model or renderer', async () => {
      const fields = fakes();
      const service = instance(ClippingService, fields);

      expect(
        await refusal(service.startClipping({ id: MANAGED } as any, { url: 'x' } as any))
      ).toMatchObject({ status: 403, code: 'MANAGED_EFFECT_REFUSED' });

      for (const step of [
        service.submitAnalyse('c'),
        service.transcribe('c'),
        service.pickClips('c'),
        service.submitClipFetch('clip'),
        service.captionClip('clip'),
        service.submitClipRender('clip'),
      ]) {
        expect((await refusal(step)).message).toContain('managed by W&W');
      }

      expect(fields.ingest.submit).not.toHaveBeenCalled();
      expect(fields.clipper.submit).not.toHaveBeenCalled();
      expect(fields._deepgram.transcribeUrl).not.toHaveBeenCalled();
      expect(fields._openAi.pickClips).not.toHaveBeenCalled();
      expect(fields.storage.signUploadUrl).not.toHaveBeenCalled();
      expect(fields._clippingRepository.updateClipping).not.toHaveBeenCalled();
    });
  });

  describe('AutopostService', () => {
    it('never loads the feed or generates anything for a managed organization', async () => {
      const service = instance(AutopostService, {
        _autopostsRepository: {
          getAutopost: jest.fn(async () => ({
            id: 'a',
            active: true,
            organizationId: MANAGED,
            url: 'https://FAKE.example/feed.xml',
          })),
        },
        _integrationService: { getIntegrationsList: jest.fn() },
      });
      const loadXML = jest.spyOn(AutopostService.prototype, 'loadXML');

      expect(await service.startAutopost('a')).toBeUndefined();
      expect(loadXML).not.toHaveBeenCalled();
      expect(service._integrationService.getIntegrationsList).not.toHaveBeenCalled();
      loadXML.mockRestore();
    });
  });

  describe('IntegrationsController connect helpers', () => {
    beforeEach(() => {
      mockTelegramGetBotId.mockClear();
      mockMoltbookRegister.mockClear();
      mockMoltbookStatus.mockClear();
    });

    it('refuses the Telegram and Moltbook connect steps before the provider is called', async () => {
      const controller = instance(IntegrationsController, {});
      const org = { id: MANAGED } as any;

      for (const attempt of [
        () => controller.getUpdates(org, { word: 'FAKE' }),
        // a refusal is not swallowed into { error } by the route's catch
        () => controller.moltbookRegister(org, { name: 'FAKE', description: 'FAKE' }),
        () => controller.moltbookStatus(org, 'FAKE-key'),
      ]) {
        expect(await refusal(attempt())).toMatchObject({
          status: 403,
          code: 'MANAGED_EFFECT_REFUSED',
        });
      }

      expect(mockTelegramGetBotId).not.toHaveBeenCalled();
      expect(mockMoltbookRegister).not.toHaveBeenCalled();
      expect(mockMoltbookStatus).not.toHaveBeenCalled();
    });

    it('still runs them for an unmanaged organization', async () => {
      const controller = instance(IntegrationsController, {});
      const org = { id: UNMANAGED } as any;

      expect(await controller.getUpdates(org, { word: 'FAKE' })).toEqual({ id: 'FAKE-bot' });
      expect(await controller.moltbookStatus(org, 'FAKE-key')).toEqual({ claimed: true });
      expect(mockTelegramGetBotId).toHaveBeenCalledTimes(1);
      expect(mockMoltbookStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('SubscriptionService (billing webhook path)', () => {
    it('completes a plan change of a managed organization although its channel writes are refused', async () => {
      const refused = () =>
        Promise.reject(new ManagedWriteRefusedError('Integration', 'updateMany', MANAGED));
      const integrationService = {
        getIntegrationsList: jest.fn(async () => [
          { disabled: false },
          { disabled: false },
          { disabled: false },
        ]),
        disableIntegrations: jest.fn(refused),
        enableAllIntegrations: jest.fn(refused),
        changeActiveCron: jest.fn(refused),
      };
      const organizationService = { disableOrEnableNonSuperAdminUsers: jest.fn() };
      const service = new SubscriptionService(
        {
          getSubscriptionByOrgId: jest.fn(async () => ({
            subscriptionTier: 'TEAM',
            totalChannels: 5,
          })),
        } as any,
        integrationService as any,
        organizationService as any
      );
      const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(service.modifySubscriptionByOrg(MANAGED, 1, 'FREE')).resolves.toBe(true);

      expect(integrationService.disableIntegrations).toHaveBeenCalledTimes(1);
      expect(integrationService.changeActiveCron).toHaveBeenCalledTimes(1);
      // the rest of the change was still applied
      expect(organizationService.disableOrEnableNonSuperAdminUsers).toHaveBeenCalledWith(
        MANAGED,
        true
      );
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });
  });
});
