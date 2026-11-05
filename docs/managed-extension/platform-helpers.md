# W&W platform helpers

Scope: TEST-001 / `ww.test.acc` only. This is the infrastructure W&W needs to
match Postiz's UI and MCP lookups: audio, mention, music and location search.
Each helper is one point-in-time, read-only provider lookup for a bound
channel. Nothing here publishes, schedules, deletes, reconnects, refreshes,
spends or hosts anything. No live call has been made: every provider in the
tests is a fake transport. The upstream contract was **not** qualified
against the providers. Nothing here claims that a provider, account or token
is continuously qualified upstream.

## Files

| File | Role |
|---|---|
| `libraries/nestjs-libraries/src/database/prisma/managed/managed.helper.contracts.ts` | Closed helper list, input rules, result type, refusal codes, operator qualification, plain-text sanitizers |
| `libraries/nestjs-libraries/src/dtos/managed/managed.helper.dto.ts` | Strict request DTO |
| `libraries/nestjs-libraries/src/database/prisma/managed/managed.helper.repository.ts` | Two read-only Prisma reads, scoped to the credential's organization |
| `libraries/nestjs-libraries/src/database/prisma/managed/managed.helper.provider.ts` | Four direct adapters over an injected transport |
| `libraries/nestjs-libraries/src/database/prisma/managed/managed.helper.service.ts` | Gate, before/after binding check, deadline, result |
| `apps/backend/src/managed-api/managed.helper.controller.ts` | `POST /managed/v1/helpers/calls` |
| `…/managed/__tests__/managed.helper.{provider,service}.spec.ts`, `apps/backend/src/managed-api/__tests__/managed.helper.controller.spec.ts` | Tests (fakes only) |

`managed.mode.ts` has one additive change: `helpers:read` was added to
`MANAGED_SCOPES`.

### Still to be wired by root (not done here)

- In `managed.api.module.ts`: add `ManagedHelperController` to the mounted
  controller list. The existing `ManagedAuthMiddleware` `forRoutes(...)` then
  covers it. Add `ManagedHelperRepository`, `ManagedHelperService` and
  `...managedHelperProviders` (from `managed.helper.service.ts`) to
  `providers`.
- The isolated runtime (`apps/backend/src/managed-runtime/`) and its config
  or Dockerfile, if helpers are served there.
- Add the three spec files to `jest.managed.config.js` `testMatch` and
  `tsconfig.managed.spec.json`.
- Set the operator variables below. They are empty by default, so helpers stay off.

## Helpers (closed set, grounded in pinned source bd8353f)

| Helper | Upstream method | Providers | Input |
|---|---|---|---|
| `instagram.audio-search.v1` | `InstagramProvider.audioSearch` | `instagram` only | `kind`: `music`\|`original_sound` (required); `query` (optional, absent = trending) |
| `linkedin.mention-search.v1` | `LinkedinProvider.mention` | `linkedin`, `linkedin-page` | `query`: company vanity name (required) |
| `tiktok-business.music-search.v1` | `TiktokBusinessProvider.musicSearch` | `tiktok-business` | `genre` (optional, `^[A-Z][A-Z_]{0,31}$`) |
| `tiktok-business.location-search.v1` | `TiktokBusinessProvider.locationSearch` | `tiktok-business` | `query` (required) |

What the source shows about inheritance:
- `InstagramStandaloneProvider` extends `SocialAbstract`, not
  `InstagramProvider`. It has no `audioSearch`, so audio search is **not**
  available for `instagram-standalone`. Such a channel gets
  `HELPER_NOT_SUPPORTED_FOR_PROVIDER` with no provider call.
- `LinkedinPageProvider extends LinkedinProvider` and does not override
  `mention`. `@Tool` metadata is read with `Reflect.getMetadata`, which walks
  the prototype chain, so upstream's dashboard offers it for `linkedin-page`
  too. The page channel's own token is sent.

## Request

```
POST /managed/v1/helpers/calls          (scope helpers:read, Cache-Control: no-store, 200)
{ "helper": "tiktok-business.music-search.v1", "integrationId": "…",
  "expectedBindingGeneration": 2, "genre": "POP" }
```

The validation pipe refuses unknown keys: `whitelist` plus
`forbidNonWhitelisted`. A caller therefore cannot pass a URL, method name,
provider identifier, organization or credential. `query` must be printable,
1–100 characters, with no control characters. A field the chosen helper does
not take, a missing required field, or a whitespace-only `query` gives
`400 HELPER_INPUT_INVALID`.

## Qualification (fail closed, checked before any read)

Every condition below must hold, read from the environment on each call:

1. The credential holds exactly `helpers:read` and no other scope. Otherwise
   `403 HELPER_CREDENTIAL_NOT_DEDICATED`. A credential with other scopes but
   without `helpers:read` is stopped earlier by the guard with `SCOPE_MISSING`.
2. The organization is managed (`POSTIZ_MANAGED_MODE`/`ORGANIZATIONS`) and is
   listed in `POSTIZ_MANAGED_HELPER_ORGANIZATIONS`. This list is empty by
   default. Otherwise `403 HELPER_ORGANIZATION_NOT_ENABLED`.
3. The helper is listed in `POSTIZ_MANAGED_HELPERS`. This list is empty by
   default. Otherwise `403 HELPER_NOT_ENABLED`.
4. `POSTIZ_MANAGED_HELPER_EXPIRES_AT` is a valid date, no later than
   `2026-11-10T23:00:00Z` (the operator-stated end of customer access), and
   still in the future. Otherwise `403 HELPER_ACCESS_EXPIRED`.
5. The rate limit is the same `ThrottlerManagedCredentialGuard` and
   `managedRateLimit()` (200 / hour per organization) as every other managed
   route, so helper calls share the existing budget.

## Channel gate (before the provider call)

The repository reads the Integration and its binding in one RepeatableRead
snapshot, with `where: { id, organizationId }` (exact owner). The Integration
select is minimal: identity fields, `disabled`, `refreshNeeded`,
`inBetweenSteps`, `deletedAt` and `tokenExpiration`. `token` is read with a
separate select in the same snapshot. It stays server-private: it is passed
to one adapter call and appears in no result, error or log. The after-call
read does not select it.

| Condition | Answer |
|---|---|
| No row in this organization | `422 INTEGRATION_NOT_FOUND` |
| Binding `PAUSED_IDENTITY_CHANGED`, or the current identity fingerprint / provider / internalId differs from the binding | `409 CHANNEL_IDENTITY_CHANGED` |
| Deleted, disabled, in between steps, unbound, not `QUALIFIED`, or an unusual internalId | `409 CHANNEL_NOT_QUALIFIED` |
| `binding.generation ≠ expectedBindingGeneration` | `409 BINDING_GENERATION_MISMATCH` |
| Provider not listed for the helper | `409 HELPER_NOT_SUPPORTED_FOR_PROVIDER` |
| `refreshNeeded`, no token, or `tokenExpiration` passed | `409 RECONNECT_REQUIRED` |

The gate never reconciles or writes a binding, unlike the draft write path.
A mismatch is refused and nothing is recorded.

## Provider call

The adapters call the provider directly. They do not use `IntegrationManager`,
`SocialAbstract.fetch` or the `/integrations/function` endpoint. Those
upstream paths can refresh a token (`RefreshIntegrationService.refresh`),
disconnect a channel (`Disconnect`), mark it `refreshNeeded`, wait and retry.
Here the separation from refresh comes from the implementation itself: no
refresh code is reachable, so it does not depend on the managed refusal
inside those paths.

- There is exactly one GET per call, with no retry. The URL is built from a
  fixed constant, and after parsing its origin and path must equal that
  constant. Values go only into the query: `URLSearchParams`, or
  `encodeURIComponent` for LinkedIn's vanity name. LinkedIn's
  `projection=(elements*(id,localizedName))` is sent unencoded, as upstream
  sends it.
  - `https://graph.facebook.com/v25.0/ig_audio` with `audio_type`, `user_id`
    (internalId), optional `search_query`, and `access_token` (the user token
    of a `page___user` token, otherwise the token, as upstream does).
  - `https://api.linkedin.com/v2/organizations` with `q=vanityName`. The
    headers are the same as upstream: `Bearer`, `LinkedIn-Version: 202601`
    and Restli 2.0.0. `logoV2` is no longer requested.
  - `https://business-api.tiktok.com/open_api/v1.3/discovery/cml/trending_list/`
    with `business_id` and `genre?`, or `…/business/publish/location/` with
    `business_id` and `search_query` (cut at 100). The token goes in the
    `Access-Token` header.
- The request uses `redirect: 'error'`, and any 3xx answer becomes
  `REDIRECT_REFUSED`.
- The whole call has a 10 s deadline (`AbortSignal.any` with the client-close
  signal). The body read is raced against the signal, so a stalled stream
  still ends.
- At most 512 KiB of the answer is read, as a stream. A larger answer is
  cancelled and becomes `TOO_LARGE`.
- A token that is not printable ASCII without spaces (for example one
  containing CR/LF) is never sent, and the answer is `RECONNECT_REQUIRED`.

Failures:

| Provider answer | Result |
|---|---|
| 401, or the provider's own refresh-token markers from pinned `handleErrors` (Instagram: `REVOKED_ACCESS_TOKEN`, `"error_subcode":33`, not-a-business, session invalidated; TikTok: `access_token_invalid` and the others) | `409 RECONNECT_REQUIRED`. The channel is **not** marked and nothing is refreshed |
| Instagram `"code":190` | `RECONNECT_REQUIRED`. **Our classification**: the pinned source does not classify 190 for this call (elsewhere it maps `190,` to bad-body) |
| 429 / TikTok rate-limit markers | `502 PROVIDER_CALL_FAILED reason RATE_LIMITED` |
| Thrown fetch error, aborted, too large, redirect, not a JSON object, wrong list type, other error, TikTok non-zero `code` | `502 PROVIDER_CALL_FAILED` with `reason` ∈ `NETWORK`, `TIMEOUT`, `TOO_LARGE`, `REDIRECT_REFUSED`, `MALFORMED`, `PROVIDER_ERROR` |

Errors are fully redacted. A thrown transport error is replaced, never
wrapped, because a Meta URL carries `access_token` in its query. No status
line, provider text, URL or header reaches an exception or a log. Upstream
TikTok returns `[]` for a non-token error; here that case is an error, so an
empty list always means the provider listed nothing.

## After the call

The channel is read again, without the token. The answer is discarded with
`409 BINDING_CHANGED_DURING_CALL` if any of these happened during the call:
the channel would now be refused, or its identity fingerprint, generation,
`disabled`, `refreshNeeded` or `inBetweenSteps` changed (for example a
reconnect, pause, rebind or delete).

## Result

```json
{ "schemaVersion": 1, "helper": "tiktok-business.music-search.v1",
  "integrationId": "…", "provider": "tiktok-business", "bindingGeneration": 2,
  "observedAt": "2026-11-05T12:00:00.000Z",
  "coverage": { "partial": true, "reasons": ["PROVIDER_PAGE"], "returned": 1, "limit": 50 },
  "items": [{ "kind": "AUDIO", "id": "…", "title": "…", "artist": "…", "durationMs": 20000 }] }
```

- Item kinds:
  - `AUDIO {id,title,artist,durationMs}` for Instagram audio and TikTok music.
  - `MENTION {id,label,mention}` for LinkedIn.
  - `LOCATION {id,name,address}` for TikTok locations.
- Only these fields are built, so any other provider key is dropped.
- **No image, artwork, preview or download URL** is ever returned. Signed CDN
  URLs can be credentials. No media is fetched.
- `coverage.partial` is always `true`. `PROVIDER_PAGE` is always set: each
  provider answer is one trending page or one match list, never a catalogue.
  `ITEM_LIMIT` means more than 50 entries arrived. `ITEMS_DROPPED` means
  entries without a usable id were left out.
- Ids must match `^[A-Za-z0-9_.:-]{1,128}$`, or the entry is dropped.
- Text is untrusted plain text. C0/C1 controls, bidi, zero-width and BOM
  characters become spaces, whitespace is collapsed, and the value is cut at
  200 code points. HTML is **not** escaped: it is text, and consumers must
  render it as text.
- `durationMs` is a whole number of milliseconds of at most 24 h, otherwise
  null. TikTok reports seconds, as upstream assumes.
- `mention` uses upstream `mentionFormat` as plain text:
  `@[label](urn:li:organization:id)`. It is only set when the id is numeric
  and the label has no `[ ] ( ) @`; otherwise it is `null`. It is never the
  HTML `<span data-mention…>` form.

## Not covered / open

- These helpers make no database rows, queue or schema changes. The W&W
  worker will run calls under the shared budget, and a durable helper command
  comes later.
- Whether the four endpoints, Graph `v25.0` and `LinkedIn-Version 202601`
  still behave as the pinned source assumes has not been checked live.
- Whether `ww.test.acc`'s channels hold the scopes these calls need is unknown.
  For example, LinkedIn organization lookup may need organization scopes, and
  TikTok CML access may need approval.
- Whether a helper call itself counts against the provider app's quota is
  unknown.
