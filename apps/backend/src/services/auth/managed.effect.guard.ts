import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { refuseManagedEffect } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';

export const MANAGED_EFFECT_KEY = 'managed_effect';

// Refuses a managed organization before the route's interceptors run. Guards
// run before FileInterceptor, so a multipart body is never streamed into
// storage for an organization whose Media create the write fence would refuse
// afterwards. Unmanaged organizations pass unchanged.
@Injectable()
export class ManagedEffectGuard implements CanActivate {
  constructor(private _reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const effect = this._reflector.get<string>(
      MANAGED_EFFECT_KEY,
      context.getHandler()
    );

    refuseManagedEffect(
      context.switchToHttp().getRequest().org?.id,
      effect || 'this request'
    );

    return true;
  }
}

export const RefuseManagedEffect = (effect: string) =>
  applyDecorators(
    SetMetadata(MANAGED_EFFECT_KEY, effect),
    UseGuards(ManagedEffectGuard)
  );
