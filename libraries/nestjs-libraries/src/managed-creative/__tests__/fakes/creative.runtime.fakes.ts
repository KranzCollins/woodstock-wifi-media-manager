// FAKES of everything the owned creative runtime reaches: the private
// scratch bucket, every provider host and the OpenAI-backed writers. Nothing
// is sent or paid. The provider router answers like the providers the
// adapters were written against, and plays RunPod's side of the scratch
// protocol (it writes what the job's signed upload urls name).
import {
  CREATIVE_SCRATCH_KEY,
  CreativeScratch,
  ScratchRead,
} from '@gitroom/nestjs-libraries/managed-creative/creative.scratch';
import {
  CreativeRuntimeDeps,
  ManagedCreativeRuntime,
} from '@gitroom/nestjs-libraries/managed-creative/creative.runtime';
import {
  ProviderRequest,
  ProviderTransport,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';
import { OpenaiImageAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/openai.image.adapter';
import { EvolinkSeedanceAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/evolink.seedance.adapter';
import { SlidesAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/slides.adapter';
import { RunPodAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/runpod.adapter';
import { DeepgramAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/deepgram.adapter';
import { OpenaiClipsAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/openai.clips.adapter';
import { ElevenLabsVoicesAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/elevenlabs.voices.adapter';

export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('FAKE-PNG-BODY'),
]);
export const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('FAKE-JPEG-BODY'),
]);
export const MP4_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisomFAKE-MP4-BODY'),
]);
export const MP3_BYTES = Buffer.from('ID3FAKE-MP3-BODY');
export const SECRET = 'SECRET-SIG';

export const SCRATCH_HOST = 'scratch.fake.test';
export const RESULT_HOSTS = {
  evolink: ['files.evolink.test'],
  fal: ['v3.fal.media'],
  transloadit: ['tmp.transloadit.test'],
};
export const EVOLINK_RESULT = 'https://files.evolink.test/out/video.mp4';
export const FAL_RESULT = 'https://v3.fal.media/files/slide.jpg';
export const TRANSLOADIT_RESULT = 'https://tmp.transloadit.test/out/slides.mp4';

// The caption file and the transcription of one FAKE talk: four lines, so
// the selection below gives two clips of 25 s and 30 s
export const SEGMENTS = [
  { start: 0, end: 12, text: 'Line one.' },
  { start: 12, end: 25, text: 'Line two.' },
  { start: 30, end: 45, text: 'Line three.' },
  { start: 45, end: 60, text: 'Line four.' },
];
export const WORDS = SEGMENTS.map((segment) => ({
  start: segment.start,
  end: segment.start + 1,
  text: segment.text.split(' ')[0],
}));
export const captionFile = (origin = 'auto_generated', extra: object = {}) =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      language: 'en',
      origin,
      word_level: true,
      segments: SEGMENTS,
      words: WORDS,
      ...extra,
    })
  );

export const keyOf = (url: string) =>
  decodeURIComponent(new URL(url).pathname.split('/').pop()!);

export class FakeScratch implements CreativeScratch {
  readonly hosts = [SCRATCH_HOST];
  files = new Map<string, Buffer>();
  failCreate = false;

  private check(key: string) {
    if (!CREATIVE_SCRATCH_KEY.test(key)) {
      throw new Error(`FAKE scratch refused key ${key}`);
    }
  }

  async signDownload(key: string) {
    this.check(key);
    return `https://${SCRATCH_HOST}/bucket/${key}?X-Amz-Signature=${SECRET}`;
  }

  async signUpload(key: string, contentType: string) {
    this.check(key);
    return `https://${SCRATCH_HOST}/bucket/${key}?X-Amz-Signature=${SECRET}&type=${encodeURIComponent(contentType)}`;
  }

  async create(key: string, bytes: Buffer) {
    this.check(key);
    if (this.failCreate) {
      throw new Error('FAKE storage down');
    }
    if (this.files.has(key)) {
      return 'exists' as const;
    }
    this.files.set(key, Buffer.from(bytes));
    return 'created' as const;
  }

  async read(key: string, maxBytes: number): Promise<ScratchRead> {
    this.check(key);
    const bytes = this.files.get(key);
    if (!bytes) {
      return { ok: false, reason: 'absent' };
    }
    return bytes.length > maxBytes
      ? { ok: false, reason: 'too_large' }
      : { ok: true, bytes: Buffer.from(bytes) };
  }
}

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status });

export interface SentRequest {
  url: string;
  method: string;
  body?: any;
}

// One FAKE per provider host. `outputs` are RunPod job outputs, consumed in
// submit order; `writes` controls what RunPod puts into the scratch bucket
export class FakeProviders {
  requests: SentRequest[] = [];
  outputs: unknown[] = [];
  runpodJobs = new Map<string, unknown>();
  assemblyThrows = false;
  evolinkTask: unknown = { status: 'completed', results: [EVOLINK_RESULT] };
  transcriptFile: Buffer | null = captionFile();
  private _jobs = 0;

  constructor(private _scratch: FakeScratch) {}

  // provider work: every POST is one billable request
  posts(host?: string) {
    return this.requests.filter(
      (request) => request.method === 'POST' && (!host || request.url.includes(host))
    );
  }

  private runpodRun(url: string, body: any) {
    const id = `rp-${++this._jobs}`;
    this.runpodJobs.set(id, this.outputs.shift());
    const job = body.input;
    const put = (target: string | undefined, bytes: Buffer | null) => {
      if (target && bytes) {
        this._scratch.files.set(keyOf(target), bytes);
      }
    };
    if (job.type === 'ingest' && !job.video) {
      put(job.transcript?.url, this.transcriptFile);
      put(job.audio?.url, Buffer.from('OggSFAKE-AUDIO'));
    }
    if (job.type === 'ingest' && job.video) {
      put(job.video.url, MP4_BYTES);
    }
    if (job.type === 'clip') {
      put(job.clips[0].output.url, MP4_BYTES);
      put(job.clips[0].thumbnail?.url, JPEG_BYTES);
    }
    return json(200, { id });
  }

  transport: ProviderTransport = async (url: string, request: ProviderRequest) => {
    const body = request.body && request.body.startsWith('{') ? JSON.parse(request.body) : request.body;
    this.requests.push({ url, method: request.method, body });

    if (url === 'https://api.evolink.ai/v1/videos/generations') {
      return json(200, { id: 'task-1' });
    }
    if (url.startsWith('https://api.evolink.ai/v1/tasks/')) {
      return json(200, this.evolinkTask);
    }
    if (url.startsWith('https://fal.run/')) {
      return json(200, { images: [{ url: FAL_RESULT }] });
    }
    if (url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/')) {
      return new Response(MP3_BYTES, { status: 200 });
    }
    if (url.startsWith('https://api.elevenlabs.io/v2/voices')) {
      return json(200, {
        voices: [{ voice_id: 'Voice0001', name: 'Ada', preview_url: 'https://cdn.example.test/SECRET-preview.mp3' }],
      });
    }
    if (url.startsWith('https://api2.transloadit.com/assemblies/')) {
      const assemblyId = url.split('/assemblies/')[1].split('?')[0];
      if (request.method === 'POST') {
        if (this.assemblyThrows) {
          throw new Error(`FAKE socket reset ${url}`);
        }
        return json(200, { ok: 'ASSEMBLY_EXECUTING', assembly_id: assemblyId });
      }
      return json(200, { ok: 'ASSEMBLY_COMPLETED', results: { subtitled: [{ url: TRANSLOADIT_RESULT }] } });
    }
    if (url.startsWith('https://api.runpod.ai/v2/')) {
      if (url.endsWith('/run')) {
        return this.runpodRun(url, body);
      }
      const id = url.split('/status/')[1];
      return this.runpodJobs.has(id)
        ? json(200, { status: 'COMPLETED', output: this.runpodJobs.get(id) })
        : json(404, {});
    }
    if (url.startsWith('https://api.deepgram.com/')) {
      return json(200, {
        results: {
          channels: [
            {
              detected_language: 'en',
              alternatives: [
                { words: WORDS.map((word) => ({ word: word.text, punctuated_word: word.text, start: word.start, end: word.end })) },
              ],
            },
          ],
          utterances: SEGMENTS.map((segment) => ({ start: segment.start, end: segment.end, transcript: segment.text })),
        },
      });
    }
    if (url === EVOLINK_RESULT || url === TRANSLOADIT_RESULT) {
      return new Response(MP4_BYTES, { status: 200 });
    }
    if (url === FAL_RESULT) {
      return new Response(JPEG_BYTES, { status: 200 });
    }
    return json(404, {});
  };
}

// The OpenAI side, as OpenaiService would answer
export function fakeOpenai() {
  return {
    generateImage: jest.fn(async (..._args: unknown[]): Promise<string | undefined> => PNG_BYTES.toString('base64')),
    slidesFromTextOnce: jest.fn(async (..._args: unknown[]): Promise<{ imagePrompt?: unknown; voiceText?: unknown }[]> => [
      { imagePrompt: 'A FAKE cat', voiceText: 'Hello cat.' },
      { imagePrompt: 'A FAKE dog', voiceText: 'Hello dog.' },
    ]),
    pickClips: jest.fn(async (..._args: unknown[]): Promise<{ from?: number; to?: number; title?: string; content?: string }[]> => [
      { from: 0, to: 1, title: 'Clip A', content: 'Post A' },
      { from: 2, to: 3, title: 'Clip B', content: 'Post B' },
    ]),
  };
}

export function fakeRuntime(
  providers: FakeProviders,
  scratch: FakeScratch,
  openai: ReturnType<typeof fakeOpenai>,
  overrides: Partial<CreativeRuntimeDeps> = {}
) {
  const transport = providers.transport;
  return new ManagedCreativeRuntime({
    scratch,
    image: new OpenaiImageAdapter(openai),
    seedance: new EvolinkSeedanceAdapter('FAKE-evolink-key', RESULT_HOSTS.evolink, transport),
    slides: new SlidesAdapter({
      writer: openai,
      falKey: 'FAKE-fal-key',
      elevenLabsKey: 'FAKE-eleven-key',
      transloadit: { authKey: 'FAKE-tl-key', authSecret: 'FAKE-tl-secret' },
      transport,
      imageHosts: RESULT_HOSTS.fal,
      videoHosts: RESULT_HOSTS.transloadit,
      scratchHosts: scratch.hosts,
    }),
    runpod: new RunPodAdapter('FAKE-runpod-key', { ingest: 'fake-ingest', clipper: 'fake-clipper' }, scratch.hosts, transport),
    deepgram: new DeepgramAdapter('FAKE-deepgram-key', scratch.hosts, transport),
    clips: new OpenaiClipsAdapter(openai),
    voices: new ElevenLabsVoicesAdapter('FAKE-eleven-key', transport),
    transport,
    resultHosts: RESULT_HOSTS,
    ...overrides,
  });
}
