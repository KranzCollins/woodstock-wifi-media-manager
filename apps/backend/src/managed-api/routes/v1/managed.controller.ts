import {
  Body,
  Controller,
  Get,
  GoneException,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
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
import { ManagedService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import {
  CreateManagedDraftDto,
  EditManagedDraftDto,
  QualifyManagedChannelDto,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';
import { ReserveManagedMediaUploadDto } from '@gitroom/nestjs-libraries/dtos/managed/managed.media.upload.dto';
import {
  ManagedChangesQueryDto,
  ManagedInventoryQueryDto,
  ManagedMediaObservationQueryDto,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.query.dto';

// W&W managed-organization API (docs/managed-extension/README.md). The
// organization is always credential.organizationId; nothing in a request can
// choose another one, and unknown body fields are rejected.
@ApiTags('Managed API')
@Controller('/managed/v1')
@UseGuards(ThrottlerManagedCredentialGuard, ManagedScopeGuard)
@Throttle({ default: { limit: managedRateLimit(), ttl: 3600000 } })
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  })
)
export class ManagedController {
  constructor(
    private _managedService: ManagedService,
    private _managedMediaService: ManagedMediaService
  ) {}

  @Get('/capabilities')
  @RequireManagedScope('posts:read')
  capabilities() {
    return this._managedService.capabilities();
  }

  @Get('/channels')
  @RequireManagedScope('channels:read')
  listChannels(@GetManagedCredentialFromRequest() credential: ManagedCredential) {
    return this._managedService.listChannels(credential.organizationId);
  }

  @Post('/channels/:integrationId/qualify')
  @RequireManagedScope('channels:qualify')
  qualifyChannel(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('integrationId') integrationId: string,
    @Body() body: QualifyManagedChannelDto
  ) {
    return this._managedService.qualifyChannel(
      credential.organizationId,
      credential.id,
      integrationId,
      body
    );
  }

  // Reserved uploads: the reservation, and each attempt's exact object, are
  // committed before a byte is sent; see docs/managed-extension/README.md
  @Post('/media/uploads')
  @RequireManagedScope('media:upload')
  reserveMediaUpload(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Body() body: ReserveManagedMediaUploadDto
  ) {
    return this._managedMediaService.reserveUpload(
      credential.organizationId,
      credential.id,
      body
    );
  }

  @Get('/media/uploads/:operationKey')
  @RequireManagedScope('media:upload')
  mediaUploadStatus(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('operationKey') operationKey: string
  ) {
    return this._managedMediaService.uploadStatus(
      credential.organizationId,
      credential.id,
      operationKey
    );
  }

  // the raw body (application/octet-stream) is read by the service only
  // after the attempt holds the reservation
  @Put('/media/uploads/:operationKey/content')
  @RequireManagedScope('media:upload')
  mediaUploadContent(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('operationKey') operationKey: string,
    @Req() req: Request,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined
  ) {
    return this._managedMediaService.receiveUploadContent(
      credential.organizationId,
      credential.id,
      operationKey,
      req,
      contentType,
      contentLength
    );
  }

  @Post('/media/uploads/:operationKey/recover')
  @RequireManagedScope('media:upload')
  recoverMediaUpload(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('operationKey') operationKey: string
  ) {
    return this._managedMediaService.recoverUpload(
      credential.organizationId,
      credential.id,
      operationKey
    );
  }

  // Removed: it had no operation key (a retry after a lost response stored a
  // second object and media row) and no bound of its own. No interceptor or
  // body parser is attached, so not a byte of the request is read or stored;
  // /media/uploads is the only managed upload path
  @Post('/media')
  @ApiOperation({ deprecated: true })
  @RequireManagedScope('media:write')
  uploadMedia(): never {
    throw new GoneException({
      code: 'ENDPOINT_REMOVED',
      msg: 'Reserve the upload with POST /managed/v1/media/uploads',
    });
  }

  @Post('/media/:mediaId/verify')
  @RequireManagedScope('media:write')
  verifyMedia(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('mediaId', new ParseUUIDPipe()) mediaId: string
  ) {
    return this._managedMediaService.verifyStoredMedia(
      credential.organizationId,
      credential.id,
      mediaId
    );
  }

  @Get('/posts')
  @RequireManagedScope('posts:read')
  inventory(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Query() query: ManagedInventoryQueryDto
  ) {
    return this._managedService.inventory(
      credential.organizationId,
      query.cursor,
      query.limit ?? 50
    );
  }

  @Get('/posts/:managedPostId')
  @RequireManagedScope('posts:read')
  getPost(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('managedPostId', new ParseUUIDPipe()) managedPostId: string
  ) {
    return this._managedService.getPost(
      credential.organizationId,
      managedPostId
    );
  }

  @Get('/posts/:managedPostId/revisions')
  @RequireManagedScope('posts:read')
  listRevisions(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('managedPostId', new ParseUUIDPipe()) managedPostId: string
  ) {
    return this._managedService.listRevisions(
      credential.organizationId,
      managedPostId
    );
  }

  // a fresh read-only look at the private objects the current revision's
  // media were proven against; GET /posts/:managedPostId never reads storage.
  // A client that goes away stops the storage reads
  @Get('/posts/:managedPostId/media-observation')
  @RequireManagedScope('posts:read')
  observeCurrentMedia(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('managedPostId', new ParseUUIDPipe()) managedPostId: string,
    @Query() query: ManagedMediaObservationQueryDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    // a response that closed before the listener was added emits no more
    if (res.destroyed || res.writableFinished) {
      ac.abort();
    }

    return this._managedService.observeCurrentMedia(
      credential.organizationId,
      managedPostId,
      query.revision,
      ac.signal
    );
  }

  // a pure read: what a create / edit operation key committed, if anything
  @Get('/operations/:operationKey')
  @RequireManagedScope('posts:read')
  operationStatus(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('operationKey') operationKey: string
  ) {
    return this._managedService.operationStatus(
      credential.organizationId,
      operationKey
    );
  }

  @Post('/posts')
  @RequireManagedScope('posts:write')
  createDraft(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Body() body: CreateManagedDraftDto
  ) {
    return this._managedService.createDraft(
      credential.organizationId,
      credential.id,
      body
    );
  }

  @Put('/posts/:managedPostId')
  @RequireManagedScope('posts:write')
  editDraft(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Param('managedPostId', new ParseUUIDPipe()) managedPostId: string,
    @Body() body: EditManagedDraftDto
  ) {
    return this._managedService.editDraft(
      credential.organizationId,
      credential.id,
      managedPostId,
      body
    );
  }

  @Get('/changes')
  @RequireManagedScope('posts:read')
  changes(
    @GetManagedCredentialFromRequest() credential: ManagedCredential,
    @Query() query: ManagedChangesQueryDto
  ) {
    return this._managedService.changes(
      credential.organizationId,
      query.after ?? 0,
      query.limit ?? 100
    );
  }
}
