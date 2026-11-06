import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

// FAKE in-memory stand-in for the subset of Prisma the managed repository
// uses, so ManagedRepository + ManagedService run unchanged on top of it.
// What it models (and what a real Postgres run still has to prove):
// - `select` picks only the listed fields, like Prisma
// - the first managedOrganization.update inside a transaction takes a
//   per-organization lock held until the transaction ends (Postgres row lock)
// - a write transaction works on a copy taken when it gets the lock and
//   commits it at the end, or drops it when the callback throws (rollback)
// - a transaction opened with an isolationLevel reads one snapshot taken at
//   its start (RepeatableRead)
// - the unique constraints of the managed models (P2002)

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

const MODELS = [
  'managedOrganization',
  'managedChannelBinding',
  'managedPost',
  'managedPostRevision',
  'managedOperation',
  'managedMediaEvidence',
  'managedChangeEvent',
  'managedMediaUpload',
  'managedMediaUploadAttempt',
  'integration',
  'post',
  'media',
] as const;

const UNIQUES: Record<string, string[][]> = {
  managedOrganization: [['organizationId']],
  managedChannelBinding: [['integrationId']],
  managedPost: [['group']],
  managedPostRevision: [['managedPostId', 'revision']],
  managedOperation: [['organizationId', 'operationKey']],
  managedChangeEvent: [['organizationId', 'sequence']],
  managedMediaUpload: [['organizationId', 'operationKey']],
  managedMediaUploadAttempt: [['uploadId', 'attempt'], ['storedPath']],
  post: [['id']],
  media: [['id']],
};

const DEFAULTS: Record<string, () => Row> = {
  managedOrganization: () => ({ sequence: 0 }),
  managedChannelBinding: () => ({
    generation: 1,
    status: 'PENDING_QUALIFICATION',
    profile: null,
    qualifiedAt: null,
    pausedAt: null,
  }),
  managedChangeEvent: () => ({
    revision: null,
    bindingGeneration: null,
    operationKey: null,
    data: '{}',
  }),
  managedMediaEvidence: () => ({
    mimeType: null,
    storageVersion: null,
    storageKey: null,
    storageNamespace: null,
  }),
  managedMediaUpload: () => ({
    status: 'RESERVED',
    attempt: 0,
    leaseExpiresAt: null,
    mediaId: null,
    evidenceId: null,
    completedSequence: null,
    failureReason: null,
  }),
  managedMediaUploadAttempt: () => ({ outcome: 'RECEIVING', detail: null }),
  post: () => ({
    parentPostId: null,
    deletedAt: null,
    delay: 0,
    image: null,
    settings: null,
    state: 'QUEUE',
  }),
  media: () => ({
    deletedAt: null,
    thumbnail: null,
    alt: null,
    originalName: null,
    status: 'ready',
  }),
};

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const previous = this.tail;
    this.tail = previous.then(() => next);
    return previous.then(() => release);
  }
}

function knownError(message: string, code: string) {
  return new (Prisma.PrismaClientKnownRequestError as any)(message, code);
}

function compare(a: any, b: any) {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function matches(row: Row, where: any): boolean {
  if (!where) {
    return true;
  }

  return Object.entries(where).every(([key, condition]: [string, any]) => {
    if (key === 'OR') {
      return (condition as any[]).some((item) => matches(row, item));
    }

    if (key === 'AND') {
      return (condition as any[]).every((item) => matches(row, item));
    }

    if (condition === null) {
      return row[key] === null || row[key] === undefined;
    }

    if (typeof condition === 'object' && !(condition instanceof Date)) {
      if ('in' in condition) {
        return condition.in.includes(row[key]);
      }

      if ('gt' in condition) {
        return compare(row[key], condition.gt) > 0;
      }

      if ('notIn' in condition) {
        return !condition.notIn.includes(row[key]);
      }

      // compound unique, e.g. organizationId_operationKey: { ... }
      return Object.entries(condition).every(
        ([field, value]) => row[field] === value
      );
    }

    return compare(row[key], condition) === 0;
  });
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) {
    return { ...row };
  }

  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key]])
  );
}

// { organization: { connect: { id } } } -> organizationId, and so on
function flattenRelations(data: Row) {
  const flat: Row = {};
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'connect' in value) {
      flat[`${key}Id`] = value.connect.id;
    } else {
      flat[key] = value;
    }
  }
  return flat;
}

interface TxContext {
  tables: Tables | null;
  release?: () => void;
}

export class FakePrismaDb {
  tables: Tables = Object.fromEntries(MODELS.map((model) => [model, []]));
  private locks = new Map<string, Mutex>();
  // every select an integration read used, to prove secrets are never asked for
  integrationSelects: Record<string, boolean>[] = [];

  private lockFor(organizationId: string) {
    if (!this.locks.has(organizationId)) {
      this.locks.set(organizationId, new Mutex());
    }
    return this.locks.get(organizationId)!.lock();
  }

  private delegate(model: string, ctx: TxContext | null) {
    const rows = () => (ctx?.tables ?? this.tables)[model];

    const create = (args: any) => {
      const row: Row = {
        ...(DEFAULTS[model]?.() || {}),
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...flattenRelations(args.data),
      };

      for (const fields of UNIQUES[model] || []) {
        if (
          rows().some((existing) =>
            fields.every((field) => existing[field] === row[field])
          )
        ) {
          throw knownError(`Unique constraint on ${fields.join(',')}`, 'P2002');
        }
      }

      rows().push(row);
      return pick(row, args.select);
    };

    const update = (args: any) => {
      const row = rows().find((item) => matches(item, args.where));
      if (!row) {
        throw knownError('Record to update not found', 'P2025');
      }

      Object.assign(row, flattenRelations(args.data), { updatedAt: new Date() });
      return pick(row, args.select);
    };

    return {
      findUnique: async (args: any) => {
        const row = rows().find((item) => matches(item, args.where));
        return row ? pick(row, args.select) : null;
      },
      findFirst: async (args: any) => {
        if (model === 'integration') {
          this.integrationSelects.push(args.select);
        }
        const row = rows().find((item) => matches(item, args.where));
        return row ? pick(row, args.select) : null;
      },
      findMany: async (args: any = {}) => {
        if (model === 'integration') {
          this.integrationSelects.push(args.select);
        }
        let list = rows().filter((item) => matches(item, args.where));
        if (args.orderBy) {
          const [[field, direction]] = Object.entries(args.orderBy) as [
            string,
            string
          ][];
          list = [...list].sort(
            (a, b) =>
              compare(a[field], b[field]) * (direction === 'desc' ? -1 : 1)
          );
        }
        if (args.take !== undefined) {
          list = list.slice(0, args.take);
        }
        return list.map((row) => pick(row, args.select));
      },
      count: async (args: any = {}) =>
        rows().filter((item) => matches(item, args.where)).length,
      create: async (args: any) => create(args),
      update: async (args: any) => {
        // the organization row is the lock every managed mutation takes first
        if (model === 'managedOrganization' && ctx && !ctx.release) {
          ctx.release = await this.lockFor(args.where.organizationId);
          ctx.tables = structuredClone(this.tables);
        }
        return update({ ...args, where: args.where });
      },
      upsert: async (args: any) => {
        const existing = rows().find((item) => matches(item, args.where));
        if (existing) {
          return update({ where: args.where, data: args.update, select: args.select });
        }
        return create({ data: args.create, select: args.select });
      },
    };
  }

  private client(ctx: TxContext | null): any {
    return Object.fromEntries(
      MODELS.map((model) => [model, this.delegate(model, ctx)])
    );
  }

  // the object handed to PrismaRepository / PrismaTransaction as `.model`
  get model(): any {
    return {
      ...this.client(null),
      $transaction: async (
        func: (tx: any) => Promise<any>,
        options?: { isolationLevel?: string }
      ) => {
        const ctx: TxContext = {
          tables: options?.isolationLevel ? structuredClone(this.tables) : null,
        };

        try {
          const result = await func(this.client(ctx));
          if (ctx.release && ctx.tables) {
            this.tables = ctx.tables;
          }
          return result;
        } finally {
          ctx.release?.();
        }
      },
    };
  }

  // test helpers acting like a writer outside the managed path
  insert(model: string, row: Row): Row {
    const full = {
      ...(DEFAULTS[model]?.() || {}),
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...row,
    };
    this.tables[model].push(full);
    return full;
  }

  patch(model: string, id: string, data: Row) {
    const row = this.tables[model].find((item) => item.id === id);
    if (!row) {
      throw new Error(`FAKE: no ${model} ${id}`);
    }
    Object.assign(row, data, { updatedAt: new Date() });
    return row;
  }
}
