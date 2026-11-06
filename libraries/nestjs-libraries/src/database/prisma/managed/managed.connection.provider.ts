// The provider side of a managed account connection
// (docs/managed-extension/account-connection.md). Deliberately smaller than
// the upstream SocialProvider: an authorization URL and one bounded code
// exchange that answers with the account, nothing else. No IntegrationManager,
// IntegrationService, Temporal or token refresh is reachable from here.

// What the provider said about the account at the exchange. Safe to record
// and to show W&W; it is not a credential
export interface ManagedConnectionAccount {
  internalId: string;
  profile: string | null;
  displayName: string | null;
}

export interface ManagedConnectionGrant {
  account: ManagedConnectionAccount;
  // Server-private. Written to the Integration row only (where upstream
  // keeps it), never to the intent, an event, a log or a response
  credential: {
    accessToken: string;
    refreshToken: string | null;
    // the provider's own expires_in; null when it gave none
    expiresInSeconds: number | null;
  };
  // as the provider reported them at the exchange
  grantedScopes: string[];
}

// What a provider can say for sure about a failed exchange. Anything else
// (network error, timeout, 5xx, malformed answer, a failure after a token was
// issued) is an unknown outcome, never one of these
export type ManagedConnectionProviderFailure =
  // nothing was sent to the provider
  | 'NOT_SENT'
  // the provider refused the code: no token was issued
  | 'REFUSED'
  // a token was issued without the requested scopes, and was dropped
  | 'SCOPES_MISSING';

// Carries no provider text: an answer can echo the code, a token or the app
// secret, so nothing from it may reach a message, a log or a response
export class ManagedConnectionProviderError extends Error {
  constructor(public readonly kind: ManagedConnectionProviderFailure) {
    super(`Provider exchange: ${kind}`);
  }
}

export interface ManagedConnectionProvider {
  readonly identifier: string;
  // Fully configured. Whether real calls may be made is decided by the
  // service from POSTIZ_MANAGED_CONNECT_PROVIDERS as well
  available(): boolean;
  // Pure, makes no call. Why an expected profile can never equal what this
  // provider reports (the exchange compares it byte for byte), as a safe
  // message that does not echo it; null when it can. Asked when the intent
  // is created, so a wrongly written profile fails before the owner's
  // consent. A provider without it accepts any profile the DTO allows
  expectedProfileRefusal?(profile: string): string | null;
  // Pure: builds the URL, makes no call. `state` is the server-generated one
  authorizationUrl(state: string): string;
  // Every call the exchange makes stops on `signal`
  exchange(code: string, signal: AbortSignal): Promise<ManagedConnectionGrant>;
}

// Injection token of the provider list the connection service picks from
export const MANAGED_CONNECTION_PROVIDERS = 'MANAGED_CONNECTION_PROVIDERS';

const PROVIDER_IDENTIFIER = /^[a-z0-9-]{1,64}$/;

// Operator switch: the exact provider identifiers real connections may use.
// Empty (the default) means no provider is enabled and no real call can be
// made, whatever is configured otherwise
export function managedConnectProviderIdentifiers(): ReadonlySet<string> {
  return new Set(
    String(process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS || '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => PROVIDER_IDENTIFIER.test(id))
  );
}
