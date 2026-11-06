// FAKE @prisma/client, mapped by jest.managed.config.js for the W&W managed
// extension unit tests only. It carries just the runtime values the code
// under test reads (enums, error class, isolation levels); no query engine,
// no database.

export class PrismaClient {
  $use(_middleware: unknown) {
    /* FAKE: the write fence is tested directly */
  }
}

class PrismaClientKnownRequestError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export const Prisma = {
  TransactionIsolationLevel: {
    ReadUncommitted: 'ReadUncommitted',
    ReadCommitted: 'ReadCommitted',
    RepeatableRead: 'RepeatableRead',
    Serializable: 'Serializable',
  },
  PrismaClientKnownRequestError,
};

export const State = {
  QUEUE: 'QUEUE',
  PUBLISHED: 'PUBLISHED',
  ERROR: 'ERROR',
  DRAFT: 'DRAFT',
} as const;
