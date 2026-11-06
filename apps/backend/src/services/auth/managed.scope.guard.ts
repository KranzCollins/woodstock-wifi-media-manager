import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ManagedCredential,
  ManagedScope,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

export const MANAGED_SCOPE_KEY = 'managed_scope';
export const RequireManagedScope = (scope: ManagedScope) =>
  SetMetadata(MANAGED_SCOPE_KEY, scope);

// Every managed route declares the one scope it needs; a route without one is
// refused, so a forgotten decorator fails closed
@Injectable()
export class ManagedScopeGuard implements CanActivate {
  constructor(private _reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const scope = this._reflector.get<ManagedScope>(
      MANAGED_SCOPE_KEY,
      context.getHandler()
    );
    const credential: ManagedCredential | undefined = context
      .switchToHttp()
      .getRequest().managedCredential;

    if (!scope || !credential?.scopes.includes(scope)) {
      throw new ForbiddenException({
        code: 'SCOPE_MISSING',
        msg: `This credential does not have the ${scope || 'required'} scope`,
      });
    }

    return true;
  }
}
