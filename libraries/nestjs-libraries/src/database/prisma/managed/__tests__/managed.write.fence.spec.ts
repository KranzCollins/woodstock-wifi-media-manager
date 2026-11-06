import {
  managedWriteFence,
  runAsManagedWriter,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.write.fence';
import { ManagedWriteRefusedError } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';

const MANAGED = '11111111-1111-4111-8111-111111111111';
const UNMANAGED = '99999999-9999-4999-8999-999999999999';

// FAKE rows the fence can look up when a write does not name its organization
const rows: Record<string, { id: string; organizationId: string; group?: string }[]> = {
  post: [
    { id: 'post-managed', organizationId: MANAGED, group: 'g-managed' },
    { id: 'post-unmanaged', organizationId: UNMANAGED, group: 'g-unmanaged' },
  ],
  integration: [
    { id: 'int-managed', organizationId: MANAGED },
    { id: 'int-unmanaged', organizationId: UNMANAGED },
  ],
  media: [
    { id: 'media-managed', organizationId: MANAGED },
    { id: 'media-unmanaged', organizationId: UNMANAGED },
  ],
};

const fakeClient = Object.fromEntries(
  Object.entries(rows).map(([model, list]) => [
    model,
    {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = list.find((r) => r.id === where.id);
        return row ? { organizationId: row.organizationId } : null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const matched = list.filter((r) => {
          if (where?.group !== undefined && r.group !== where.group) {
            return false;
          }
          if (where?.integrationId !== undefined) {
            return (
              r.organizationId ===
              (where.integrationId === 'int-managed' ? MANAGED : UNMANAGED)
            );
          }
          return true;
        });
        return [...new Set(matched.map((r) => r.organizationId))].map(
          (organizationId) => ({ organizationId })
        );
      }),
    },
  ])
) as any;

const fence = managedWriteFence(fakeClient);

const run = (model: string, action: string, args: any) => {
  const next = jest.fn(async () => 'written');
  return {
    next,
    result: fence({ model, action, args, dataPath: [], runInTransaction: false } as any, next),
  };
};

describe('managedWriteFence', () => {
  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = MANAGED;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
  });

  // every write shape the existing repositories use on the fenced models
  const managedWrites: [string, string, any][] = [
    // PostsRepository.createOrUpdatePost (dashboard, public API, MCP, autopost)
    ['Post', 'upsert', { where: { id: 'new-id' }, create: { organization: { connect: { id: MANAGED } } }, update: {} }],
    ['Post', 'upsert', { where: { id: 'post-managed' }, create: { organization: { connect: { id: UNMANAGED } } }, update: {} }],
    // changeState / updatePost / updateImages (worker) by id only
    ['Post', 'update', { where: { id: 'post-managed' }, data: { state: 'ERROR' } }],
    // changeDate / updateReleaseId with the organization
    ['Post', 'update', { where: { id: 'post-managed', organizationId: MANAGED }, data: {} }],
    // deletePost by group, the rotate-and-sweep by group without organization
    ['Post', 'updateMany', { where: { organizationId: MANAGED, group: 'g-managed' }, data: { deletedAt: new Date() } }],
    ['Post', 'updateMany', { where: { group: 'g-managed', deletedAt: null }, data: { deletedAt: new Date() } }],
    // IntegrationRepository soft-deleting a channel's posts
    ['Post', 'updateMany', { where: { integrationId: 'int-managed' }, data: { deletedAt: new Date() } }],
    // OAuth reconnect / token refresh upsert
    ['Integration', 'upsert', { where: { organizationId_internalId: { organizationId: MANAGED, internalId: 'x' } }, create: { organizationId: MANAGED }, update: {} }],
    // customer reassignment, disable, delete, preferences
    ['Integration', 'update', { where: { id: 'int-managed', organizationId: MANAGED }, data: { customerId: 'c' } }],
    ['Integration', 'update', { where: { id: 'int-managed' }, data: { refreshNeeded: true } }],
    ['Integration', 'updateMany', { where: { organizationId: MANAGED }, data: { disabled: true } }],
    // media upload, delete, processing result
    ['Media', 'create', { data: { organization: { connect: { id: MANAGED } }, name: 'a', path: 'b' } }],
    ['Media', 'update', { where: { id: 'media-managed', organizationId: MANAGED }, data: { deletedAt: new Date() } }],
    ['Media', 'update', { where: { id: 'media-managed' }, data: { path: 'replaced' } }],
    ['Post', 'deleteMany', { where: { organizationId: MANAGED } }],
    ['Post', 'createMany', { data: [{ organizationId: UNMANAGED }, { organizationId: MANAGED }] }],
  ];

  it.each(managedWrites)('refuses %s.%s on a managed organization', async (model, action, args) => {
    const { result, next } = run(model, action, args);
    await expect(result).rejects.toBeInstanceOf(ManagedWriteRefusedError);
    await expect(result).rejects.toMatchObject({ code: 'MANAGED_WRITE_REFUSED' });
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a write that moves an unmanaged row into a managed organization', async () => {
    const { result } = run('Post', 'update', {
      where: { id: 'post-unmanaged' },
      data: { organization: { connect: { id: MANAGED } } },
    });
    await expect(result).rejects.toBeInstanceOf(ManagedWriteRefusedError);
  });

  it.each([
    ['Post', 'upsert', { where: { id: 'new-id' }, create: { organization: { connect: { id: UNMANAGED } } }, update: {} }],
    ['Post', 'update', { where: { id: 'post-unmanaged' }, data: { state: 'ERROR' } }],
    ['Post', 'updateMany', { where: { group: 'g-unmanaged' }, data: {} }],
    ['Integration', 'update', { where: { id: 'int-unmanaged' }, data: {} }],
    ['Media', 'create', { data: { organization: { connect: { id: UNMANAGED } } } }],
  ])('lets %s.%s of an unmanaged organization through', async (model, action, args) => {
    const { result, next } = run(model, action, args);
    await expect(result).resolves.toBe('written');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lets reads and other models through without looking anything up', async () => {
    for (const [model, action] of [
      ['Post', 'findMany'],
      ['Post', 'count'],
      ['Comments', 'create'],
      ['Notifications', 'create'],
    ]) {
      const { result } = run(model, action, { where: { organizationId: MANAGED } });
      await expect(result).resolves.toBe('written');
    }
    expect(fakeClient.post.findUnique).not.toHaveBeenCalled();
  });

  it('allows the managed writer of the same organization only', async () => {
    const args = { where: { id: 'post-managed' }, data: { content: 'x' } };

    await expect(
      runAsManagedWriter(MANAGED, () => run('Post', 'update', args).result)
    ).resolves.toBe('written');

    await expect(
      runAsManagedWriter(UNMANAGED, () => run('Post', 'update', args).result)
    ).rejects.toBeInstanceOf(ManagedWriteRefusedError);

    // the context does not leak out of the callback
    await expect(run('Post', 'update', args).result).rejects.toBeInstanceOf(
      ManagedWriteRefusedError
    );
  });

  it('fails closed when it cannot tell the organization of a create', async () => {
    const { result, next } = run('Post', 'create', { data: { content: 'x' } });
    await expect(result).rejects.toMatchObject({
      code: 'MANAGED_FENCE_UNRESOLVED_ORGANIZATION',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('is a pass-through while managed mode is disabled', async () => {
    delete process.env.POSTIZ_MANAGED_MODE;
    const { result, next } = run('Post', 'update', {
      where: { id: 'post-managed' },
      data: { state: 'ERROR' },
    });
    await expect(result).resolves.toBe('written');
    expect(next).toHaveBeenCalled();
    expect(fakeClient.post.findUnique).not.toHaveBeenCalled();
  });

  it('is a pass-through for an organization removed from the allowlist', async () => {
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = UNMANAGED;
    const { result } = run('Post', 'update', {
      where: { id: 'post-managed' },
      data: {},
    });
    await expect(result).resolves.toBe('written');
  });
});
