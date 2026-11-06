import { randomUUID } from 'crypto';
import { stringifySync } from 'subtitle';

// The requests of ImagesSlides (image-text-slides), shared with the managed
// slides adapter so both send exactly the same thing. No I/O in here

export const SLIDES_IMAGE_MODEL = 'ideogram/v2';
export const SLIDES_SPEECH_MODEL = 'eleven_multilingual_v2';
export const ELEVENLABS_SPEECH_TIMEOUT_MS = 60000;
export const TRANSLOADIT_ENDPOINT = 'https://api2.transloadit.com';

export const elevenLabsSpeechUrl = (voice: string) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`;

export const elevenLabsSpeechBody = (text: string) => ({
  text,
  model_id: SLIDES_SPEECH_MODEL,
});

// Every cue lasts as long as the voice of its slide plus one second
export function slidesSrt(slides: { text: string; seconds: number }[]) {
  return stringifySync(
    slides
      .reduce((all, current) => {
        const start = all.length ? all[all.length - 1].end : 0;
        const end = start + current.seconds * 1000 + 1000;
        all.push({
          start: start,
          end: end,
          text: current.text,
        });

        return all;
      }, [] as { start: number; end: number; text: string }[])
      .map((item) => ({
        type: 'cue',
        data: item,
      })),
    { format: 'SRT' }
  );
}

// The assembly steps: every image with its voice, joined, then the subtitles
// of the ":original" upload (subtitles.srt) burned in
export function slidesAssemblySteps(
  slides: { imageUrl: string; audioUrl: string; seconds: number }[]
) {
  return {
    ...slides.reduce((all, current, index) => {
      all[`image${index}`] = {
        robot: '/http/import',
        url: current.imageUrl,
      };
      all[`audio${index}`] = {
        robot: '/http/import',
        url: current.audioUrl,
      };
      all[`merge${index}`] = {
        use: [
          {
            name: `image${index}`,
            as: 'image',
          },
          {
            name: `audio${index}`,
            as: 'audio',
          },
        ],
        robot: '/video/merge',
        duration: current.seconds + 1,
        audio_delay: 0.5,
        preset: 'hls-1080p',
        resize_strategy: 'min_fit',
        loop: true,
      };
      return all;
    }, {} as Record<string, unknown>),
    concatenated: {
      robot: '/video/concat',
      result: false,
      video_fade_seconds: 0.5,
      use: slides.map((p, index) => ({
        name: `merge${index}`,
        as: `video_${index + 1}`,
      })),
    },
    subtitled: {
      robot: '/video/subtitle',
      result: true,
      preset: 'hls-1080p',
      use: {
        bundle_steps: true,
        steps: [
          {
            name: 'concatenated',
            as: 'video',
          },
          {
            name: ':original',
            as: 'subtitles',
          },
        ],
      },
      position: 'center',
      font_size: 8,
      subtitles_type: 'burned',
    },
  };
}

// The id the Transloadit SDK gives every assembly it creates (a v4 uuid
// without dashes). W&W makes and records it before the assembly is sent, so
// the assembly can be looked up whatever happens to the answer
export const newAssemblyId = () => randomUUID().replace(/-/g, '');

export const isAssemblyId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

// Scratch files of one slide, named like managedScratchKeys. W&W retains the
// Fal image and the ElevenLabs voice under these keys before the assembly
// imports them; nothing else is ever imported
export function slideScratchKeys(operationId: string, index: number) {
  return {
    image: `ww-${operationId}-slide-${index}.jpg`,
    audio: `ww-${operationId}-slide-${index}.mp3`,
  };
}
