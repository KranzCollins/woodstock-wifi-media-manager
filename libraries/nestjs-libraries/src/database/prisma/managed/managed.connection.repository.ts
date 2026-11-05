import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { runAsManagedWriter } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.write.fence';
import {
  BindingRow,
  EventRow,
  IntegrationIdentity,
  ManagedRepository,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { ManagedConnectionMode } from '@gitroom/nestjs-libraries/dtos/managed/managed.connection.dto';
import {
  ManagedConnectionAccount,
  ManagedConnectionGrant,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.provider';

// Prisma access of managed account connections
// (docs/managed-extension/account-connection.md). Integration is only read
// and written with CONNECTION_INTEGRATION_SELECT: a token is written to the
// row, but no token, refreshToken, customInstanceDetails or
// additionalSettings is ever read back out of this file.

export type ConnectionIntentStatus =
  | 'PENDING'
  | 'EXCHANGING'
  | 'COMPLETED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'CANCELLED'
  | 'EXPIRED';

export type ConnectionAttemptOutcome =
  | 'ISSUED'
  | 'REPLACED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'EXCHANGING'
  | 'COMPLETED'
  | 'FAILED'
  | 'UNKNOWN';

export type ConnectionFailureCode =
  // the provider sent an error instead of a code; nothing was exchanged
  | 'PROVIDER_DENIED'
  // the exchange could not be started; nothing was sent
  | 'EXCHANGE_NOT_SENT'
  // the provider refused the code; no token was issued
  | 'EXCHANGE_REFUSED'
  // a token was issued without the requested scopes; it was dropped
  | 'SCOPES_MISSING'
  // the authorizing account is not the expected one; nothing was bound
  | 'ACCOUNT_MISMATCH'
  | 'TARGET_IDENTITY_MISMATCH'
  // the target changed since the intent was created; nothing was bound
  | 'ALREADY_CONNECTED'
  | 'INTEGRATION_NOT_RECONNECTABLE'
  | 'BINDING_GENERATION_MISMATCH'
  // UNKNOWN: the provider may have issued a token we do not hold
  | 'EXCHANGE_TIMEOUT'
  | 'EXCHANGE_OUTCOME_UNKNOWN'
  | 'RECORD_FAILED';

export interface ConnectionIntentRow {
  id: string;
  operationKey: string;
  credentialId: string;
  requestHash: string;
  providerIdentifier: string;
  mode: ManagedConnectionMode;
  targetIntegrationId: string | null;
  expectedBindingGeneration: number | null;
  expectedInternalId: string | null;
  expectedProfile: string | null;
  status: ConnectionIntentStatus;
  attempt: number;
  expiresAt: Date;
  leaseExpiresAt: Date | null;
  failureCode: ConnectionFailureCode | null;
  integrationId: string | null;
  bindingGeneration: number | null;
  bindingStatus: string | null;
  completedSequence: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectionAttemptRow {
  id: string;
  intentId: string;
  attempt: number;
  // server-private: never returned
  stateDigest: string;
  relayCredentialId: string;
  expiresAt: Date;
  outcome: ConnectionAttemptOutcome;
  // server-private: never returned
  codeDigest: string | null;
  callbackCredentialId: string | null;
  claimedAt: Date | null;
  failureCode: ConnectionFailureCode | null;
  observedInternalId: string | null;
  observedProfile: string | null;
  observedAt: Date | null;
  providerExpiresIn: number | null;
  grantedScopes: string | null;
}

export type ConnectionIntentUpdate = Partial<
  Pick<
    ConnectionIntentRow,
    | 'status'
    | 'attempt'
    | 'leaseExpiresAt'
    | 'failureCode'
    | 'integrationId'
    | 'bindingGeneration'
    | 'bindingStatus'
    | 'completedSequence'
  >
>;

export type ConnectionAttemptUpdate = Partial<
  Pick<
    ConnectionAttemptRow,
    | 'outcome'
    | 'codeDigest'
    | 'callbackCredentialId'
    | 'claimedAt'
    | 'failureCode'
    | 'observedInternalId'
    | 'observedProfile'
    | 'observedAt'
    | 'providerExpiresIn'
    | 'grantedScopes'
  >
>;

export interface ConnectionReader {
  getIntent(intentId: string): Promise<ConnectionIntentRow | null>;
  getIntentByOperationKey(
    operationKey: string
  ): Promise<ConnectionIntentRow | null>;
  getAttempt(
    intentId: string,
    attempt: number
  ): Promise<ConnectionAttemptRow | null>;
}

export interface ConnectionTx extends ConnectionReader {
  // dense per-organization sequence, shared with the managed change feed
  nextSequence(): number;
  createIntent(
    data: Omit<
      ConnectionIntentRow,
      | 'id'
      | 'status'
      | 'attempt'
      | 'leaseExpiresAt'
      | 'failureCode'
      | 'integrationId'
      | 'bindingGeneration'
      | 'bindingStatus'
      | 'completedSequence'
      | 'createdAt'
      | 'updatedAt'
    >
  ): Promise<ConnectionIntentRow>;
  // Moves the intent only from the status and attempt it was read in; null
  // when it already left them (the transaction is then rolled back by the
  // caller's refusal)
  moveIntent(
    from: Pick<ConnectionIntentRow, 'id' | 'status' | 'attempt'>,
    data: ConnectionIntentUpdate
  ): Promise<ConnectionIntentRow | null>;
  createAttempt(
    data: Pick<
      ConnectionAttemptRow,
      'intentId' | 'attempt' | 'stateDigest' | 'relayCredentialId' | 'expiresAt'
    >
  ): Promise<ConnectionAttemptRow>;
  // Moves the attempt only from the outcome it was read in
  moveAttempt(
    from: Pick<ConnectionAttemptRow, 'id' | 'outcome'>,
    data: ConnectionAttemptUpdate
  ): Promise<ConnectionAttemptRow | null>;
  getIntegration(integrationId: string): Promise<IntegrationIdentity | null>;
  // any row of the organization with this account id, deleted ones included
  // (Integration is unique on organizationId + internalId)
  findIntegrationByInternalId(
    internalId: string
  ): Promise<IntegrationIdentity | null>;
  createIntegration(data: {
    providerIdentifier: string;
    account: ManagedConnectionAccount;
    credential: ManagedConnectionGrant['credential'];
  }): Promise<IntegrationIdentity>;
  // only the exact, not deleted row of that account id
  updateIntegrationCredential(
    integrationId: string,
    internalId: string,
    data: {
      account: ManagedConnectionAccount;
      credential: ManagedConnectionGrant['credential'];
    }
  ): Promise<IntegrationIdentity | null>;
  getBinding(integrationId: string): Promise<BindingRow | null>;
  createBinding(
    data: Omit<BindingRow, 'id' | 'organizationId'>
  ): Promise<BindingRow>;
  updateBinding(
    id: string,
    data: Partial<Omit<BindingRow, 'id' | 'organizationId' | 'integrationId'>>
  ): Promise<BindingRow>;
  appendEvent(data: Omit<EventRow, 'createdAt'>): Promise<void>;
}

// the fields of ManagedRepository's identity select, nothing more
const CONNECTION_INTEGRATION_SELECT = {
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
} as const;

const BINDING_SELECT = {
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

const INTENT_SELECT = {
  id: true,
  operationKey: true,
  credentialId: true,
  requestHash: true,
  providerIdentifier: true,
  mode: true,
  targetIntegrationId: true,
  expectedBindingGeneration: true,
  expectedInternalId: true,
  expectedProfile: true,
  status: true,
  attempt: true,
  expiresAt: true,
  leaseExpiresAt: true,
  failureCode: true,
  integrationId: true,
  bindingGeneration: true,
  bindingStatus: true,
  completedSequence: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ATTEMPT_SELECT = {
  id: true,
  intentId: true,
  attempt: true,
  stateDigest: true,
  relayCredentialId: true,
  expiresAt: true,
  outcome: true,
  codeDigest: true,
  callbackCredentialId: true,
  claimedAt: true,
  failureCode: true,
  observedInternalId: true,
  observedProfile: true,
  observedAt: true,
  providerExpiresIn: true,
  grantedScopes: true,
} as const;

function notFound(err: unknown) {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025'
  );
}

// the provider's expires_in from the moment it was recorded; null clears an
// earlier expiry instead of keeping one that belongs to another token
function tokenExpiration(credential: ManagedConnectionGrant['credential']) {
  return credential.expiresInSeconds
    ? new Date(Date.now() + credential.expiresInSeconds * 1000)
    : null;
}

// Every query is scoped to the organization the store was opened for
class PrismaConnectionStore implements ConnectionTx {
  constructor(
    private _client: Prisma.TransactionClient,
    private _organizationId: string,
    private _sequence: { value: number } | null
  ) {}

  get sequence() {
    return this._sequence?.value ?? null;
  }

  nextSequence() {
    if (!this._sequence) {
      throw new Error('A connection reader cannot allocate sequences');
    }

    this._sequence.value += 1;
    return this._sequence.value;
  }

  async getIntent(intentId: string) {
    return (await this._client.managedConnectionIntent.findFirst({
      where: { id: intentId, organizationId: this._organizationId },
      select: INTENT_SELECT,
    })) as ConnectionIntentRow | null;
  }

  async getIntentByOperationKey(operationKey: string) {
    return (await this._client.managedConnectionIntent.findUnique({
      where: {
        organizationId_operationKey: {
          organizationId: this._organizationId,
          operationKey,
        },
      },
      select: INTENT_SELECT,
    })) as ConnectionIntentRow | null;
  }

  async getAttempt(intentId: string, attempt: number) {
    return (await this._client.managedConnectionAttempt.findFirst({
      where: { intentId, attempt, organizationId: this._organizationId },
      select: ATTEMPT_SELECT,
    })) as ConnectionAttemptRow | null;
  }

  async createIntent(
    data: Parameters<ConnectionTx['createIntent']>[0]
  ) {
    return (await this._client.managedConnectionIntent.create({
      data: { ...data, organizationId: this._organizationId },
      select: INTENT_SELECT,
    })) as ConnectionIntentRow;
  }

  async moveIntent(
    from: Pick<ConnectionIntentRow, 'id' | 'status' | 'attempt'>,
    data: ConnectionIntentUpdate
  ) {
    try {
      return (await this._client.managedConnectionIntent.update({
        where: {
          id: from.id,
          status: from.status,
          attempt: from.attempt,
          organizationId: this._organizationId,
        },
        data,
        select: INTENT_SELECT,
      })) as ConnectionIntentRow;
    } catch (err) {
      if (notFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async createAttempt(data: Parameters<ConnectionTx['createAttempt']>[0]) {
    return (await this._client.managedConnectionAttempt.create({
      data: { ...data, organizationId: this._organizationId },
      select: ATTEMPT_SELECT,
    })) as ConnectionAttemptRow;
  }

  async moveAttempt(
    from: Pick<ConnectionAttemptRow, 'id' | 'outcome'>,
    data: ConnectionAttemptUpdate
  ) {
    try {
      return (await this._client.managedConnectionAttempt.update({
        where: {
          id: from.id,
          outcome: from.outcome,
          organizationId: this._organizationId,
        },
        data,
        select: ATTEMPT_SELECT,
      })) as ConnectionAttemptRow;
    } catch (err) {
      if (notFound(err)) {
        return null;
      }
      throw err;
    }
  }

  getIntegration(integrationId: string) {
    return this._client.integration.findFirst({
      where: { id: integrationId, organizationId: this._organizationId },
      select: CONNECTION_INTEGRATION_SELECT,
    });
  }

  findIntegrationByInternalId(internalId: string) {
    return this._client.integration.findFirst({
      where: { internalId, organizationId: this._organizationId },
      select: CONNECTION_INTEGRATION_SELECT,
    });
  }

  // The fields upstream createOrUpdateIntegration sets on a new channel,
  // without a picture (nothing here fetches or stores one)
  createIntegration(data: Parameters<ConnectionTx['createIntegration']>[0]) {
    return this._client.integration.create({
      data: {
        organizationId: this._organizationId,
        providerIdentifier: data.providerIdentifier,
        type: 'social',
        internalId: data.account.internalId,
        rootInternalId: data.account.internalId,
        name:
          data.account.displayName ||
          data.account.profile ||
          data.account.internalId,
        profile: data.account.profile,
        token: data.credential.accessToken,
        refreshToken: data.credential.refreshToken || '',
        tokenExpiration: tokenExpiration(data.credential),
        inBetweenSteps: false,
        refreshNeeded: false,
        additionalSettings: '[]',
      },
      select: CONNECTION_INTEGRATION_SELECT,
    });
  }

  // What upstream's update branch sets on a reconnect, for the same row only:
  // the id, the account id and "not deleted" are all conditions, so a row
  // that changed in between is not written
  async updateIntegrationCredential(
    integrationId: string,
    internalId: string,
    data: Parameters<ConnectionTx['updateIntegrationCredential']>[2]
  ) {
    try {
      return await this._client.integration.update({
        where: {
          id: integrationId,
          organizationId: this._organizationId,
          internalId,
          deletedAt: null,
        },
        data: {
          profile: data.account.profile,
          token: data.credential.accessToken,
          // never wipe a stored refresh token with an empty one (upstream)
          ...(data.credential.refreshToken
            ? { refreshToken: data.credential.refreshToken }
            : {}),
          tokenExpiration: tokenExpiration(data.credential),
          inBetweenSteps: false,
          refreshNeeded: false,
        },
        select: CONNECTION_INTEGRATION_SELECT,
      });
    } catch (err) {
      if (notFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async getBinding(integrationId: string) {
    return (await this._client.managedChannelBinding.findFirst({
      where: { integrationId, organizationId: this._organizationId },
      select: BINDING_SELECT,
    })) as BindingRow | null;
  }

  async createBinding(data: Omit<BindingRow, 'id' | 'organizationId'>) {
    return (await this._client.managedChannelBinding.create({
      data: { ...data, organizationId: this._organizationId },
      select: BINDING_SELECT,
    })) as BindingRow;
  }

  async updateBinding(
    id: string,
    data: Partial<Omit<BindingRow, 'id' | 'organizationId' | 'integrationId'>>
  ) {
    return (await this._client.managedChannelBinding.update({
      where: { id, organizationId: this._organizationId },
      data,
      select: BINDING_SELECT,
    })) as BindingRow;
  }

  async appendEvent(data: Omit<EventRow, 'createdAt'>) {
    await this._client.managedChangeEvent.create({
      data: { ...data, organizationId: this._organizationId },
      select: { id: true },
    });
  }
}

@Injectable()
export class ManagedConnectionRepository {
  constructor(
    private _managedRepository: ManagedRepository,
    private _transaction: PrismaTransaction
  ) {}

  // The same transaction ManagedRepository.mutate runs: the organization row
  // is locked first, sequences are allocated under it, and the Integration
  // write passes the write fence only because it runs inside
  // runAsManagedWriter for this organization. ManagedTx has no intent
  // methods, so the store differs; the lock, the sequence and the fence do
  // not
  async mutate<T>(
    organizationId: string,
    func: (tx: ConnectionTx) => Promise<T>
  ): Promise<T> {
    await this._managedRepository.ensureOrganization(organizationId);

    return runAsManagedWriter(organizationId, () =>
      this._transaction.model.$transaction(
        async (tx) => {
          const locked = await tx.managedOrganization.update({
            where: { organizationId },
            data: { updatedAt: new Date() },
            select: { sequence: true },
          });

          const store = new PrismaConnectionStore(tx, organizationId, {
            value: locked.sequence,
          });
          const result = await func(store);

          if (store.sequence !== locked.sequence) {
            await tx.managedOrganization.update({
              where: { organizationId },
              data: { sequence: store.sequence! },
              select: { id: true },
            });
          }

          return result;
        },
        { maxWait: 10000, timeout: 20000 }
      )
    );
  }

  read<T>(
    organizationId: string,
    func: (reader: ConnectionReader) => Promise<T>
  ): Promise<T> {
    return this._transaction.model.$transaction(
      (tx) => func(new PrismaConnectionStore(tx, organizationId, null)),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }
}
