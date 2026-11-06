import { HttpException, Inject, Injectable } from '@nestjs/common';
import { ManagedCredential } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import {
  ManagedConflictException,
  ManagedUnprocessableException,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';
import { identityFingerprint } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import {
  ProviderTransport,
  deadline,
  fetchTransport,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';
import {
  HelperChannel,
  HelperIntegrationRow,
  ManagedHelperRepository,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.repository';
import {
  MANAGED_HELPER_ADAPTERS,
  MANAGED_HELPER_TRANSPORT,
  ManagedHelperAdapter,
  HelperAdapterOutcome,
  defaultManagedHelperAdapters,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.provider';
import {
  MANAGED_HELPER_CALL_DEADLINE_MS,
  MANAGED_HELPER_DEFINITIONS,
  MANAGED_HELPER_MAX_ITEMS,
  ManagedHelperCoverageReason,
  ManagedHelperException,
  ManagedHelperInput,
  ManagedHelperResult,
  managedHelperInputRefusal,
  managedHelperRefusal,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.contracts';
import { ManagedHelperRequestDto } from '@gitroom/nestjs-libraries/dtos/managed/managed.helper.dto';

// W&W platform helpers (docs/managed-extension/platform-helpers.md): one
// point-in-time provider lookup for a qualified, bound channel. Read only: it
// writes no row, refreshes no token and never marks a channel, whatever the
// provider answers. A result is only returned when the channel's binding and
// identity are the same after the provider answered as before the call.

// a provider's own account id (Integration.internalId), as the connection
// DTO accepts it; anything else is not sent to a provider
const INTERNAL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export const managedHelperProviders = [
  {
    provide: MANAGED_HELPER_ADAPTERS,
    useFactory: (): ManagedHelperAdapter[] => defaultManagedHelperAdapters(),
  },
  { provide: MANAGED_HELPER_TRANSPORT, useValue: fetchTransport },
];

// Everything about the channel a result depends on. Compared before and
// after the provider call
function channelState(integration: HelperIntegrationRow, generation: number) {
  return JSON.stringify([
    identityFingerprint(integration),
    generation,
    integration.disabled,
    integration.refreshNeeded,
    integration.inBetweenSteps,
  ]);
}

@Injectable()
export class ManagedHelperService {
  // the whole provider call; tests shorten it
  callDeadlineMs = MANAGED_HELPER_CALL_DEADLINE_MS;
  // tests move the clock
  now = () => new Date();

  constructor(
    private _repository: ManagedHelperRepository,
    @Inject(MANAGED_HELPER_ADAPTERS)
    private _adapters: ManagedHelperAdapter[],
    @Inject(MANAGED_HELPER_TRANSPORT)
    private _transport: ProviderTransport
  ) {}

  // Why this channel cannot be looked up for, or null. Shared by the reads
  // before and after the provider call
  private channelRefusal(
    channel: HelperChannel,
    expectedGeneration: number
  ): HttpException | null {
    const { integration, binding } = channel;
    if (!integration) {
      return new ManagedUnprocessableException(
        'INTEGRATION_NOT_FOUND',
        'Channel not found in this organization'
      );
    }

    if (binding?.status === 'PAUSED_IDENTITY_CHANGED') {
      return new ManagedConflictException(
        'CHANNEL_IDENTITY_CHANGED',
        'The recorded identity of this channel changed; it must be qualified again'
      );
    }

    if (
      integration.deletedAt ||
      integration.disabled ||
      integration.inBetweenSteps ||
      !binding ||
      binding.status !== 'QUALIFIED' ||
      !INTERNAL_ID.test(integration.internalId)
    ) {
      return new ManagedConflictException(
        'CHANNEL_NOT_QUALIFIED',
        'Helpers only run for a qualified channel that is not deleted, disabled or unfinished'
      );
    }

    // the binding is reconciled by the qualifying write path only; a read
    // that sees another identity refuses and records nothing
    if (
      binding.identityFingerprint !== identityFingerprint(integration) ||
      binding.providerIdentifier !== integration.providerIdentifier ||
      binding.internalId !== integration.internalId
    ) {
      return new ManagedConflictException(
        'CHANNEL_IDENTITY_CHANGED',
        'The identity of this channel is not the one it was qualified with'
      );
    }

    if (binding.generation !== expectedGeneration) {
      return new ManagedConflictException(
        'BINDING_GENERATION_MISMATCH',
        `The binding is at generation ${binding.generation}`
      );
    }

    return null;
  }

  private reconnectRequired() {
    return new ManagedHelperException(
      'RECONNECT_REQUIRED',
      'The channel token cannot be used; the owner must reconnect the channel'
    );
  }

  async run(
    credential: ManagedCredential,
    body: ManagedHelperRequestDto,
    signal?: AbortSignal
  ): Promise<ManagedHelperResult> {
    const organizationId = credential.organizationId;
    const definition = MANAGED_HELPER_DEFINITIONS[body.helper];
    const adapter = this._adapters.find((item) => item.helper === body.helper);

    // operator qualification first: an unqualified helper reads nothing
    const refusal = managedHelperRefusal(
      credential,
      body.helper,
      process.env,
      this.now()
    );
    if (refusal) {
      throw refusal;
    }
    if (!definition || !adapter) {
      throw new ManagedHelperException(
        'HELPER_NOT_ENABLED',
        'This helper is not enabled on this server'
      );
    }

    const input: ManagedHelperInput = {
      query: body.query?.trim() || undefined,
      kind: body.kind,
      genre: body.genre,
    };
    const inputRefusal =
      body.query !== undefined && !input.query
        ? new ManagedHelperException(
            'HELPER_INPUT_INVALID',
            'query must contain a visible character'
          )
        : managedHelperInputRefusal(body.helper, input);
    if (inputRefusal) {
      throw inputRefusal;
    }

    const before = await this._repository.readChannelWithToken(
      organizationId,
      body.integrationId
    );
    const beforeRefusal = this.channelRefusal(
      before,
      body.expectedBindingGeneration
    );
    if (beforeRefusal) {
      throw beforeRefusal;
    }

    const integration = before.integration!;
    const binding = before.binding!;
    if (!definition.providerIdentifiers.includes(integration.providerIdentifier)) {
      throw new ManagedHelperException(
        'HELPER_NOT_SUPPORTED_FOR_PROVIDER',
        `${body.helper} is not available for this channel's provider`
      );
    }

    // never refreshed here: a channel that needs it, or whose recorded
    // expiry passed, is the owner's to reconnect
    const expiration = integration.tokenExpiration
      ? new Date(integration.tokenExpiration).getTime()
      : null;
    if (
      integration.refreshNeeded ||
      !before.token ||
      (expiration !== null && expiration <= this.now().getTime())
    ) {
      throw this.reconnectRequired();
    }

    const callSignal = deadline(this.callDeadlineMs, signal);
    let outcome: HelperAdapterOutcome;
    try {
      outcome = await adapter.call(
        { token: before.token, internalId: integration.internalId, input, signal: callSignal },
        this._transport
      );
    } catch {
      // Replace unexpected transport/stream exceptions: their message or cause can contain the provider URL and token.
      outcome = { ok: false, failure: callSignal.aborted ? 'TIMEOUT' : 'NETWORK' };
    }
    const observedAt = this.now();

    if (outcome.ok === false) {
      if (outcome.failure === 'RECONNECT_REQUIRED') {
        throw this.reconnectRequired();
      }
      throw new ManagedHelperException(
        'PROVIDER_CALL_FAILED',
        'The provider lookup gave no usable answer; nothing was retried',
        outcome.failure
      );
    }

    // the answer only belongs to the channel if nothing about it moved
    const after = await this._repository.readChannel(
      organizationId,
      body.integrationId
    );
    if (
      this.channelRefusal(after, body.expectedBindingGeneration) ||
      channelState(after.integration!, after.binding!.generation) !==
        channelState(integration, binding.generation)
    ) {
      throw new ManagedHelperException(
        'BINDING_CHANGED_DURING_CALL',
        'The channel or its binding changed while the provider answered; the answer was discarded'
      );
    }

    const reasons: ManagedHelperCoverageReason[] = ['PROVIDER_PAGE'];
    if (outcome.truncated) {
      reasons.push('ITEM_LIMIT');
    }
    if (outcome.dropped) {
      reasons.push('ITEMS_DROPPED');
    }

    return {
      schemaVersion: 1,
      helper: body.helper,
      integrationId: integration.id,
      provider: integration.providerIdentifier,
      bindingGeneration: binding.generation,
      observedAt: observedAt.toISOString(),
      coverage: {
        partial: true,
        reasons,
        returned: outcome.items.length,
        limit: MANAGED_HELPER_MAX_ITEMS,
      },
      items: outcome.items,
    };
  }
}
