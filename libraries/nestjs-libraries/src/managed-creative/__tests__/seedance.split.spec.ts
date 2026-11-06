// T1: Seedance is split into submit and status and process() is a loop over
// them. The body, headers, timeouts, interval, 180 polls and every error
// message stay what they were. fetch is a FAKE; nothing reaches Evolink.
const mockTimer = jest.fn(async (_ms: number) => undefined);
jest.mock('@gitroom/helpers/utils/timer', () => ({ timer: (ms: number) => mockTimer(ms) }));

import {
  Seedance,
  seedanceGenerationBody,
} from '@gitroom/nestjs-libraries/videos/seedance/seedance';

// The bodies the code before the split sent, written out by hand
const TEXT_BODY =
  '{"model":"seedance-2.0-fast-text-to-video","prompt":"a cat","aspect_ratio":"9:16","duration":8,"quality":"720p","generate_audio":true}';
const REFERENCE_BODY =
  '{"model":"seedance-2.0-fast-reference-to-video","prompt":"a cat","image_urls":["https://FAKE/a.png","https://FAKE/b.png"],"aspect_ratio":"16:9","duration":8,"quality":"720p","generate_audio":true}';

const answer = (value: unknown) => ({ json: async () => value }) as any;

describe('Seedance submit / status split', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.EVOLINK_API_KEY = 'FAKE-evolink-key';
    mockTimer.mockClear();
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    delete process.env.EVOLINK_API_KEY;
    fetchSpy.mockRestore();
  });

  it('sends the same generation body, byte for byte', async () => {
    fetchSpy.mockResolvedValue(answer({ id: 'task-1' }));
    const seedance = new Seedance();

    await seedance.submit('vertical', { prompt: 'a cat', images: [] });
    await seedance.submit('horizontal', {
      prompt: 'a cat',
      images: [
        { id: '1', path: 'https://FAKE/a.png' },
        { id: '2', path: 'https://FAKE/b.png' },
      ],
    });

    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.evolink.ai/v1/videos/generations');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer FAKE-evolink-key',
      },
      body: TEXT_BODY,
    });
    expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetchSpy.mock.calls[1][1].body).toBe(REFERENCE_BODY);
    expect(JSON.stringify(seedanceGenerationBody('vertical', { prompt: 'a cat', images: [] }))).toBe(
      TEXT_BODY
    );
  });

  it('submit keeps the errors of a missing task id', async () => {
    const seedance = new Seedance();
    fetchSpy.mockResolvedValueOnce(answer({ error: { code: 'E1', message: 'bad' } }));
    await expect(seedance.submit('vertical', { prompt: 'x', images: [] })).rejects.toThrow('E1: bad');

    fetchSpy.mockResolvedValueOnce(answer({}));
    await expect(seedance.submit('vertical', { prompt: 'x', images: [] })).rejects.toThrow(
      'Failed to generate video'
    );
  });

  it('process() polls every 10 s and returns results[0]', async () => {
    fetchSpy
      .mockResolvedValueOnce(answer({ id: 'task-1' }))
      .mockResolvedValueOnce(answer({ status: 'pending' }))
      .mockResolvedValueOnce(answer({ status: 'processing' }))
      .mockResolvedValueOnce(
        answer({ status: 'completed', results: ['https://FAKE/v.mp4', 'https://FAKE/other.mp4'] })
      );

    await expect(new Seedance().process('vertical', { prompt: 'a cat', images: [] })).resolves.toBe(
      'https://FAKE/v.mp4'
    );

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    for (const call of fetchSpy.mock.calls.slice(1)) {
      expect(call[0]).toBe('https://api.evolink.ai/v1/tasks/task-1');
      expect(call[1].method).toBeUndefined();
      expect(call[1].headers.Authorization).toBe('Bearer FAKE-evolink-key');
    }
    expect(mockTimer.mock.calls).toEqual([[10000], [10000]]);
  });

  it('process() still times out after 180 polls and submits once', async () => {
    fetchSpy.mockImplementation(async (url: string) =>
      answer(url.endsWith('/generations') ? { id: 'task-1' } : { status: 'pending' })
    );

    await expect(new Seedance().process('vertical', { prompt: 'x', images: [] })).rejects.toThrow(
      'Video generation timed out'
    );

    const posts = fetchSpy.mock.calls.filter((call) => call[1].method === 'POST');
    expect(posts).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(181);
  });

  it.each<[object, string]>([
    [{ status: 'failed', error: { code: 'E2', message: 'nope' } }, 'E2: nope'],
    [{ status: 'weird' }, 'Video generation failed (status weird)'],
    [{ status: 'completed', results: [] }, 'Video generation succeeded but no video URL returned'],
    [{ status: 'completed' }, 'Video generation succeeded but no video URL returned'],
  ])('process() keeps the error of the task answer %j', async (task, message) => {
    fetchSpy
      .mockResolvedValueOnce(answer({ id: 'task-1' }))
      .mockResolvedValueOnce(answer(task));

    await expect(new Seedance().process('vertical', { prompt: 'x', images: [] })).rejects.toThrow(
      message
    );
  });

  it('status() maps the answer without throwing', async () => {
    const seedance = new Seedance();
    fetchSpy.mockResolvedValueOnce(answer({ status: 'processing' }));
    await expect(seedance.status('task-1')).resolves.toEqual({ status: 'pending' });

    fetchSpy.mockResolvedValueOnce(answer({ status: 'completed', results: ['https://FAKE/v.mp4'] }));
    await expect(seedance.status('task-1')).resolves.toEqual({
      status: 'completed',
      url: 'https://FAKE/v.mp4',
    });
  });
});
