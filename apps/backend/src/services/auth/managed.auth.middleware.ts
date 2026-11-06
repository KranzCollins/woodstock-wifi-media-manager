import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import { Request, Response, NextFunction } from 'express';
import { isIP } from 'net';
import {
  findManagedCredential,
  isManagedModeEnabled,
  isManagedOrganization,
  MANAGED_AUTH_ATTEMPTS_PER_HOUR,
  MANAGED_AUTH_FAILURES_PER_HOUR,
  sha256Hex,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

// Headers other routes use to pick or switch an organization; none of them
// means anything on the managed API, so a request carrying one is refused
// rather than silently ignored
const ORGANIZATION_OVERRIDES = ['x-postiz-org', 'showorg', 'impersonate'];

const HOUR = 3600000;

const FAILURES_KEY = 'managed_auth_failures';

// The address Express resolved: the socket peer, or with the runtime's
// bounded `trust proxy` the entry its trusted proxy added. No forwarding
// header is read here. Anything that is not an IP address shares one bucket,
// and the key is a fixed-length digest, so no request chooses the size or the
// number of Redis keys
function addressKey(req: Request) {
  const ip =
    typeof req.ip === 'string'
      ? req.ip.replace(/^::ffff:(?=\d{1,3}(\.\d{1,3}){3}$)/i, '')
      : '';
  return `managed_auth_${sha256Hex(isIP(ip) ? ip.toLowerCase() : 'unresolved')}`;
}

// JSON bodies are already bounded to 100 kB; this bounds their nesting, so
// deeply nested settings can't exhaust the stack of the transformer, the
// validator or the canonical hash
const MAX_BODY_DEPTH = 12;

function deeperThan(value: unknown, max: number) {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [current, depth] = stack.pop()!;
    if (current && typeof current === 'object') {
      if (depth >= max) {
        return true;
      }
      for (const child of Object.values(current)) {
        stack.push([child, depth + 1]);
      }
    }
  }

  return false;
}

// Service authentication for the W&W managed API. Separate from the cookie /
// `auth` header session, Postiz API keys and OAuth app tokens: only a bearer
// token whose SHA-256 is configured in POSTIZ_MANAGED_CREDENTIALS is
// accepted, and the organization is the one bound to that credential.
@Injectable()
export class ManagedAuthMiddleware implements NestMiddleware {
  constructor(
    @InjectThrottlerStorage() private _throttlerStorage: ThrottlerStorage
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    if (!isManagedModeEnabled()) {
      res.status(HttpStatus.NOT_FOUND).json({ code: 'NOT_FOUND', msg: 'Not found' });
      return;
    }

    if (ORGANIZATION_OVERRIDES.some((header) => req.headers[header] !== undefined)) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'ORGANIZATION_OVERRIDE_REFUSED',
        msg: 'The organization comes from the managed credential only',
      });
      return;
    }

    const authorization = req.headers.authorization;
    const bearer = /^Bearer ([^\s]+)$/.exec(
      typeof authorization === 'string' ? authorization : ''
    );
    const found = findManagedCredential(bearer?.[1]);
    const credential =
      found && isManagedOrganization(found.organizationId) ? found : undefined;

    // Every request is counted for its address before its outcome is
    // answered, so token guessing is bounded per address. A failing one is
    // first counted against the global failure bound, and once that is
    // exhausted no address counter is created for it
    let blocked: boolean;
    try {
      blocked =
        (!credential &&
          (await this.blocked(FAILURES_KEY, MANAGED_AUTH_FAILURES_PER_HOUR))) ||
        (await this.blocked(addressKey(req), MANAGED_AUTH_ATTEMPTS_PER_HOUR));
    } catch (err) {
      // without the counters there is no bound: fail closed
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        code: 'AUTH_LIMIT_UNAVAILABLE',
        msg: 'The managed API is unavailable',
      });
      return;
    }

    if (blocked) {
      res
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .json({ code: 'TOO_MANY_ATTEMPTS', msg: 'Too many requests' });
      return;
    }

    if (!credential) {
      res
        .status(HttpStatus.UNAUTHORIZED)
        .json({ code: 'UNAUTHENTICATED', msg: 'Invalid managed credential' });
      return;
    }

    if (deeperThan(req.body, MAX_BODY_DEPTH)) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'INVALID_INPUT',
        msg: `The body is nested deeper than ${MAX_BODY_DEPTH} levels`,
      });
      return;
    }

    // @ts-ignore
    req.managedCredential = credential;
    next();
  }

  private async blocked(key: string, limit: number) {
    const { isBlocked } = await this._throttlerStorage.increment(
      key,
      HOUR,
      limit,
      HOUR,
      'managed-auth'
    );
    return isBlocked;
  }
}
