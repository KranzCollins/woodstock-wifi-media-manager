import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ManagedScopeGuard, RequireManagedScope } from '@gitroom/backend/services/auth/managed.scope.guard';
import { GetManagedCredentialFromRequest } from '@gitroom/nestjs-libraries/user/managed.credential.from.request';
import { ManagedCredential, managedRateLimit } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { ManagedLifecycleService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.service';
import { ManagedLifecycleException } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';
import { ThrottlerManagedCredentialGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import { ManagedLifecycleScheduleDto, ManagedLifecyclePublishNowDto, ManagedLifecycleCancelDto,
  ManagedLifecycleDeleteDto, ManagedLifecycleResolveDto } from '@gitroom/nestjs-libraries/dtos/managed/managed.lifecycle.dto';

// Exact ww.managed-lifecycle.v1 routes. Dedicated lifecycle lookup/feed do
// not change the historical draft protocol. Every read and write shares the
// organization request budget and authenticated scope guard. Mutation
// acceptance is not publication evidence; the service returns that contract.
@Controller('/managed/v1')
@UseGuards(ThrottlerManagedCredentialGuard, ManagedScopeGuard)
@Throttle({ default: { limit: managedRateLimit(), ttl: 3600000 } })
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class ManagedLifecycleController {
  constructor(private readonly service: ManagedLifecycleService) {}

  private principal(credential: ManagedCredential) {
    return { organizationId: credential.organizationId, credentialId: credential.id, scopes: credential.scopes };
  }
  private query(query: Record<string, unknown>, keys: readonly string[]) {
    if (!query || Object.keys(query).length !== keys.length || keys.some(key => typeof query[key] !== 'string') ||
        Object.keys(query).some(key => !keys.includes(key))) {
      throw new ManagedLifecycleException('LIFECYCLE_INPUT_INVALID', 'The query must contain exactly the declared fields');
    }
    return query;
  }

  @Get('/lifecycle/capabilities') @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:read')
  capabilities(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Query() query: Record<string, unknown>) {
    this.query(query, []);
    return this.service.capabilities(this.principal(credential));
  }

  @Get('/lifecycle/release-preview/:managedPostId') @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:read')
  preview(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Param('managedPostId') id: string,
    @Query() query: Record<string, unknown>) {
    this.query(query, ['revision', 'codec']);
    return this.service.releasePreview(this.principal(credential), id, { revision: query.revision, codec: query.codec });
  }

  @Get('/posts/:managedPostId/lifecycle') @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:read')
  lifecycle(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Param('managedPostId') id: string,
    @Query() query: Record<string, unknown>) {
    this.query(query, []);
    return this.service.lifecycle(this.principal(credential), id);
  }

  @Get('/dispatches/:dispatchId') @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:read')
  dispatch(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Param('dispatchId') id: string,
    @Query() query: Record<string, unknown>) {
    this.query(query, []);
    return this.service.dispatch(this.principal(credential), id);
  }

  @Get('/lifecycle/operations/:operationKey') @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:read')
  operation(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Param('operationKey') key: string,
    @Query() query: Record<string, unknown>) {
    this.query(query, []);
    return this.service.operation(this.principal(credential), key);
  }

  @Get('/lifecycle/events') @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:read')
  events(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Query() query: Record<string, unknown>) {
    this.query(query, ['after']);
    return this.service.events(this.principal(credential), query.after);
  }

  @Post('/posts/:managedPostId/schedule') @HttpCode(200) @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:schedule')
  schedule(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Param('managedPostId') id: string,
    @Body() body: ManagedLifecycleScheduleDto, @Query() query: Record<string, unknown>) {
    this.query(query, []);
    return this.service.schedule(this.principal(credential), id, body);
  }

  @Post('/posts/:managedPostId/publish-now') @HttpCode(200) @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:publish')
  publishNow(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Param('managedPostId') id: string,
    @Body() body: ManagedLifecyclePublishNowDto, @Query() query: Record<string, unknown>) {
    this.query(query, []);
    return this.service.publishNow(this.principal(credential), id, body);
  }

  @Post('/posts/:managedPostId/cancel') @HttpCode(200) @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:schedule')
  cancel(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Param('managedPostId') id: string,
    @Body() body: ManagedLifecycleCancelDto, @Query() query: Record<string, unknown>) {
    this.query(query, []);
    return this.service.cancel(this.principal(credential), id, body);
  }

  @Post('/posts/:managedPostId/delete') @HttpCode(200) @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:schedule')
  delete(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Param('managedPostId') id: string,
    @Body() body: ManagedLifecycleDeleteDto, @Query() query: Record<string, unknown>) {
    this.query(query, []);
    return this.service.delete(this.principal(credential), id, body);
  }

  @Post('/dispatches/:dispatchId/resolve') @HttpCode(200) @Header('Cache-Control', 'no-store') @RequireManagedScope('posts:publish')
  resolve(@GetManagedCredentialFromRequest() credential: ManagedCredential, @Param('dispatchId') id: string,
    @Body() body: ManagedLifecycleResolveDto, @Query() query: Record<string, unknown>) {
    this.query(query, []);
    return this.service.resolve(this.principal(credential), id, body);
  }
}
