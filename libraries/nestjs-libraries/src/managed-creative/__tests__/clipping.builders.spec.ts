// T2: the clipping jobs and the reading of their answers are pure functions
// that ClippingService calls. The submitted jobs are compared, as JSON, with
// the jobs the service sent before the extraction (written out by hand), and
// the managed refusals still stop every paid step. Storage, repository,
// ingest, clipper and billing are FAKES; nothing reaches RunPod or YouTube.
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }), { virtual: true });
jest.mock(
  '@temporalio/common',
  () => ({
    TypedSearchAttributes: class {},
    ApplicationFailure: class extends Error {
      constructor(message: string, public type?: string, public nonRetryable?: boolean) {
        super(message);
      }
    },
  }),
  { virtual: true }
);
jest.mock('@gitroom/nestjs-libraries/database/prisma/clipping/clipping.repository', () => ({
  ClippingRepository: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service', () => ({
  SubscriptionService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/organizations/organization.service', () => ({
  OrganizationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/integrations/integration.service', () => ({
  IntegrationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/posts/posts.service', () => ({
  PostsService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/media/media.service', () => ({
  MediaService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/openai/openai.service', () => ({ OpenaiService: class {} }));
jest.mock('@gitroom/nestjs-libraries/deepgram/deepgram.service', () => ({
  DeepgramService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: {
    createStorage: () => ({}),
    createIngestProcessor: (): null => null,
    createClipProcessor: (): null => null,
  },
}));
jest.mock('@gitroom/nestjs-libraries/integrations/social.abstract', () => ({
  truncateForTemporal: (message: string) => message,
}));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({ ioRedis: {} }));
jest.mock('@gitroom/nestjs-libraries/temporal/temporal.search.attribute', () => ({
  organizationId: {},
}));
jest.mock('@gitroom/nestjs-libraries/services/make.is', () => ({ makeId: () => 'FAKE-id' }));
jest.mock('@gitroom/helpers/utils/timer', () => ({ timer: async () => undefined }));
jest.mock('@gitroom/backend/services/auth/permissions/permission.exception.class', () => ({
  AuthorizationActions: {},
  Sections: {},
  SubscriptionException: class extends Error {},
}));

import { ClippingService } from '@gitroom/nestjs-libraries/database/prisma/clipping/clipping.service';
import {
  analyseOutcome,
  buildClipFetchJob,
  clipCaptionWords,
  clipFetchOutcome,
  clipRenderOutcome,
  selectClips,
} from '@gitroom/nestjs-libraries/managed-creative/clipping-builders';

const MANAGED = '11111111-1111-4111-8111-111111111111';
const UNMANAGED = '99999999-9999-4999-8999-999999999999';
const URL_ = 'https://youtube.com/watch?v=FAKE';

const instance = <T>(type: { prototype: T }, fields: Record<string, any>): any =>
  Object.assign(Object.create(type.prototype), fields);

function fakes(org: string, overrides: { clipping?: object; clip?: object; words?: unknown } = {}) {
  return {
    ingest: { submit: jest.fn(async () => 'FAKE-job'), status: jest.fn() },
    clipper: { submit: jest.fn(async () => 'FAKE-job'), status: jest.fn() },
    storage: {
      signUploadUrl: jest.fn(async (key: string) => `https://FAKE-up/${key}`),
      signDownloadUrl: jest.fn(async (key: string) => `https://FAKE-down/${key}`),
      readFile: jest.fn(async (_key: string) => JSON.stringify(overrides.words ?? [])),
      writeFile: jest.fn(async () => undefined),
    },
    _clippingRepository: {
      getClippingById: jest.fn(async () => ({
        id: 'c',
        organizationId: org,
        url: URL_,
        status: 'pending',
        maxClips: 5,
        clips: [],
        ...overrides.clipping,
      })),
      getClipById: jest.fn(async () => ({
        id: 'clip',
        clippingId: 'c',
        status: 'pending',
        start: 12.5,
        end: 47.5,
        trimStart: 10,
        clipping: { organizationId: org, url: URL_, fit: 'blur', duration: null },
        ...overrides.clip,
      })),
      updateClipping: jest.fn(),
      updateClip: jest.fn(),
    },
    _subscriptionService: { chargeCredits: jest.fn(async () => ({ id: 'FAKE-credit' })) },
    _deepgram: { transcribeUrl: jest.fn() },
    _openAi: { pickClips: jest.fn() },
    failClip: jest.fn(),
  };
}

const submitted = (submit: jest.Mock) => JSON.stringify(submit.mock.calls[0][0]);

// an install without billing: the balance is the 180 minute ceiling
beforeEach(() => {
  delete process.env.STRIPE_PUBLISHABLE_KEY;
});

describe('ClippingService submits the same jobs', () => {
  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = MANAGED;
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
  });

  it('analyse with captions, then audio only', async () => {
    const fields = fakes(UNMANAGED);
    await instance(ClippingService, fields).submitAnalyse('c');
    expect(submitted(fields.ingest.submit)).toBe(
      '{"version":1,"type":"ingest","reference":"c","source":{"url":"https://youtube.com/watch?v=FAKE","via":"oxylabs"},"transcript":{"url":"https://FAKE-up/clipping-c-transcript.json","languages":["en"]},"audio":{"url":"https://FAKE-up/clipping-c-audio.ogg","unless_transcript":true},"limits":{"max_duration_seconds":10800}}'
    );
    expect(fields.storage.signUploadUrl.mock.calls).toEqual([
      ['clipping-c-transcript.json', 'application/json'],
      ['clipping-c-audio.ogg', 'audio/ogg'],
    ]);

    const audioOnly = fakes(UNMANAGED, { clipping: { status: 'transcribing' } });
    await instance(ClippingService, audioOnly).submitAnalyse('c');
    expect(submitted(audioOnly.ingest.submit)).toBe(
      '{"version":1,"type":"ingest","reference":"c","source":{"url":"https://youtube.com/watch?v=FAKE","via":"oxylabs"},"audio":{"url":"https://FAKE-up/clipping-c-audio.ogg","unless_transcript":false},"limits":{"max_duration_seconds":10800}}'
    );
  });

  it('clip window fetch, crop inside the duration and blur without one', async () => {
    const crop = fakes(UNMANAGED, {
      clip: {
        start: 12.4,
        end: 47.6,
        clipping: { organizationId: UNMANAGED, url: URL_, fit: 'crop', duration: 48 },
      },
    });
    await instance(ClippingService, crop).submitClipFetch('clip');
    expect(submitted(crop.ingest.submit)).toBe(
      '{"version":1,"type":"ingest","reference":"clip","source":{"url":"https://youtube.com/watch?v=FAKE","via":"oxylabs","max_height":1080,"start_seconds":10,"end_seconds":48},"video":{"url":"https://FAKE-up/clip-clip-source.mp4"}}'
    );

    const blur = fakes(UNMANAGED, { clip: { start: 1, end: 47.6 } });
    await instance(ClippingService, blur).submitClipFetch('clip');
    expect(submitted(blur.ingest.submit)).toBe(
      '{"version":1,"type":"ingest","reference":"clip","source":{"url":"https://youtube.com/watch?v=FAKE","via":"oxylabs","max_height":720,"start_seconds":0,"end_seconds":50},"video":{"url":"https://FAKE-up/clip-clip-source.mp4"}}'
    );
  });

  it('clip render with captions, and without words', async () => {
    const fields = fakes(UNMANAGED, { words: [{ text: 'hi', start: 2.4, end: 2.9 }] });
    await instance(ClippingService, fields).submitClipRender('clip');
    expect(submitted(fields.clipper.submit)).toBe(
      '{"version":1,"type":"clip","reference":"clip","source":{"url":"https://FAKE-down/clip-clip-source.mp4"},"clips":[{"reference":"clip","start_seconds":2.5,"end_seconds":37.5,"output":{"url":"https://FAKE-up/clip-clip.mp4"},"thumbnail":{"url":"https://FAKE-up/clip-clip.jpg","timestamp_seconds":0}}],"frame":{"width":1080,"height":1920,"fit":"blur"},"captions":{"words":[{"text":"hi","start":2.4,"end":2.9}]}}'
    );
    expect(fields.storage.signDownloadUrl.mock.calls).toEqual([['clip-clip-source.mp4']]);
    expect(fields.storage.signUploadUrl.mock.calls).toEqual([
      ['clip-clip.mp4', 'video/mp4'],
      ['clip-clip.jpg', 'image/jpeg'],
    ]);

    const crop = fakes(UNMANAGED, {
      clip: { clipping: { organizationId: UNMANAGED, url: URL_, fit: 'crop' } },
    });
    await instance(ClippingService, crop).submitClipRender('clip');
    expect(submitted(crop.clipper.submit)).toBe(
      '{"version":1,"type":"clip","reference":"clip","source":{"url":"https://FAKE-down/clip-clip-source.mp4"},"clips":[{"reference":"clip","start_seconds":2.5,"end_seconds":37.5,"output":{"url":"https://FAKE-up/clip-clip.mp4"},"thumbnail":{"url":"https://FAKE-up/clip-clip.jpg","timestamp_seconds":0}}],"frame":{"width":1080,"height":1920,"fit":"crop"}}'
    );
  });

  it('captions come from the transcript words when they are word level', async () => {
    const transcript = {
      version: 1,
      language: 'en',
      origin: 'auto_generated',
      word_level: true,
      segments: [] as any[],
      words: [
        { text: 'before', start: 10, end: 12.5 },
        { text: 'in', start: 13, end: 13.5 },
        { text: 'after', start: 47.5, end: 48 },
      ],
    };
    const fields = fakes(UNMANAGED, { words: transcript });
    await instance(ClippingService, fields).captionClip('clip');

    expect(fields._deepgram.transcribeUrl).not.toHaveBeenCalled();
    expect(fields.storage.readFile).toHaveBeenCalledWith('clipping-c-transcript.json');
    expect(clipCaptionWords(transcript as any, 12.5, 47.5, 10)).toEqual([
      { text: 'in', start: 3, end: 3.5 },
    ]);
    expect(clipCaptionWords({ ...transcript, word_level: false } as any, 12.5, 47.5, 10)).toBeNull();
  });
});

describe('ClippingService reads the analyse answer as before', () => {
  const completed = (result: object) => ({
    status: 'completed',
    result: { version: 1, reference: 'c', status: 'completed', ...result },
  });

  async function check(job: object) {
    const fields = fakes(UNMANAGED);
    fields.ingest.status.mockResolvedValue(job as never);
    const service = instance(ClippingService, fields);
    try {
      return { fields, answer: await service.checkAnalyse('c', 'FAKE-job') };
    } catch (err: any) {
      return { fields, error: err.message as string };
    }
  }

  it.each<[string, object, object]>([
    ['pending', { status: 'pending' }, { answer: { state: 'pending' } }],
    ['a crashed job', { status: 'failed', error: 'x' }, { answer: { state: 'retry' } }],
    [
      'a retryable failure',
      completed({ status: 'failed', failure: { code: 'X', message: 'm', retryable: true } }),
      { answer: { state: 'retry' } },
    ],
    [
      'too long',
      completed({
        status: 'failed',
        source: { duration_seconds: 12000 },
        failure: { code: 'DURATION_TOO_LONG', message: 'm', retryable: false },
      }),
      {
        error:
          'This video is 200 minutes long. It has to fit the clipping minutes left on this account for this month, and 180 minutes at most.',
      },
    ],
    [
      'a private video',
      completed({
        status: 'failed',
        failure: { code: 'SOURCE_UNAVAILABLE', message: 'm', retryable: false },
      }),
      {
        error:
          'This video is private, removed, or restricted by age or region, so it cannot be clipped.',
      },
    ],
    [
      'no duration',
      completed({ source: {} }),
      {
        error:
          'Something went wrong while clipping this video, the clipping minutes were given back.',
      },
    ],
    [
      'nothing to transcribe',
      completed({ source: { duration_seconds: 60 } }),
      { error: 'This video has no captions and no audio.' },
    ],
  ])('%s', async (_name, job, expected) => {
    const { fields, ...result } = await check(job);
    expect(result).toEqual(expected);
    expect(fields._subscriptionService.chargeCredits).not.toHaveBeenCalled();
  });

  it('uploaded captions are asked again for the audio, without a charge', async () => {
    const { fields, answer } = await check(
      completed({
        source: { duration_seconds: 60 },
        transcript: { origin: 'uploader_provided', language: 'en', word_level: true, segments: 1, words: 1 },
      })
    );
    expect(answer).toEqual({ state: 'retry' });
    expect(fields._clippingRepository.updateClipping).toHaveBeenCalledWith(UNMANAGED, 'c', {
      status: 'transcribing',
    });
    expect(fields._subscriptionService.chargeCredits).not.toHaveBeenCalled();
  });

  it('a usable answer charges the minutes and stores the source', async () => {
    const captions = await check(
      completed({
        source: { duration_seconds: 125.2, title: 'T', thumbnail_url: 'https://FAKE/t.jpg' },
        transcript: { origin: 'auto_generated', language: 'en', word_level: true, segments: 1, words: 1 },
      })
    );
    expect(captions.answer).toEqual({ state: 'done', transcribe: false });
    expect(captions.fields._subscriptionService.chargeCredits).toHaveBeenCalledWith(
      'c',
      UNMANAGED,
      'clipping_minutes',
      3
    );
    expect(captions.fields._clippingRepository.updateClipping).toHaveBeenCalledWith(UNMANAGED, 'c', {
      title: 'T',
      thumbnail: 'https://FAKE/t.jpg',
      duration: 126,
      creditsId: 'FAKE-credit',
    });

    const audio = await check(completed({ source: { duration_seconds: 60 }, audio: { bytes: 1 } }));
    expect(audio.answer).toEqual({ state: 'done', transcribe: true });
    expect(audio.fields._clippingRepository.updateClipping).toHaveBeenCalledWith(UNMANAGED, 'c', {
      title: URL_,
      duration: 60,
      creditsId: 'FAKE-credit',
    });
  });
});

describe('clip fetch and render answers', () => {
  it('a fetched window stores where it starts', async () => {
    const fields = fakes(UNMANAGED);
    fields.ingest.status.mockResolvedValue({
      status: 'completed',
      result: { status: 'completed', video: { bytes: 1 }, source: { trim: { start_seconds: 9.5 } } },
    } as never);
    expect(await instance(ClippingService, fields).checkClipFetch('clip', 'j')).toEqual({
      state: 'done',
    });
    expect(fields._clippingRepository.updateClip).toHaveBeenCalledWith('clip', { trimStart: 9.5 });

    expect(
      clipFetchOutcome({ status: 'completed', result: { status: 'completed', video: { bytes: 1 } } } as any, 12.5)
    ).toEqual({ state: 'done', trimStart: 10 });
  });

  it('a window that failed for good fails only the clip', async () => {
    const fields = fakes(UNMANAGED);
    fields.ingest.status.mockResolvedValue({
      status: 'completed',
      result: {
        status: 'failed',
        failure: { code: 'UNSUPPORTED_INPUT', message: 'm', retryable: false },
      },
    } as never);
    expect(await instance(ClippingService, fields).checkClipFetch('clip', 'j')).toEqual({
      state: 'failed',
    });
    expect(fields.failClip).toHaveBeenCalledWith(
      'clip',
      'This link is not a video that can be clipped. Live streams are not supported.',
      true
    );
    expect(fields._clippingRepository.updateClip).not.toHaveBeenCalled();
  });

  it('render answers: retry, partial failure, done with a thumbnail', () => {
    const failure = { code: 'X', message: 'm', retryable: true };
    expect(clipRenderOutcome({ status: 'pending' })).toEqual({ state: 'pending' });
    expect(clipRenderOutcome({ status: 'failed', error: 'x' })).toEqual({ state: 'retry' });
    expect(
      clipRenderOutcome({
        status: 'completed',
        result: { version: 1, reference: 'r', status: 'partial', clips: [{ reference: 'r', status: 'failed', failure }] },
      })
    ).toEqual({ state: 'retry' });
    expect(
      clipRenderOutcome({
        status: 'completed',
        result: {
          version: 1,
          reference: 'r',
          status: 'partial',
          clips: [{ reference: 'r', status: 'failed', failure: { ...failure, retryable: false } }],
        },
      })
    ).toMatchObject({ state: 'failed', failure: { code: 'X' } });
    expect(
      clipRenderOutcome({
        status: 'completed',
        result: { version: 1, reference: 'r', status: 'completed', clips: [{ reference: 'r', status: 'completed', thumbnail: { bytes: 1 } }] },
      })
    ).toEqual({ state: 'done', thumbnail: true });
  });

  it('analyseOutcome keeps no-speech and captions answers apart', () => {
    expect(
      analyseOutcome({
        status: 'completed',
        result: { version: 1, reference: 'c', status: 'completed', source: { duration_seconds: 5 }, audio: { bytes: 1 } },
      })
    ).toEqual({ state: 'done', durationSeconds: 5, title: undefined, thumbnailUrl: undefined, transcribe: true });
  });

  it('buildClipFetchJob never reads past the end of the video', () => {
    expect(
      buildClipFetchJob({
        reference: 'r',
        url: URL_,
        fit: 'blur',
        start: 0.2,
        end: 9.9,
        durationSeconds: 10,
        videoUploadUrl: 'https://FAKE-up/x',
      }).source
    ).toMatchObject({ start_seconds: 0, end_seconds: 10 });
  });
});

describe('selectClips', () => {
  const segments = [
    { start: 0, end: 5, text: '0' },
    { start: 5, end: 15, text: '1' },
    { start: 15, end: 40, text: '2' },
    { start: 40, end: 95, text: '3' },
    { start: 95, end: 100, text: '4' },
    { start: 100, end: 130, text: '5' },
    { start: 130, end: 140, text: '6' },
    { start: 140, end: 230, text: '7' },
    { start: 230, end: 320.5, text: '8' },
  ];
  const pick = (from: number, to: number) => ({ from, to, title: `${from}-${to}`, content: 'c' });

  it('drops incomplete model selections before indexing transcript segments', () => {
    expect(selectClips(segments, [{ from: 0, to: 2 }, { title: 'missing bounds', content: 'c' }, pick(0, 2)], 10))
      .toEqual([{ title: '0-2', content: 'c', start: 0, end: 40 }]);
  });

  it('trims an overrun, drops overlaps, short, long and out of range clips', () => {
    const picked = [
      pick(0, 3), // 95 s: ends on line 2 instead, 0-40
      pick(1, 2), // overlaps the first
      pick(4, 4), // 5 s, too short
      pick(4, 5), // 95-130
      pick(5, 9), // past the last line
      pick(2.5, 3), // not a line number
      pick(3, 3), // 40-95, touches but does not overlap
      pick(6, 6), // exactly 10 s
      pick(7, 7), // exactly 90 s
      pick(8, 8), // one line of 90.5 s can't be trimmed
      pick(3, 2), // backwards
    ];

    expect(selectClips(segments, picked, 10)).toEqual([
      { title: '0-3', content: 'c', start: 0, end: 40 },
      { title: '4-5', content: 'c', start: 95, end: 130 },
      { title: '3-3', content: 'c', start: 40, end: 95 },
      { title: '6-6', content: 'c', start: 130, end: 140 },
      { title: '7-7', content: 'c', start: 140, end: 230 },
    ]);
    expect(selectClips(segments, picked, 2).map((clip) => clip.title)).toEqual(['0-3', '4-5']);
  });

  it('pickClips stores what selectClips selected', async () => {
    const fields = fakes(UNMANAGED, {
      clipping: { maxClips: 2, title: 'T' },
      words: { language: 'en', segments },
    });
    const createClips = jest.fn(async (_id: string, clips: any[]) =>
      clips.map((_c, index) => ({ id: `clip-${index}` }))
    );
    Object.assign(fields._clippingRepository, { createClips });
    fields._openAi.pickClips.mockResolvedValue([pick(0, 3), pick(4, 5), pick(3, 3)] as never);

    expect(await instance(ClippingService, fields).pickClips('c')).toEqual(['clip-0', 'clip-1']);
    expect(createClips.mock.calls[0][1]).toEqual(selectClips(segments, [pick(0, 3), pick(4, 5), pick(3, 3)], 2));
  });
});

describe('managed organizations', () => {
  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = MANAGED;
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
  });

  it('every paid step still refuses before anything is signed or submitted', async () => {
    const fields = fakes(MANAGED);
    const service = instance(ClippingService, fields);

    await expect(service.startClipping({ id: MANAGED } as any, { url: URL_ } as any)).rejects.toThrow();
    for (const step of [
      service.submitAnalyse('c'),
      service.transcribe('c'),
      service.pickClips('c'),
      service.submitClipFetch('clip'),
      service.captionClip('clip'),
      service.submitClipRender('clip'),
    ]) {
      await expect(step).rejects.toThrow('managed by W&W');
    }

    expect(fields.ingest.submit).not.toHaveBeenCalled();
    expect(fields.clipper.submit).not.toHaveBeenCalled();
    expect(fields.storage.signUploadUrl).not.toHaveBeenCalled();
    expect(fields.storage.signDownloadUrl).not.toHaveBeenCalled();
    expect(fields._deepgram.transcribeUrl).not.toHaveBeenCalled();
    expect(fields._openAi.pickClips).not.toHaveBeenCalled();
  });
});
