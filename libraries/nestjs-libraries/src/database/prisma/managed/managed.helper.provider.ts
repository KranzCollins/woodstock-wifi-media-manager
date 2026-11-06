import {
  ProviderResponse,
  ProviderTransport,
  parseJson,
  readBounded,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';
import {
  ManagedHelperCallFailure,
  ManagedHelperInput,
  ManagedHelperItem,
  ManagedHelperName,
  MANAGED_HELPER_MAX_ITEMS,
  MANAGED_HELPER_MAX_RESPONSE_BYTES,
  durationMs,
  plainText,
  providerId,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.contracts';

// The provider side of W&W platform helpers (docs/managed-extension/
// platform-helpers.md). Each adapter is one fixed GET copied from the pinned
// upstream method (bd8353f), made directly through an injected transport.
// Deliberately not IntegrationManager, SocialAbstract.fetch or the
// /integrations/function endpoint: those refresh a token, mark a channel
// refreshNeeded, disconnect it or retry, and none of that may happen here.
// A token the provider refuses is RECONNECT_REQUIRED, with no second call.
//
// Nothing a provider sends reaches a result except the listed fields, as
// bounded plain text. Image, artwork and preview URLs are never returned (a
// signed CDN URL is a credential of its own), and no media is fetched. No
// URL, header, status line or provider text reaches an error or a log: a Meta
// URL carries the access token in its query.

export const MANAGED_HELPER_ADAPTERS = 'MANAGED_HELPER_ADAPTERS';
export const MANAGED_HELPER_TRANSPORT = 'MANAGED_HELPER_TRANSPORT';

// Server-private for the length of one call
export interface HelperCallContext {
  token: string;
  internalId: string;
  input: ManagedHelperInput;
  signal: AbortSignal;
}

export type HelperAdapterOutcome =
  | {
      ok: true;
      items: ManagedHelperItem[];
      // entries without a usable id were left out
      dropped: boolean;
      // the provider sent more than MANAGED_HELPER_MAX_ITEMS
      truncated: boolean;
    }
  | { ok: false; failure: 'RECONNECT_REQUIRED' | ManagedHelperCallFailure };

export interface ManagedHelperAdapter {
  readonly helper: ManagedHelperName;
  call(
    context: HelperCallContext,
    transport: ProviderTransport
  ): Promise<HelperAdapterOutcome>;
}

// META_GRAPH_API_VERSION of the pinned facebook.provider.ts, copied so this
// file does not load the upstream providers
const META_GRAPH_VERSION = 'v25.0';
const INSTAGRAM_AUDIO_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}/ig_audio`;
const LINKEDIN_ORGANIZATIONS_URL = 'https://api.linkedin.com/v2/organizations';
const TIKTOK_BASE = 'https://business-api.tiktok.com/open_api/v1.3';
const TIKTOK_MUSIC_URL = `${TIKTOK_BASE}/discovery/cml/trending_list/`;
const TIKTOK_LOCATION_URL = `${TIKTOK_BASE}/business/publish/location/`;

// a token that can be sent in a header or a query without changing the
// request; anything else is not sent at all
const SENDABLE_TOKEN = /^[\x21-\x7e]{1,4096}$/;

type ProviderAnswer =
  | { ok: true; status: number; text: string; body: Record<string, any> | null }
  | { ok: false; failure: ManagedHelperCallFailure };

function whenAborted(signal: AbortSignal) {
  return new Promise<{ ok: false; reason: 'read_failed' }>((resolve) => {
    const done = () => resolve({ ok: false, reason: 'read_failed' });
    if (signal.aborted) {
      done();
    } else {
      signal.addEventListener('abort', done, { once: true });
    }
  });
}

async function discard(response: ProviderResponse) {
  await response.body
    ?.getReader()
    .cancel()
    .catch((): undefined => undefined);
}

// One GET to `endpoint` and nowhere else. `query` is appended as given (the
// LinkedIn projection must stay unencoded, like upstream sends it); the
// origin and path are checked after parsing so no value can move the request
async function getJson(
  transport: ProviderTransport,
  endpoint: string,
  query: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<ProviderAnswer> {
  const url = new URL(`${endpoint}?${query}`);
  if (`${url.origin}${url.pathname}` !== endpoint || url.hash) {
    return { ok: false, failure: 'MALFORMED' };
  }

  let response: ProviderResponse;
  try {
    response = await transport(url.toString(), {
      method: 'GET',
      headers,
      signal,
      redirect: 'error',
    });
  } catch (err) {
    // replaced, never wrapped: the error can carry the URL
    return { ok: false, failure: signal.aborted ? 'TIMEOUT' : 'NETWORK' };
  }

  if (response.status >= 300 && response.status < 400) {
    await discard(response);
    return { ok: false, failure: 'REDIRECT_REFUSED' };
  }

  // a body that stops sending is ended by the deadline even when the
  // transport does not abort its stream
  const read = await Promise.race([
    readBounded(response, MANAGED_HELPER_MAX_RESPONSE_BYTES),
    whenAborted(signal),
  ]);
  if (read.ok === false) {
    if (read.reason === 'too_large') {
      return { ok: false, failure: 'TOO_LARGE' };
    }
    return { ok: false, failure: signal.aborted ? 'TIMEOUT' : 'NETWORK' };
  }
  if (signal.aborted) {
    return { ok: false, failure: 'TIMEOUT' };
  }

  const parsed = parseJson(read.text);
  const body =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : null;
  // a success that is not a JSON object is never read as an empty list
  if (response.status === 200 && !body) {
    return { ok: false, failure: 'MALFORMED' };
  }

  return { ok: true, status: response.status, text: read.text, body };
}

// the first MANAGED_HELPER_MAX_ITEMS entries of a provider list, mapped;
// entries the mapper refuses (no usable id) are dropped
function boundedItems(
  list: unknown[],
  map: (entry: any) => ManagedHelperItem | null
): HelperAdapterOutcome {
  const items: ManagedHelperItem[] = [];
  let dropped = false;
  for (const entry of list.slice(0, MANAGED_HELPER_MAX_ITEMS)) {
    const item =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? map(entry)
        : null;
    if (item) {
      items.push(item);
    } else {
      dropped = true;
    }
  }

  return {
    ok: true,
    items,
    dropped,
    truncated: list.length > MANAGED_HELPER_MAX_ITEMS,
  };
}

// A failed HTTP answer; token problems first. `tokenRefused` is the
// provider's own refresh-token classification from the pinned source
function httpFailure(
  answer: { status: number; text: string },
  tokenRefused: (text: string) => boolean
): HelperAdapterOutcome {
  if (answer.status === 401 || tokenRefused(answer.text)) {
    return { ok: false, failure: 'RECONNECT_REQUIRED' };
  }
  if (answer.status === 429) {
    return { ok: false, failure: 'RATE_LIMITED' };
  }
  return { ok: false, failure: 'PROVIDER_ERROR' };
}

// ---- Instagram (Facebook login), InstagramProvider.audioSearch -------------

// InstagramProvider.handleErrors' refresh-token branches, plus Meta's
// OAuthException code 190 (an invalid or expired access token), which the
// pinned source does not classify for this call
function instagramTokenRefused(text: string) {
  const lower = text.toLowerCase();
  return (
    text.indexOf('REVOKED_ACCESS_TOKEN') > -1 ||
    text.indexOf('"error_subcode":33') > -1 ||
    lower.indexOf('the user is not an instagram business') > -1 ||
    lower.indexOf('session has been invalidated') > -1 ||
    /"code"\s*:\s*190\b/.test(text)
  );
}

export class InstagramAudioSearchAdapter implements ManagedHelperAdapter {
  readonly helper = 'instagram.audio-search.v1' as const;

  async call(
    context: HelperCallContext,
    transport: ProviderTransport
  ): Promise<HelperAdapterOutcome> {
    // the stored token is `page token___user token` (or one token); upstream
    // sends the user token when there is one
    const [accessToken, userToken] = context.token.split('___');
    const token = userToken || accessToken;
    if (!SENDABLE_TOKEN.test(token || '')) {
      return { ok: false, failure: 'RECONNECT_REQUIRED' };
    }

    const params = new URLSearchParams({
      audio_type: context.input.kind === 'original_sound' ? 'original_sound' : 'music',
      user_id: context.internalId,
    });
    if (context.input.query) {
      params.set('search_query', context.input.query);
    }
    params.set('access_token', token);

    const answer = await getJson(
      transport,
      INSTAGRAM_AUDIO_URL,
      params.toString(),
      {},
      context.signal
    );
    if (answer.ok === false) {
      return answer;
    }
    if (answer.status !== 200 || !answer.body || answer.body.error) {
      return httpFailure(answer, instagramTokenRefused);
    }
    if (!Array.isArray(answer.body.audio)) {
      return { ok: false, failure: 'MALFORMED' };
    }

    return boundedItems(answer.body.audio, (audio) => {
      const id = providerId(audio.audio_id);
      return id
        ? {
            kind: 'AUDIO',
            id,
            title: plainText(audio.title),
            artist: plainText(audio.display_artist || audio.ig_username),
            durationMs: durationMs(audio.duration_in_ms),
          }
        : null;
    });
  }
}

// ---- LinkedIn and LinkedIn Page, LinkedinProvider.mention -------------------

// LinkedinProvider.mentionFormat, only when the label goes in unchanged
function linkedinMention(id: string, label: string) {
  return /^\d+$/.test(id) && /^[^[\]()@]+$/.test(label)
    ? `@[${label}](urn:li:organization:${id})`
    : null;
}

export class LinkedinMentionSearchAdapter implements ManagedHelperAdapter {
  readonly helper = 'linkedin.mention-search.v1' as const;

  async call(
    context: HelperCallContext,
    transport: ProviderTransport
  ): Promise<HelperAdapterOutcome> {
    if (!SENDABLE_TOKEN.test(context.token)) {
      return { ok: false, failure: 'RECONNECT_REQUIRED' };
    }

    // upstream's request without logoV2: no logo URL is returned anyway
    const answer = await getJson(
      transport,
      LINKEDIN_ORGANIZATIONS_URL,
      `q=vanityName&vanityName=${encodeURIComponent(
        context.input.query || ''
      )}&projection=(elements*(id,localizedName))`,
      {
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        'LinkedIn-Version': '202601',
        Authorization: `Bearer ${context.token}`,
      },
      context.signal
    );
    if (answer.ok === false) {
      return answer;
    }
    if (answer.status !== 200 || !answer.body) {
      return httpFailure(answer, () => false);
    }
    if (!Array.isArray(answer.body.elements)) {
      return { ok: false, failure: 'MALFORMED' };
    }

    return boundedItems(answer.body.elements, (organization) => {
      const id = providerId(organization.id);
      const label = plainText(organization.localizedName);
      // upstream's /mentions keeps only entries with a label and an id
      return id && label
        ? { kind: 'MENTION', id, label, mention: linkedinMention(id, label) }
        : null;
    });
  }
}

// ---- TikTok Business, TiktokBusinessProvider.musicSearch / locationSearch --

// TiktokBusinessProvider.handleErrors' refresh-token branch
function tiktokTokenRefused(text: string) {
  return (
    text.indexOf('access_token_invalid') > -1 ||
    text.indexOf('Access token is incorrect') > -1 ||
    text.indexOf('Access token has expired') > -1 ||
    text.indexOf('The access token is invalid') > -1 ||
    text.indexOf('auth_removed') > -1
  );
}

// The Business API answers HTTP 200 with a non-zero `code` for errors.
// Upstream turns a non-token error into an empty list; here it is an error,
// so an empty list always means the provider listed nothing
async function tiktokGet(
  transport: ProviderTransport,
  endpoint: string,
  query: URLSearchParams,
  context: HelperCallContext
): Promise<
  { ok: true; data: Record<string, any> } | Extract<HelperAdapterOutcome, { ok: false }>
> {
  if (!SENDABLE_TOKEN.test(context.token)) {
    return { ok: false, failure: 'RECONNECT_REQUIRED' };
  }

  const answer = await getJson(
    transport,
    endpoint,
    query.toString(),
    { 'Access-Token': context.token },
    context.signal
  );
  if (answer.ok === false) {
    return answer;
  }
  if (answer.status !== 200 || !answer.body || answer.body.code !== 0) {
    // the same order as TiktokBusinessProvider.handleErrors
    if (answer.status === 401 || tiktokTokenRefused(answer.text)) {
      return { ok: false, failure: 'RECONNECT_REQUIRED' };
    }
    if (
      answer.status === 429 ||
      answer.text.indexOf('rate_limit_exceeded') > -1 ||
      answer.text.indexOf('Too many requests') > -1
    ) {
      return { ok: false, failure: 'RATE_LIMITED' };
    }
    return { ok: false, failure: 'PROVIDER_ERROR' };
  }

  const data = answer.body.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? { ok: true, data }
    : { ok: false, failure: 'MALFORMED' };
}

export class TiktokMusicSearchAdapter implements ManagedHelperAdapter {
  readonly helper = 'tiktok-business.music-search.v1' as const;

  async call(
    context: HelperCallContext,
    transport: ProviderTransport
  ): Promise<HelperAdapterOutcome> {
    const query = new URLSearchParams({ business_id: context.internalId });
    if (context.input.genre) {
      query.set('genre', context.input.genre);
    }

    const answer = await tiktokGet(transport, TIKTOK_MUSIC_URL, query, context);
    if (answer.ok === false) {
      return answer;
    }
    if (!Array.isArray(answer.data.list)) {
      return { ok: false, failure: 'MALFORMED' };
    }

    return boundedItems(answer.data.list, (track) => {
      // upstream: only a song_clip_id is publishable as music_sound_id
      const id = providerId(
        track.full_duration_song_clip?.song_clip_id ||
          track.trending_song_clip?.song_clip_id
      );
      return id
        ? {
            kind: 'AUDIO',
            id,
            title: plainText(track.commercial_music_name),
            artist: plainText(track.artist),
            // seconds, like upstream reads them
            durationMs: durationMs(
              track.duration || track.trending_song_clip?.duration,
              1000
            ),
          }
        : null;
    });
  }
}

export class TiktokLocationSearchAdapter implements ManagedHelperAdapter {
  readonly helper = 'tiktok-business.location-search.v1' as const;

  async call(
    context: HelperCallContext,
    transport: ProviderTransport
  ): Promise<HelperAdapterOutcome> {
    const query = new URLSearchParams({
      business_id: context.internalId,
      search_query: (context.input.query || '').slice(0, 100),
    });

    const answer = await tiktokGet(
      transport,
      TIKTOK_LOCATION_URL,
      query,
      context
    );
    if (answer.ok === false) {
      return answer;
    }
    if (!Array.isArray(answer.data.locations)) {
      return { ok: false, failure: 'MALFORMED' };
    }

    return boundedItems(answer.data.locations, (location) => {
      const id = providerId(location.location_id);
      return id
        ? {
            kind: 'LOCATION',
            id,
            name: plainText(location.location_name),
            address: plainText(location.location_address),
          }
        : null;
    });
  }
}

export function defaultManagedHelperAdapters(): ManagedHelperAdapter[] {
  return [
    new InstagramAudioSearchAdapter(),
    new LinkedinMentionSearchAdapter(),
    new TiktokMusicSearchAdapter(),
    new TiktokLocationSearchAdapter(),
  ];
}
