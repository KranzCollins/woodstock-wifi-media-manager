import {
  InstagramStandaloneConnectionAdapter,
  MAX_RESPONSE_BYTES,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.instagram';
import { ManagedConnectionProviderError } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.provider';

// FAKE configuration and secrets: no real app, account or network is used
const ENV = {
  INSTAGRAM_APP_ID: '1234567890',
  INSTAGRAM_APP_SECRET: 'FAKE-APP-SECRET-never-logged',
  POSTIZ_MANAGED_INSTAGRAM_REDIRECT_URI:
    'https://connect.ww.example/integrations/social/instagram-standalone',
};
const STATE = 'A'.repeat(43);
const CODE = 'FAKE-CODE';
const SHORT = 'FAKE-SHORT-TOKEN';
const LONG = 'FAKE-LONG-TOKEN';

// a FAKE fetch answer, streamed in one chunk
function answer(status: number, body: unknown) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  let sent = false;
  return {
    status,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) {
            return { done: true, value: undefined };
          }
          sent = true;
          return { done: false, value: new Uint8Array(bytes) };
        },
        cancel: jest.fn(async () => undefined),
      }),
    },
  } as unknown as Response;
}

function fakeFetch(answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) {
      throw new Error('FAKE fetch: no answer left');
    }
    return next;
  });
  return { fetch, calls };
}

const happy = () => [
  answer(200, {
    access_token: SHORT,
    user_id: 17841400000000000,
    permissions: ['instagram_business_basic'],
  }),
  answer(200, { access_token: LONG, token_type: 'bearer', expires_in: 5183944 }),
  answer(200, { user_id: '17841400000000000', username: 'ww.test.acc', name: 'W&W test' }),
];

async function thrown(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a failure');
}

describe('InstagramStandaloneConnectionAdapter (FAKE fetch, no network)', () => {
  let logged: jest.SpyInstance[];

  beforeEach(() => {
    logged = ['log', 'error', 'warn', 'info', 'debug'].map((method) =>
      jest.spyOn(console, method as any).mockImplementation(() => undefined)
    );
  });

  afterEach(() => {
    for (const spy of logged) {
      expect(spy).not.toHaveBeenCalled();
    }
    jest.restoreAllMocks();
  });

  describe('configuration', () => {
    it('is available only fully configured with an exact https redirect URI and reviewed scopes', () => {
      const adapter = (env: Record<string, string | undefined>) =>
        new InstagramStandaloneConnectionAdapter(jest.fn(), env as any);

      expect(adapter(ENV).available()).toBe(true);
      expect(adapter({}).available()).toBe(false);
      expect(adapter({ ...ENV, INSTAGRAM_APP_SECRET: undefined }).available()).toBe(false);
      expect(adapter({ ...ENV, INSTAGRAM_APP_ID: '123&redirect_uri=x' }).available()).toBe(false);

      for (const uri of [
        'http://connect.ww.example/integrations/social/instagram-standalone',
        'https://redirectmeto.com/http://localhost/integrations/social/instagram-standalone',
        'https://connect.ww.example/cb?next=1',
        'https://connect.ww.example/cb#x',
        'https://user:pass@connect.ww.example/cb',
        'https://connect.ww.example',
        'not a url',
      ]) {
        expect([uri, adapter({ ...ENV, POSTIZ_MANAGED_INSTAGRAM_REDIRECT_URI: uri }).available()]).toEqual([uri, false]);
      }

      for (const scopes of [
        'instagram_business_basic,instagram_graph_user_profile',
        'instagram_business_content_publish',
        'instagram_basic',
      ]) {
        expect(
          adapter({ ...ENV, POSTIZ_MANAGED_INSTAGRAM_SCOPES: scopes }).available()
        ).toBe(false);
      }
      expect(
        adapter({
          ...ENV,
          POSTIZ_MANAGED_INSTAGRAM_SCOPES:
            'instagram_business_basic,instagram_business_content_publish',
        }).available()
      ).toBe(true);
    });
  });

  describe('expected profile', () => {
    it('accepts only the username as Instagram reports it, without a call and without normalizing', () => {
      const { fetch } = fakeFetch([]);
      const adapter = new InstagramStandaloneConnectionAdapter(fetch, ENV as any);

      for (const profile of ['ww.test.acc', 'ww_test.acc1', '1234']) {
        expect([profile, adapter.expectedProfileRefusal(profile)]).toEqual([profile, null]);
      }
      for (const profile of ['@ww.test.acc', 'WW.test.acc', 'ww.tEst', 'ww test', 'ww\ttest', ' ww']) {
        const refusal = adapter.expectedProfileRefusal(profile);
        expect([profile, typeof refusal]).toEqual([profile, 'string']);
        expect(refusal).not.toContain(profile.trim());
      }
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('authorization URL', () => {
    it('is upstream\'s authorize URL with our state, the fixed redirect URI and least-privilege scopes, without a call', () => {
      const { fetch } = fakeFetch([]);
      const url = new URL(
        new InstagramStandaloneConnectionAdapter(fetch, ENV as any).authorizationUrl(STATE)
      );

      expect(`${url.origin}${url.pathname}`).toBe('https://www.instagram.com/oauth/authorize');
      expect([...url.searchParams.entries()]).toEqual([
        ['enable_fb_login', '0'],
        ['client_id', ENV.INSTAGRAM_APP_ID],
        ['redirect_uri', ENV.POSTIZ_MANAGED_INSTAGRAM_REDIRECT_URI],
        ['response_type', 'code'],
        ['scope', 'instagram_business_basic'],
        ['state', STATE],
      ]);
      // no PKCE is claimed: upstream sends none
      expect(url.searchParams.has('code_challenge')).toBe(false);
      expect(url.toString()).not.toContain(ENV.INSTAGRAM_APP_SECRET);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses to build a URL unconfigured', async () => {
      const err = await thrown(
        (async () => new InstagramStandaloneConnectionAdapter(jest.fn(), {} as any).authorizationUrl(STATE))()
      );
      expect(err).toBeInstanceOf(ManagedConnectionProviderError);
      expect((err as ManagedConnectionProviderError).kind).toBe('NOT_SENT');
    });
  });

  describe('exchange', () => {
    it('makes upstream\'s three calls to the exact endpoints under one signal and records the provider\'s expires_in', async () => {
      const { fetch, calls } = fakeFetch(happy());
      const signal = new AbortController().signal;

      const grant = await new InstagramStandaloneConnectionAdapter(fetch, ENV as any).exchange(
        CODE,
        signal
      );

      expect(grant).toEqual({
        account: {
          internalId: '17841400000000000',
          profile: 'ww.test.acc',
          displayName: 'W&W test',
        },
        credential: {
          accessToken: LONG,
          refreshToken: LONG,
          expiresInSeconds: 5183944,
        },
        grantedScopes: ['instagram_business_basic'],
      });

      expect(calls.map((call) => [call.init.method, call.url.split('?')[0]])).toEqual([
        ['POST', 'https://api.instagram.com/oauth/access_token'],
        ['GET', 'https://graph.instagram.com/access_token'],
        ['GET', 'https://graph.instagram.com/v25.0/me'],
      ]);
      for (const call of calls) {
        expect(call.init.signal).toBe(signal);
        expect(call.init.redirect).toBe('error');
      }

      const form = calls[0].init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(Object.fromEntries(form.entries())).toEqual({
        client_id: ENV.INSTAGRAM_APP_ID,
        client_secret: ENV.INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: ENV.POSTIZ_MANAGED_INSTAGRAM_REDIRECT_URI,
        code: CODE,
      });
      expect(Object.fromEntries(new URL(calls[1].url).searchParams)).toEqual({
        grant_type: 'ig_exchange_token',
        client_id: ENV.INSTAGRAM_APP_ID,
        client_secret: ENV.INSTAGRAM_APP_SECRET,
        access_token: SHORT,
      });
      expect(Object.fromEntries(new URL(calls[2].url).searchParams)).toEqual({
        fields: 'user_id,username,name',
        access_token: LONG,
      });
    });

    it('records no expiry when the provider gave none, instead of assuming 58 days', async () => {
      const answers = happy();
      answers[1] = answer(200, { access_token: LONG });
      const { fetch } = fakeFetch(answers);

      const grant = await new InstagramStandaloneConnectionAdapter(fetch, ENV as any).exchange(
        CODE,
        new AbortController().signal
      );
      expect(grant.credential.expiresInSeconds).toBeNull();
    });

    it('asks for no long-lived token when the requested scopes were not granted', async () => {
      for (const permissions of [undefined, [], 'instagram_business_content_publish']) {
        const { fetch, calls } = fakeFetch([
          answer(200, { access_token: SHORT, ...(permissions ? { permissions } : {}) }),
        ]);
        const err = await thrown(
          new InstagramStandaloneConnectionAdapter(fetch, ENV as any).exchange(
            CODE,
            new AbortController().signal
          )
        );
        expect((err as ManagedConnectionProviderError).kind).toBe('SCOPES_MISSING');
        expect(calls).toHaveLength(1);
      }

      // upstream's string forms are understood
      const { fetch } = fakeFetch([
        answer(200, {
          access_token: SHORT,
          permissions: 'instagram_business_basic%2Cinstagram_business_content_publish',
        }),
        ...happy().slice(1),
      ]);
      await expect(
        new InstagramStandaloneConnectionAdapter(fetch, ENV as any).exchange(
          CODE,
          new AbortController().signal
        )
      ).resolves.toMatchObject({
        grantedScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
      });
    });

    it('calls a 4xx with an error a refusal, and anything else an unknown outcome', async () => {
      const outcome = async (first: Response, rest: Response[] = []) => {
        const { fetch } = fakeFetch([first, ...rest]);
        return thrown(
          new InstagramStandaloneConnectionAdapter(fetch, ENV as any).exchange(
            CODE,
            new AbortController().signal
          )
        );
      };

      const refused = await outcome(
        answer(400, { error_type: 'OAuthException', code: 400, error_message: 'Invalid code' })
      );
      expect(refused).toBeInstanceOf(ManagedConnectionProviderError);
      expect((refused as ManagedConnectionProviderError).kind).toBe('REFUSED');

      for (const unknown of [
        await outcome(answer(500, { error_message: 'down' })),
        await outcome(answer(400, 'not json')),
        await outcome(answer(200, {})),
        // a short-lived token was issued before these failed
        await outcome(happy()[0], [answer(400, { error: { message: 'x' } })]),
        await outcome(happy()[0], [happy()[1], answer(200, { username: 'no id' })]),
      ]) {
        expect(unknown).not.toBeInstanceOf(ManagedConnectionProviderError);
      }
    });

    it('bounds every answer it reads', async () => {
      const { fetch } = fakeFetch([answer(200, 'x'.repeat(MAX_RESPONSE_BYTES + 1))]);
      const err = await thrown(
        new InstagramStandaloneConnectionAdapter(fetch, ENV as any).exchange(
          CODE,
          new AbortController().signal
        )
      );
      expect(err).not.toBeInstanceOf(ManagedConnectionProviderError);
    });

    it('never passes on what a failed call carried', async () => {
      const fetch = jest.fn(async (url: string) => {
        throw Object.assign(new Error(`request to ${url} failed`), {
          cause: new Error(ENV.INSTAGRAM_APP_SECRET),
        });
      });
      const err = await thrown(
        new InstagramStandaloneConnectionAdapter(fetch, ENV as any).exchange(
          CODE,
          new AbortController().signal
        )
      );

      expect(err.message).toBe('Provider call failed');
      expect((err as any).cause).toBeUndefined();
      expect(JSON.stringify(err)).not.toContain(ENV.INSTAGRAM_APP_SECRET);
      expect(err.message).not.toContain(CODE);
    });

    it('sends nothing unconfigured or already aborted', async () => {
      for (const [env, signal] of [
        [{}, new AbortController().signal],
        [ENV, AbortSignal.abort()],
      ] as const) {
        const { fetch } = fakeFetch(happy());
        const err = await thrown(
          new InstagramStandaloneConnectionAdapter(fetch, env as any).exchange(CODE, signal)
        );
        expect((err as ManagedConnectionProviderError).kind).toBe('NOT_SENT');
        expect(fetch).not.toHaveBeenCalled();
      }
    });
  });
});
