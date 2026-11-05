import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { ThrottlerManagedCredentialGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import {
  ManagedScopeGuard,
  RequireManagedScope,
} from '@gitroom/backend/services/auth/managed.scope.guard';
import { GetManagedCredentialFromRequest } from '@gitroom/nestjs-libraries/user/managed.credential.from.request';
import {
  ManagedCredential,
  managedRateLimit,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { MANAGED_HELPER_SCOPE } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.contracts';
import { ManagedHelperService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.service';
import { ManagedHelperRequestDto } from '@gitroom/nestjs-libraries/dtos/managed/managed.helper.dto';

// W&W platform helpers (docs/managed-extension/platform-helpers.md). One
// read-only provider lookup per request, for a channel of the credential's
// organization. Same guards and shared 200 / hour budget as every managed
// route
@ApiTags('Managed API')
@Controller('/managed/v1/helpers')
@UseGuards(ThrottlerManagedCredentialGuard, ManagedScopeGuard)
@Throttle({ default: { limit: managedRateLimit(), ttl: 3600000 } })
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  })
)
export class ManagedHelperController {
  constructor(private _helperService: ManagedHelperService) {}

  // a POST because the input is a typed body; it changes nothing
  @Post('/calls')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequireManagedScope(MANAGED_HELPER_SCOPE)
  call(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Body() body: ManagedHelperRequestDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    // a response that closed before the listener was added emits no more
    if (res.destroyed || res.writableFinished) {
      ac.abort();
    }

    return this._helperService.run(credential, body, ac.signal);
  }
}
