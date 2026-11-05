import { Injectable } from '@nestjs/common';
import { ClippingTranscript } from '@gitroom/nestjs-libraries/upload/clipping.processor.interface';

// The request and the reading of its answer, shared with the W&W creative
// worker so both send exactly the same thing
export const DEEPGRAM_LISTEN_URL =
  'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&utterances=true&detect_language=true&mip_opt_out=true';
export const DEEPGRAM_TIMEOUT_MS = 10 * 60 * 1000;

export function deepgramTranscript(results: any): ClippingTranscript {
  const channel = results?.channels?.[0];

  return {
    version: 1,
    language: channel?.detected_language || 'en',
    origin: 'transcribed',
    word_level: true,
    segments: (results?.utterances || []).map((p: any) => ({
      start: p.start,
      end: p.end,
      text: p.transcript,
    })),
    words: (channel?.alternatives?.[0]?.words || []).map((p: any) => ({
      text: p.punctuated_word || p.word,
      start: p.start,
      end: p.end,
    })),
  };
}

@Injectable()
export class DeepgramService {
  // Deepgram fetches the file itself, so media bytes never pass through here.
  // The answer comes back on the same request: an hour of audio takes about a
  // minute, and Deepgram gives up on its side after ten
  async transcribeUrl(url: string): Promise<ClippingTranscript> {
    const response = await fetch(DEEPGRAM_LISTEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Deepgram ${response.status}: ${(await response.text()).slice(0, 500)}`
      );
    }

    const { results } = await response.json();
    return deepgramTranscript(results);
  }
}
