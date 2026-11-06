import { DynamicModule, Global, Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { ManagedService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import { managedRateLimit } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { ManagedApiModule } from '@gitroom/backend/managed-api/managed.api.module';
import { ManagedRuntimeHealthController } from '@gitroom/backend/managed-runtime/health.controller';
import {
  MANAGED_RUNTIME_STATE,
  ManagedRuntimeState,
} from '@gitroom/backend/managed-runtime/managed-runtime.config';

import { managedLifecycleProviders } from './managed-lifecycle.providers';
import { ManagedLifecycleController } from '../managed-api/managed.lifecycle.controller';
import { ManagedLifecycleMediaController } from '../managed-api/managed.lifecycle.media.controller';
import { ManagedAuthMiddleware } from '../services/auth/managed.auth.middleware';
import { ManagedScopeGuard } from '../services/auth/managed.scope.guard';

// The isolated W&W managed runtime (docs/managed-extension/deployment.md):
// the managed API and exactly the providers it injects. Unlike AppModule, no
// Temporal client or worker registration, dashboard / public API, agent, chat,
// video, third-party, payment or social provider is loaded
const providers = [
  PrismaService,
  PrismaRepository,
  PrismaTransaction,
  ManagedRepository,
  ManagedService,
  ManagedMediaService,
  ManagedAuthMiddleware,
  ManagedScopeGuard,
  ...managedLifecycleProviders,
];

@Global()
@Module({
  imports: [
    ManagedApiModule,
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 3600000,
          limit: managedRateLimit(),
        },
      ],
      storage: new ThrottlerStorageRedisService(ioRedis),
    }),
  ],
  controllers: [ManagedRuntimeHealthController, ManagedLifecycleController, ManagedLifecycleMediaController],
  providers,
  exports: providers,
})
export class ManagedRuntimeModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Signed media is independently authenticated, metered and private. Only
    // this isolated runtime mounts it; the upstream Sentry app never does.
    consumer.apply(ManagedAuthMiddleware).forRoutes(ManagedLifecycleController);
  }

  static register(state: ManagedRuntimeState): DynamicModule {
    return {
      module: ManagedRuntimeModule,
      providers: [{ provide: MANAGED_RUNTIME_STATE, useValue: state }],
    };
  }
}
