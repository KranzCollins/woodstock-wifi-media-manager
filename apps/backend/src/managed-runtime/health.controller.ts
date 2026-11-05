import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Response } from 'express';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { assertManagedEnrollment } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import {
  holdsManagedRuntimeLease,
  MANAGED_RUNTIME_READY_CACHE_MS,
  MANAGED_RUNTIME_READY_TIMEOUT_MS,
  MANAGED_RUNTIME_STATE,
  ManagedRuntimeState,
  managedStorageNamespace,
  withTimeout,
} from '@gitroom/backend/managed-runtime/managed-runtime.config';

type CheckResult = 'ok' | 'error';

interface Readiness {
  ok: boolean;
  checks: Record<'enrollment' | 'redis' | 'lease' | 'storage', CheckResult>;
}

// Unauthenticated, so only for the private network: it answers with check
// names and ok / error, never a count, an organization, a host or a reason.
// Never cached by a proxy; within the process one result serves every probe
// for MANAGED_RUNTIME_READY_CACHE_MS
@Controller('/managed-runtime')
export class ManagedRuntimeHealthController {
  private _readiness?: { at: number; result: Promise<Readiness> };

  constructor(
    private _prismaService: PrismaService,
    @Inject(MANAGED_RUNTIME_STATE) private _state: ManagedRuntimeState
  ) {}

  private async check(run: () => Promise<boolean>): Promise<CheckResult> {
    try {
      return (await withTimeout(run(), MANAGED_RUNTIME_READY_TIMEOUT_MS))
        ? 'ok'
        : 'error';
    } catch (err) {
      return 'error';
    }
  }

  // liveness: the process answers; nothing else is contacted
  @Get('/health')
  health() {
    return { status: 'ok' };
  }

  // readiness: the enrollment table can be read and every durable enrollment
  // is enrolled in this process, Redis answers, this process still holds the
  // single-instance lease, and the upload directory is the same private
  // volume the process started with. The full schema check runs once, at
  // startup
  @Get('/ready')
  async ready(@Res() res: Response) {
    if (
      !this._readiness ||
      Date.now() - this._readiness.at >= MANAGED_RUNTIME_READY_CACHE_MS
    ) {
      this._readiness = { at: Date.now(), result: this.readiness() };
    }

    const { ok, checks } = await this._readiness.result;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'error', checks });
  }

  private async readiness(): Promise<Readiness> {
    const [enrollment, redis, lease, storage] = await Promise.all([
      this.check(async () => {
        await assertManagedEnrollment(this._prismaService, { quiet: true });
        return true;
      }),
      this.check(async () => (await ioRedis.ping()) === 'PONG'),
      this.check(() => holdsManagedRuntimeLease(ioRedis, this._state.instanceId)),
      this.check(
        async () =>
          (await managedStorageNamespace(String(process.env.UPLOAD_DIRECTORY))) ===
          this._state.storageNamespace
      ),
    ]);

    const checks = { enrollment, redis, lease, storage };
    return { ok: Object.values(checks).every((result) => result === 'ok'), checks };
  }
}
