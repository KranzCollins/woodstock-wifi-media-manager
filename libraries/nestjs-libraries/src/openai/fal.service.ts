import { Injectable } from '@nestjs/common';

import pLimit from 'p-limit';
const limit = pLimit(10);

export const FAL_RUN_URL = 'https://fal.run/fal-ai/';
export const FAL_TIMEOUT_MS = 300000;

export function falImageBody(text: string, isVertical: boolean) {
  return {
    prompt: text,
    aspect_ratio: isVertical ? '9:16' : '16:9',
    resolution: '720p',
    num_images: 1,
    output_format: 'jpeg',
    expand_prompt: true,
  };
}

@Injectable()
export class FalService {
  async generateImageFromText(
    model: string,
    text: string,
    isVertical: boolean = false
  ): Promise<string> {
    const response = await limit(() =>
      fetch(`${FAL_RUN_URL}${model}`, {
        method: 'POST',
        headers: {
          Authorization: `Key ${process.env.FAL_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(falImageBody(text, isVertical)),
        signal: AbortSignal.timeout(FAL_TIMEOUT_MS),
      })
    );

    if (!response.ok) {
      throw new Error(
        `fal ${response.status}: ${(await response.text()).slice(0, 500)}`
      );
    }

    const { images, video, ...all } = await response.json();

    console.log(all, video, images);

    if (video) {
      return video.url;
    }

    return images[0].url as string;
  }
}
