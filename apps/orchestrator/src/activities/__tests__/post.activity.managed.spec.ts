// The activity's real collaborators pull in providers, Temporal and storage;
// they are replaced by FAKE modules so only PostActivity's own code runs.
jest.mock('nestjs-temporal-core', () => ({
  Activity: () => () => undefined,
  ActivityMethod: () => () => undefined,
  TemporalService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/posts/posts.service', () => ({
  PostsService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/notifications/notification.service', () => ({
  NotificationService: class {},
}));
jest.mock('@gitroom/helpers/utils/strip.html.validation', () => ({
  stripHtmlValidation: (_editor: string, content: string) => content,
}));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock('@gitroom/nestjs-libraries/integrations/refresh.integration.service', () => ({
  RefreshIntegrationService: class {},
}));
jest.mock('@gitroom/helpers/utils/timer', () => ({ timer: async () => undefined }));
jest.mock('@gitroom/nestjs-libraries/database/prisma/integrations/integration.service', () => ({
  IntegrationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.service', () => ({
  WebhooksService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher', () => ({
  getSsrfSafeDispatcher: () => undefined,
}));
jest.mock('@temporalio/common', () => ({ TypedSearchAttributes: class {} }));
jest.mock('@gitroom/nestjs-libraries/temporal/temporal.search.attribute', () => ({
  organizationId: {},
  postId: {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service', () => ({
  SubscriptionService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/temporal/temporal.heartbeat', () => ({
  setHeartbeatDetails: () => undefined,
  withHeartbeat: (func: () => any) => func(),
}));
jest.mock('@gitroom/nestjs-libraries/integrations/social.abstract', () => {
  class FakeFailure extends Error {
    constructor(public type: string, message: string) {
      super(message);
    }
  }
  return {
    BadBody: class extends FakeFailure {
      constructor(_identifier: string, _json: string, _body: any, message = '') {
        super('bad_body', message);
      }
    },
    Disconnect: class extends FakeFailure {},
    PublishedWithError: class extends FakeFailure {},
  };
});
jest.mock('@gitroom/nestjs-libraries/database/prisma/managed/managed.service', () => ({
  ManagedService: class {},
}));

import { PostActivity } from '@gitroom/orchestrator/activities/post.activity';
import { ManagedWriteRefusedError } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';

const MANAGED = '11111111-1111-4111-8111-111111111111';
const UNMANAGED = '99999999-9999-4999-8999-999999999999';

const integration = (organizationId: string) =>
  ({
    id: 'int-1',
    organizationId,
    providerIdentifier: 'x',
    internalId: 'internal',
    token: 'FAKE-token',
  } as any);

describe('PostActivity in a managed organization', () => {
  let provider: Record<string, jest.Mock>;
  let deps: Record<string, any>;
  let activity: PostActivity;

  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = MANAGED;

    // FAKE social provider: any call to it would be an external effect
    provider = {
      post: jest.fn(async () => [{ id: 'p', postId: 'remote', releaseURL: 'u', status: 'success' }]),
      comment: jest.fn(async () => []),
      checkPostStatus: jest.fn(),
      finalizePost: jest.fn(),
    };

    deps = {
      postService: {
        getPostById: jest.fn(),
        getPostsRecursively: jest.fn(),
        changeState: jest.fn(async () => undefined),
        searchForMissingThreeHoursPosts: jest.fn(),
        updateTags: jest.fn(async (_org: string, posts: any[]) => posts),
        updateMedia: jest.fn(async () => []),
      },
      notificationService: { inAppNotification: jest.fn(async () => undefined) },
      integrationManager: { getSocialIntegration: jest.fn(() => provider) },
      integrationService: { processInternalPlug: jest.fn() },
      refreshService: {},
      webhookService: {},
      temporalService: {
        client: {
          getRawClient: () => ({
            workflow: { start: jest.fn(async () => undefined), signalWithStart: jest.fn() },
          }),
        },
      },
      subscriptionService: {},
      managedService: { recordDispatchRefusal: jest.fn(async () => undefined) },
    };

    activity = new PostActivity(
      deps.postService,
      deps.notificationService,
      deps.integrationManager,
      deps.integrationService,
      deps.refreshService,
      deps.webhookService,
      deps.temporalService,
      deps.subscriptionService,
      deps.managedService
    );
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
  });

  it('reports no post to every workflow version before the publish sleep', async () => {
    expect(await activity.getPost(MANAGED, 'post-1')).toBe(false);
    expect(await activity.getPostsList(MANAGED, 'post-1')).toEqual([]);
    expect(deps.postService.getPostById).not.toHaveBeenCalled();
    expect(deps.postService.getPostsRecursively).not.toHaveBeenCalled();
  });

  it.each([
    ['postSocial', (a: PostActivity) => a.postSocial(integration(MANAGED), [])],
    ['postSocialPending', (a: PostActivity) => a.postSocialPending(integration(MANAGED), [])],
    ['postComment', (a: PostActivity) => a.postComment('remote', undefined, integration(MANAGED), [])],
    ['checkPostStatus', (a: PostActivity) => a.checkPostStatus(integration(MANAGED), {})],
    ['finalizePost', (a: PostActivity) => a.finalizePost(integration(MANAGED), {})],
  ])('%s refuses before the provider is even resolved', async (_name, call) => {
    await expect(call(activity)).rejects.toMatchObject({ type: 'bad_body' });
    expect(deps.integrationManager.getSocialIntegration).not.toHaveBeenCalled();
    expect(deps.postService.updateTags).not.toHaveBeenCalled();
    for (const method of Object.values(provider)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it('refuses internal plugs of a managed organization', async () => {
    await expect(
      activity.processInternalPlug({
        post: 'p',
        originalIntegration: 'a',
        integration: 'b',
        plugName: 'repost',
        orgId: MANAGED,
        delay: 0,
        information: {},
      })
    ).rejects.toMatchObject({ type: 'bad_body' });
    expect(deps.integrationService.processInternalPlug).not.toHaveBeenCalled();
  });

  it('records the refused state change instead of writing the row', async () => {
    deps.postService.changeState.mockRejectedValueOnce(
      new ManagedWriteRefusedError('Post', 'update', MANAGED)
    );

    await expect(activity.changeState('post-1', 'ERROR' as any, 'No Post')).resolves.toBeUndefined();
    expect(deps.managedService.recordDispatchRefusal).toHaveBeenCalledWith(
      MANAGED,
      'post-1',
      'changeState:ERROR'
    );
  });

  it('keeps every other changeState failure', async () => {
    deps.postService.changeState.mockRejectedValueOnce(new Error('db down'));
    await expect(activity.changeState('post-1', 'ERROR' as any)).rejects.toThrow('db down');
    expect(deps.managedService.recordDispatchRefusal).not.toHaveBeenCalled();
  });

  it('never emails (or digests) the error branch of a refused in-flight dispatch', async () => {
    await activity.inAppNotification(MANAGED, 'FAKE subject', 'FAKE message', true, true, 'fail');
    expect(deps.notificationService.inAppNotification).toHaveBeenLastCalledWith(
      MANAGED,
      'FAKE subject',
      'FAKE message',
      false,
      false,
      'fail'
    );

    await activity.inAppNotification(UNMANAGED, 'FAKE subject', 'FAKE message', true, true, 'fail');
    expect(deps.notificationService.inAppNotification).toHaveBeenLastCalledWith(
      UNMANAGED,
      'FAKE subject',
      'FAKE message',
      true,
      true,
      'fail'
    );

    delete process.env.POSTIZ_MANAGED_MODE;
    await activity.inAppNotification(MANAGED, 'FAKE subject', 'FAKE message', true, false);
    expect(deps.notificationService.inAppNotification).toHaveBeenLastCalledWith(
      MANAGED,
      'FAKE subject',
      'FAKE message',
      true,
      false,
      'success'
    );
  });

  it('never pokes missed posts of a managed organization', async () => {
    const signalWithStart = jest.fn(async () => undefined);
    deps.temporalService.client.getRawClient = () => ({ workflow: { signalWithStart } });
    deps.postService.searchForMissingThreeHoursPosts.mockResolvedValue([
      { id: 'm', organizationId: MANAGED, integration: { providerIdentifier: 'x' } },
      { id: 'u', organizationId: UNMANAGED, integration: { providerIdentifier: 'x' } },
    ]);

    await activity.searchForMissingThreeHoursPosts();

    expect(signalWithStart).toHaveBeenCalledTimes(1);
    expect((signalWithStart.mock.calls[0] as any[])[1].workflowId).toBe('post_u');
  });

  it('leaves an unmanaged organization publishing as before (FAKE provider)', async () => {
    deps.postService.getPostById.mockResolvedValue({ id: 'post-1', state: 'QUEUE', deletedAt: null });
    expect(await activity.getPost(UNMANAGED, 'post-1')).toMatchObject({ id: 'post-1' });

    await activity.postSocial(integration(UNMANAGED), [
      { id: 'post-1', content: 'hello', settings: '{}', image: '[]' } as any,
    ]);
    expect(provider.post).toHaveBeenCalledTimes(1);
  });

  it('changes nothing for anyone while managed mode is disabled', async () => {
    delete process.env.POSTIZ_MANAGED_MODE;
    await activity.postSocial(integration(MANAGED), [
      { id: 'post-1', content: 'hello', settings: '{}', image: '[]' } as any,
    ]);
    expect(provider.post).toHaveBeenCalledTimes(1);
  });
});
