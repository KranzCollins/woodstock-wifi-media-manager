// The only way a creative adapter reaches a provider. The worker passes
// fetchTransport; tests pass a FAKE. Headers (and the key in them) are built
// inside the adapter and never leave it: not in a result, an error or a log.

export interface ProviderResponse {
  status: number;
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
    };
  } | null;
}

export interface ProviderRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  // a provider answer is never followed somewhere else
  redirect: 'error';
}

export type ProviderTransport = (
  url: string,
  request: ProviderRequest
) => Promise<ProviderResponse>;

export const fetchTransport: ProviderTransport = (url, request) =>
  fetch(url, request) as unknown as Promise<ProviderResponse>;

// One deadline for the request and the reading of its answer, ended early when
// the caller (a worker shutting down) aborts
export function deadline(ms: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

export type BoundedRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'read_failed' };

export type BoundedBytes =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'too_large' | 'read_failed' };

// Reads at most maxBytes of the answer as text; a longer one is cut off and
// refused, and one that is not UTF-8 is not read
export async function readBounded(
  response: ProviderResponse,
  maxBytes: number,
  signal?: AbortSignal
): Promise<BoundedRead> {
  const read = await readBoundedBytes(response, maxBytes, signal);
  if (read.ok === false) return read;
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) };
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
}

// The same for an answer that is not text (the mp3 of a voice). Never throws:
// a pre-aborted signal, an abort while reading and a failing cancel all end as
// read_failed, and nothing of the error leaves
export async function readBoundedBytes(
  response: ProviderResponse,
  maxBytes: number,
  signal?: AbortSignal
): Promise<BoundedBytes> {
  if (signal?.aborted) return { ok: false, reason: 'read_failed' };
  if (!response.body) return { ok: true, bytes: Buffer.alloc(0) };
  // Even opening/cancelling a stream can throw a provider URL. No raw error leaves this boundary.
  let reader: ReturnType<NonNullable<ProviderResponse['body']>['getReader']>;
  try { reader = response.body.getReader(); }
  catch { return { ok: false, reason: 'read_failed' }; }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: (error: Error) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  aborted.catch(() => undefined);
  const onAbort = () => rejectAbort(new Error('ABORTED'));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value?.byteLength || 0;
      if (size > maxBytes) return { ok: false, reason: 'too_large' };
      if (value) chunks.push(value);
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
  } catch {
    return { ok: false, reason: 'read_failed' };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Cancellation is best effort and must not extend the deadline.
    try { void reader.cancel().catch(() => undefined); } catch { /* redacted */ }
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    return undefined;
  }
}
