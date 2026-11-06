// Effects that happened before the write fence could refuse: paid AI post
// generation, short links on post create, third-party connect / delete, and
// another organization adopting a W&W reserved object through save-media.
// The routes' and PostsService's own code runs; collaborators are FAKE.
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }), { virtual: true });
jest.mock('@temporalio/common', () => ({ TypedSearchAttributes: class {} }), { virtual: true });
jest.mock('@sentry/nestjs', () => ({ metrics: { count: jest.fn() } }));
jest.mock('sharp', () => jest.fn());
jest.mock('nestjs-real-ip', () => ({ RealIP: () => () => undefined }), { virtual: true });
jest.mock('@gitroom/nestjs-libraries/database/prisma/posts/posts.repository', () => ({
  PostsRepository: class {},
}));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock('@gitroom/nestjs-libraries/integrations/social/social.integrations.interface', () => ({}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/integrations/integration.service', () => ({
  IntegrationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/media/media.service', () => ({
  MediaService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/short-linking/short.link.service', () => ({
  ShortLinkService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/dtos/posts/create.post.dto', () => ({
  CreatePostDto: class {},
}));
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher', () => ({
  getSsrfSafeAxios: jest.fn(),
}));
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator', () => ({
  IsSafeWebhookUrl: () => () => undefined,
}));
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({
  streamUploadOptions: () => ({}),
}));
jest.mock('@gitroom/nestjs-libraries/openai/openai.service', () => ({ OpenaiService: class {} }));
jest.mock('@gitroom/nestjs-libraries/temporal/temporal.search.attribute', () => ({
  organizationId: {},
  postId: {},
}));
jest.mock('@gitroom/helpers/utils/timer', () => ({ timer: async () => undefined }));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({ ioRedis: {} }));
jest.mock('@gitroom/nestjs-libraries/integrations/social.abstract', () => ({
  RefreshToken: class extends Error {},
}));
jest.mock('@gitroom/nestjs-libraries/integrations/refresh.integration.service', () => ({
  RefreshIntegrationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/agent/agent.graph.service', () => ({
  AgentGraphService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/3rdparties/thirdparty.manager', () => ({
  ThirdPartyManager: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service', () => ({
  SubscriptionService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/videos/video.interface', () => ({ VideoAbstract: class {} }));
jest.mock('@gitroom/helpers/auth/auth.service', () => ({
  AuthService: { fixedDecryption: (value: string) => value },
}));
jest.mock('@gitroom/backend/services/auth/permissions/permission.exception.class', () => ({
  AuthorizationActions: {},
  Sections: {},
}));
jest.mock('@gitroom/backend/services/auth/permissions/permissions.ability', () => ({
  CheckPolicies: () => () => undefined,
}));

jest.mock('@copilotkit/runtime', () => ({
  CopilotRuntime: jest.fn(), OpenAIAdapter: jest.fn(),
  copilotRuntimeNodeHttpEndpoint: jest.fn(() => jest.fn(() => 'FAKE-handler-result')),
}));
jest.mock('@ag-ui/mastra', () => ({ MastraAgent: { getLocalAgents: jest.fn(() => ({})) } }));
jest.mock('@mastra/core/di', () => ({ RequestContext: class { set() {} } }));
jest.mock('@gitroom/nestjs-libraries/chat/mastra.service', () => ({ MastraService: class {} }));
import { CopilotController } from '@gitroom/backend/api/routes/copilot.controller';
import { OpenAIAdapter, copilotRuntimeNodeHttpEndpoint } from '@copilotkit/runtime';

import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { PostsController } from '@gitroom/backend/api/routes/posts.controller';
import { ThirdPartyController } from '@gitroom/backend/api/routes/third-party.controller';
import { MediaController } from '@gitroom/backend/api/routes/media.controller';

const MANAGED = '11111111-1111-4111-8111-111111111111';
const UNMANAGED = '99999999-9999-4999-8999-999999999999';

// a service instance without its constructor: only the FAKE fields it uses
const instance = <T>(type: { prototype: T }, fields: Record<string, any>): any =>
  Object.assign(Object.create(type.prototype), fields);

async function refusal(run: () => unknown) {
  try {
    await run();
  } catch (err: any) {
    return { status: err.getStatus?.(), code: err.getResponse?.()?.code };
  }
  throw new Error('expected a refusal');
}

const REFUSED = { status: 403, code: 'MANAGED_EFFECT_REFUSED' };

describe('effects a managed organization reached before the fence', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = MANAGED;
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  describe('Copilot paid chat', () => {
    let oldKey: string | undefined;
    beforeEach(() => { oldKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'FAKE-key-never-sent'; jest.clearAllMocks(); });
    afterEach(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
    it('refuses chat and agent before constructing a billed runtime', async () => {
      const mastra = jest.fn(async () => ({}));
      const controller = new CopilotController({} as any, { mastra } as any);
      expect(await refusal(() => controller.chatAgent({} as any, {} as any, { id: MANAGED } as any))).toEqual(REFUSED);
      expect(await refusal(() => controller.agent({} as any, {} as any, { id: MANAGED } as any))).toEqual(REFUSED);
      expect(mastra).not.toHaveBeenCalled();
      expect(OpenAIAdapter).not.toHaveBeenCalled();
      expect(copilotRuntimeNodeHttpEndpoint).not.toHaveBeenCalled();
    });
    it('preserves nonmanaged chat routing using fake, nonbilling collaborators', async () => {
      const controller = new CopilotController({} as any, { mastra: async () => ({}) } as any);
      expect(controller.chatAgent({} as any, {} as any, { id: UNMANAGED } as any)).toBe('FAKE-handler-result');
      expect(await controller.agent({} as any, {} as any, { id: UNMANAGED } as any)).toBe('FAKE-handler-result');
      expect(OpenAIAdapter).toHaveBeenCalledTimes(2);
    });
  });

  describe('PostsService', () => {
    const fakes = () => ({
      _postRepository: {
        getPostById: jest.fn(async (): Promise<any> => undefined),
        createOrUpdatePost: jest.fn(async () => ({ posts: [] as any[] })),
        updateReleaseId: jest.fn(async () => ({ id: 'post-1' })),
      },
      _integrationManager: {
        getSocialIntegration: jest.fn(() => ({ releaseUrl: jest.fn() })),
      },
      // FAKE shortener: a call would create links in the operator's account
      _shortLinkService: {
        convertTextToShortLinks: jest.fn(async (_org: string, messages: string[]) => messages),
      },
    });

    const body = () =>
      ({
        type: 'schedule',
        shortLink: true,
        date: '2026-11-08T09:00:00',
        tags: [],
        posts: [
          {
            integration: { id: 'int-1' },
            settings: { __type: 'x' },
            value: [{ id: 'post-1', content: 'FAKE https://example.com/a', image: [] }],
          },
        ],
      } as any);

    it('createPost refuses before short links, the republish lookup or the write', async () => {
      const fields = fakes();
      const service = instance(PostsService, fields);

      expect(await refusal(() => service.createPost(MANAGED, body(), 'WEB'))).toEqual(REFUSED);
      expect(fields._shortLinkService.convertTextToShortLinks).not.toHaveBeenCalled();
      expect(fields._postRepository.getPostById).not.toHaveBeenCalled();
      expect(fields._integrationManager.getSocialIntegration).not.toHaveBeenCalled();
      expect(fields._postRepository.createOrUpdatePost).not.toHaveBeenCalled();
    });

    it('createPost still shortens and writes for an unmanaged organization', async () => {
      const fields = fakes();
      const service = instance(PostsService, fields);

      expect(await service.createPost(UNMANAGED, body(), 'WEB')).toEqual([]);
      expect(fields._shortLinkService.convertTextToShortLinks).toHaveBeenCalledTimes(1);
      expect(fields._postRepository.createOrUpdatePost).toHaveBeenCalledTimes(1);
    });

    it('updateReleaseId refuses before the provider is asked with the stored token', async () => {
      const fields = fakes();
      const service = instance(PostsService, fields);

      expect(await refusal(() => service.updateReleaseId(MANAGED, 'post-1', 'r'))).toEqual(
        REFUSED
      );
      expect(fields._postRepository.getPostById).not.toHaveBeenCalled();
      expect(fields._integrationManager.getSocialIntegration).not.toHaveBeenCalled();
      expect(fields._postRepository.updateReleaseId).not.toHaveBeenCalled();

      await service.updateReleaseId(UNMANAGED, 'post-1', 'r');
      expect(fields._postRepository.updateReleaseId).toHaveBeenCalledTimes(1);
    });
  });

  describe('PostsController AI generation', () => {
    const fakes = () => {
      const agent = {
        // FAKE agent: each run would call the model and upload an image
        start: jest.fn(async function* () {
          yield { name: 'FAKE-event' };
        }),
      };
      const postsService = { separatePosts: jest.fn(async () => ({ posts: ['FAKE'] })) };
      const res = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };
      return {
        agent,
        postsService,
        res,
        controller: new PostsController(postsService as any, agent as any, {} as any),
      };
    };

    it('refuses /posts/generator before the agent runs or the stream starts', async () => {
      const { agent, res, controller } = fakes();

      expect(
        await refusal(() =>
          controller.generatePosts({ id: MANAGED } as any, {} as any, res as any)
        )
      ).toEqual(REFUSED);
      expect(agent.start).not.toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });

    it('refuses /posts/separate-posts before the model is called', async () => {
      const { postsService, controller } = fakes();

      expect(
        await refusal(() =>
          controller.separatePosts({ id: MANAGED } as any, { content: 'FAKE', len: 2 })
        )
      ).toEqual(REFUSED);
      expect(postsService.separatePosts).not.toHaveBeenCalled();
    });

    it('still generates for an unmanaged organization', async () => {
      const { agent, postsService, res, controller } = fakes();

      await controller.generatePosts({ id: UNMANAGED } as any, {} as any, res as any);
      expect(agent.start).toHaveBeenCalledTimes(1);
      expect(res.write).toHaveBeenCalledWith(JSON.stringify({ name: 'FAKE-event' }) + '\n');
      expect(res.end).toHaveBeenCalledTimes(1);

      await controller.separatePosts({ id: UNMANAGED } as any, { content: 'FAKE', len: 2 });
      expect(postsService.separatePosts).toHaveBeenCalledWith('FAKE', 2);
    });
  });

  describe('ThirdPartyController connect / delete', () => {
    const fakes = () => {
      // FAKE vendor: checkConnection is an outbound call with the given key
      const vendor = {
        checkConnection: jest.fn(async () => ({ name: 'FAKE', username: 'FAKE', id: 'FAKE' })),
      };
      const manager = {
        getThirdPartyByName: jest.fn(() => ({ instance: vendor })),
        saveIntegration: jest.fn(async () => ({ id: 'FAKE-third-party' })),
        deleteIntegration: jest.fn(async () => ({ id: 'FAKE-third-party' })),
      };
      return {
        vendor,
        manager,
        controller: new ThirdPartyController(manager as any, {} as any),
      };
    };

    it('refuses before the vendor is called or the key is stored or removed', async () => {
      const { vendor, manager, controller } = fakes();
      const org = { id: MANAGED } as any;

      expect(await refusal(() => controller.addApiKey(org, 'heygen', 'FAKE-key'))).toEqual(
        REFUSED
      );
      expect(await refusal(() => controller.deleteById(org, 'FAKE-third-party'))).toEqual(
        REFUSED
      );

      expect(manager.getThirdPartyByName).not.toHaveBeenCalled();
      expect(vendor.checkConnection).not.toHaveBeenCalled();
      expect(manager.saveIntegration).not.toHaveBeenCalled();
      expect(manager.deleteIntegration).not.toHaveBeenCalled();
    });

    it('still connects and removes for an unmanaged organization', async () => {
      const { vendor, manager, controller } = fakes();
      const org = { id: UNMANAGED } as any;

      expect(await controller.addApiKey(org, 'heygen', 'FAKE-key')).toEqual({
        id: 'FAKE-third-party',
      });
      expect(vendor.checkConnection).toHaveBeenCalledWith('FAKE-key');
      await controller.deleteById(org, 'FAKE-third-party');
      expect(manager.deleteIntegration).toHaveBeenCalledWith(UNMANAGED, 'FAKE-third-party');
    });
  });

  describe('MediaController save-media', () => {
    beforeEach(() => {
      process.env.CLOUDFLARE_BUCKET_URL = 'https://FAKE.bucket.example';
    });

    afterEach(() => {
      delete process.env.CLOUDFLARE_BUCKET_URL;
    });

    const fakes = () => {
      const mediaService = { saveFile: jest.fn(async () => ({ id: 'FAKE-media' })) };
      return {
        mediaService,
        controller: new MediaController(mediaService as any, {} as any),
      };
    };

    it('never lets another organization adopt a W&W reserved object, whatever the mode', async () => {
      for (const mode of ['enabled', undefined]) {
        if (mode) {
          process.env.POSTIZ_MANAGED_MODE = mode;
        } else {
          delete process.env.POSTIZ_MANAGED_MODE;
        }

        const { mediaService, controller } = fakes();
        for (const name of [
          'managed-0a1b2c3d-1.png',
          'MANAGED-0a1b2c3d-1.png',
          'managed-x.mp4',
        ]) {
          expect(
            await refusal(() =>
              controller.saveMedia({ id: UNMANAGED } as any, {} as any, name, 'FAKE.png')
            )
          ).toMatchObject({ status: 400 });
        }
        expect(mediaService.saveFile).not.toHaveBeenCalled();
      }
    });

    it('still saves an ordinary bucket object name', async () => {
      const { mediaService, controller } = fakes();
      const name = 'AbCdEfGhIj0123456789.png';

      await controller.saveMedia({ id: UNMANAGED } as any, {} as any, name, 'FAKE.png');
      expect(mediaService.saveFile).toHaveBeenCalledWith(
        UNMANAGED,
        name,
        'https://FAKE.bucket.example/' + name,
        'FAKE.png'
      );
    });
  });
});
