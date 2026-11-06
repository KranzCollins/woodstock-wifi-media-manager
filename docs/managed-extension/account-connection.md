# W&W managed account connection (connect / reconnect), local prototype

This adds an owner-driven way to connect or reconnect a channel of a managed organization through W&W, without the upstream OAuth routes (they keep refusing managed organizations with `MANAGED_EFFECT_REFUSED`). It is **locally integrated and tested, not hosted and not enabled for a real provider**:

- Codex integrated both scopes, module registration and the additive schema baseline on 4 November 2026.
- The author ran no commands. Codex subsequently passed the 47 connection unit cases, the full 471-case managed suite, actual PostgreSQL concurrency/recovery scenarios, and negative actual Nest route authorization/DTO tests. Independent review remains pending.
- No real provider call, credential, account, reconnect of a real channel, hosting or paid service was used or authorized.
- This is not W&W parity with Postiz Cloud and does not make channel identity "verified upstream" anywhere outside the receipt described below.

## Upstream contract qualification: pending

The Instagram adapter (`managed.connection.instagram.ts`) copies the protocol of the pinned upstream adapter (`libraries/nestjs-libraries/src/integrations/social/instagram.standalone.provider.ts` at `bd8353f`): the authorize URL and its parameters, the code exchange (multipart POST), the long-lived token exchange, and `/v25.0/me`.

Meta's business-login documentation could not be read: the fetch returned HTTP 429 on 2026-11-04. So the following are **unqualified** until someone reads the current documentation and records the result:

- Whether PKCE is supported. The adapter sends none, like upstream, and nothing claims it.
- Which scopes Meta actually grants, and whether `permissions` is always present in the first answer. The adapter refuses when it is missing, like upstream's `checkScopes`.
- Lifetimes of codes and tokens, and the meaning of `expires_in`. The value is recorded as given and never assumed.
- Whether live mode needs App Review, Advanced Access, tester invites, or deauthorize / data-deletion callbacks. None of those callbacks exist.
- Whether the `user_id` from `/me` equals what Postiz Cloud stored for the same account. Don't use it to map Cloud channels.

## Principals and scopes

| Scope | Holder | Routes |
| --- | --- | --- |
| `channels:connect` | The W&W service / MCP credential (AI-facing) | Create, read, cancel, retry and recover intents. It never sees an authorization URL, state, code or token. |
| `channels:connect-callback` | **Only** W&W's server relay credential | `authorization` and `callback` |

- The service refuses relay actions (`403 RELAY_CREDENTIAL_REQUIRED`) unless the credential holds `channels:connect-callback` **and does not hold** `channels:connect`. A single principal can therefore never both request a connection and complete it.
- The callback must come from the same relay credential that was issued the authorization (`409 RELAY_CREDENTIAL_MISMATCH`).
- Intent routes are bound to the credential that created the intent (`409 OPERATION_KEY_CREDENTIAL_MISMATCH`), the same way as reserved uploads.
- Another organization gets `404 NOT_FOUND`.
- The scope map is `MANAGED_CONNECTION_ROUTE_SCOPES` in `apps/backend/src/managed-api/managed.connection.controller.ts`. It is set with the existing `MANAGED_SCOPE_KEY` metadata, so the existing `ManagedScopeGuard` enforces it unchanged.
- Both scopes are registered in `MANAGED_SCOPES`. Existing credentials acquire neither scope automatically; the provider switch still defaults off.

The W&W side of the browser flow is not part of this change: an authenticated human, a W&W session bound to the intent, the redirect, and the registered callback page that relays `{ state, code | error }` server to server.

## Configuration (operator only)

Real calls are **off by default**. Every one of these must be set before a real exchange can happen. Activation is a separate operator decision.

| Variable | Meaning |
| --- | --- |
| `POSTIZ_MANAGED_CONNECT_PROVIDERS` | Exact provider identifiers that may connect, comma-separated. Empty (the default) means every intent is refused with `409 CONNECT_PROVIDER_UNAVAILABLE` and no provider is called. |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | The Meta app's id and secret (the upstream variable names). They are never logged. Invalid values make the adapter unavailable. |
| `POSTIZ_MANAGED_INSTAGRAM_REDIRECT_URI` | The exact redirect URI registered with the app: `https`, no credentials, query or fragment, in canonical form, and never `redirectmeto.com`. Unlike upstream, it does not derive from `FRONTEND_URL`, which is the media path prefix. |
| `POSTIZ_MANAGED_INSTAGRAM_SCOPES` | Optional. A comma-separated subset of the four scopes the upstream adapter requests (the reviewed list). It must include `instagram_business_basic`. The default is `instagram_business_basic` only (least privilege for a DRAFT-only W&W). Any other value makes the adapter unavailable. |

When enabled, the runtime needs outbound HTTPS to `www.instagram.com` (URL only, no call), `api.instagram.com` and `graph.instagram.com`. That amends `deployment.md`, which currently states that no outbound network is needed.

## HTTP contract (`/managed/v1/connections`)

Errors are `{ "code", "msg" }`. Every answer is an intent view (below), except the relay's `authorization` answer.

### `POST /intents` (`channels:connect`)

```json
{ "operationKey": "ww:connect:ig:1", "providerIdentifier": "instagram-standalone",
  "mode": "CONNECT", "expectedAccount": { "profile": "ww.test.acc" } }
{ "operationKey": "ww:reconnect:ig:1", "providerIdentifier": "instagram-standalone",
  "mode": "RECONNECT", "integrationId": "cl…", "expectedBindingGeneration": 2,
  "expectedAccount": { "profile": "ww.test.acc" } }
```

- **`CONNECT`**
  - Needs `expectedAccount.internalId` or `expectedAccount.profile`, and no target.
  - An account that already has an Integration row in the organization, deleted rows included, gets `409 ALREADY_CONNECTED`.
    - A channel that is not deleted can be reconnected with `RECONNECT`.
    - A **deleted** channel is retained and is a dead end in this API: CONNECT refuses its account, RECONNECT refuses the deleted row, and nothing restores it. There is no silent restore and no fallback to the Postiz UI. Restoring a retained deleted channel needs its own, separately qualified authority (see "Remaining W&W journey work"); W&W shows the refusal as such.
    - With only a profile expected, the account is only known after the exchange, so the same refusal then comes as `FAILED ALREADY_CONNECTED` after the owner's consent, with the token dropped.
- **`RECONNECT`**
  - Needs `integrationId` and `expectedBindingGeneration`.
  - The channel must exist in the organization, not be deleted, not be in between steps, and be of the same provider; otherwise `409 INTEGRATION_NOT_RECONNECTABLE`.
  - Its binding must be at exactly `expectedBindingGeneration` (`409 BINDING_GENERATION_MISMATCH`).
  - The expected account id is pinned to the channel's recorded `internalId`. A different `expectedAccount.internalId` gets `409 TARGET_IDENTITY_MISMATCH`.
- **Idempotency.** The operation key is bound to the organization, the credential and `requestHash = sha256({kind, providerIdentifier, mode, integrationId, expectedBindingGeneration, expectedInternalId, expectedProfile})`.
  - The same key with the same request returns the stored intent with `replayed: true`.
  - A different request gets `409 OPERATION_KEY_PAYLOAD_MISMATCH`.
- `409 CONNECT_PROVIDER_UNAVAILABLE` while the provider is not enabled and configured.
- **Expected profile format.** `expectedAccount.profile` is stored and later compared with the provider's answer byte for byte; it is never normalized. A provider may refuse, when the intent is created, a profile it can never report (`ManagedConnectionProvider.expectedProfileRefusal`). That answers `400 INVALID_INPUT` with a message that does not echo the input. No intent is written and the owner is never sent to consent.
  - Instagram: lowercase, no leading `@`, no whitespace (`ww.test.acc`, not `@WW.Test.Acc`), in both modes. W&W normalizes the human's input before confirmation and sends the canonical form.
  - Other providers have no rule: any profile the DTO allows is taken as is. No case folding is applied generically.
  - Checked at creation only. An intent created earlier with another spelling still fails with `ACCOUNT_MISMATCH` after the exchange.

### `POST /intents/:intentId/authorization` (relay only)

Answers `{ intentId, attempt, authorizationUrl, expiresAt }` with `Cache-Control: no-store`.

- The server generates a **256-bit state** (`randomBytes(32)`, base64url, 43 characters) and builds the provider URL around it. Only `sha256(state)` is stored. The state exists in memory and in this answer only.
- Each call issues a **new** authorization (`attempt + 1`) and marks the previous open one `REPLACED`. A lost answer is therefore answered by asking again, and the earlier URL's state stops matching.
- At most `MANAGED_CONNECTION_MAX_ATTEMPTS = 3` authorizations per intent, retries included. After that: `409 AUTHORIZATION_LIMIT_REACHED`.
- The target is checked again first. A target that changed fails the intent (`FAILED`, with the target code) instead of sending the owner to consent.
- If the provider's configuration disappears between that check and building the URL, the answer is `409 CONNECT_PROVIDER_UNAVAILABLE` and the transaction rolls back: no new attempt, the previous open authorization stays open, and nothing of the provider's error is passed on.
- An authorization expires after 10 minutes (`AUTHORIZATION_EXPIRED`), and never later than its intent (30 minutes, `INTENT_EXPIRED`).

### `POST /intents/:intentId/callback` (relay only)

Body is `{ state, code }` or `{ state, error }`. Exactly one of `code` and `error` is allowed (`400 INVALID_INPUT` otherwise).

1. **Claim transaction** (organization lock):
   - The intent must have a current authorization (`AUTHORIZATION_NOT_ISSUED`).
   - `sha256(state)` must equal the stored digest, compared with `timingSafeEqual` (`STATE_MISMATCH`). A state of a replaced authorization, of another intent or of another organization never matches.
   - The relay credential must be the issuing one, and neither the intent nor the authorization may be expired.
   - `error` → `FAILED PROVIDER_DENIED`. No exchange happens.
   - A provider that was switched off answers `CONNECT_PROVIDER_UNAVAILABLE` **without claiming**.
   - A target that changed answers `FAILED` with its code. The code is never sent.
   - Otherwise the attempt becomes `EXCHANGING` with `sha256(code)` and the intent gets a 2-minute lease. This is committed **before** the provider is called. From here on this code is never sent again.
2. **One bounded exchange** outside the transaction:
   - One `AbortController` covers the whole exchange, with a 30 s deadline (`MANAGED_CONNECTION_EXCHANGE_DEADLINE_MS`). Every provider call gets its signal.
   - An answer that arrives after the deadline is never adopted.
3. **Terminal transaction** (organization lock, inside `runAsManagedWriter` for this organization):
   - It re-checks that the intent and the attempt are still `EXCHANGING` under this claim. If not (it was recovered), the result is dropped.
   - **Identity gate, before any write:**
     - The provider's `internalId` must equal the expected one (`ACCOUNT_MISMATCH` for CONNECT, `TARGET_IDENTITY_MISMATCH` for RECONNECT).
     - The provider's `profile` must equal `expectedAccount.profile` exactly if one was given (`ACCOUNT_MISMATCH`).
     - The target is re-checked with the observed account (`ALREADY_CONNECTED`, `INTEGRATION_NOT_RECONNECTABLE`, `BINDING_GENERATION_MISMATCH`).
     - A mismatch writes no Integration, binding or event. The provider's answer is kept on the attempt as evidence only.
   - Then the Integration is written, the binding moved and events appended (see "Binding and history"), and the intent becomes `COMPLETED`.

**Callback answers:**

- A processed callback answers `200` with the intent view, whether it ended `COMPLETED`, `FAILED` or `UNKNOWN`.
- The same `{ state, code }` (or the same denial) again, after the outcome was recorded, returns the same view with `replayed: true`. The provider is not called again.
- Another code for a settled attempt gets `409 INTENT_ALREADY_USED`.
- While the claim is running: `409 EXCHANGE_IN_PROGRESS`. After its lease: `409 EXCHANGE_NEEDS_RECOVERY`.
- If neither the terminal transaction nor the fallback could be recorded: `503 CONNECTION_OUTCOME_UNRECORDED`. Recover after the lease.

### `GET /intents/:intentId`, `POST /intents/:intentId/cancel | retry | recover` (`channels:connect`)

- `cancel`: `PENDING` → `CANCELLED`, and its open authorization too. Repeating it returns the same view.
- `retry`: only `FAILED` with a **retryable** code and attempts left → `PENDING`. A new authorization is then needed.
  - Retryable codes are only those where no token was issued: `PROVIDER_DENIED`, `EXCHANGE_NOT_SENT`, `EXCHANGE_REFUSED`.
  - Everything else needs a new intent, which is a new decision: `INTENT_NOT_RETRYABLE`.
- `recover`: only `EXCHANGING` with an expired lease → `UNKNOWN EXCHANGE_OUTCOME_UNKNOWN`. It makes no provider call and never re-exchanges the code. Within the lease it answers `EXCHANGE_IN_PROGRESS`.

### Intent view (safe for AI)

```json
{ "intentId": "…", "operationKey": "…", "providerIdentifier": "instagram-standalone",
  "mode": "CONNECT", "status": "COMPLETED",
  "target": null, "expectedAccount": { "internalId": null, "profile": "ww.test.acc" },
  "attempt": 1, "maxAttempts": 3, "expiresAt": "…", "leaseExpiresAt": null,
  "failure": null,
  "receipt": { "integrationId": "cl…", "account": { "internalId": "1784…", "profile": "ww.test.acc" },
               "identityEvidence": "PROVIDER_ACCOUNT_AT_EXCHANGE", "observedAt": "…",
               "binding": { "generation": 1, "status": "PENDING_QUALIFICATION" },
               "qualification": "REQUIRED", "sequence": 18 },
  "replayed": false }
```

- `failure` is `{ code, retryable }`.
- `receipt` is present only when the intent is `COMPLETED`. It only proves which account authorized at the time of the exchange. `GET /channels` keeps meaning `RECORDED_IN_POSTIZ_NOT_UPSTREAM_VERIFIED`.
- **Never in any answer, row of these models or event:** token, refresh token, code, state, the state or code digest, the authorization URL (outside the relay's own answer), the granted scope list, `expires_in`, or the account observed on a **failed** attempt.
- Exposing any of those is a separate data-exposure decision.

## States and outcomes

```
intent:  PENDING ─authorization─▶ PENDING (attempt n) ─callback─▶ EXCHANGING ─▶ COMPLETED | FAILED | UNKNOWN
         PENDING ─▶ CANCELLED | EXPIRED | FAILED (target changed / denied)
         FAILED (retryable) ─retry─▶ PENDING
         EXCHANGING (lease expired) ─recover─▶ UNKNOWN
attempt: ISSUED ─▶ REPLACED | CANCELLED | EXPIRED | FAILED | EXCHANGING ─▶ COMPLETED | FAILED | UNKNOWN
```

| Failure code | Outcome | Token issued? | Retryable |
| --- | --- | --- | --- |
| `PROVIDER_DENIED` | FAILED | no | yes |
| `EXCHANGE_NOT_SENT` | FAILED | no (nothing sent) | yes |
| `EXCHANGE_REFUSED` (a provider 4xx with an error) | FAILED | no | yes |
| `SCOPES_MISSING` | FAILED | short-lived, dropped | no |
| `ACCOUNT_MISMATCH`, `TARGET_IDENTITY_MISMATCH` | FAILED | yes, dropped | no |
| `ALREADY_CONNECTED`, `INTEGRATION_NOT_RECONNECTABLE`, `BINDING_GENERATION_MISMATCH` | FAILED | only if seen after the exchange | no |
| `EXCHANGE_TIMEOUT`, `EXCHANGE_OUTCOME_UNKNOWN`, `RECORD_FAILED` | **UNKNOWN** | possibly | no |

`UNKNOWN` is never reported as success, never retried and never re-exchanged. It means nothing was bound, but the provider may hold a token that nobody has. The pinned adapter has no revoke method, so only the owner can revoke it, by removing the app in the provider's settings.

## Binding and history

A connect or reconnect never qualifies a channel. Qualification stays the existing explicit `POST /managed/v1/channels/:integrationId/qualify` with the generation and the identity fingerprint.

- **CONNECT**
  - Creates the Integration with the fields of upstream `createOrUpdateIntegration`'s create branch: no picture, `tokenExpiration` from the provider's `expires_in`, or null when none was given.
  - Creates the binding exactly as `ManagedService.reconcileBinding` would: `PENDING_QUALIFICATION` at generation 1, with `CHANNEL_BINDING_CREATED`.
  - Then appends `CHANNEL_CONNECTED`.
- **RECONNECT**
  - Updates only the target row, with `id`, `internalId` and "not deleted" as conditions: token, refresh token (never wiped by an empty one), `tokenExpiration`, `profile`, `refreshNeeded=false`, `inBetweenSteps=false`. Its name, posts and settings stay.
  - The binding moves to generation + 1:
    - `PENDING_QUALIFICATION` if the recorded identity is unchanged.
    - `PAUSED_IDENTITY_CHANGED` (with the same `CHANNEL_PAUSED_IDENTITY_CHANGED` event as `reconcileBinding`) if it changed, for example a renamed handle.
    - A binding that was already paused gets this event again. It is not a duplicate: `reconcileBinding` skips a paused binding because it leaves its generation alone, but the reconnect moves it to a new generation, and this event is the only one that records the binding paused at that generation (with the bound and the newly recorded fingerprint).
  - Then appends `CHANNEL_RECONNECTED`.
  - Drafts written against the old generation are refused by the existing gate until W&W qualifies again.
- Events carry `{ intentId, attempt, identityFingerprint, identityEvidence, qualification: "REQUIRED" }` and the intent's operation key. Sequences come from the same dense organization counter, under the same lock.
- Nothing is deleted:
  - Earlier events, bindings' history in the feed, posts, revisions, intents and attempts are kept.
  - Earlier `qualifiedAt` stays on the binding row as "last qualified".
- The Integration write passes the existing write fence **only** because it runs inside `runAsManagedWriter` for the same organization. No fence bypass exists. The same write outside it is refused (tested).
- Only `select`s of the identity fields are used: no Integration secret is read back or returned.
- No Temporal workflow, activity or token refresh is started. The refresh cron stays blocked for managed organizations by `RefreshIntegrationService.refresh`, so a managed channel must be reconnected by the owner before its token expires.

## Data and secrets

| Where | What | Retention |
| --- | --- | --- |
| `ManagedConnectionIntent` | Organization, operation key, creating credential id, request hash, provider, mode, target, expected account, status, attempt counter, expiry, lease, failure code, receipt ids. **No secret.** | Never deleted; no sweeper. |
| `ManagedConnectionAttempt` | `sha256(state)`, `sha256(code)`, relay credential ids, timestamps, outcome, and the provider's answer as point-in-time evidence (`observedInternalId`, `observedProfile`, `observedAt`, `providerExpiresIn`, `grantedScopes`), kept apart from the credential. **No token, code or state.** | Never deleted. The digests are of a 256-bit random value and of a single-use code; neither is recoverable authority. |
| `Integration.token`, `refreshToken` | The provider credential, in plain text like every upstream channel. | Upstream lifecycle. The database and its backups hold account credentials; a backup and access policy is not set. |
| Process memory | The state (only until the authorization answer is sent), the code and the tokens (only during the callback request). | Lost on restart. A restart after a claim leaves `EXCHANGING`, which `recover` turns into `UNKNOWN`. Nothing is resumed. JavaScript strings cannot be zeroed. |
| Logs | Nothing from the provider: no answer, URL (the long-lived exchange carries the app secret and token in its query, as upstream does), error object or cause. | — |

## Instagram adapter (differences from upstream, all on our side)

- A 256-bit state from the service, not `makeSecureId(6)` (about 36 bits).
- A fixed `https` redirect URI from its own variable. Never `redirectmeto.com`.
- The requested scopes are a configured subset of the reviewed four, `instagram_business_basic` only by default. The `permissions` of the first answer are checked **before** a long-lived token is requested (upstream checks after it).
- `fetch` only to the three exact endpoints:
  - `redirect: 'error'`
  - the exchange's `AbortSignal` on every call
  - at most 64 KiB read per answer
  - a fetch error is replaced by `Provider call failed` with no cause
- A 4xx answer with an error to the code exchange is `REFUSED`. Everything else that fails is an unknown outcome.
- `/me` asks for `user_id,username,name` (no picture URL). `user_id` must be a plain id.
- `expires_in` is recorded as given (bounded). Missing means `null`, never 58 days.
- No PKCE, no refresh, no revoke. `IntegrationManager`, the full `IntegrationService` and the upstream provider classes are not imported.

## Integration points (root)

Nothing below was changed by this job:

1. **`managed.mode.ts`**: add `'channels:connect'` and `'channels:connect-callback'` to `MANAGED_SCOPES`.
   - Configure the relay credential with `channels:connect-callback` only.
   - Configure the AI-facing credential with `channels:connect` and never the relay scope.
2. **`managed.api.module.ts`**:
   - Add `ManagedConnectionController` to the mounted controller list, so `ManagedAuthMiddleware` covers it through `forRoutes(...)`.
   - Add the providers `ManagedConnectionRepository`, `ManagedConnectionService` and `managedConnectionProviders` (exported from `managed.connection.service.ts`). They depend on the existing `ManagedRepository` and `PrismaTransaction`.
3. **`managed-runtime.module.ts`**: the same providers, if they are not provided through `ManagedApiModule`.
   - The adapter has no import-time side effects, and no `IntegrationManager` is needed.
   - **`managed-runtime.config.ts`**, optional: a startup check that refuses a listed provider without a valid configuration.
4. **Schema**: `ManagedConnectionIntent` and `ManagedConnectionAttempt` were added to `schema.prisma`. The migration, the sha-pinned baseline and `prisma-generate` are root's.
5. **`managed.errors.ts`**: the new codes live in `ManagedConnectionConflictException` in `managed.connection.service.ts`, with the same `{ code, msg }` shape. Move them into `ManagedConflictCode` if preferred.
6. **Docs**: add the egress amendment to `deployment.md`, and this file plus the new specs to the `README.md` ownership and tests table.
7. **Tests**: the new specs are already under the `jest.managed.config.js` test paths.
   - The main spec extends the FAKE DB in-spec for the two models. Adding them to `fakes/fake.prisma.db.ts` (models, defaults, uniques) would let other specs use them.

## Tests (FAKE only; not run by this change)

| Spec | What it is meant to prove |
| --- | --- |
| `managed.connection.spec.ts` | Real repository, service and write fence over the FAKE Prisma, with a FAKE provider.<br>**Disabled by default:** intent creation is refused and a callback is not claimed.<br>**Connect success:** a pending-qualification binding at generation 1, dense events, `expires_in` recorded, identity-only selects, no secret in answers, intent or attempt rows, or events, and qualification still needed.<br>**Idempotency:** create replay, payload or credential mismatch.<br>**Identity gate:** profile or id mismatch (no rows written, evidence kept, not retryable), and ALREADY_CONNECTED (deleted rows included, never restored, with a message that says so).<br>**Expected profile:** with the real Instagram adapter (FAKE fetch), a leading `@`, whitespace or uppercase is `400 INVALID_INPUT` in both modes with no intent, attempt or fetch; a canonical profile is stored byte for byte; a provider without a rule takes the profile as is.<br>**Authorization URL failure:** `CONNECT_PROVIDER_UNAVAILABLE`, rolled back, the open authorization kept, no provider text.<br>**Failures:** denied consent → retry with a new state, an old state refused. NOT_SENT, REFUSED and SCOPES_MISSING mapping. An unknown error is never logged. A deadline timeout is UNKNOWN and a late answer is not adopted. A lost terminal transaction is UNKNOWN.<br>**Concurrency:** 6 concurrent callbacks make 1 exchange, and two intents racing for one account bind 1.<br>**Recovery:** a dead claim is held until the lease, then recovered as UNKNOWN with no exchange.<br>**Expiry and bounds:** authorization and intent expiry, the authorization bound, cancel.<br>**Isolation:** other organizations, and relay-versus-AI credentials.<br>**Reconnect:** exact generation only, the same row, history kept, qualification required at the new generation, a generation that moved before the exchange, another account never bound, a renamed handle pauses, an already paused channel is paused again at the new generation only, deleted / unknown / other-provider channels refused.<br>**Fence:** an Integration write outside the managed writer is refused. |
| `managed.connection.instagram.spec.ts` | FAKE fetch. The expected-profile rule (lowercase, no `@`, no whitespace, never normalized, input not echoed). Configuration is refused for http, `redirectmeto.com`, query or fragment, credentials, or unreviewed scopes. The authorize URL equals upstream's parameters with our state and no PKCE. The three exact calls under one signal with `redirect: 'error'`. `expires_in` recorded, or null. No long-lived token without the scopes. Refusal versus unknown. The answer bound. No secret in errors, and no console output. Nothing is sent unconfigured or aborted. |
| `managed.connection.controller.spec.ts` | Routes and paths, one scope per route through the existing guard, AI versus relay separation, no route for today's scopes, `no-store` on the relay answers, and the organization taken from the credential. |

## Remaining W&W journey work

- W&W relay (Codex): the authenticated human session, binding the intent to that session (cookie or nonce), the redirect, the registered callback page, and the server-to-server relay. Then UI states for every failure code, including the owner instructions for `UNKNOWN` and mismatches (revoke the app, log in to the right account, create a new intent).
- An operator step that provisions the `Organization` row, the Meta app (ownership, mode, review, redirect URI), secret storage, and egress.
- Qualifying the upstream contract against Meta's current documentation (see above), then a separately authorized live run for the test account only.
- A W&W qualify step after every connect / reconnect, which the existing API already supports.
- Reconnect reminders before `tokenExpiration`, because refresh stays blocked. Exposing the expiry to W&W is a separate decision.
- Decisions not taken here:
  - whether failed-attempt identity, granted scopes or expiry may be shown to W&W
  - a retention or sweeper policy for intent and attempt rows
  - restoring a retained deleted channel in a managed organization. Today CONNECT refuses its account and RECONNECT refuses the deleted row, by design. A restore would revive a row with its history, posts and binding, so it needs its own explicitly qualified authority and contract (who may ask, the identity proof, the binding generation, its events). It must not be added as a silent side effect of CONNECT or RECONNECT, or handed off to the Postiz UI.
