import {
  ProviderRequest,
  ProviderResponse,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';
import {
  HelperCallContext,
  InstagramAudioSearchAdapter,
  LinkedinMentionSearchAdapter,
  TiktokLocationSearchAdapter,
  TiktokMusicSearchAdapter,
  defaultManagedHelperAdapters,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.provider';
import {
  MANAGED_HELPER_DEFINITIONS,
  MANAGED_HELPER_MAX_RESPONSE_BYTES,
  MANAGED_HELPER_NAMES,
  plainText,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.contracts';

// Every provider here is a FAKE transport: no request leaves the process
const PAGE_TOKEN = 'FAKE-PAGE-TOKEN-0000';
const USER_TOKEN = 'FAKE-USER-TOKEN-1111';

function respond(
  status: number,
  payload: unknown,
  chunks?: Uint8Array[]
): ProviderResponse {
  const parts = chunks || [
    Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  ];
  let index = 0;
  return {
    status,
    body: {
      getReader: () => ({
        read: async () =>
          index < parts.length
            ? { done: false, value: parts[index++] }
            : { done: true },
        cancel: async () => undefined,
      }),
    },
  };
}

function fakeTransport(
  answer: (url: string, request: ProviderRequest) => Promise<ProviderResponse> | ProviderResponse
) {
  const calls: { url: string; request: ProviderRequest }[] = [];
  const transport = jest.fn(async (url: string, request: ProviderRequest) => {
    calls.push({ url, request });
    return answer(url, request);
  });
  return { transport, calls };
}

function context(input: HelperCallContext['input'], token = PAGE_TOKEN): HelperCallContext {
  return {
    token,
    internalId: '17841400000000001',
    input,
    signal: new AbortController().signal,
  };
}

describe('managed helper adapters', () => {
  it('has exactly one adapter per closed helper, each for a listed provider', () => {
    expect(defaultManagedHelperAdapters().map((adapter) => adapter.helper)).toEqual([
      ...MANAGED_HELPER_NAMES,
    ]);
    // instagram-standalone does not extend InstagramProvider (no audioSearch)
    expect(MANAGED_HELPER_DEFINITIONS['instagram.audio-search.v1'].providerIdentifiers).toEqual([
      'instagram',
    ]);
    expect(MANAGED_HELPER_DEFINITIONS['linkedin.mention-search.v1'].providerIdentifiers).toEqual([
      'linkedin',
      'linkedin-page',
    ]);
  });

  describe('instagram.audio-search.v1', () => {
    it('sends one GET to the fixed ig_audio URL with the user token, and returns only safe fields', async () => {
      const { transport, calls } = fakeTransport(() =>
        respond(200, {
          audio: [
            {
              audio_id: '9001',
              title: 'Lo\u0007fi ‮beat\n',
              display_artist: '<img src=x onerror=alert(1)>',
              duration_in_ms: 31000,
              cover_artwork_thumbnail_uri: 'https://cdn.example/a.jpg?sig=FAKE',
              download_url: 'https://cdn.example/a.mp3?token=FAKE',
              unexpected: { nested: true },
            },
            { title: 'no id' },
          ],
        })
      );

      const outcome = await new InstagramAudioSearchAdapter().call(
        context({ kind: 'music', query: 'lo fi&x=1' }, `${PAGE_TOKEN}___${USER_TOKEN}`),
        transport
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        `https://graph.facebook.com/v25.0/ig_audio?audio_type=music&user_id=17841400000000001&search_query=lo+fi%26x%3D1&access_token=${USER_TOKEN}`
      );
      expect(calls[0].request).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(outcome).toEqual({
        ok: true,
        items: [
          {
            kind: 'AUDIO',
            id: '9001',
            title: 'Lo fi beat',
            // plain text: kept as characters, never interpreted
            artist: '<img src=x onerror=alert(1)>',
            durationMs: 31000,
          },
        ],
        dropped: true,
        truncated: false,
      });
      expect(JSON.stringify(outcome)).not.toMatch(/https?:|FAKE/);
    });

    it('sends the page token when there is no user token, and no search_query for trending', async () => {
      const { transport, calls } = fakeTransport(() => respond(200, { audio: [] }));
      await new InstagramAudioSearchAdapter().call(context({ kind: 'original_sound' }), transport);
      expect(calls[0].url).toBe(
        `https://graph.facebook.com/v25.0/ig_audio?audio_type=original_sound&user_id=17841400000000001&access_token=${PAGE_TOKEN}`
      );
    });

    it.each([
      [401, { error: { message: 'x', code: 102 } }],
      [400, { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }],
      [400, { error: { message: 'REVOKED_ACCESS_TOKEN' } }],
      [200, { error: { message: 'Your session has been invalidated' } }],
    ])('maps a refused token (%s) to RECONNECT_REQUIRED without a second call', async (status, body) => {
      const { transport } = fakeTransport(() => respond(status, body));
      expect(await new InstagramAudioSearchAdapter().call(context({ kind: 'music' }), transport)).toEqual({
        ok: false,
        failure: 'RECONNECT_REQUIRED',
      });
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it('never sends a token it cannot send unchanged', async () => {
      const { transport } = fakeTransport(() => respond(200, { audio: [] }));
      expect(
        await new InstagramAudioSearchAdapter().call(context({ kind: 'music' }, 'bad token\r\nX: y'), transport)
      ).toEqual({ ok: false, failure: 'RECONNECT_REQUIRED' });
      expect(transport).not.toHaveBeenCalled();
    });

    it('replaces a transport error that carries the URL and token', async () => {
      const { transport } = fakeTransport(() => {
        throw new Error(`fetch failed https://graph.facebook.com/?access_token=${PAGE_TOKEN}`);
      });
      const outcome = await new InstagramAudioSearchAdapter().call(context({ kind: 'music' }), transport);
      expect(outcome).toEqual({ ok: false, failure: 'NETWORK' });
      expect(JSON.stringify(outcome)).not.toContain(PAGE_TOKEN);
    });
  });

  describe('bounded transport', () => {
    const adapter = new InstagramAudioSearchAdapter();

    it('refuses a redirect instead of following it', async () => {
      const { transport } = fakeTransport(() => respond(302, ''));
      expect(await adapter.call(context({ kind: 'music' }), transport)).toEqual({
        ok: false,
        failure: 'REDIRECT_REFUSED',
      });
    });

    it('stops reading an oversized answer', async () => {
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      const chunks = Array.from(
        { length: MANAGED_HELPER_MAX_RESPONSE_BYTES / chunk.length + 2 },
        () => chunk
      );
      const { transport } = fakeTransport(() => respond(200, '', chunks));
      expect(await adapter.call(context({ kind: 'music' }), transport)).toEqual({
        ok: false,
        failure: 'TOO_LARGE',
      });
    });

    it.each([['not json'], [JSON.stringify([1, 2])], [JSON.stringify({ audio: 'x' })]])(
      'refuses a malformed answer %s',
      async (text) => {
        const { transport } = fakeTransport(() => respond(200, text));
        expect(await adapter.call(context({ kind: 'music' }), transport)).toEqual({
          ok: false,
          failure: 'MALFORMED',
        });
      }
    );

    it('ends a stalled request and a stalled body at the deadline', async () => {
      const stalledRequest = jest.fn(
        (url: string, request: ProviderRequest) =>
          new Promise<ProviderResponse>((resolve, reject) =>
            request.signal.addEventListener('abort', () => reject(new Error(url)))
          )
      );
      const stalledBody = jest.fn(async () => ({
        status: 200,
        body: {
          getReader: () => ({
            read: () => new Promise<{ done: boolean }>(() => undefined),
            cancel: async () => undefined,
          }),
        },
      }));

      for (const transport of [stalledRequest, stalledBody]) {
        const outcome = await adapter.call(
          { ...context({ kind: 'music' }), signal: AbortSignal.timeout(20) },
          transport as any
        );
        expect(outcome).toEqual({ ok: false, failure: 'TIMEOUT' });
      }
    });

    it('answers a provider 429 as RATE_LIMITED and does not retry', async () => {
      const { transport } = fakeTransport(() => respond(429, { error: { code: 4 } }));
      expect(await adapter.call(context({ kind: 'music' }), transport)).toEqual({
        ok: false,
        failure: 'RATE_LIMITED',
      });
      expect(transport).toHaveBeenCalledTimes(1);
    });
  });

  describe('linkedin.mention-search.v1', () => {
    it('sends the pinned vanityName request and returns the plain provider mention format', async () => {
      const { transport, calls } = fakeTransport(() =>
        respond(200, {
          elements: [
            { id: 1337, localizedName: 'W&W Agency', logoV2: { 'original~': 'https://x' } },
            { id: 42, localizedName: 'Evil [x](javascript:alert(1))' },
            { id: 'urn:bad id', localizedName: 'dropped' },
            { id: 7, localizedName: '   ' },
          ],
        })
      );

      const outcome = await new LinkedinMentionSearchAdapter().call(context({ query: 'w&w' }), transport);

      expect(calls[0].url).toBe(
        'https://api.linkedin.com/v2/organizations?q=vanityName&vanityName=w%26w&projection=(elements*(id,localizedName))'
      );
      expect(calls[0].request.headers).toEqual({
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        'LinkedIn-Version': '202601',
        Authorization: `Bearer ${PAGE_TOKEN}`,
      });
      expect(outcome).toEqual({
        ok: true,
        items: [
          { kind: 'MENTION', id: '1337', label: 'W&W Agency', mention: '@[W&W Agency](urn:li:organization:1337)' },
          { kind: 'MENTION', id: '42', label: 'Evil [x](javascript:alert(1))', mention: null },
        ],
        dropped: true,
        truncated: false,
      });
    });

    it('maps 401 to RECONNECT_REQUIRED and other errors to PROVIDER_ERROR', async () => {
      for (const [status, failure] of [
        [401, 'RECONNECT_REQUIRED'],
        [403, 'PROVIDER_ERROR'],
        [500, 'PROVIDER_ERROR'],
      ] as const) {
        const { transport } = fakeTransport(() => respond(status, { message: `secret ${PAGE_TOKEN}` }));
        const outcome = await new LinkedinMentionSearchAdapter().call(context({ query: 'acme' }), transport);
        expect(outcome).toEqual({ ok: false, failure });
      }
    });
  });

  describe('tiktok-business helpers', () => {
    it('sends the fixed trending_list request and bounds the list', async () => {
      const list = Array.from({ length: 60 }, (_, index) => ({
        full_duration_song_clip: { song_clip_id: `clip${index}` },
        commercial_music_name: `Song ${index}`,
        artist: 'Artist',
        duration: 30,
        thumbnail_url: 'https://cdn/thumb?sig=FAKE',
        preview_url: 'https://cdn/prev?sig=FAKE',
      }));
      list[0] = { trending_song_clip: { song_clip_id: 'trend0', duration: 15 } } as any;
      list[1] = { commercial_music_name: 'no clip id' } as any;
      const { transport, calls } = fakeTransport(() => respond(200, { code: 0, data: { list } }));

      const outcome = await new TiktokMusicSearchAdapter().call(
        { ...context({ genre: 'POP' }), internalId: '7000000000000000001' },
        transport
      );

      expect(calls[0].url).toBe(
        'https://business-api.tiktok.com/open_api/v1.3/discovery/cml/trending_list/?business_id=7000000000000000001&genre=POP'
      );
      expect(calls[0].request.headers).toEqual({ 'Access-Token': PAGE_TOKEN });
      expect(outcome.ok && outcome.items.length).toBe(49);
      expect(outcome.ok && outcome.items[0]).toEqual({
        kind: 'AUDIO',
        id: 'trend0',
        title: '',
        artist: '',
        durationMs: 15000,
      });
      expect(outcome).toMatchObject({ dropped: true, truncated: true });
      expect(JSON.stringify(outcome)).not.toContain('FAKE');
    });

    it('sends the fixed location request with the query cut at 100', async () => {
      const { transport, calls } = fakeTransport(() =>
        respond(200, {
          code: 0,
          data: { locations: [{ location_id: 'loc1', location_name: 'Amsterdam', location_address: 'NL', extra: 1 }] },
        })
      );
      const outcome = await new TiktokLocationSearchAdapter().call(
        { ...context({ query: 'a'.repeat(120) }), internalId: '7000000000000000001' },
        transport
      );
      expect(calls[0].url).toBe(
        `https://business-api.tiktok.com/open_api/v1.3/business/publish/location/?business_id=7000000000000000001&search_query=${'a'.repeat(100)}`
      );
      expect(outcome).toEqual({
        ok: true,
        items: [{ kind: 'LOCATION', id: 'loc1', name: 'Amsterdam', address: 'NL' }],
        dropped: false,
        truncated: false,
      });
    });

    it.each([
      [{ code: 40105, message: 'access_token_invalid' }, 'RECONNECT_REQUIRED'],
      [{ code: 40100, message: 'Too many requests' }, 'RATE_LIMITED'],
      [{ code: 40002, message: 'bad business_id' }, 'PROVIDER_ERROR'],
      [{ code: 0, data: [] }, 'MALFORMED'],
    ])('reads the HTTP 200 error envelope %j as %s, never as an empty list', async (body, failure) => {
      const { transport } = fakeTransport(() => respond(200, body));
      expect(await new TiktokMusicSearchAdapter().call(context({}), transport)).toEqual({
        ok: false,
        failure,
      });
      expect(transport).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps provider text plain and bounded', () => {
    expect(plainText('a\u0000b​c⁦d\r\ne', 200)).toBe('a b c d e');
    expect(plainText('x'.repeat(500))).toHaveLength(200);
    expect(plainText({ toString: () => 'x' })).toBe('');
  });
});
