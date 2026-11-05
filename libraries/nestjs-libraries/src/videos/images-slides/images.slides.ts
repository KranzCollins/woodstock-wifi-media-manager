import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import {
  ExposeVideoFunction,
  URL,
  Video,
  VideoAbstract,
} from '@gitroom/nestjs-libraries/videos/video.interface';
import { chunk } from 'lodash';
import Transloadit from 'transloadit';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { Readable } from 'stream';
import { parseBuffer } from 'music-metadata';

import pLimit from 'p-limit';
import { FalService } from '@gitroom/nestjs-libraries/openai/fal.service';
import {
  SLIDES_IMAGE_MODEL,
  ELEVENLABS_SPEECH_TIMEOUT_MS,
  elevenLabsSpeechBody,
  elevenLabsSpeechUrl,
  slidesAssemblySteps,
  slidesSrt,
} from '@gitroom/nestjs-libraries/managed-creative/slides-builders';
import { IsString } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
const limit = pLimit(2);

const transloadit = new Transloadit({
  authKey: process.env.TRANSLOADIT_AUTH || 'just empty text',
  authSecret: process.env.TRANSLOADIT_SECRET || 'just empty text',
});

// ElevenLabs reports quota and permission problems as 401 with the reason in
// the body, as either { detail: { status, message } } or { detail: 'text' }
async function elevenLabsError(response: Response) {
  const { detail } = await response.json().catch(() => ({ detail: undefined }));
  const reason =
    typeof detail === 'string'
      ? detail
      : detail?.message || detail?.status || response.statusText;
  return `ElevenLabs ${response.status}: ${reason}`;
}

async function getAudioDuration(buffer: Buffer): Promise<number> {
  const metadata = await parseBuffer(buffer, 'audio/mpeg');
  return metadata.format.duration || 0;
}

class ImagesSlidesParams {
  @JSONSchema({
    description: 'Elevenlabs voice id, use a special tool to get it, this is a required filed',
  })
  @IsString()
  voice: string;

  @JSONSchema({
    description: 'Simple string of the prompt, not a json',
  })
  @IsString()
  prompt: string;
}

@Video({
  identifier: 'image-text-slides',
  title: 'Image Text Slides',
  description: 'Generate videos slides from images and text, Don\'t break down the slides, provide only the first slide information',
  placement: 'text-to-image',
  tools: [{ functionName: 'loadVoices', output: 'voice id' }],
  dto: ImagesSlidesParams,
  trial: true,
  available:
    !!process.env.ELEVENSLABS_API_KEY &&
    !!process.env.TRANSLOADIT_AUTH &&
    !!process.env.TRANSLOADIT_SECRET &&
    !!process.env.OPENAI_API_KEY &&
    !!process.env.FAL_KEY,
})
export class ImagesSlides extends VideoAbstract<ImagesSlidesParams> {
  override dto = ImagesSlidesParams;
  private storage = UploadFactory.createStorage();
  constructor(
    private _openaiService: OpenaiService,
    private _falService: FalService
  ) {
    super();
  }

  async process(
    output: 'vertical' | 'horizontal',
    customParams: ImagesSlidesParams
  ): Promise<URL> {
    const list = await this._openaiService.generateSlidesFromText(
      customParams.prompt
    );

    // Plain async calls so a failed image or voice request rejects Promise.all
    // and fails the job, instead of a promise that never settles and a job that
    // hangs until the workflow times out
    const generated = await Promise.all(
      list.reduce((all, current) => {
        all.push(
          (async () => ({
            len: 0,
            url: await this._falService.generateImageFromText(
              SLIDES_IMAGE_MODEL,
              current.imagePrompt,
              output === 'vertical'
            ),
          }))()
        );

        all.push(
          (async () => {
            const response = await limit(() =>
              fetch(elevenLabsSpeechUrl(customParams.voice), {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'xi-api-key': process.env.ELEVENSLABS_API_KEY || '',
                },
                body: JSON.stringify(elevenLabsSpeechBody(current.voiceText)),
                signal: AbortSignal.timeout(ELEVENLABS_SPEECH_TIMEOUT_MS),
              })
            );

            if (!response.ok) {
              throw new Error(await elevenLabsError(response));
            }

            const buffer = Buffer.from(await response.arrayBuffer());

            const { path } = await this.storage.uploadFile({
              buffer,
              mimetype: 'audio/mp3',
              size: buffer.length,
              path: '',
              fieldname: '',
              destination: '',
              stream: new Readable(),
              filename: '',
              originalname: '',
              encoding: '',
            });

            return {
              len: await getAudioDuration(buffer),
              url:
                path.indexOf('http') === -1
                  ? process.env.FRONTEND_URL +
                    '/' +
                    process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY +
                    path
                  : path,
            };
          })()
        );

        return all;
      }, [] as Promise<any>[])
    );

    const split = chunk(generated, 2);

    const srt = slidesSrt(
      list.map((current, index) => ({
        text: current.voiceText,
        seconds: split[index][1].len,
      }))
    );

    console.log(split);

    const { results } = await transloadit.createAssembly({
      uploads: {
        'subtitles.srt': srt,
      },
      waitForCompletion: true,
      timeout: 30 * 60 * 1000,
      params: {
        steps: slidesAssemblySteps(
          split.map(([image, audio]) => ({
            imageUrl: image.url,
            audioUrl: audio.url,
            seconds: audio.len,
          }))
        ),
      },
    });

    return results.subtitled[0].url;
  }

  @ExposeVideoFunction()
  async loadVoices(data: any) {
    const response = await fetch(
      'https://api.elevenlabs.io/v2/voices?page_size=40&category=premade',
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENSLABS_API_KEY || '',
        },
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!response.ok) {
      throw new Error(await elevenLabsError(response));
    }

    const { voices } = await response.json();

    return {
      voices: voices.map((voice: any) => ({
        id: voice.voice_id,
        name: voice.name,
        preview_url: voice.preview_url,
      })),
    };
  }
}
