import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'crypto';
import {
  ManagedCredential,
  sha256Hex,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import {
  ManagedBadRequestException,
  ManagedConflictException,
  ManagedNotFoundException,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';
import { BindingRow } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { identityFingerprint } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import {
  ConnectionAttemptRow,
  ConnectionAttemptUpdate,
  ConnectionFailureCode,
  ConnectionIntentRow,
  ConnectionIntentStatus,
  ConnectionReader,
  ConnectionTx,
  ManagedConnectionRepository,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.repository';
import {
  MANAGED_CONNECTION_PROVIDERS,
  managedConnectProviderIdentifiers,
  ManagedConnectionGrant,
  ManagedConnectionProvider,
  ManagedConnectionProviderError,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.provider';
import { InstagramStandaloneConnectionAdapter } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.instagram';
import {
  CreateManagedConnectionIntentDto,
  ManagedConnectionCallbackDto,
  ManagedConnectionMode,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.connection.dto';

// Owner-driven channel connect / reconnect for managed organizations
// (docs/managed-extension/account-connection.md). An AI-facing credential
// can create, read, cancel, retry and recover intents; only the separate
// server relay credential gets an authorization URL or submits a callback.
// One claimed callback makes at most one bounded exchange per attempt, and a
// code whose exchange may have had an effect is never exchanged again.

// The two scopes the connection routes require. A credential that holds the
// relay scope must not hold the connect scope, so the AI-facing principal can
// never see an authorization URL or submit a code
export const MANAGED_CONNECTION_SCOPES = {
  connect: 'channels:connect',
  relay: 'channels:connect-callback',
} as const;

export const MANAGED_CONNECTION_INTENT_TTL_MS = 30 * 60 * 1000;
// how long one issued authorization URL may come back
export const MANAGED_CONNECTION_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
// authorizations per intent, re-issues and retries included
export const MANAGED_CONNECTION_MAX_ATTEMPTS = 3;
// the whole exchange, every provider call included
export const MANAGED_CONNECTION_EXCHANGE_DEADLINE_MS = 30 * 1000;
// the exchange deadline plus room for the terminal transaction; only after it
// may a claimed exchange be recovered (as UNKNOWN)
export const MANAGED_CONNECTION_LEASE_MS = 2 * 60 * 1000;

// Only failures before any effect, or the provider refusing the code: no
// token was issued, so a new authorization may be tried under the same
// intent. A failure after a token was issued and dropped (scopes, account
// mismatch) or with an unknown outcome needs a new intent, a new decision
const RETRYABLE: ReadonlySet<ConnectionFailureCode> = new Set([
  'PROVIDER_DENIED',
  'EXCHANGE_NOT_SENT',
  'EXCHANGE_REFUSED',
]);

type TargetRefusal =
  | 'ALREADY_CONNECTED'
  | 'INTEGRATION_NOT_RECONNECTABLE'
  | 'TARGET_IDENTITY_MISMATCH'
  | 'BINDING_GENERATION_MISMATCH';

export type ManagedConnectionConflictCode =
  | Exclude<TargetRefusal, 'BINDING_GENERATION_MISMATCH'>
  | 'CONNECT_PROVIDER_UNAVAILABLE'
  | 'INTENT_EXPIRED'
  | 'INTENT_NOT_PENDING'
  | 'INTENT_NOT_RETRYABLE'
  | 'INTENT_NOT_RECOVERABLE'
  | 'INTENT_ALREADY_USED'
  | 'AUTHORIZATION_LIMIT_REACHED'
  | 'AUTHORIZATION_NOT_ISSUED'
  | 'AUTHORIZATION_EXPIRED'
  | 'RELAY_CREDENTIAL_MISMATCH'
  | 'STATE_MISMATCH'
  | 'EXCHANGE_IN_PROGRESS'
  | 'EXCHANGE_NEEDS_RECOVERY';

const CONFLICT_MESSAGES: Record<ManagedConnectionConflictCode, string> = {
  // A deleted channel is retained, not freed: it can be neither connected
  // again nor reconnected here, and nothing restores it (restoring needs its
  // own qualified authority, see account-connection.md)
  ALREADY_CONNECTED:
    'This account already has a channel in this organization, possibly a deleted one. A channel that is not deleted can be reconnected with mode RECONNECT; a deleted channel cannot be connected, reconnected or restored through this API',
  INTEGRATION_NOT_RECONNECTABLE:
    'Only an existing, not deleted, finished channel of the same provider can be reconnected',
  TARGET_IDENTITY_MISMATCH:
    'The expected account is not the one recorded for this channel',
  CONNECT_PROVIDER_UNAVAILABLE:
    'Connecting this provider is not enabled on this server',
  INTENT_EXPIRED: 'This connection intent expired',
  INTENT_NOT_PENDING: 'This connection intent is not pending',
  INTENT_NOT_RETRYABLE:
    'Only an intent that failed before a token was issued, and has attempts left, can be retried',
  INTENT_NOT_RECOVERABLE: 'Only an exchange that did not finish can be recovered',
  INTENT_ALREADY_USED: 'This connection intent already has an outcome',
  AUTHORIZATION_LIMIT_REACHED: `This intent already issued ${MANAGED_CONNECTION_MAX_ATTEMPTS} authorizations`,
  AUTHORIZATION_NOT_ISSUED:
    'This intent has no open authorization; ask the relay for one',
  AUTHORIZATION_EXPIRED: 'This authorization expired; ask the relay for a new one',
  RELAY_CREDENTIAL_MISMATCH:
    'The authorization was issued to another relay credential',
  STATE_MISMATCH:
    'The state does not belong to the current authorization of this intent',
  EXCHANGE_IN_PROGRESS: 'The exchange of this intent is running',
  EXCHANGE_NEEDS_RECOVERY: 'The exchange did not finish; recover the intent',
};

export class ManagedConnectionConflictException extends ConflictException {
  constructor(public readonly code: ManagedConnectionConflictCode, msg: string) {
    super({ code, msg });
  }
}

// What any connection route answers. Never a token, code, state, digest,
// authorization URL or the provider's scope list
export interface ManagedConnectionIntentView {
  intentId: string;
  operationKey: string;
  providerIdentifier: string;
  mode: ManagedConnectionMode;
  status: ConnectionIntentStatus;
  target: {
    integrationId: string | null;
    expectedBindingGeneration: number | null;
  } | null;
  expectedAccount: { internalId: string | null; profile: string | null };
  attempt: number;
  maxAttempts: number;
  expiresAt: Date;
  leaseExpiresAt: Date | null;
  failure: { code: ConnectionFailureCode; retryable: boolean } | null;
  receipt: {
    integrationId: string | null;
    account: { internalId: string | null; profile: string | null };
    identityEvidence: 'PROVIDER_ACCOUNT_AT_EXCHANGE';
    observedAt: Date | null;
    binding: { generation: number | null; status: string | null };
    qualification: 'REQUIRED';
    sequence: number | null;
  } | null;
}

type Outcome<T> = { ok: T } | { refused: HttpException };

type ExchangeResult =
  | { grant: ManagedConnectionGrant }
  | { outcome: 'FAILED' | 'UNKNOWN'; failureCode: ConnectionFailureCode };

interface Claim {
  intentId: string;
  attempt: number;
  provider: ManagedConnectionProvider;
}

function digestEquals(presented: string, stored: string | null) {
  if (!stored) {
    return false;
  }

  const left = Buffer.from(presented, 'hex');
  const right = Buffer.from(stored, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function expired(at: Date | null) {
  return !!at && Date.now() >= new Date(at).getTime();
}

// The default provider list: the Instagram standalone adapter only. Real
// calls stay off until the operator lists it in POSTIZ_MANAGED_CONNECT_PROVIDERS
// and configures it
export const managedConnectionProviders = {
  provide: MANAGED_CONNECTION_PROVIDERS,
  useFactory: (): ManagedConnectionProvider[] => [
    new InstagramStandaloneConnectionAdapter(),
  ],
};

@Injectable()
export class ManagedConnectionService {
  // the whole-exchange deadline; tests shorten it
  exchangeDeadlineMs = MANAGED_CONNECTION_EXCHANGE_DEADLINE_MS;

  constructor(
    private _connectionRepository: ManagedConnectionRepository,
    @Inject(MANAGED_CONNECTION_PROVIDERS)
    private _providers: ManagedConnectionProvider[]
  ) {}

  private unwrap<T>(outcome: Outcome<T>): T {
    if ('refused' in outcome) {
      throw outcome.refused;
    }

    return outcome.ok;
  }

  // Chosen by exact identifier among the injected adapters, enabled by the
  // operator and fully configured; otherwise no real call can be made
  private enabledProvider(providerIdentifier: string) {
    if (!managedConnectProviderIdentifiers().has(providerIdentifier)) {
      return null;
    }

    const provider = this._providers.find(
      (item) => item.identifier === providerIdentifier
    );
    return provider?.available() ? provider : null;
  }

  private assertRelay(credential: Pick<ManagedCredential, 'scopes'>) {
    const scopes = credential.scopes as readonly string[];
    if (
      !scopes.includes(MANAGED_CONNECTION_SCOPES.relay) ||
      scopes.includes(MANAGED_CONNECTION_SCOPES.connect)
    ) {
      throw new ForbiddenException({
        code: 'RELAY_CREDENTIAL_REQUIRED',
        msg: 'Only the separate W&W server relay credential can do this',
      });
    }
  }

  private refusal(code: ManagedConnectionConflictCode | TargetRefusal) {
    if (code === 'BINDING_GENERATION_MISMATCH') {
      return new ManagedConflictException(
        'BINDING_GENERATION_MISMATCH',
        'The binding is not at the expected generation'
      );
    }

    return new ManagedConnectionConflictException(code, CONFLICT_MESSAGES[code]);
  }

  private statusRefusal(intent: ConnectionIntentRow) {
    switch (intent.status) {
      case 'EXCHANGING':
        return this.refusal(
          expired(intent.leaseExpiresAt)
            ? 'EXCHANGE_NEEDS_RECOVERY'
            : 'EXCHANGE_IN_PROGRESS'
        );
      case 'EXPIRED':
        return this.refusal('INTENT_EXPIRED');
      case 'COMPLETED':
      case 'FAILED':
      case 'UNKNOWN':
        return this.refusal('INTENT_ALREADY_USED');
      default:
        return this.refusal('INTENT_NOT_PENDING');
    }
  }

  private view(
    intent: ConnectionIntentRow,
    attempt: ConnectionAttemptRow | null
  ): ManagedConnectionIntentView {
    const status: ConnectionIntentStatus =
      intent.status === 'PENDING' && expired(intent.expiresAt)
        ? 'EXPIRED'
        : intent.status;

    return {
      intentId: intent.id,
      operationKey: intent.operationKey,
      providerIdentifier: intent.providerIdentifier,
      mode: intent.mode,
      status,
      target:
        intent.mode === 'RECONNECT'
          ? {
              integrationId: intent.targetIntegrationId,
              expectedBindingGeneration: intent.expectedBindingGeneration,
            }
          : null,
      expectedAccount: {
        internalId: intent.expectedInternalId,
        profile: intent.expectedProfile,
      },
      attempt: intent.attempt,
      maxAttempts: MANAGED_CONNECTION_MAX_ATTEMPTS,
      expiresAt: intent.expiresAt,
      leaseExpiresAt: intent.status === 'EXCHANGING' ? intent.leaseExpiresAt : null,
      failure: intent.failureCode
        ? {
            code: intent.failureCode,
            retryable: RETRYABLE.has(intent.failureCode),
          }
        : null,
      // Which account authorized, as the provider said at the exchange. It
      // proves nothing later on: the channel still has to be qualified
      // through POST /channels/:integrationId/qualify
      receipt:
        status === 'COMPLETED' && attempt
          ? {
              integrationId: intent.integrationId,
              account: {
                internalId: attempt.observedInternalId,
                profile: attempt.observedProfile,
              },
              identityEvidence: 'PROVIDER_ACCOUNT_AT_EXCHANGE',
              observedAt: attempt.observedAt,
              binding: {
                generation: intent.bindingGeneration,
                status: intent.bindingStatus,
              },
              qualification: 'REQUIRED',
              sequence: intent.completedSequence,
            }
          : null,
    };
  }

  private async currentView(
    reader: ConnectionReader,
    intent: ConnectionIntentRow
  ) {
    return this.view(
      intent,
      intent.attempt ? await reader.getAttempt(intent.id, intent.attempt) : null
    );
  }

  // the intent of this organization, created by this credential
  private async ownIntent(
    reader: ConnectionReader,
    credentialId: string,
    intentId: string
  ) {
    const intent = await reader.getIntent(intentId);
    if (!intent) {
      throw new ManagedNotFoundException('Connection intent not found');
    }

    if (intent.credentialId !== credentialId) {
      throw new ManagedConflictException(
        'OPERATION_KEY_CREDENTIAL_MISMATCH',
        'This connection intent belongs to another credential'
      );
    }

    return intent;
  }

  // Whether the target is still what the intent was created for: checked at
  // creation, before an authorization is issued, before the exchange and
  // again with the provider's answer
  private async targetRefusal(
    tx: ConnectionTx,
    intent: Pick<
      ConnectionIntentRow,
      | 'mode'
      | 'providerIdentifier'
      | 'targetIntegrationId'
      | 'expectedBindingGeneration'
      | 'expectedInternalId'
    >
  ): Promise<TargetRefusal | null> {
    if (intent.mode === 'CONNECT') {
      return intent.expectedInternalId &&
        (await tx.findIntegrationByInternalId(intent.expectedInternalId))
        ? 'ALREADY_CONNECTED'
        : null;
    }

    const integration = await tx.getIntegration(intent.targetIntegrationId!);
    if (
      !integration ||
      integration.deletedAt ||
      integration.inBetweenSteps ||
      integration.providerIdentifier !== intent.providerIdentifier
    ) {
      return 'INTEGRATION_NOT_RECONNECTABLE';
    }

    if (integration.internalId !== intent.expectedInternalId) {
      return 'TARGET_IDENTITY_MISMATCH';
    }

    const binding = await tx.getBinding(integration.id);
    return !binding || binding.generation !== intent.expectedBindingGeneration
      ? 'BINDING_GENERATION_MISMATCH'
      : null;
  }

  // An intent past its expiry, and its open authorization, become EXPIRED
  private async expire(tx: ConnectionTx, intent: ConnectionIntentRow) {
    const attempt = intent.attempt
      ? await tx.getAttempt(intent.id, intent.attempt)
      : null;
    if (attempt?.outcome === 'ISSUED') {
      await tx.moveAttempt(attempt, { outcome: 'EXPIRED' });
    }

    await tx.moveIntent(intent, { status: 'EXPIRED' });
  }

  // the attempt and the intent settle together
  private async settle(
    tx: ConnectionTx,
    intent: ConnectionIntentRow,
    attempt: ConnectionAttemptRow,
    outcome: 'FAILED' | 'UNKNOWN',
    failureCode: ConnectionFailureCode,
    evidence: ConnectionAttemptUpdate = {}
  ) {
    const settledAttempt = await tx.moveAttempt(attempt, {
      ...evidence,
      outcome,
      failureCode,
    });
    const settled = await tx.moveIntent(intent, {
      status: outcome,
      failureCode,
      leaseExpiresAt: null,
    });

    return this.view(settled || intent, settledAttempt || attempt);
  }

  async createIntent(
    organizationId: string,
    credentialId: string,
    body: CreateManagedConnectionIntentDto
  ) {
    const expectedInternalId = body.expectedAccount.internalId ?? null;
    const expectedProfile = body.expectedAccount.profile ?? null;

    if (body.mode === 'CONNECT') {
      if (body.integrationId || body.expectedBindingGeneration !== undefined) {
        throw new ManagedBadRequestException(
          'CONNECT takes no integrationId or expectedBindingGeneration'
        );
      }

      if (!expectedInternalId && !expectedProfile) {
        throw new ManagedBadRequestException(
          'CONNECT needs expectedAccount.internalId or expectedAccount.profile'
        );
      }
    } else if (!body.integrationId || !body.expectedBindingGeneration) {
      throw new ManagedBadRequestException(
        'RECONNECT needs integrationId and expectedBindingGeneration'
      );
    }

    // fixed key order, so the hash is canonical
    const requestHash = sha256Hex(
      JSON.stringify({
        kind: 'CONNECTION_INTENT',
        providerIdentifier: body.providerIdentifier,
        mode: body.mode,
        integrationId: body.integrationId ?? null,
        expectedBindingGeneration: body.expectedBindingGeneration ?? null,
        expectedInternalId,
        expectedProfile,
      })
    );

    return this._connectionRepository.mutate(organizationId, async (tx) => {
      const existing = await tx.getIntentByOperationKey(body.operationKey);
      if (existing) {
        if (existing.credentialId !== credentialId) {
          throw new ManagedConflictException(
            'OPERATION_KEY_CREDENTIAL_MISMATCH',
            'This operation key belongs to another credential'
          );
        }

        if (existing.requestHash !== requestHash) {
          throw new ManagedConflictException(
            'OPERATION_KEY_PAYLOAD_MISMATCH',
            'This operation key was used for another connection intent'
          );
        }

        return { ...(await this.currentView(tx, existing)), replayed: true };
      }

      const provider = this.enabledProvider(body.providerIdentifier);
      if (!provider) {
        throw this.refusal('CONNECT_PROVIDER_UNAVAILABLE');
      }

      // a profile this provider can never report fails now, not after the
      // owner's consent and a dropped token
      const profileRefusal =
        expectedProfile && provider.expectedProfileRefusal?.(expectedProfile);
      if (profileRefusal) {
        throw new ManagedBadRequestException(profileRefusal);
      }

      // A reconnect is pinned to the account recorded for the channel now
      let pinnedInternalId = expectedInternalId;
      if (body.mode === 'RECONNECT') {
        const integration = await tx.getIntegration(body.integrationId!);
        if (!integration) {
          throw this.refusal('INTEGRATION_NOT_RECONNECTABLE');
        }

        if (expectedInternalId && integration.internalId !== expectedInternalId) {
          throw this.refusal('TARGET_IDENTITY_MISMATCH');
        }
        pinnedInternalId = integration.internalId;
      }

      const target = {
        mode: body.mode,
        providerIdentifier: body.providerIdentifier,
        targetIntegrationId: body.integrationId ?? null,
        expectedBindingGeneration: body.expectedBindingGeneration ?? null,
        expectedInternalId: pinnedInternalId,
      };

      const refused = await this.targetRefusal(tx, target);
      if (refused) {
        throw this.refusal(refused);
      }

      const created = await tx.createIntent({
        ...target,
        operationKey: body.operationKey,
        credentialId,
        requestHash,
        expectedProfile,
        expiresAt: new Date(Date.now() + MANAGED_CONNECTION_INTENT_TTL_MS),
      });

      return { ...this.view(created, null), replayed: false };
    });
  }

  async getIntent(organizationId: string, credentialId: string, intentId: string) {
    return this._connectionRepository.read(organizationId, async (reader) =>
      this.currentView(
        reader,
        await this.ownIntent(reader, credentialId, intentId)
      )
    );
  }

  async cancelIntent(
    organizationId: string,
    credentialId: string,
    intentId: string
  ) {
    return this.unwrap(
      await this._connectionRepository.mutate(
        organizationId,
        async (tx): Promise<Outcome<ManagedConnectionIntentView>> => {
          const intent = await this.ownIntent(tx, credentialId, intentId);
          if (intent.status === 'CANCELLED') {
            return { ok: await this.currentView(tx, intent) };
          }

          if (intent.status !== 'PENDING') {
            return { refused: this.statusRefusal(intent) };
          }

          if (expired(intent.expiresAt)) {
            await this.expire(tx, intent);
            return { refused: this.refusal('INTENT_EXPIRED') };
          }

          const attempt = intent.attempt
            ? await tx.getAttempt(intent.id, intent.attempt)
            : null;
          if (attempt?.outcome === 'ISSUED') {
            await tx.moveAttempt(attempt, { outcome: 'CANCELLED' });
          }

          const cancelled = await tx.moveIntent(intent, { status: 'CANCELLED' });
          return { ok: await this.currentView(tx, cancelled!) };
        }
      )
    );
  }

  // FAILED with a retryable code -> PENDING, for one more authorization. The
  // failed attempt and its code are never used again
  async retryIntent(
    organizationId: string,
    credentialId: string,
    intentId: string
  ) {
    return this.unwrap(
      await this._connectionRepository.mutate(
        organizationId,
        async (tx): Promise<Outcome<ManagedConnectionIntentView>> => {
          const intent = await this.ownIntent(tx, credentialId, intentId);
          if (
            intent.status !== 'FAILED' ||
            !intent.failureCode ||
            !RETRYABLE.has(intent.failureCode) ||
            intent.attempt >= MANAGED_CONNECTION_MAX_ATTEMPTS
          ) {
            return { refused: this.refusal('INTENT_NOT_RETRYABLE') };
          }

          if (expired(intent.expiresAt)) {
            await tx.moveIntent(intent, { status: 'EXPIRED' });
            return { refused: this.refusal('INTENT_EXPIRED') };
          }

          const pending = await tx.moveIntent(intent, {
            status: 'PENDING',
            failureCode: null,
          });
          return { ok: await this.currentView(tx, pending!) };
        }
      )
    );
  }

  // An exchange whose process died holds the intent until its lease ran out.
  // It becomes UNKNOWN: the provider may have issued a token that nobody
  // holds. No provider call is made and the code is never exchanged again
  async recoverIntent(
    organizationId: string,
    credentialId: string,
    intentId: string
  ) {
    return this.unwrap(
      await this._connectionRepository.mutate(
        organizationId,
        async (tx): Promise<Outcome<ManagedConnectionIntentView>> => {
          const intent = await this.ownIntent(tx, credentialId, intentId);
          if (intent.status !== 'EXCHANGING') {
            return { refused: this.refusal('INTENT_NOT_RECOVERABLE') };
          }

          if (!expired(intent.leaseExpiresAt)) {
            return { refused: this.statusRefusal(intent) };
          }

          const attempt = await tx.getAttempt(intent.id, intent.attempt);
          return {
            ok: await this.settle(
              tx,
              intent,
              attempt!,
              'UNKNOWN',
              'EXCHANGE_OUTCOME_UNKNOWN'
            ),
          };
        }
      )
    );
  }

  // Relay only. Issues a new 256-bit state and the provider URL carrying it;
  // the state is kept as a digest only, so a lost answer is answered by
  // issuing another one (bounded), which replaces the earlier URL
  async authorize(
    credential: Pick<ManagedCredential, 'id' | 'organizationId' | 'scopes'>,
    intentId: string
  ) {
    this.assertRelay(credential);

    return this.unwrap(
      await this._connectionRepository.mutate(
        credential.organizationId,
        async (
          tx
        ): Promise<
          Outcome<{
            intentId: string;
            attempt: number;
            authorizationUrl: string;
            expiresAt: Date;
          }>
        > => {
          const intent = await tx.getIntent(intentId);
          if (!intent) {
            return {
              refused: new ManagedNotFoundException('Connection intent not found'),
            };
          }

          if (intent.status !== 'PENDING') {
            return { refused: this.statusRefusal(intent) };
          }

          if (expired(intent.expiresAt)) {
            await this.expire(tx, intent);
            return { refused: this.refusal('INTENT_EXPIRED') };
          }

          if (intent.attempt >= MANAGED_CONNECTION_MAX_ATTEMPTS) {
            return { refused: this.refusal('AUTHORIZATION_LIMIT_REACHED') };
          }

          const provider = this.enabledProvider(intent.providerIdentifier);
          if (!provider) {
            return { refused: this.refusal('CONNECT_PROVIDER_UNAVAILABLE') };
          }

          const previous = intent.attempt
            ? await tx.getAttempt(intent.id, intent.attempt)
            : null;

          // the owner is not sent to consent for a target that changed
          const refused = await this.targetRefusal(tx, intent);
          if (refused) {
            if (previous?.outcome === 'ISSUED') {
              await tx.moveAttempt(previous, {
                outcome: 'FAILED',
                failureCode: refused,
              });
            }
            await tx.moveIntent(intent, {
              status: 'FAILED',
              failureCode: refused,
            });
            return { refused: this.refusal(refused) };
          }

          // The configuration can disappear since the check above. Thrown,
          // not returned, so this transaction rolls back; nothing of the
          // provider's error is passed on
          const state = randomBytes(32).toString('base64url');
          let authorizationUrl: string;
          try {
            authorizationUrl = provider.authorizationUrl(state);
          } catch (err) {
            throw this.refusal('CONNECT_PROVIDER_UNAVAILABLE');
          }

          if (previous?.outcome === 'ISSUED') {
            await tx.moveAttempt(previous, { outcome: 'REPLACED' });
          }

          const expiresAt = new Date(
            Math.min(
              new Date(intent.expiresAt).getTime(),
              Date.now() + MANAGED_CONNECTION_AUTHORIZATION_TTL_MS
            )
          );
          const attempt = await tx.createAttempt({
            intentId: intent.id,
            attempt: intent.attempt + 1,
            stateDigest: sha256Hex(state),
            relayCredentialId: credential.id,
            expiresAt,
          });
          await tx.moveIntent(intent, { attempt: attempt.attempt });

          return {
            ok: {
              intentId: intent.id,
              attempt: attempt.attempt,
              authorizationUrl,
              expiresAt,
            },
          };
        }
      )
    );
  }

  // Relay only. The callback W&W's registered page received, relayed server
  // to server
  async callback(
    credential: Pick<ManagedCredential, 'id' | 'organizationId' | 'scopes'>,
    intentId: string,
    body: ManagedConnectionCallbackDto
  ) {
    this.assertRelay(credential);

    if (!body.code === !body.error) {
      throw new ManagedBadRequestException('Send exactly one of code or error');
    }

    const stateDigest = sha256Hex(body.state);
    const codeDigest = body.code ? sha256Hex(body.code) : null;

    const claimed = this.unwrap(
      await this._connectionRepository.mutate(
        credential.organizationId,
        async (
          tx
        ): Promise<
          Outcome<
            | { done: ManagedConnectionIntentView & { replayed: boolean } }
            | { claim: Claim }
          >
        > => {
          const intent = await tx.getIntent(intentId);
          if (!intent) {
            return {
              refused: new ManagedNotFoundException('Connection intent not found'),
            };
          }

          const attempt = intent.attempt
            ? await tx.getAttempt(intent.id, intent.attempt)
            : null;
          if (!attempt) {
            return { refused: this.refusal('AUTHORIZATION_NOT_ISSUED') };
          }

          // the full state, compared by digest in constant time; a state of
          // a replaced authorization or another intent never matches
          if (!digestEquals(stateDigest, attempt.stateDigest)) {
            return { refused: this.refusal('STATE_MISMATCH') };
          }

          if (attempt.relayCredentialId !== credential.id) {
            return { refused: this.refusal('RELAY_CREDENTIAL_MISMATCH') };
          }

          if (attempt.outcome === 'EXCHANGING') {
            return { refused: this.statusRefusal(intent) };
          }

          // the same callback again, after its outcome was recorded
          if (
            ['COMPLETED', 'FAILED', 'UNKNOWN'].includes(attempt.outcome) &&
            intent.status === attempt.outcome
          ) {
            const same = codeDigest
              ? digestEquals(codeDigest, attempt.codeDigest)
              : !attempt.codeDigest && attempt.failureCode === 'PROVIDER_DENIED';
            return same
              ? { ok: { done: { ...this.view(intent, attempt), replayed: true } } }
              : { refused: this.refusal('INTENT_ALREADY_USED') };
          }

          if (attempt.outcome !== 'ISSUED' || intent.status !== 'PENDING') {
            return {
              refused:
                intent.status === 'PENDING'
                  ? this.refusal('AUTHORIZATION_NOT_ISSUED')
                  : this.statusRefusal(intent),
            };
          }

          if (expired(intent.expiresAt)) {
            await this.expire(tx, intent);
            return { refused: this.refusal('INTENT_EXPIRED') };
          }

          if (expired(attempt.expiresAt)) {
            await tx.moveAttempt(attempt, { outcome: 'EXPIRED' });
            return { refused: this.refusal('AUTHORIZATION_EXPIRED') };
          }

          const base = { callbackCredentialId: credential.id };

          // the owner declined (or the provider refused) before any code
          if (body.error) {
            return {
              ok: {
                done: {
                  ...(await this.settle(
                    tx,
                    intent,
                    attempt,
                    'FAILED',
                    'PROVIDER_DENIED',
                    base
                  )),
                  replayed: false,
                },
              },
            };
          }

          // nothing is claimed: the same callback can come again once the
          // operator enabled the provider
          const provider = this.enabledProvider(intent.providerIdentifier);
          if (!provider) {
            return { refused: this.refusal('CONNECT_PROVIDER_UNAVAILABLE') };
          }

          // a target that changed fails the intent before the code is sent
          const refused = await this.targetRefusal(tx, intent);
          if (refused) {
            return {
              ok: {
                done: {
                  ...(await this.settle(tx, intent, attempt, 'FAILED', refused, {
                    ...base,
                    codeDigest,
                  })),
                  replayed: false,
                },
              },
            };
          }

          // the durable claim: from here on this code is never sent again
          await tx.moveAttempt(attempt, {
            ...base,
            outcome: 'EXCHANGING',
            codeDigest,
            claimedAt: new Date(),
          });
          await tx.moveIntent(intent, {
            status: 'EXCHANGING',
            leaseExpiresAt: new Date(Date.now() + MANAGED_CONNECTION_LEASE_MS),
          });

          return {
            ok: {
              claim: { intentId: intent.id, attempt: attempt.attempt, provider },
            },
          };
        }
      )
    );

    if ('done' in claimed) {
      return claimed.done;
    }

    const result = await this.exchange(claimed.claim.provider, body.code!);
    return { ...(await this.record(credential.organizationId, claimed.claim, result)), replayed: false };
  }

  // One bounded exchange. The deadline aborts every provider call, and an
  // answer that arrives after it is never adopted. No error object, provider
  // answer or URL is logged or returned
  private async exchange(
    provider: ManagedConnectionProvider,
    code: string
  ): Promise<ExchangeResult> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'DEADLINE'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('DEADLINE');
      }, this.exchangeDeadlineMs);
    });

    try {
      const grant = await Promise.race([
        provider.exchange(code, controller.signal),
        deadline,
      ]);

      return grant === 'DEADLINE'
        ? { outcome: 'UNKNOWN', failureCode: 'EXCHANGE_TIMEOUT' }
        : { grant };
    } catch (err) {
      if (controller.signal.aborted) {
        return { outcome: 'UNKNOWN', failureCode: 'EXCHANGE_TIMEOUT' };
      }

      if (err instanceof ManagedConnectionProviderError) {
        return {
          outcome: 'FAILED',
          failureCode:
            err.kind === 'NOT_SENT'
              ? 'EXCHANGE_NOT_SENT'
              : err.kind === 'REFUSED'
              ? 'EXCHANGE_REFUSED'
              : 'SCOPES_MISSING',
        };
      }

      return { outcome: 'UNKNOWN', failureCode: 'EXCHANGE_OUTCOME_UNKNOWN' };
    } finally {
      clearTimeout(timer);
    }
  }

  // The terminal transaction. A claim that was recovered meanwhile keeps its
  // UNKNOWN outcome and this exchange's late result is dropped
  private async record(
    organizationId: string,
    claim: Claim,
    result: ExchangeResult
  ): Promise<ManagedConnectionIntentView> {
    try {
      return await this._connectionRepository.mutate(organizationId, async (tx) => {
        const intent = (await tx.getIntent(claim.intentId))!;
        const attempt = await tx.getAttempt(claim.intentId, claim.attempt);
        if (
          !attempt ||
          intent.status !== 'EXCHANGING' ||
          intent.attempt !== claim.attempt ||
          attempt.outcome !== 'EXCHANGING'
        ) {
          return this.currentView(tx, intent);
        }

        if (!('grant' in result)) {
          return this.settle(tx, intent, attempt, result.outcome, result.failureCode);
        }

        const { account } = result.grant;
        const evidence: ConnectionAttemptUpdate = {
          observedInternalId: account.internalId,
          observedProfile: account.profile,
          observedAt: new Date(),
          providerExpiresIn: result.grant.credential.expiresInSeconds,
          grantedScopes: JSON.stringify(result.grant.grantedScopes),
        };

        // the identity gate, before anything is written
        const mismatch: ConnectionFailureCode | null =
          intent.expectedInternalId &&
          account.internalId !== intent.expectedInternalId
            ? intent.mode === 'RECONNECT'
              ? 'TARGET_IDENTITY_MISMATCH'
              : 'ACCOUNT_MISMATCH'
            : intent.expectedProfile && account.profile !== intent.expectedProfile
            ? 'ACCOUNT_MISMATCH'
            : (await this.targetRefusal(tx, {
                ...intent,
                expectedInternalId: account.internalId,
              }));

        if (mismatch) {
          return this.settle(tx, intent, attempt, 'FAILED', mismatch, evidence);
        }

        const bound = await this.bind(tx, intent, result.grant);
        if (!bound) {
          return this.settle(
            tx,
            intent,
            attempt,
            'FAILED',
            'INTEGRATION_NOT_RECONNECTABLE',
            evidence
          );
        }

        const completedAttempt = await tx.moveAttempt(attempt, {
          ...evidence,
          outcome: 'COMPLETED',
        });
        const completed = await tx.moveIntent(intent, {
          status: 'COMPLETED',
          leaseExpiresAt: null,
          integrationId: bound.integrationId,
          bindingGeneration: bound.binding.generation,
          bindingStatus: bound.binding.status,
          completedSequence: bound.sequence,
        });

        return this.view(completed!, completedAttempt);
      });
    } catch (err) {
      // The terminal transaction did not commit (or its answer was lost). If
      // the intent is still EXCHANGING nothing was bound, but the provider
      // may hold a token nobody has: UNKNOWN, never retried
      try {
        return await this._connectionRepository.mutate(organizationId, async (tx) => {
          const intent = (await tx.getIntent(claim.intentId))!;
          const attempt = await tx.getAttempt(claim.intentId, claim.attempt);
          if (
            intent.status === 'EXCHANGING' &&
            intent.attempt === claim.attempt &&
            attempt?.outcome === 'EXCHANGING'
          ) {
            return this.settle(tx, intent, attempt, 'UNKNOWN', 'RECORD_FAILED');
          }

          return this.currentView(tx, intent);
        });
      } catch (inner) {
        // still EXCHANGING: POST /recover settles it after the lease
        throw new HttpException(
          {
            code: 'CONNECTION_OUTCOME_UNRECORDED',
            msg: 'The outcome could not be recorded; recover the intent after its lease',
          },
          HttpStatus.SERVICE_UNAVAILABLE
        );
      }
    }
  }

  // Writes the credential and moves the binding, in the terminal transaction.
  // A connected or reconnected channel is never qualified here: CONNECT
  // creates a PENDING_QUALIFICATION binding, RECONNECT takes the existing one
  // to a new generation that must be qualified again (paused if the recorded
  // identity changed). Earlier bindings, events, posts and revisions stay
  private async bind(
    tx: ConnectionTx,
    intent: ConnectionIntentRow,
    grant: ManagedConnectionGrant
  ): Promise<{ integrationId: string; binding: BindingRow; sequence: number } | null> {
    let binding: BindingRow;
    let current: string;
    let integrationId: string;

    if (intent.mode === 'CONNECT') {
      const integration = await tx.createIntegration({
        providerIdentifier: intent.providerIdentifier,
        account: grant.account,
        credential: grant.credential,
      });
      integrationId = integration.id;
      current = identityFingerprint(integration);

      // what ManagedService.reconcileBinding records for a new channel
      const sequence = tx.nextSequence();
      binding = await tx.createBinding({
        integrationId,
        generation: 1,
        status: 'PENDING_QUALIFICATION',
        providerIdentifier: integration.providerIdentifier,
        internalId: integration.internalId,
        profile: integration.profile,
        identityFingerprint: current,
        qualifiedAt: null,
        pausedAt: null,
      });
      await tx.appendEvent({
        sequence,
        kind: 'CHANNEL_BINDING_CREATED',
        entityType: 'CHANNEL',
        entityId: integrationId,
        revision: null,
        bindingGeneration: binding.generation,
        operationKey: null,
        data: JSON.stringify({ identityFingerprint: current }),
      });
    } else {
      const integration = await tx.updateIntegrationCredential(
        intent.targetIntegrationId!,
        intent.expectedInternalId!,
        { account: grant.account, credential: grant.credential }
      );
      if (!integration) {
        return null;
      }

      integrationId = integration.id;
      current = identityFingerprint(integration);
      const previous = (await tx.getBinding(integrationId))!;
      const changed = previous.identityFingerprint !== current;

      binding = await tx.updateBinding(previous.id, {
        status: changed ? 'PAUSED_IDENTITY_CHANGED' : 'PENDING_QUALIFICATION',
        generation: previous.generation + 1,
        pausedAt: new Date(),
      });

      if (changed) {
        // the event ManagedService.reconcileBinding appends for a pause
        await tx.appendEvent({
          sequence: tx.nextSequence(),
          kind: 'CHANNEL_PAUSED_IDENTITY_CHANGED',
          entityType: 'CHANNEL',
          entityId: integrationId,
          revision: null,
          bindingGeneration: binding.generation,
          operationKey: null,
          data: JSON.stringify({
            boundIdentityFingerprint: previous.identityFingerprint,
            recordedIdentityFingerprint: current,
          }),
        });
      }
    }

    const sequence = tx.nextSequence();
    await tx.appendEvent({
      sequence,
      kind: intent.mode === 'CONNECT' ? 'CHANNEL_CONNECTED' : 'CHANNEL_RECONNECTED',
      entityType: 'CHANNEL',
      entityId: integrationId,
      revision: null,
      bindingGeneration: binding.generation,
      operationKey: intent.operationKey,
      data: JSON.stringify({
        intentId: intent.id,
        attempt: intent.attempt,
        identityFingerprint: current,
        identityEvidence: 'PROVIDER_ACCOUNT_AT_EXCHANGE',
        qualification: 'REQUIRED',
      }),
    });

    return { integrationId, binding, sequence };
  }
}
