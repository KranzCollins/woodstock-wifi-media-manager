import { Controller, Get, Param, Req, Res, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ManagedMediaCapabilityService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-capability';

const EXTENSION: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4' };
const MAX_RESPONSES = 2;
const WRITE_DEADLINE_MS = 10_000;
// Process-wide even if a future DI dependency makes a controller scoped.
let activeResponses = 0;

// The provider authenticates this one private byte read with the signed
// capability path, not the managed service credential. The service verifies
// its current DB authority and charges the same organization budget. Never
// log this URL or put it in a DTO/event. The isolated runtime must serve this
// route without an access log containing paths.
@Controller('/managed-media')
export class ManagedLifecycleMediaController {
  constructor(private readonly media: ManagedMediaCapabilityService) {}

  @Get('/:filename')
  async fetch(@Param('filename') filename: string, @Req() request: Request, @Res() response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET') throw new HttpException({ code: 'METHOD_NOT_ALLOWED' }, HttpStatus.METHOD_NOT_ALLOWED);
    const match = typeof filename === 'string' && filename.length < 512
      ? /^([A-Za-z0-9_.-]+)\.(jpg|png|mp4)$/.exec(filename) : null;
    if (!match || Object.keys(request.query).length ||
        (request.headers.range !== undefined && typeof request.headers.range !== 'string')) {
      throw new HttpException({ code: 'CAPABILITY_INVALID' }, HttpStatus.NOT_FOUND);
    }
    // Bound both in-flight service work and buffers retained by slow sockets.
    // A disconnected client does not free its slot until its service work
    // has ended. Otherwise repeated disconnects could accumulate read work.
    if (activeResponses >= MAX_RESPONSES) {
      response.setHeader('Retry-After', '1');
      throw new HttpException({ code: 'CAPACITY_UNAVAILABLE' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    activeResponses++;
    let workEnded = false;
    let responseEnded = false;
    let released = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (!released && workEnded && responseEnded) {
        released = true; activeResponses--; clearTimeout(timer);
        response.off('finish', ended); response.off('close', ended);
      }
    };
    const ended = () => { responseEnded = true; release(); };
    response.once('finish', ended); response.once('close', ended);
    try {
      const result = await this.media.fetch({ token: match[1], range: request.headers.range, expectedMimeType: EXTENSION[match[2]] });
      workEnded = true;
      if (response.destroyed || responseEnded) { responseEnded = true; release(); return; }
      if (result.headers['content-type'] !== EXTENSION[match[2]]) {
        throw new HttpException({ code: 'CAPABILITY_INVALID' }, HttpStatus.NOT_FOUND);
      }
      for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
      response.status(result.status);
      timer = setTimeout(() => response.destroy(), WRITE_DEADLINE_MS);
      timer.unref();
      response.end(result.body);
    } catch (error) {
      workEnded = true; responseEnded = true; release();
      throw error;
    }
  }
}
