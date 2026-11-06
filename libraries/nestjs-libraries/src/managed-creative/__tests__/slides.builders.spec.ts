// image-text-slides after its requests moved into slides-builders. Every
// provider is a FAKE (OpenAI SDK, fetch, Transloadit, storage); nothing is
// sent or paid. What is checked: ImagesSlides, FalService and OpenaiService
// send exactly what they sent before, with the same defaults and retries.
const mockParse = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
  choices: [{ message: { parsed: { slides: [] } } }],
}));
jest.mock('openai', () => ({
  ...jest.requireActual('openai'),
  __esModule: true,
  default: class {
    chat = { completions: { parse: (...args: unknown[]) => mockParse(...args) } };
  },
}));
jest.mock('openai/helpers/zod', () => ({
  zodResponseFormat: (_schema: unknown, name: string) => ({ name }),
}));
const mockCreateAssembly = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
  results: { subtitled: [{ url: 'https://tmp.transloadit.test/video.mp4' }] },
}));
jest.mock('transloadit', () => ({
  __esModule: true,
  default: class {
    createAssembly = (...args: unknown[]) => mockCreateAssembly(...args);
  },
}));
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn(async () => ({ format: { duration: 2 } })) }), {
  virtual: true,
});
jest.mock('p-limit', () => ({ __esModule: true, default: () => (fn: () => unknown) => fn() }));
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: {
    createStorage: () => ({
      uploadFile: async () => ({ path: 'https://cdn.test/voice.mp3' }),
    }),
  },
}));

import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import { FalService } from '@gitroom/nestjs-libraries/openai/fal.service';
import { ImagesSlides } from '@gitroom/nestjs-libraries/videos/images-slides/images.slides';
import {
  isAssemblyId,
  newAssemblyId,
  slideScratchKeys,
  slidesAssemblySteps,
  slidesSrt,
} from '@gitroom/nestjs-libraries/managed-creative/slides-builders';

const slidesAnswer = (slides: unknown) => ({ choices: [{ message: { parsed: { slides } } }] });

// The steps of one slide exactly as ImagesSlides wrote them before
const ONE_SLIDE_STEPS = {
  image0: { robot: '/http/import', url: 'https://img.test/0.jpg' },
  audio0: { robot: '/http/import', url: 'https://cdn.test/voice.mp3' },
  merge0: {
    use: [
      { name: 'image0', as: 'image' },
      { name: 'audio0', as: 'audio' },
    ],
    robot: '/video/merge',
    duration: 3,
    audio_delay: 0.5,
    preset: 'hls-1080p',
    resize_strategy: 'min_fit',
    loop: true,
  },
  concatenated: {
    robot: '/video/concat',
    result: false,
    video_fade_seconds: 0.5,
    use: [{ name: 'merge0', as: 'video_1' }],
  },
  subtitled: {
    robot: '/video/subtitle',
    result: true,
    preset: 'hls-1080p',
    use: {
      bundle_steps: true,
      steps: [
        { name: 'concatenated', as: 'video' },
        { name: ':original', as: 'subtitles' },
      ],
    },
    position: 'center',
    font_size: 8,
    subtitles_type: 'burned',
  },
};

describe('OpenaiService slides', () => {
  beforeEach(() => mockParse.mockReset());

  it('one request keeps the client defaults unless options are passed', async () => {
    mockParse.mockResolvedValue(slidesAnswer([{ imagePrompt: 'I', voiceText: 'V' }]));
    const service = new OpenaiService();

    expect(await service.slidesFromTextOnce('text')).toEqual([{ imagePrompt: 'I', voiceText: 'V' }]);
    expect(mockParse.mock.calls[0][1]).toBeUndefined();
    expect(mockParse.mock.calls[0][0]).toMatchObject({
      model: 'gpt-4.1',
      messages: [{ role: 'system' }, { role: 'user', content: 'text' }],
      response_format: { name: 'slides' },
    });

    const signal = new AbortController().signal;
    await service.slidesFromTextOnce('text', { maxRetries: 0, timeout: 5, signal });
    expect(mockParse.mock.calls[1][1]).toEqual({ maxRetries: 0, timeout: 5, signal });
  });

  it('generateSlidesFromText still tries three times and then answers []', async () => {
    mockParse.mockRejectedValue(new Error('down'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await new OpenaiService().generateSlidesFromText('text')).toEqual([]);
    expect(mockParse).toHaveBeenCalledTimes(3);
    expect(mockParse.mock.calls.every((call) => call[1] === undefined)).toBe(true);

    mockParse.mockReset();
    mockParse
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(slidesAnswer([{ imagePrompt: 'I', voiceText: 'V' }]));
    expect(await new OpenaiService().generateSlidesFromText('text')).toHaveLength(1);
    expect(mockParse).toHaveBeenCalledTimes(2);
  });
});

describe('FalService.generateImageFromText', () => {
  it('sends the same request as before', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ images: [{ url: 'https://img.test/0.jpg' }] }),
    } as any);
    process.env.FAL_KEY = 'FAKE-fal';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await new FalService().generateImageFromText('ideogram/v2', 'a cat', true)).toBe(
      'https://img.test/0.jpg'
    );
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://fal.run/fal-ai/ideogram/v2');
    expect(init.headers).toEqual({ Authorization: 'Key FAKE-fal', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: 'a cat',
      aspect_ratio: '9:16',
      resolution: '720p',
      num_images: 1,
      output_format: 'jpeg',
      expand_prompt: true,
    });
    fetchSpy.mockRestore();
    delete process.env.FAL_KEY;
  });
});

describe('ImagesSlides.process', () => {
  it('sends the same voice requests and assembly as before', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }) as any);
    process.env.ELEVENSLABS_API_KEY = 'FAKE-eleven';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const openai = {
      generateSlidesFromText: jest.fn(async () => [{ imagePrompt: 'I0', voiceText: 'Hello' }]),
    };
    const fal = { generateImageFromText: jest.fn(async () => 'https://img.test/0.jpg') };

    const url = await new ImagesSlides(openai as any, fal as any).process('horizontal', {
      voice: 'VOICE1',
      prompt: 'the prompt',
    });

    expect(url).toBe('https://tmp.transloadit.test/video.mp4');
    expect(openai.generateSlidesFromText).toHaveBeenCalledWith('the prompt');
    expect(fal.generateImageFromText).toHaveBeenCalledWith('ideogram/v2', 'I0', false);
    const [ttsUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(ttsUrl).toBe('https://api.elevenlabs.io/v1/text-to-speech/VOICE1?output_format=mp3_44100_128');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'xi-api-key': 'FAKE-eleven' });
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Hello', model_id: 'eleven_multilingual_v2' });

    const [options] = mockCreateAssembly.mock.calls[0] as [any];
    expect(options.waitForCompletion).toBe(true);
    expect(options.timeout).toBe(30 * 60 * 1000);
    expect(options.uploads['subtitles.srt']).toContain('00:00:00,000 --> 00:00:03,000');
    expect(options.uploads['subtitles.srt']).toContain('Hello');
    expect(options.params).toEqual({ steps: ONE_SLIDE_STEPS });
    fetchSpy.mockRestore();
    delete process.env.ELEVENSLABS_API_KEY;
  });
});

describe('slides builders', () => {
  it('build the steps and cues of ImagesSlides', () => {
    expect(
      slidesAssemblySteps([
        { imageUrl: 'https://img.test/0.jpg', audioUrl: 'https://cdn.test/voice.mp3', seconds: 2 },
      ])
    ).toEqual(ONE_SLIDE_STEPS);

    const srt = slidesSrt([
      { text: 'One', seconds: 2 },
      { text: 'Two', seconds: 1.5 },
    ]);
    expect(srt).toContain('00:00:00,000 --> 00:00:03,000\nOne');
    expect(srt).toContain('00:00:03,000 --> 00:00:05,500\nTwo');
  });

  it('assembly ids look like the SDK ones and scratch keys follow the operation', () => {
    const id = newAssemblyId();
    expect(isAssemblyId(id)).toBe(true);
    expect(newAssemblyId()).not.toBe(id);
    expect(isAssemblyId('../assemblies')).toBe(false);
    expect(slideScratchKeys('op1', 2)).toEqual({
      image: 'ww-op1-slide-2.jpg',
      audio: 'ww-op1-slide-2.mp3',
    });
  });
});
