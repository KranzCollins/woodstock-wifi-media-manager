import { AsyncLocalStorage } from 'async_hooks';
import { Prisma } from '@prisma/client';
import {
  isManagedModeEnabled,
  isManagedOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { ManagedWriteRefusedError } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';

// The single write boundary for managed organizations. Registered on
// PrismaService, so every repository (dashboard, public API, MCP / agent
// tools, autopost, OAuth reconnect, worker activities) passes through it: a
// write on a fenced model that lands in a managed organization is refused
// unless it runs inside runAsManagedWriter for that same organization. With
// managed mode disabled, or for an organization off the allowlist, it is a
// pass-through.

// Prisma model name -> client delegate
const FENCED_MODELS: Record<string, 'post' | 'integration' | 'media'> = {
  Post: 'post',
  Integration: 'integration',
  Media: 'media',
};

const UNIQUE_WRITES = new Set(['update', 'delete']);
const MANY_WRITES = new Set(['updateMany', 'updateManyAndReturn', 'deleteMany']);
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);

// only the two reads the fence needs, so tests can pass a plain fake
type FenceDelegate = {
  findUnique(args: any): PromiseLike<any>;
  findMany(args: any): PromiseLike<any>;
};

export type FenceClient = Record<
  'post' | 'integration' | 'media',
  FenceDelegate
>;

const managedWriter = new AsyncLocalStorage<{ organizationId: string }>();

export function runAsManagedWriter<T>(
  organizationId: string,
  func: () => Promise<T>
): Promise<T> {
  return managedWriter.run({ organizationId }, func);
}

function organizationFromData(data: any): string | undefined {
  if (typeof data?.organizationId === 'string') {
    return data.organizationId;
  }

  if (typeof data?.organization?.connect?.id === 'string') {
    return data.organization.connect.id;
  }

  return undefined;
}

function organizationFromWhere(where: any): string | undefined {
  if (typeof where?.organizationId === 'string') {
    return where.organizationId;
  }

  // Integration's @@unique([organizationId, internalId])
  if (typeof where?.organizationId_internalId?.organizationId === 'string') {
    return where.organizationId_internalId.organizationId;
  }

  return undefined;
}

// null = could not be determined, the caller fails closed on it
async function targetOrganizations(
  delegate: FenceDelegate,
  action: string,
  args: any
): Promise<(string | null)[]> {
  if (CREATES.has(action)) {
    const rows = Array.isArray(args?.data) ? args.data : [args?.data];
    return rows.map((row: any) => organizationFromData(row) ?? null);
  }

  // a write that moves a row into an organization is checked for it as well
  const moved = [organizationFromData(args?.data)].filter(
    (id): id is string => !!id
  );

  if (UNIQUE_WRITES.has(action)) {
    const fromWhere = organizationFromWhere(args?.where);
    if (fromWhere) {
      return [fromWhere, ...moved];
    }

    const row = await delegate.findUnique({
      where: args?.where,
      select: { organizationId: true },
    });

    // no row: the write itself fails with "record not found"
    return row ? [row.organizationId, ...moved] : moved;
  }

  if (action === 'upsert') {
    const fromWhere = organizationFromWhere(args?.where);
    const updated = [organizationFromData(args?.update)].filter(
      (id): id is string => !!id
    );

    if (fromWhere) {
      return [fromWhere, ...updated];
    }

    const row = await delegate.findUnique({
      where: args?.where,
      select: { organizationId: true },
    });

    return row
      ? [row.organizationId, ...updated]
      : [organizationFromData(args?.create) ?? null];
  }

  if (MANY_WRITES.has(action)) {
    const fromWhere = organizationFromWhere(args?.where);
    if (fromWhere) {
      return [fromWhere, ...moved];
    }

    const rows: { organizationId: string }[] = await delegate.findMany({
      where: args?.where,
      select: { organizationId: true },
      distinct: ['organizationId'],
    });

    return [...rows.map((row) => row.organizationId), ...moved];
  }

  return [];
}

export function managedWriteFence(client: FenceClient): Prisma.Middleware {
  return async (params, next) => {
    const delegate = params.model ? FENCED_MODELS[params.model] : undefined;
    if (
      !delegate ||
      !isManagedModeEnabled() ||
      !(
        CREATES.has(params.action) ||
        UNIQUE_WRITES.has(params.action) ||
        MANY_WRITES.has(params.action) ||
        params.action === 'upsert'
      )
    ) {
      return next(params);
    }

    const organizations = await targetOrganizations(
      client[delegate],
      params.action,
      params.args
    );
    const writer = managedWriter.getStore();

    for (const organizationId of organizations) {
      if (organizationId === null) {
        throw new ManagedWriteRefusedError(
          params.model!,
          params.action,
          null,
          'MANAGED_FENCE_UNRESOLVED_ORGANIZATION'
        );
      }

      if (
        isManagedOrganization(organizationId) &&
        writer?.organizationId !== organizationId
      ) {
        throw new ManagedWriteRefusedError(
          params.model!,
          params.action,
          organizationId
        );
      }
    }

    return next(params);
  };
}
