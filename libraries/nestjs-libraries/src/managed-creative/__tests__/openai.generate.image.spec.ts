// T1: OpenaiService.generateImage passes request options as the SDK's second
// argument; callers that don't pass them send exactly what they sent before.
// The SDK is a FAKE; nothing reaches OpenAI.
const mockImagesGenerate = jest.fn(async (..._args: unknown[]) => ({
  data: [{ b64_json: 'FAKE-b64' }],
}));
jest.mock('openai', () => ({
  __esModule: true,
  default: class {
    images = { generate: (...args: unknown[]) => mockImagesGenerate(...args) };
  },
}));
jest.mock('openai/helpers/zod', () => ({ zodResponseFormat: () => ({}) }));

import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';

describe('OpenaiService.generateImage request options', () => {
  beforeEach(() => mockImagesGenerate.mockClear());

  it('existing callers send the same body and no options', async () => {
    const service = new OpenaiService();

    await expect(service.generateImage('a cat')).resolves.toBe('FAKE-b64');
    await service.generateImage('a cat', true);

    expect(mockImagesGenerate.mock.calls).toEqual([
      [{ prompt: 'a cat', model: 'chatgpt-image-latest', size: '1024x1024' }, undefined],
      [{ prompt: 'a cat', model: 'chatgpt-image-latest', size: '1024x1536' }, undefined],
    ]);
  });

  it('request options reach images.generate unchanged', async () => {
    const signal = new AbortController().signal;
    await new OpenaiService().generateImage('a cat', false, {
      maxRetries: 0,
      timeout: 1000,
      signal,
    });

    expect(mockImagesGenerate).toHaveBeenCalledTimes(1);
    expect(mockImagesGenerate.mock.calls[0][1]).toEqual({ maxRetries: 0, timeout: 1000, signal });
  });
});
