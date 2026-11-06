import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ManagedCredential } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

// The W&W managed credential ManagedAuthMiddleware matched; its
// organizationId is the only organization a managed request can act on
export const GetManagedCredentialFromRequest = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): ManagedCredential => {
    const request = ctx.switchToHttp().getRequest();
    return request.managedCredential;
  }
);
