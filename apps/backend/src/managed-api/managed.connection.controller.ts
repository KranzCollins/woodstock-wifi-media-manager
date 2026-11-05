import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  SetMetadata,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ThrottlerManagedCredentialGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import {
  MANAGED_SCOPE_KEY,
  ManagedScopeGuard,
} from '@gitroom/backend/services/auth/managed.scope.guard';
import { GetManagedCredentialFromRequest } from '@gitroom/nestjs-libraries/user/managed.credential.from.request';
import {
  ManagedCredential,
  managedRateLimit,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import {
  MANAGED_CONNECTION_SCOPES,
  ManagedConnectionService,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.service';
import {
  CreateManagedConnectionIntentDto,
  ManagedConnectionCallbackDto,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.connection.dto';

// The scope each route requires, read by the existing ManagedScopeGuard
// through the same metadata key as @RequireManagedScope. Until these scopes
// are in MANAGED_SCOPES no credential can hold them, so every route here
// refuses with SCOPE_MISSING
const RequireConnectionScope = (
  scope: (typeof MANAGED_CONNECTION_SCOPES)[keyof typeof MANAGED_CONNECTION_SCOPES]
) => SetMetadata(MANAGED_SCOPE_KEY, scope);

export const MANAGED_CONNECTION_ROUTE_SCOPES = {
  createIntent: MANAGED_CONNECTION_SCOPES.connect,
  getIntent: MANAGED_CONNECTION_SCOPES.connect,
  cancelIntent: MANAGED_CONNECTION_SCOPES.connect,
  retryIntent: MANAGED_CONNECTION_SCOPES.connect,
  recoverIntent: MANAGED_CONNECTION_SCOPES.connect,
  authorize: MANAGED_CONNECTION_SCOPES.relay,
  callback: MANAGED_CONNECTION_SCOPES.relay,
} as const;

// W&W managed account connection (docs/managed-extension/account-connection.md).
// The organization is always credential.organizationId. The AI-facing
// credential (channels:connect) never sees an authorization URL and never
// submits a code; only W&W's server relay (channels:connect-callback) does
@ApiTags('Managed API')
@Controller('/managed/v1/connections')
@UseGuards(ThrottlerManagedCredentialGuard, ManagedScopeGuard)
@Throttle({ default: { limit: managedRateLimit(), ttl: 3600000 } })
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  })
)
export class ManagedConnectionController {
  constructor(private _connectionService: ManagedConnectionService) {}

  @Post('/intents')
  @RequireConnectionScope(MANAGED_CONNECTION_ROUTE_SCOPES.createIntent)
  createIntent(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Body() body: CreateManagedConnectionIntentDto
  ) {
    return this._connectionService.createIntent(
      credential.organizationId,
      credential.id,
      body
    );
  }

  @Get('/intents/:intentId')
  @RequireConnectionScope(MANAGED_CONNECTION_ROUTE_SCOPES.getIntent)
  getIntent(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('intentId', new ParseUUIDPipe()) intentId: string
  ) {
    return this._connectionService.getIntent(
      credential.organizationId,
      credential.id,
      intentId
    );
  }

  @Post('/intents/:intentId/cancel')
  @RequireConnectionScope(MANAGED_CONNECTION_ROUTE_SCOPES.cancelIntent)
  cancelIntent(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('intentId', new ParseUUIDPipe()) intentId: string
  ) {
    return this._connectionService.cancelIntent(
      credential.organizationId,
      credential.id,
      intentId
    );
  }

  @Post('/intents/:intentId/retry')
  @RequireConnectionScope(MANAGED_CONNECTION_ROUTE_SCOPES.retryIntent)
  retryIntent(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('intentId', new ParseUUIDPipe()) intentId: string
  ) {
    return this._connectionService.retryIntent(
      credential.organizationId,
      credential.id,
      intentId
    );
  }

  // never calls the provider: an exchange that outlived its lease becomes
  // UNKNOWN
  @Post('/intents/:intentId/recover')
  @RequireConnectionScope(MANAGED_CONNECTION_ROUTE_SCOPES.recoverIntent)
  recoverIntent(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('intentId', new ParseUUIDPipe()) intentId: string
  ) {
    return this._connectionService.recoverIntent(
      credential.organizationId,
      credential.id,
      intentId
    );
  }

  // relay only: the answer carries the state inside the provider URL
  @Post('/intents/:intentId/authorization')
  @Header('Cache-Control', 'no-store')
  @RequireConnectionScope(MANAGED_CONNECTION_ROUTE_SCOPES.authorize)
  authorize(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('intentId', new ParseUUIDPipe()) intentId: string
  ) {
    return this._connectionService.authorize(credential, intentId);
  }

  @Post('/intents/:intentId/callback')
  @Header('Cache-Control', 'no-store')
  @RequireConnectionScope(MANAGED_CONNECTION_ROUTE_SCOPES.callback)
  callback(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('intentId', new ParseUUIDPipe()) intentId: string,
    @Body() body: ManagedConnectionCallbackDto
  ) {
    return this._connectionService.callback(credential, intentId, body);
  }
}
