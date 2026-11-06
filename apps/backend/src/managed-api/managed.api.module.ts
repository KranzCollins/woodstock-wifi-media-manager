import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ManagedController } from '@gitroom/backend/managed-api/routes/v1/managed.controller';
import { ManagedAuthMiddleware } from '@gitroom/backend/services/auth/managed.auth.middleware';
import { ManagedScopeGuard } from '@gitroom/backend/services/auth/managed.scope.guard';
import { ManagedConnectionController } from '@gitroom/backend/managed-api/managed.connection.controller';
import { ManagedConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.repository';
import { ManagedConnectionService, managedConnectionProviders } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.service';

import { ManagedHelperController } from '@gitroom/backend/managed-api/managed.helper.controller';
import { ManagedHelperRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.repository';
import { ManagedHelperService, managedHelperProviders } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.service';
import { ManagedCreativeController } from '@gitroom/backend/managed-api/managed.creative.controller';
import { ManagedCreativeRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.repository';
import { ManagedCreativeService, managedCreativeProviders } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.service';

// Mounted only with POSTIZ_MANAGED_MODE=enabled (docs/managed-extension)
const managedController =
  process.env.POSTIZ_MANAGED_MODE === 'enabled' && !process.env.MCP_ONLY
    ? [ManagedController, ManagedConnectionController, ManagedHelperController, ManagedCreativeController]
    : [];

@Module({
  imports: [],
  controllers: managedController,
  providers: [ManagedAuthMiddleware, ManagedScopeGuard, ManagedConnectionRepository, ManagedConnectionService, managedConnectionProviders, ManagedHelperRepository, ManagedHelperService, ...managedHelperProviders, ManagedCreativeRepository, ManagedCreativeService, ...managedCreativeProviders],
})
export class ManagedApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    if (managedController.length) {
      consumer.apply(ManagedAuthMiddleware).forRoutes(...managedController);
    }
  }
}
