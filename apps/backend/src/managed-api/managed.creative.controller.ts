import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  Res,
  StreamableFile,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
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
import {
  CREATIVE_UUID,
  MANAGED_CREATIVE_SCOPE,
  ManagedCreativeException,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.contracts';
import { ManagedCreativeService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.service';
import {
  ManagedCreativeArtifactDto,
  ManagedCreativeCallDto,
  ManagedCreativeJobDto,
  ManagedCreativePollDto,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.creative.dto';

// The owned creative runtime (docs/managed-extension/creative-runtime.md):
// W&W's CreativeProviderRuntime port over HTTP, for the organization of a
// dedicated creative credential. Same guards and shared 200 / hour budget as
// every managed route. Every kind is off until the operator enables it.
@ApiTags('Managed API')
@Controller('/managed/v1/creative')
@UseGuards(ThrottlerManagedCredentialGuard, ManagedScopeGuard)
@Throttle({ default: { limit: managedRateLimit(), ttl: 3600000 } })
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  })
)
export class ManagedCreativeController {
  constructor(private _creativeService: ManagedCreativeService) {}

  private jobId(jobId: string) {
    if (!CREATIVE_UUID.test(jobId)) {
      throw new ManagedCreativeException('CREATIVE_INPUT_INVALID', 'jobId must be a W&W job uuid');
    }
    return jobId;
  }

  // Binds the job id, its W&W scope and its frozen input to this
  // organization; the same binding again answers the same
  @Put('/jobs/:jobId')
  @Header('Cache-Control', 'no-store')
  @RequireManagedScope(MANAGED_CREATIVE_SCOPE)
  bindJob(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('jobId') jobId: string,
    @Body() body: ManagedCreativeJobDto
  ) {
    return this._creativeService.bindJob(credential, this.jobId(jobId), body);
  }

  // The exact bytes of one declared Seedance source asset version, as
  // application/octet-stream with X-WW-Source-Sha256
  @Put('/jobs/:jobId/sources/:assetId/versions/:version')
  @Header('Cache-Control', 'no-store')
  @RequireManagedScope(MANAGED_CREATIVE_SCOPE)
  putSource(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('jobId') jobId: string,
    @Param('assetId') assetId: string,
    @Param('version', ParseIntPipe) version: number,
    @Req() req: Request,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Headers('x-ww-source-sha256') sha256: string | undefined
  ) {
    if (!CREATIVE_UUID.test(assetId)) {
      throw new ManagedCreativeException('CREATIVE_SOURCE_NOT_DECLARED', 'assetId must be a W&W asset uuid');
    }
    return this._creativeService.putSource(
      credential,
      this.jobId(jobId),
      assetId,
      version,
      req,
      contentType,
      contentLength,
      sha256
    );
  }

  // One billable call. Every answer the call can have is a 200 with W&W's
  // shape; only a request that never reached the gate is an error
  @Post('/calls')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequireManagedScope(MANAGED_CREATIVE_SCOPE)
  call(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Body() body: ManagedCreativeCallDto
  ) {
    return this._creativeService.call(credential, body);
  }

  // A read of a handle one of this organization's calls recorded
  @Post('/polls')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequireManagedScope(MANAGED_CREATIVE_SCOPE)
  poll(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Body() body: ManagedCreativePollDto
  ) {
    return this._creativeService.poll(credential, body);
  }

  // The retained bytes of a finished call (the image, the video or one
  // clip), or { kind: 'missing', code } as JSON. Never a url
  @Post('/artifacts/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequireManagedScope(MANAGED_CREATIVE_SCOPE)
  async readArtifact(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Body() body: ManagedCreativeArtifactDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const read = await this._creativeService.readArtifact(credential, body);
    if (read.kind === 'missing') {
      return { kind: 'missing', code: read.code };
    }

    res.setHeader('X-WW-Artifact-Sha256', read.sha256);
    return new StreamableFile(read.bytes, {
      type: read.contentType,
      length: read.bytes.length,
    });
  }

  // ImagesSlides.loadVoices: the premade voice ids and names
  @Get('/voices')
  @Header('Cache-Control', 'no-store')
  @RequireManagedScope(MANAGED_CREATIVE_SCOPE)
  voices(@GetManagedCredentialFromRequest() credential: ManagedCredential) {
    return this._creativeService.voices(credential);
  }
}
