import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  BindingRow,
  IntegrationIdentity,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';

// Prisma reads of W&W platform helpers (docs/managed-extension/
// platform-helpers.md). Read only: nothing here writes, so a helper call
// never refreshes a token, marks a channel or records anything. Every query
// names the organization of the credential.

export type HelperIntegrationRow = IntegrationIdentity & {
  tokenExpiration: Date | null;
};

export interface HelperChannel {
  integration: HelperIntegrationRow | null;
  binding: BindingRow | null;
}

// Server-private: the access token of the bound channel. It goes from here
// to one provider adapter call and nowhere else (no result, error or log)
export interface HelperChannelWithToken extends HelperChannel {
  token: string | null;
}

const HELPER_INTEGRATION_SELECT = {
  id: true,
  organizationId: true,
  providerIdentifier: true,
  internalId: true,
  rootInternalId: true,
  profile: true,
  name: true,
  customName: true,
  disabled: true,
  refreshNeeded: true,
  inBetweenSteps: true,
  deletedAt: true,
  tokenExpiration: true,
} as const;

const HELPER_BINDING_SELECT = {
  id: true,
  organizationId: true,
  integrationId: true,
  generation: true,
  status: true,
  providerIdentifier: true,
  internalId: true,
  profile: true,
  identityFingerprint: true,
  qualifiedAt: true,
  pausedAt: true,
} as const;

@Injectable()
export class ManagedHelperRepository {
  constructor(private _transaction: PrismaTransaction) {}

  // the channel and its binding from one snapshot
  private read<T>(func: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this._transaction.model.$transaction(func, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  private async channel(
    tx: Prisma.TransactionClient,
    organizationId: string,
    integrationId: string
  ): Promise<HelperChannel> {
    const integration = await tx.integration.findFirst({
      where: { id: integrationId, organizationId },
      select: HELPER_INTEGRATION_SELECT,
    });
    const binding = (await tx.managedChannelBinding.findFirst({
      where: { integrationId, organizationId },
      select: HELPER_BINDING_SELECT,
    })) as BindingRow | null;

    return { integration, binding };
  }

  // before the provider call
  readChannelWithToken(
    organizationId: string,
    integrationId: string
  ): Promise<HelperChannelWithToken> {
    return this.read(async (tx) => {
      const channel = await this.channel(tx, organizationId, integrationId);
      const credential = channel.integration
        ? await tx.integration.findFirst({
            where: { id: integrationId, organizationId },
            select: { token: true },
          })
        : null;

      return { ...channel, token: credential?.token ?? null };
    });
  }

  // after the provider call: the same rows, without the token
  readChannel(
    organizationId: string,
    integrationId: string
  ): Promise<HelperChannel> {
    return this.read((tx) => this.channel(tx, organizationId, integrationId));
  }
}
