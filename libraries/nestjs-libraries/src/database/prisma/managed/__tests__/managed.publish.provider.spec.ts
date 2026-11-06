// The instagram-standalone publish adapter driving the real upstream
// InstagramStandaloneProvider / InstagramProvider through a real
// ManagedPublishTransport. Only the transport's provider fetch is FAKE: it
// never reaches a network and answers from a script. The access token and
// every capability URL are FAKE and synthetic, and must never appear in an
// outcome, error, hash or continuation
import { inspect } from 'util';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { InstagramStandaloneProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.standalone.provider';
import type { ManagedMediaPin } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-capability';
import {
  InstagramStandalonePublishAdapter,
  ManagedPublishCall,
  ManagedPublishCallError,
  ManagedPublishCredential,
  ManagedPublishMediaInput,
  ManagedPublishOutcome,
  ManagedPublishPrepareError,
  ManagedPublishPrepared,
  ManagedPublishReleaseInput,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.provider';
import {
  ManagedPublishTransport,
  ManagedPublishTransportPorts,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.transport';

const SECRET = 'FAKE-ig-access-token-0123456789abcdef';
const ORIGIN = 'https://media.ww.test';
const IG_USER = '17841400000000001';
const PROFILE = 'ww.test_account';
const C1 = '17900000000000011';
const C2 = '17900000000000012';
const C3 = '17900000000000013';
const CAROUSEL = '17900000000000020';
const M1 = '17950000000000031';
const M2 = '17950000000000032';
const COMMENT_ID = '17960000000000041';
const PERMALINK = 'https://www.instagram.com/p/DFakePost01/';
// the decoded publication text, sent byte for byte: literal entities, NBSP,
// emoji (with a ZWJ sequence) and URL-significant characters
const TEXT =
  'Café &amp; &lt;b&gt; \u{1F600} \u{1F469}‍\u{1F4BB} #ww @friend +1 100% a&b=c?d';
const COMMENT_TEXT = 'First! &quot;quoted&quot; \u{1F44D}';
const V = META_GRAPH_API_VERSION;
const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'video/mp4': '.mp4',
};

const path = (...parts: string[]) => `/${V}/${parts.join('/')}`;
const params = (url: URL) => Object.fromEntries(url.searchParams.entries());

// ---- FAKE provider over the real transport ------------------------------------

type Reply = { status?: number; body: unknown } | Error;
const ok = (body: unknown): Reply => ({ body });
const answer = (status: number, body: unknown): Reply => ({ status, body });
const status = (status_code: string): Reply =>
  ok({ status_code, status: status_code });
const graphError = (status: number, code: number, subcode: number, message: string) =>
  answer(status, { error: { message, type: 'OAuthException', code, error_subcode: subcode } });

class FakeHttp {
  readonly requests: { method: string; url: URL; init: RequestInit }[] = [];
  private readonly replies: Reply[];

  constructor(...replies: Reply[]) {
    this.replies = replies;
  }

  readonly fetch = (async (input: unknown, init: RequestInit = {}) => {
    this.requests.push({ method: init.method ?? 'GET', url: new URL(String(input)), init });
    const reply = this.replies.shift();
    if (!reply) {
      throw new Error('FakeHttp: no reply scripted');
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof globalThis.fetch;

  routes() {
    return this.requests.map(({ method, url }) => `${method} ${url.pathname}`);
  }

  unused() {
    return this.replies.length;
  }
}

// What the dispatcher hands an adapter: the transport's frozen adapterFetch
// and its ledger reader, never the transport or its ports
function step(http: FakeHttp, reservedUnits: number, ports: Partial<ManagedPublishTransportPorts> = {}) {
  const transport = new ManagedPublishTransport({
    reservedUnits,
    deadlineAt: new Date(Date.now() + 60_000),
    now: () => new Date(),
    verifyAdmission: async () => true,
    recordAttempt: async () => true,
    fetch: http.fetch,
    ...ports,
  });
  const call: ManagedPublishCall = Object.freeze({
    credential: new ManagedPublishCredential(SECRET),
    fetch: transport.adapterFetch(),
    ledger: () => transport.ledger(),
  });
  return { transport, call };
}

async function run(
  units: number,
  replies: Reply[],
  go: (call: ManagedPublishCall) => Promise<ManagedPublishOutcome>,
  ports: Partial<ManagedPublishTransportPorts> = {}
) {
  const http = new FakeHttp(...replies);
  const { transport, call } = step(http, units, ports);
  const outcome = await go(call);
  expectClean(outcome);
  return { http, transport, outcome };
}

// synthetic capability URLs on the configured origin, minted in order
function capabilities() {
  const minted: ManagedMediaPin[] = [];
  return {
    minted,
    url: async (pin: ManagedMediaPin) => {
      minted.push(pin);
      return `${ORIGIN}/cap/k${minted.length}-${pin.mediaId}${EXT[pin.mimeType]}`;
    },
  };
}
const capability = (n: number, mediaId: string, mimeType: string) =>
  `${ORIGIN}/cap/k${n}-${mediaId}${EXT[mimeType]}`;

// ---- releases -----------------------------------------------------------------

const pin = (n: number, mimeType = 'image/jpeg'): ManagedMediaPin => ({
  mediaId: `media-${n}`,
  evidenceId: `evidence-${n}`,
  sha256: n.toString(16).padStart(64, '0'),
  byteLength: 1000 + n,
  mimeType,
});

const media = (
  n: number,
  mimeType = 'image/jpeg',
  options: Partial<Omit<ManagedPublishMediaInput, 'pin'>> = {}
): ManagedPublishMediaInput => ({
  pin: pin(n, mimeType),
  alt: null,
  thumbnail: null,
  thumbnailTimestampMs: null,
  ...options,
});

const release = (
  root: ManagedPublishMediaInput[],
  options: { text?: string; settings?: Record<string, unknown>; comments?: string[] } = {}
): ManagedPublishReleaseInput => ({
  internalId: IG_USER,
  profile: PROFILE,
  settings: options.settings ?? { post_type: 'post' },
  members: [
    { postId: 'post-root', text: options.text ?? TEXT, media: root },
    ...(options.comments ?? []).map((text, index) => ({
      postId: `post-comment-${index + 1}`,
      text,
      media: [],
    })),
  ],
});

const adapter = () => new InstagramStandalonePublishAdapter({ mediaOrigin: ORIGIN });

// ---- checks -------------------------------------------------------------------

function expectClean(...values: unknown[]) {
  for (const value of values) {
    const text = [
      inspect(value, { depth: 10, showHidden: true }),
      JSON.stringify(value) ?? '',
      value instanceof Error ? `${value.message} ${value.stack}` : '',
    ].join(' ');
    for (const secret of [SECRET, 'media.ww.test', '/cap/']) {
      expect(text).not.toContain(secret);
    }
  }
}

function sealedOf(outcome: ManagedPublishOutcome): string {
  if (outcome.status !== 'pending' && outcome.status !== 'ready') {
    throw new Error(`expected a continuation, got ${JSON.stringify(outcome)}`);
  }
  const sealed = outcome.continuation.sealed();
  expectClean(sealed);
  return sealed;
}

function prepareRefusal(input: unknown) {
  try {
    adapter().prepare(input as ManagedPublishReleaseInput);
  } catch (err) {
    expect(err).toBeInstanceOf(ManagedPublishPrepareError);
    expectClean(err);
    return (err as ManagedPublishPrepareError).reason;
  }
  throw new Error('prepare did not refuse');
}

async function callRefusal(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (err) {
    expect(err).toBeInstanceOf(ManagedPublishCallError);
    expectClean(err);
    return (err as ManagedPublishCallError).code;
  }
  throw new Error('the call was not refused');
}

const reforge = (sealed: string, change: (pendingData: any) => void) => {
  const parsed = JSON.parse(sealed);
  change(parsed.pendingData);
  return JSON.stringify(parsed);
};

// Walk a single-container release (picture or reel) to its ready continuation
async function readyAfterPost(
  instagram: InstagramStandalonePublishAdapter,
  prepared: ManagedPublishPrepared
) {
  const post = await run(1, [ok({ id: C1 })], (call) =>
    instagram.postPending(prepared, { ...call, media: capabilities() })
  );
  const sealed = sealedOf(post.outcome);
  const poll = await run(1, [status('FINISHED')], (call) => instagram.poll(prepared, sealed, call));
  expect(poll.outcome.status).toBe('ready');
  return sealedOf(poll.outcome);
}

// ---- the tests ----------------------------------------------------------------

describe('InstagramStandalonePublishAdapter', () => {
  const protoFetch = InstagramProvider.prototype.fetch;
  const protoProbe = (InstagramProvider.prototype as any).igPublishedMediaId;
  const globalFetch = globalThis.fetch;

  afterEach(() => {
    // no step reaches past its own delegate instance
    expect(InstagramProvider.prototype.fetch).toBe(protoFetch);
    expect((InstagramProvider.prototype as any).igPublishedMediaId).toBe(protoProbe);
    expect(globalThis.fetch).toBe(globalFetch);
    jest.restoreAllMocks();
  });

  describe('prepare', () => {
    it('binds a release to frozen facts and an input hash', () => {
      const instagram = adapter();
      const prepared = instagram.prepare(release([media(1)]));
      expect(prepared).toBeInstanceOf(ManagedPublishPrepared);
      expect(Object.isFrozen(prepared)).toBe(true);
      expect(prepared).toMatchObject({
        identifier: 'instagram-standalone',
        members: 1,
        media: 1,
        units: { POST: 1, POLL: 1, FINALIZE: 2, COMMENT: 2 },
        finalizeSteps: 1,
      });
      expect(prepared.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(instagram.prepare(release([media(1)])).requestHash).toBe(prepared.requestHash);
      // an NBSP is not a space
      expect(
        instagram.prepare(release([media(1)], { text: TEXT.replace(' ', ' ') })).requestHash
      ).not.toBe(prepared.requestHash);
      expectClean(prepared);
      expect(Object.isFrozen(instagram.steps)).toBe(true);
    });

    it('refuses what upstream would drop or never send', () => {
      expect(prepareRefusal(release([]))).toBe('MEDIA_REQUIRED');
      expect(
        prepareRefusal(release([media(1)], { settings: { post_type: 'post', audio: { id: '1' } } }))
      ).toBe('AUDIO_NOT_SUPPORTED');
      expect(prepareRefusal(release([media(1, 'image/gif')]))).toBe('MEDIA_TYPE_NOT_SUPPORTED');
      expect(prepareRefusal(release([media(1)], { text: 'a'.repeat(2201) }))).toBe('TEXT_TOO_LONG');
      expect(prepareRefusal(release([media(1)], { text: 'bad \uD800 surrogate' }))).toBe(
        'TEXT_INVALID'
      );
      expect(
        prepareRefusal(release([media(1)], { settings: { post_type: 'story' } }))
      ).toBe('TEXT_NOT_SUPPORTED');
      expect(
        prepareRefusal(release([media(1)], { text: '', settings: { post_type: 'story' }, comments: ['x'] }))
      ).toBe('COMMENTS_NOT_SUPPORTED');
      expect(prepareRefusal(release([media(1)], { comments: [''] }))).toBe('TEXT_REQUIRED');
      expect(
        prepareRefusal(release([media(1, 'image/jpeg', { thumbnail: pin(2, 'image/png') })]))
      ).toBe('COVER_NOT_SUPPORTED');
      expect(
        prepareRefusal(release([media(1)], { settings: { post_type: 'post', is_trial_reel: true } }))
      ).toBe('TRIAL_REEL_NOT_SUPPORTED');
      expect(prepareRefusal({ ...release([media(1)]), extra: true })).toBe('RELEASE_INVALID');
    });
  });

  it('publishes a picture: container, poll pending then ready, publish, permalink', async () => {
    const instagram = adapter();
    const prepared = instagram.prepare(release([media(1, 'image/jpeg', { alt: 'A cat & a dog' })]));
    const urls = capabilities();

    const post = await run(instagram.stepUnits(prepared, 'POST'), [ok({ id: C1 })], (call) =>
      instagram.postPending(prepared, { ...call, media: urls })
    );
    expect(post.outcome.status).toBe('pending');
    expect(urls.minted).toEqual([pin(1)]);
    expect(post.http.routes()).toEqual([`POST ${path(IG_USER, 'media')}`]);
    expect(params(post.http.requests[0].url)).toEqual({
      image_url: capability(1, 'media-1', 'image/jpeg'),
      alt_text: 'A cat & a dog',
      access_token: SECRET,
      caption: TEXT,
    });
    // the transport, not upstream, chose how the provider fetch is called
    expect(post.http.requests[0].init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    expect(post.transport.ledger()).toEqual({
      attemptedRequests: 1,
      attemptedMutations: 1,
      completedRequests: 1,
      mutationMayHaveLeft: true,
      failure: null,
    });

    let sealed = sealedOf(post.outcome);
    expect(instagram.stepUnits(prepared, 'POLL', sealed)).toBe(1);
    const processing = await run(1, [status('IN_PROGRESS')], (call) =>
      instagram.poll(prepared, sealed, call)
    );
    expect(processing.outcome.status).toBe('pending');
    expect(processing.http.routes()).toEqual([`GET ${path(C1)}`]);
    expect(params(processing.http.requests[0].url)).toEqual({
      access_token: SECRET,
      fields: 'status_code,status',
    });
    expect(processing.transport.ledger().mutationMayHaveLeft).toBe(false);
    expect(sealedOf(processing.outcome)).toBe(sealed);

    const ready = await run(1, [status('FINISHED')], (call) => instagram.poll(prepared, sealed, call));
    expect(ready.outcome.status).toBe('ready');
    sealed = sealedOf(ready.outcome);

    expect(instagram.stepUnits(prepared, 'FINALIZE', sealed)).toBe(2);
    const done = await run(2, [ok({ id: M1 }), ok({ permalink: PERMALINK, id: M1 })], (call) =>
      instagram.finalize(prepared, sealed, call)
    );
    expect(done.outcome).toEqual({ status: 'success', releaseId: M1, releaseURL: PERMALINK });
    expect(done.http.routes()).toEqual([
      `POST ${path(IG_USER, 'media_publish')}`,
      `GET ${path(M1)}`,
    ]);
    expect(params(done.http.requests[0].url)).toEqual({
      creation_id: C1,
      access_token: SECRET,
      field: 'id',
    });
    expect(params(done.http.requests[1].url)).toEqual({ fields: 'permalink', access_token: SECRET });
  });

  it('publishes a carousel with collaborators in two finalize steps', async () => {
    const instagram = adapter();
    const prepared = instagram.prepare(
      release([media(1), media(2, 'image/png'), media(3, 'video/mp4')], {
        settings: { post_type: 'post', collaborators: [{ label: '@friend.one' }] },
      })
    );
    expect(prepared.units).toEqual({ POST: 3, POLL: 3, FINALIZE: 2, COMMENT: 2 });
    expect(prepared.finalizeSteps).toBe(2);

    const post = await run(3, [ok({ id: C1 }), ok({ id: C2 }), ok({ id: C3 })], (call) =>
      instagram.postPending(prepared, { ...call, media: capabilities() })
    );
    expect(post.http.requests.map(({ url }) => params(url))).toEqual([
      { image_url: capability(1, 'media-1', 'image/jpeg'), is_carousel_item: 'true', access_token: SECRET },
      { image_url: capability(2, 'media-2', 'image/png'), is_carousel_item: 'true', access_token: SECRET },
      {
        video_url: capability(3, 'media-3', 'video/mp4'),
        media_type: 'VIDEO',
        thumb_offset: '0',
        is_carousel_item: 'true',
        access_token: SECRET,
      },
    ]);
    let sealed = sealedOf(post.outcome);

    const poll = await run(3, [status('FINISHED'), status('FINISHED'), status('FINISHED')], (call) =>
      instagram.poll(prepared, sealed, call)
    );
    expect(poll.http.routes()).toEqual([C1, C2, C3].map((id) => `GET ${path(id)}`));
    sealed = sealedOf(poll.outcome);

    expect(instagram.stepUnits(prepared, 'FINALIZE', sealed)).toBe(1);
    const container = await run(1, [ok({ id: CAROUSEL })], (call) =>
      instagram.finalize(prepared, sealed, call)
    );
    expect(container.outcome.status).toBe('pending');
    expect(params(container.http.requests[0].url)).toEqual({
      caption: TEXT,
      media_type: 'CAROUSEL',
      children: `${C1},${C2},${C3}`,
      collaborators: '["friend.one"]',
      access_token: SECRET,
    });
    sealed = sealedOf(container.outcome);

    expect(instagram.stepUnits(prepared, 'POLL', sealed)).toBe(1);
    const carouselReady = await run(1, [status('FINISHED')], (call) =>
      instagram.poll(prepared, sealed, call)
    );
    expect(carouselReady.http.routes()).toEqual([`GET ${path(CAROUSEL)}`]);
    sealed = sealedOf(carouselReady.outcome);

    expect(instagram.stepUnits(prepared, 'FINALIZE', sealed)).toBe(2);
    const done = await run(2, [ok({ id: M1 }), ok({ permalink: PERMALINK })], (call) =>
      instagram.finalize(prepared, sealed, call)
    );
    expect(params(done.http.requests[0].url)).toMatchObject({ creation_id: CAROUSEL });
    expect(done.outcome).toEqual({ status: 'success', releaseId: M1, releaseURL: PERMALINK });
  });

  it('sends a reel with its cover and collaborators', async () => {
    const instagram = adapter();
    const prepared = instagram.prepare(
      release([media(1, 'video/mp4', { thumbnail: pin(2, 'image/png') })], {
        settings: { post_type: 'post', collaborators: [{ label: 'friend.one' }] },
      })
    );
    const urls = capabilities();
    const post = await run(1, [ok({ id: C1 })], (call) =>
      instagram.postPending(prepared, { ...call, media: urls })
    );
    expect(urls.minted).toEqual([pin(1, 'video/mp4'), pin(2, 'image/png')]);
    expect(params(post.http.requests[0].url)).toEqual({
      video_url: capability(1, 'media-1', 'video/mp4'),
      media_type: 'REELS',
      cover_url: capability(2, 'media-2', 'image/png'),
      collaborators: '["friend.one"]',
      access_token: SECRET,
      caption: TEXT,
    });
    expect(post.outcome.status).toBe('pending');
  });

  it('sends a trial reel with its thumbnail offset', async () => {
    const instagram = adapter();
    const prepared = instagram.prepare(
      release([media(1, 'video/mp4', { thumbnailTimestampMs: 1500 })], {
        settings: { post_type: 'post', is_trial_reel: true, graduation_strategy: 'SS_PERFORMANCE' },
      })
    );
    const post = await run(1, [ok({ id: C1 })], (call) =>
      instagram.postPending(prepared, { ...call, media: capabilities() })
    );
    expect(params(post.http.requests[0].url)).toEqual({
      video_url: capability(1, 'media-1', 'video/mp4'),
      media_type: 'REELS',
      thumb_offset: '1500',
      trial_params: '{"graduation_strategy":"SS_PERFORMANCE"}',
      access_token: SECRET,
      caption: TEXT,
    });
  });

  it('publishes stories one by one and answers the last story', async () => {
    const instagram = adapter();
    const prepared = instagram.prepare(
      release([media(1), media(2, 'video/mp4')], { text: '', settings: { post_type: 'story' } })
    );
    expect(prepared.units.FINALIZE).toBe(5);
    const post = await run(2, [ok({ id: C1 }), ok({ id: C2 })], (call) =>
      instagram.postPending(prepared, { ...call, media: capabilities() })
    );
    expect(post.http.requests.map(({ url }) => params(url))).toEqual([
      { image_url: capability(1, 'media-1', 'image/jpeg'), media_type: 'STORIES', access_token: SECRET },
      { video_url: capability(2, 'media-2', 'video/mp4'), media_type: 'STORIES', access_token: SECRET },
    ]);
    const poll = await run(2, [status('FINISHED'), status('FINISHED')], (call) =>
      instagram.poll(prepared, sealedOf(post.outcome), call)
    );
    const sealed = sealedOf(poll.outcome);

    expect(instagram.stepUnits(prepared, 'FINALIZE', sealed)).toBe(5);
    const done = await run(
      5,
      [status('FINISHED'), ok({ id: M1 }), status('FINISHED'), ok({ id: M2 }), ok({ permalink: PERMALINK })],
      (call) => instagram.finalize(prepared, sealed, call)
    );
    expect(done.http.routes()).toEqual([
      `GET ${path(C1)}`,
      `POST ${path(IG_USER, 'media_publish')}`,
      `GET ${path(C2)}`,
      `POST ${path(IG_USER, 'media_publish')}`,
      `GET ${path(M2)}`,
    ]);
    expect(done.outcome).toEqual({ status: 'success', releaseId: M2, releaseURL: PERMALINK });
  });

  it('comments with the exact text under the published post', async () => {
    const instagram = adapter();
    const prepared = instagram.prepare(release([media(1)], { comments: [COMMENT_TEXT] }));
    expect(instagram.stepUnits(prepared, 'COMMENT')).toBe(2);

    const done = await run(2, [ok({ id: COMMENT_ID }), ok({ permalink: PERMALINK })], (call) =>
      instagram.comment(prepared, 1, M1, call)
    );
    expect(done.http.routes()).toEqual([`POST ${path(M1, 'comments')}`, `GET ${path(M1)}`]);
    expect(params(done.http.requests[0].url)).toEqual({ message: COMMENT_TEXT, access_token: SECRET });
    expect(done.outcome).toEqual({ status: 'success', releaseId: COMMENT_ID, releaseURL: PERMALINK });

    // the comment exists; only the parent's permalink read failed
    const noPermalink = await run(2, [ok({ id: COMMENT_ID }), answer(500, {})], (call) =>
      instagram.comment(prepared, 1, M1, call)
    );
    expect(noPermalink.outcome).toEqual({ status: 'success', releaseId: COMMENT_ID, releaseURL: null });

    const refused = await run(
      2,
      [graphError(400, 100, 1772107, 'comment refused'), ok({ permalink: PERMALINK })],
      (call) => instagram.comment(prepared, 1, M1, call)
    );
    expect(refused.outcome).toEqual({ status: 'rejected', code: 'PROVIDER_REJECTED' });
    expect(refused.http.requests).toHaveLength(1);

    expect(
      await callRefusal(() => instagram.comment(prepared, 0, M1, step(new FakeHttp(), 2).call))
    ).toBe('MEMBER_INVALID');
  });

  describe('outcomes', () => {
    it('refuses a call before any request', async () => {
      const instagram = adapter();
      const prepared = instagram.prepare(release([media(1)]));
      const http = new FakeHttp(ok({ id: C1 }));
      const { call } = step(http, 1);
      const urls = capabilities();

      expect(
        await callRefusal(() =>
          instagram.postPending(prepared, { ...call, fetch: jest.fn() as any, media: urls })
        )
      ).toBe('TRANSPORT_INVALID');
      expect(
        await callRefusal(() =>
          instagram.postPending(prepared, { ...call, fetch: globalThis.fetch, media: urls })
        )
      ).toBe('TRANSPORT_INVALID');
      expect(
        await callRefusal(() =>
          instagram.postPending(prepared, {
            ...call,
            ledger: () => {
              throw new Error('gone');
            },
            media: urls,
          })
        )
      ).toBe('TRANSPORT_INVALID');
      expect(
        await callRefusal(() =>
          instagram.postPending(prepared, {
            ...call,
            ledger: () => ({ ...call.ledger(), attemptedRequests: 1 }),
            media: urls,
          })
        )
      ).toBe('TRANSPORT_USED');
      expect(
        await callRefusal(() =>
          instagram.postPending(prepared, {
            ...call,
            credential: new ManagedPublishCredential('short'),
            media: urls,
          })
        )
      ).toBe('CREDENTIAL_INVALID');
      expect(
        await callRefusal(() =>
          instagram.postPending(
            new ManagedPublishPrepared('instagram-standalone', prepared.requestHash, 1, 1, prepared.units, 1),
            { ...call, media: urls }
          )
        )
      ).toBe('PREPARED_UNKNOWN');
      expect(urls.minted).toHaveLength(0);
      expect(http.requests).toHaveLength(0);
      expect(call.ledger().attemptedRequests).toBe(0);
    });

    it('never sends when media delivery is not qualified', async () => {
      const prepared = adapter().prepare(release([media(1)]));
      const changed = await run(1, [], (call) =>
        adapter().postPending(prepared, {
          ...call,
          media: { url: async () => Promise.reject(Object.assign(new Error('x'), { code: 'MEDIA_CHANGED' })) },
        })
      );
      expect(changed.outcome).toEqual({ status: 'not_sent', code: 'MEDIA_CHANGED' });

      const foreign = await run(1, [], (call) =>
        adapter().postPending(prepared, {
          ...call,
          media: { url: async () => 'https://elsewhere.test/cap/k1-media-1.jpg' },
        })
      );
      expect(foreign.outcome).toEqual({ status: 'not_sent', code: 'MEDIA_DELIVERY_NOT_QUALIFIED' });

      const noOrigin = new InstagramStandalonePublishAdapter({ mediaOrigin: null });
      const unqualified = await run(1, [], (call) =>
        noOrigin.postPending(noOrigin.prepare(release([media(1)])), { ...call, media: capabilities() })
      );
      expect(unqualified.outcome).toEqual({ status: 'not_sent', code: 'MEDIA_DELIVERY_NOT_QUALIFIED' });
      for (const { http } of [changed, foreign, unqualified]) {
        expect(http.requests).toHaveLength(0);
      }
    });

    it('is NOT_SENT only when the ledger shows nothing left', async () => {
      const instagram = adapter();
      const prepared = instagram.prepare(release([media(1)]));
      const post = (ports: Partial<ManagedPublishTransportPorts>, ...replies: Reply[]) =>
        run(1, replies, (call) => instagram.postPending(prepared, { ...call, media: capabilities() }), ports);

      const lostFirst = await post({ verifyAdmission: async () => false }, ok({ id: C1 }));
      expect(lostFirst.outcome).toEqual({ status: 'not_sent', code: 'REQUEST_NOT_SENT' });
      expect(lostFirst.http.requests).toHaveLength(0);

      const network = await post({}, new Error('socket hang up'));
      expect(network.outcome).toEqual({ status: 'unknown', code: 'OUTCOME_UNKNOWN' });
      expect(network.transport.ledger()).toMatchObject({ mutationMayHaveLeft: true, failure: 'TRANSPORT_FAILED' });

      const serverError = await post({}, answer(500, { error: { message: 'boom', code: 2 } }));
      expect(serverError.outcome).toEqual({ status: 'unknown', code: 'OUTCOME_UNKNOWN' });

      const throttled = await post({}, graphError(429, 4, 0, 'rate'));
      expect(throttled.outcome).toEqual({ status: 'unknown', code: 'OUTCOME_UNKNOWN' });

      const proven = await post({}, graphError(400, 100, 2207001, 'spam'));
      expect(proven.outcome).toEqual({ status: 'rejected', code: 'PROVIDER_REJECTED' });

      const revoked = await post({}, graphError(400, 190, 460, 'REVOKED_ACCESS_TOKEN'));
      expect(revoked.outcome).toEqual({ status: 'rejected', code: 'CHANNEL_REFRESH_NEEDED' });
    });

    it('stops a step at the deadline without sending', async () => {
      const instagram = adapter();
      const prepared = instagram.prepare(release([media(1)]));
      const start = Date.now();
      let clock = start;
      const http = new FakeHttp(ok({ id: C1 }));
      const { call } = step(http, 1, { now: () => new Date(clock), deadlineAt: new Date(start + 1_000) });
      clock = start + 2_000;
      const outcome = await instagram.postPending(prepared, { ...call, media: capabilities() });
      expect(outcome).toEqual({ status: 'not_sent', code: 'REQUEST_NOT_SENT' });
      expect(http.requests).toHaveLength(0);
    });

    it('never sends more than the units reserved for the step', async () => {
      const instagram = adapter();
      const prepared = instagram.prepare(release([media(1), media(2), media(3)]));
      expect(instagram.stepUnits(prepared, 'POST')).toBe(3);
      const short = await run(2, [ok({ id: C1 }), ok({ id: C2 }), ok({ id: C3 })], (call) =>
        instagram.postPending(prepared, { ...call, media: capabilities() })
      );
      expect(short.http.requests).toHaveLength(2);
      expect(short.outcome).toEqual({ status: 'unknown', code: 'STEP_BUDGET_EXCEEDED' });
      expect(short.transport.ledger()).toMatchObject({ attemptedRequests: 2, failure: 'RESERVATION_EXHAUSTED' });
    });

    it('judges a partial multi-request step by what became visible', async () => {
      const instagram = adapter();
      const carousel = instagram.prepare(release([media(1), media(2), media(3)]));

      // containers are invisible: a proven refusal of the second is a refusal
      const refused = await run(3, [ok({ id: C1 }), graphError(400, 100, 2207009, 'ratio'), ok({ id: C3 })], (call) =>
        instagram.postPending(carousel, { ...call, media: capabilities() })
      );
      expect(refused.http.requests).toHaveLength(2);
      expect(refused.outcome).toEqual({ status: 'rejected', code: 'PROVIDER_REJECTED' });

      // an unexplained failure after a container left is uncertain
      const failed = await run(3, [ok({ id: C1 }), answer(503, {}), ok({ id: C3 })], (call) =>
        instagram.postPending(carousel, { ...call, media: capabilities() })
      );
      expect(failed.http.requests).toHaveLength(2);
      expect(failed.outcome).toEqual({ status: 'unknown', code: 'OUTCOME_UNKNOWN' });

      // the lease is lost after the first container left
      let verified = 0;
      const lost = await run(
        3,
        [ok({ id: C1 }), ok({ id: C2 }), ok({ id: C3 })],
        (call) => instagram.postPending(carousel, { ...call, media: capabilities() }),
        { verifyAdmission: async () => ++verified <= 2 }
      );
      expect(lost.http.requests).toHaveLength(1);
      expect(lost.outcome).toEqual({ status: 'unknown', code: 'LEASE_LOST' });

      // the first story is live when the second is refused
      const stories = instagram.prepare(
        release([media(1), media(2)], { text: '', settings: { post_type: 'story' } })
      );
      const post = await run(2, [ok({ id: C1 }), ok({ id: C2 })], (call) =>
        instagram.postPending(stories, { ...call, media: capabilities() })
      );
      const ready = await run(2, [status('FINISHED'), status('FINISHED')], (call) =>
        instagram.poll(stories, sealedOf(post.outcome), call)
      );
      const half = await run(
        5,
        [status('FINISHED'), ok({ id: M1 }), status('FINISHED'), graphError(400, 100, 2207001, 'spam')],
        (call) => instagram.finalize(stories, sealedOf(ready.outcome), call)
      );
      expect(half.http.requests).toHaveLength(4);
      expect(half.outcome).toEqual({ status: 'unknown', code: 'OUTCOME_UNKNOWN' });
    });

    it('never takes the newest media or a container id for the publication', async () => {
      const instagram = adapter();
      const prepared = instagram.prepare(release([media(1)]));
      const sealed = await readyAfterPost(instagram, prepared);

      // "blocked" may still have published: no status or newest-media probe
      // runs, and the answer is UNKNOWN
      const blocked = await run(
        2,
        [graphError(400, 9, 2207051, 'Action is blocked'), status('PUBLISHED'), ok({ data: [{ id: M2 }] })],
        (call) => instagram.finalize(prepared, sealed, call)
      );
      expect(blocked.http.routes()).toEqual([`POST ${path(IG_USER, 'media_publish')}`]);
      expect(blocked.outcome).toEqual({ status: 'unknown', code: 'OUTCOME_UNKNOWN' });

      // upstream reports a PUBLISHED container as completed with the
      // container's id: not proof of this publication
      const published = await run(1, [status('PUBLISHED')], (call) =>
        instagram.poll(prepared, sealed, call)
      );
      expect(published.outcome).toEqual({ status: 'unknown', code: 'OUTCOME_UNKNOWN' });

      // a story a previous run published is skipped by upstream: this step
      // published fewer stories than the release has
      const stories = instagram.prepare(
        release([media(1), media(2)], { text: '', settings: { post_type: 'story' } })
      );
      const post = await run(2, [ok({ id: C1 }), ok({ id: C2 })], (call) =>
        instagram.postPending(stories, { ...call, media: capabilities() })
      );
      const resumed = await run(
        5,
        [status('PUBLISHED'), status('FINISHED'), ok({ id: M2 }), ok({ permalink: PERMALINK })],
        (call) => instagram.finalize(stories, sealedOf(post.outcome), call)
      );
      expect(resumed.outcome).toEqual({ status: 'unknown', code: 'OUTCOME_UNKNOWN' });
    });

    it('rejects an injected or foreign continuation and answer before IO', async () => {
      const instagram = adapter();
      const prepared = instagram.prepare(release([media(1)]));
      const post = await run(1, [ok({ id: C1 })], (call) =>
        instagram.postPending(prepared, { ...call, media: capabilities() })
      );
      const sealed = sealedOf(post.outcome);
      const other = instagram.prepare(release([media(1)], { text: 'another text' }));

      const forged = [
        reforge(sealed, (data) => (data.type = 'graph.facebook.com')),
        reforge(sealed, (data) => (data.carouselId = C2)),
        reforge(sealed, (data) => (data.containers = [`${C1}/comments`])),
        reforge(sealed, (data) => (data.access_token = SECRET)),
        reforge(sealed, (data) => (data.message = 'injected')),
        sealed.replace('{', '{ '),
      ];
      for (const continuation of forged) {
        const http = new FakeHttp(status('FINISHED'), ok({ id: M1 }));
        const { call } = step(http, 2);
        expect(await callRefusal(() => instagram.poll(prepared, continuation, call))).toBe(
          'CONTINUATION_INVALID'
        );
        expect(await callRefusal(() => instagram.finalize(prepared, continuation, call))).toBe(
          'CONTINUATION_INVALID'
        );
        expect(http.requests).toHaveLength(0);
      }
      expect(() => instagram.stepUnits(other, 'POLL', sealed)).toThrow(ManagedPublishCallError);
      const foreign = step(new FakeHttp(status('FINISHED')), 1);
      expect(await callRefusal(() => instagram.poll(other, sealed, foreign.call))).toBe(
        'CONTINUATION_INVALID'
      );

      // a container id that is not a Graph node never becomes a continuation
      const injected = await run(1, [ok({ id: 'graph.facebook.com' })], (call) =>
        instagram.postPending(prepared, { ...call, media: capabilities() })
      );
      expect(injected.outcome).toEqual({ status: 'unknown', code: 'OUTCOME_UNKNOWN' });
    });
  });

  describe('InstagramStandaloneProvider optional delegate', () => {
    it('keeps its own delegate and graph.instagram.com by default', async () => {
      const provider = new InstagramStandaloneProvider();
      const delegate = (provider as any).instagramProvider;
      expect(delegate).toBeInstanceOf(InstagramProvider);
      expect(Object.prototype.hasOwnProperty.call(delegate, 'fetch')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(delegate, 'igPublishedMediaId')).toBe(false);
      expect(new InstagramStandaloneProvider()).not.toBe(provider);
      expect((new InstagramStandaloneProvider() as any).instagramProvider).not.toBe(delegate);

      const postPending = jest
        .spyOn(InstagramProvider.prototype, 'postPending')
        .mockResolvedValue([]);
      const integration = { internalId: IG_USER, profile: PROFILE } as any;
      await provider.postPending(IG_USER, SECRET, [], integration);
      expect(postPending).toHaveBeenCalledWith(IG_USER, SECRET, [], integration, 'graph.instagram.com');
      expect(postPending.mock.instances[0]).toBe(delegate);
    });
  });
});
