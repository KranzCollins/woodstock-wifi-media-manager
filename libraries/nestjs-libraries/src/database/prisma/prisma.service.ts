import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { managedWriteFence } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.write.fence';
import {
  assertManagedEnrollment,
  assertManagedModeConfig,
  ManagedEnrollmentError,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      log: [
        {
          emit: 'event',
          level: 'query',
        },
      ],
    });

    // W&W managed organizations: refuses writes outside the managed path,
    // a pass-through unless POSTIZ_MANAGED_MODE=enabled. A broken managed
    // configuration stops the process here, in every app
    assertManagedModeConfig();
    this.$use(managedWriteFence(this));
  }
  async onModuleInit() {
    await this.$connect();

    // Runs before any onApplicationBootstrap, so before the Temporal worker
    // polls and before the backend listens. Exits like Nest's own abortOnError:
    // a rejected init would leave the backend (its listen() catch) or the
    // orchestrator (Sentry's unhandled-rejection handler) running without
    // stopping
    try {
      await assertManagedEnrollment(this);
    } catch (err) {
      Logger.error(
        `Managed enrollment check failed, refusing to start: ${
          err instanceof ManagedEnrollmentError ? err.message : 'Enrollment state could not be verified'
        }`,
        'ManagedMode'
      );
      process.exit(1);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Injectable()
export class PrismaRepository<T extends keyof PrismaService> {
  public model: Pick<PrismaService, T>;
  constructor(private _prismaService: PrismaService) {
    this.model = this._prismaService;
  }
}

@Injectable()
export class PrismaTransaction {
  public model: Pick<PrismaService, '$transaction'>;
  constructor(private _prismaService: PrismaService) {
    this.model = this._prismaService;
  }
}
