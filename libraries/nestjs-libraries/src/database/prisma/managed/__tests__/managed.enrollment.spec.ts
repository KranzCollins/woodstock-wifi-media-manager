// Durable enrollment: once a ManagedOrganization row exists, a process whose
// environment leaves that organization out (or turns the mode off) refuses to
// start. FAKE client rows only; the real table is covered by the root's
// disposable PostgreSQL run.
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertManagedEnrollment,
  ManagedEnrollmentError,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

const ORG = 'a1111111-1111-4111-8111-111111111111';
const OTHER = 'b2222222-2222-4222-8222-222222222222';

const client = (rows: string[] | Error) => ({
  managedOrganization: {
    findMany: jest.fn(async () => {
      if (rows instanceof Error) {
        throw rows;
      }
      return rows.map((organizationId) => ({ organizationId }));
    }),
  },
});

const knownError = (code: string) =>
  new (Prisma.PrismaClientKnownRequestError as any)(`FAKE ${code}`, code);

async function check(rows: string[] | Error) {
  try {
    await assertManagedEnrollment(client(rows));
    return 'started';
  } catch (err) {
    return err as Error;
  }
}

describe('durable managed enrollment', () => {
  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
  });

  it('starts when nothing was ever enrolled, whatever the mode', async () => {
    expect(await check([])).toBe('started');

    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
    expect(await check([])).toBe('started');
  });

  it('starts when every enrolled organization is on this process allowlist', async () => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = `${ORG},${OTHER}`;
    expect(await check([ORG])).toBe('started');
    expect(await check([ORG, OTHER])).toBe('started');
  });

  it('refuses a process started without the mode while rows exist', async () => {
    for (const mode of [undefined, 'disabled']) {
      if (mode) {
        process.env.POSTIZ_MANAGED_MODE = mode;
      }
      process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;

      const result = await check([ORG]);
      expect(result).toBeInstanceOf(ManagedEnrollmentError);
      // counts only, never an organization id
      expect((result as Error).message).toContain('1 of 1');
      expect((result as Error).message).not.toContain(ORG);
    }
  });

  it('refuses an allowlist that leaves out an enrolled organization', async () => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;

    const result = await check([ORG, OTHER]);
    expect(result).toBeInstanceOf(ManagedEnrollmentError);
    expect((result as Error).message).toContain('1 of 2');
    expect((result as Error).message).not.toContain(OTHER);
  });

  it('logs a matching enrollment unless asked to be quiet (readiness probes)', async () => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await assertManagedEnrollment(client([ORG]), { quiet: true });
      expect(log).not.toHaveBeenCalled();

      await assertManagedEnrollment(client([ORG]));
      expect(log).toHaveBeenCalledTimes(1);

      // quiet never softens the check
      process.env.POSTIZ_MANAGED_ORGANIZATIONS = OTHER;
      await expect(
        assertManagedEnrollment(client([ORG]), { quiet: true })
      ).rejects.toBeInstanceOf(ManagedEnrollmentError);
    } finally {
      log.mockRestore();
    }
  });

  it('refuses missing or unreachable enrollment, never assuming an empty table', async () => {
    const missing = knownError('P2021');
    expect(await check(missing)).toBe(missing);

    const unreachable = knownError('P1001');
    expect(await check(unreachable)).toBe(unreachable);

    const other = new Error('FAKE driver failure');
    expect(await check(other)).toBe(other);
  });

  describe('PrismaService.onModuleInit', () => {
    let exit: jest.SpyInstance;

    beforeEach(() => {
      exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    });

    afterEach(() => {
      exit.mockRestore();
    });

    // the FAKE @prisma/client has no engine: $connect and the delegate are set
    // on the instance
    const service = (rows: string[] | Error) => {
      const prisma = new PrismaService() as any;
      const order: string[] = [];
      prisma.$connect = jest.fn(async () => {
        order.push('connect');
      });
      const fake = client(rows);
      prisma.managedOrganization = {
        findMany: jest.fn(async (args: any) => {
          order.push('enrollment');
          return fake.managedOrganization.findMany(args);
        }),
      };
      return { prisma, order };
    };

    it('stops the process (exit 1) before the app boots when enrollment is missing', async () => {
      const { prisma, order } = service([ORG]);
      await prisma.onModuleInit();

      expect(order).toEqual(['connect', 'enrollment']);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('stops the process when the enrollment table is missing', async () => {
      await service(knownError('P2021')).prisma.onModuleInit();
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('stops the process when the check itself fails', async () => {
      const { prisma } = service(knownError('P1001'));
      await prisma.onModuleInit();
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('boots normally only for a matching enrollment or a proven empty table', async () => {
      process.env.POSTIZ_MANAGED_MODE = 'enabled';
      process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
      await service([ORG]).prisma.onModuleInit();

      delete process.env.POSTIZ_MANAGED_MODE;
      delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
      await service([]).prisma.onModuleInit();

      expect(exit).not.toHaveBeenCalled();
    });
  });
});
