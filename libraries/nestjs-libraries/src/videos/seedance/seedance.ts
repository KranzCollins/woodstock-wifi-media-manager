import {
  URL,
  Video,
  VideoAbstract,
} from '@gitroom/nestjs-libraries/videos/video.interface';
import { timer } from '@gitroom/helpers/utils/timer';
import { ArrayMaxSize, IsArray, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class Image {
  @IsString()
  id: string;

  @IsString()
  path: string;
}
export class SeedanceParams {
  @IsString()
  prompt: string;

  @Type(() => Image)
  @ValidateNested({ each: true })
  @IsArray()
  @ArrayMaxSize(3)
  images: Image[];
}

export const EVOLINK_GENERATIONS_URL =
  'https://api.evolink.ai/v1/videos/generations';
export const EVOLINK_TASKS_URL = 'https://api.evolink.ai/v1/tasks/';
export const SEEDANCE_POLL_INTERVAL_MS = 10000;
export const SEEDANCE_MAX_POLLS = 180; // ~30 minutes at 10s interval

export type SeedanceTaskStatus =
  | { status: 'pending' }
  | { status: 'completed'; url: string }
  | { status: 'failed'; error: string };

// The exact body of a generation, also sent by the W&W creative worker
export function seedanceGenerationBody(
  output: 'vertical' | 'horizontal',
  customParams: SeedanceParams
) {
  const imageUrls = customParams?.images?.map((p) => p.path) || [];
  return {
    model: imageUrls.length
      ? 'seedance-2.0-fast-reference-to-video'
      : 'seedance-2.0-fast-text-to-video',
    prompt: customParams.prompt,
    ...(imageUrls.length ? { image_urls: imageUrls } : {}),
    aspect_ratio: output === 'horizontal' ? '16:9' : '9:16',
    duration: 8,
    quality: '720p',
    generate_audio: true,
  };
}

// What a task answer means; anything but pending or processing ends the task
export function seedanceTaskStatus(data: any): SeedanceTaskStatus {
  if (data?.status === 'completed') {
    const videoUrl = data?.results || [];
    if (videoUrl.length > 0) {
      return { status: 'completed', url: videoUrl[0] };
    }
    return {
      status: 'failed',
      error: 'Video generation succeeded but no video URL returned',
    };
  }

  if (data?.status !== 'pending' && data?.status !== 'processing') {
    return {
      status: 'failed',
      error: data?.error
        ? `${data.error.code}: ${data.error.message}`
        : `Video generation failed (status ${data?.status})`,
    };
  }

  return { status: 'pending' };
}

@Video({
  identifier: 'seedance',
  title: 'Seedance 2.0 (Audio + Video)',
  description: 'Generate videos with the most advanced video model.',
  placement: 'text-to-image',
  dto: SeedanceParams,
  tools: [],
  trial: false,
  available: !!process.env.EVOLINK_API_KEY,
})
export class Seedance extends VideoAbstract<SeedanceParams> {
  override dto = SeedanceParams;

  // One billable request: a timeout or an answer without an id does not say
  // whether the task exists, so it is never sent again from here
  async submit(
    output: 'vertical' | 'horizontal',
    customParams: SeedanceParams
  ): Promise<{ taskId: string }> {
    const value = await (
      await fetch(EVOLINK_GENERATIONS_URL, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.EVOLINK_API_KEY}`,
        },
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify(seedanceGenerationBody(output, customParams)),
      })
    ).json();

    const taskId = value?.id;
    if (!taskId) {
      throw new Error(
        value?.error
          ? `${value.error.code}: ${value.error.message}`
          : `Failed to generate video`
      );
    }

    return { taskId };
  }

  async status(taskId: string): Promise<SeedanceTaskStatus> {
    const data = await (
      await fetch(EVOLINK_TASKS_URL + taskId, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.EVOLINK_API_KEY}`,
        },
        signal: AbortSignal.timeout(30000),
      })
    ).json();

    return seedanceTaskStatus(data);
  }

  async process(
    output: 'vertical' | 'horizontal',
    customParams: SeedanceParams
  ): Promise<URL> {
    const { taskId } = await this.submit(output, customParams);

    console.log('seedance taskId', taskId);
    let attempts = 0;
    while (true) {
      if (attempts++ >= SEEDANCE_MAX_POLLS) {
        throw new Error('Video generation timed out');
      }

      console.log('waiting for video to be ready');
      const task = await this.status(taskId);
      if (task.status === 'completed') {
        return task.url;
      }

      if (task.status === 'failed') {
        throw new Error(task.error);
      }

      await timer(SEEDANCE_POLL_INTERVAL_MS);
    }
  }
}
