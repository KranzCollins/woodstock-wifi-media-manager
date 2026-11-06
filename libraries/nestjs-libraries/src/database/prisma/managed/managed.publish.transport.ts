import { MANAGED_RATE_LIMIT_MAX } from './managed.mode';

// One transport instance belongs to one durably admitted provider step.
// The caller reserves its maximum request count before admission. The
// dispatcher constructs the transport and retains it, and with it this
// ledger; the adapter receives nothing but adapterFetch(), a frozen function
// bound to this step. Ports, provider fetch, deadline and ledger live in
// runtime #private state, so an adapter can neither reach the network around
// the transport nor extend the step or rewrite what was sent. After any
// attempted mutation the dispatcher cannot accept an adapter's assertion that
// nothing was sent.
export type ManagedPublishTransportCode =
  | 'REQUEST_REFUSED' | 'RESERVATION_EXHAUSTED' | 'ADMISSION_LOST'
  | 'DEADLINE_EXPIRED' | 'RESPONSE_TOO_LARGE' | 'TRANSPORT_FAILED'
  // The provider refused a mutation (any non-2xx) or answered 429 / 5xx.
  // The answer is handed over for classification; no later request of the
  // step leaves, so nothing is retried within it.
  | 'PROVIDER_REJECTED';

export class ManagedPublishTransportError extends Error {
  constructor(readonly code: ManagedPublishTransportCode) {
    super(code);
    this.name = 'ManagedPublishTransportError';
  }
}

export interface ManagedPublishSentLedger {
  attemptedRequests: number;
  attemptedMutations: number;
  completedRequests: number;
  // Conservative: calling fetch is enough to make the outcome uncertain,
  // even when the network error is described as a connection failure.
  mutationMayHaveLeft: boolean;
  failure: ManagedPublishTransportCode | null;
}

// Snapshotted once by the constructor; later changes to this object have no
// effect on the step.
export interface ManagedPublishTransportPorts {
  reservedUnits: number;
  deadlineAt: Date;
  now(): Date;
  // The DB implementation checks exact call/holder/dispatch version and a
  // lease lasting through deadlineAt. Called before every request, including
  // read-only sub-requests which could otherwise outlive the admission.
  // Receives a fresh copy of the deadline on every call.
  verifyAdmission(deadlineAt: Date): Promise<boolean>;
  // Durable sent ledger admission, before fetch. No URL, body or credentials.
  recordAttempt(ordinal: number, mutation: boolean): Promise<boolean>;
  fetch: typeof globalThis.fetch;
}

export type ManagedPublishFetch = (input: string, options?: RequestInit) => Promise<Response>;

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DEADLINE_MS = 120_000;
const MAX_URL_LENGTH = 64 * 1024;

const GRAPH_HOST = 'graph.instagram.com';
// /<version>/<node>[/<edge>]; the edges are the only ones in GRAPH_ROUTES
const GRAPH_PATH = /^\/v\d{1,3}\.\d{1,3}\/(\d{1,32})(?:\/(media|media_publish|comments))?$/;
const GRAPH_NODE = /^\d{1,32}$/;
const GRAPH_CHILDREN = /^\d{1,32}(?:,\d{1,32}){1,19}$/;
// Graph method tunnelling and batching; never an allowed key, refused by name
const OVERRIDE_KEY = /^(?:_?method|batch)$/i;

type QueryRule = (value: string) => boolean;
interface GraphRoute {
  required: ReadonlyMap<string, QueryRule>;
  optional: ReadonlyMap<string, QueryRule>;
}

const anyValue: QueryRule = () => true;
const exactly = (...allowed: string[]): QueryRule => (value) => allowed.includes(value);
const graphRoute = (
  required: Record<string, QueryRule>,
  optional: Record<string, QueryRule> = {}
): GraphRoute => ({
  required: new Map(Object.entries({ ...required, access_token: (value: string) => value.length > 0 })),
  optional: new Map(Object.entries(optional)),
});

// Closed first adapter: exactly the pinned InstagramProvider requests on
// graph.instagram.com, keyed by method and edge. No deletion, no other node
// edge, no user-supplied host, redirect or local file.
const GRAPH_ROUTES: ReadonlyMap<string, GraphRoute> = new Map([
  // container status and permalink
  ['GET /', graphRoute({ fields: exactly('status_code', 'status_code,status', 'permalink') })],
  // upstream's newest-media probe after a blocked media_publish; its answer
  // never proves that a publication matches
  ['GET /media', graphRoute({ fields: exactly('id'), limit: exactly('1') })],
  ['POST /media', graphRoute({}, {
    image_url: anyValue, video_url: anyValue,
    media_type: exactly('STORIES', 'REELS', 'VIDEO', 'CAROUSEL'),
    cover_url: anyValue, thumb_offset: anyValue, alt_text: anyValue,
    is_carousel_item: exactly('true'), collaborators: anyValue, trial_params: anyValue,
    caption: anyValue, children: (value) => GRAPH_CHILDREN.test(value),
  })],
  ['POST /media_publish', graphRoute({ creation_id: (value) => GRAPH_NODE.test(value), field: exactly('id') })],
  ['POST /comments', graphRoute({ message: anyValue })],
]);

interface AllowedRequest {
  href: string;
  method: 'GET' | 'POST';
}

function allowedRequest(input: unknown, options: unknown): AllowedRequest | null {
  if (typeof input !== 'string' || input.length > MAX_URL_LENGTH ||
      options === null || typeof options !== 'object') return null;
  const init = options as RequestInit;
  const method = init.method ?? 'GET';
  if ((method !== 'GET' && method !== 'POST') || init.body != null || init.signal ||
      init.redirect || init.credentials || init.headers ||
      Object.keys(init).some((key) => key !== 'method')) return null;
  // The URL parser drops tabs and newlines, resolves dot segments and turns
  // backslashes into slashes; only a request sent exactly as written passes.
  if (/[\u0000- \u007f#\\]/.test(input)) return null;
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  const path = GRAPH_PATH.exec(url.pathname);
  const query = input.indexOf('?');
  if (url.protocol !== 'https:' || url.hostname !== GRAPH_HOST || url.port ||
      url.username || url.password || url.hash || !path ||
      (query === -1 ? input : input.slice(0, query)) !== `https://${GRAPH_HOST}${url.pathname}`) return null;
  const route = GRAPH_ROUTES.get(`${method} /${path[2] ?? ''}`);
  if (!route) return null;
  // Keys are compared decoded, so an encoded duplicate or override is caught.
  const seen = new Set<string>();
  let closed = true;
  url.searchParams.forEach((value, key) => {
    const rule = route.required.get(key) ?? route.optional.get(key);
    if (seen.has(key) || OVERRIDE_KEY.test(key) || !rule || !rule(value)) closed = false;
    seen.add(key);
  });
  route.required.forEach((_rule, key) => {
    if (!seen.has(key)) closed = false;
  });
  return closed ? { href: url.href, method } : null;
}

// Settles with the work or with DEADLINE_EXPIRED, whichever is first. Work is
// never started once the deadline passed, and a late rejection of work that
// lost the race is handled here, never left unhandled.
function beforeAbort<T>(start: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ManagedPublishTransportError('DEADLINE_EXPIRED'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    let work: Promise<T>;
    try { work = Promise.resolve(start()); } catch (error) { work = Promise.reject(error); }
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const ignore = () => undefined;

// Never awaited and never throws: a stalled provider's cancellation cannot
// extend the deadline and no provider error escapes.
function cancelLater(target: () => { cancel(): unknown } | null | undefined) {
  void Promise.resolve().then(() => target()?.cancel()).then(ignore, ignore);
}

export class ManagedPublishTransport {
  readonly #state: ManagedPublishSentLedger = {
    attemptedRequests: 0, attemptedMutations: 0, completedRequests: 0,
    mutationMayHaveLeft: false, failure: null,
  };
  readonly #reservedUnits: number;
  readonly #deadline: number;
  readonly #now: () => Date;
  readonly #verifyAdmission: (deadlineAt: Date) => Promise<boolean>;
  readonly #recordAttempt: (ordinal: number, mutation: boolean) => Promise<boolean>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #adapterFetch: ManagedPublishFetch;
  #tail: Promise<void> = Promise.resolve();

  constructor(ports: ManagedPublishTransportPorts) {
    const { reservedUnits, deadlineAt, now, verifyAdmission, recordAttempt, fetch } = ports;
    if (!Number.isSafeInteger(reservedUnits) || reservedUnits < 1 ||
        reservedUnits > MANAGED_RATE_LIMIT_MAX || !(deadlineAt instanceof Date) ||
        typeof now !== 'function' || typeof verifyAdmission !== 'function' ||
        typeof recordAttempt !== 'function' || typeof fetch !== 'function') {
      throw new ManagedPublishTransportError('REQUEST_REFUSED');
    }
    this.#deadline = Date.prototype.getTime.call(deadlineAt);
    if (!Number.isFinite(this.#deadline)) throw new ManagedPublishTransportError('REQUEST_REFUSED');
    this.#reservedUnits = reservedUnits;
    this.#now = now.bind(ports);
    this.#verifyAdmission = verifyAdmission.bind(ports);
    this.#recordAttempt = recordAttempt.bind(ports);
    this.#fetch = fetch;
    if (this.#remainingMs() === null) throw new ManagedPublishTransportError('DEADLINE_EXPIRED');
    // Serializing one step's sub-requests makes Promise.all in an upstream
    // adapter obey the reservation and stop after the first uncertain failure.
    this.#adapterFetch = Object.freeze((input: string, options: RequestInit = {}) => {
      const request = this.#tail.then(() => this.#perform(input, options));
      this.#tail = request.then(ignore, ignore);
      return request;
    });
  }

  ledger(): Readonly<ManagedPublishSentLedger> { return Object.freeze({ ...this.#state }); }

  // The only thing an adapter is given.
  adapterFetch(): ManagedPublishFetch { return this.#adapterFetch; }

  fetch(input: string, options?: RequestInit): Promise<Response> {
    return this.#adapterFetch(input, options);
  }

  #fail(code: ManagedPublishTransportCode): never {
    this.#state.failure ??= code;
    throw new ManagedPublishTransportError(this.#state.failure);
  }

  #remainingMs(): number | null {
    let now = Number.NaN;
    try { now = Date.prototype.getTime.call(this.#now()); } catch { /* An unreadable clock is expired. */ }
    const remaining = this.#deadline - now;
    return Number.isFinite(remaining) && remaining > 0 && remaining <= MAX_DEADLINE_MS ? remaining : null;
  }

  #remaining(): number {
    return this.#remainingMs() ?? this.#fail('DEADLINE_EXPIRED');
  }

  async #admit(check: () => Promise<boolean>, signal: AbortSignal): Promise<void> {
    let admitted = false;
    try {
      admitted = (await beforeAbort(check, signal)) === true;
    } catch {
      this.#fail(signal.aborted ? 'DEADLINE_EXPIRED' : 'ADMISSION_LOST');
    }
    if (!admitted) this.#fail('ADMISSION_LOST');
  }

  async #perform(input: unknown, options: unknown): Promise<Response> {
    if (this.#state.failure) this.#fail(this.#state.failure);
    let request: AllowedRequest | null = null;
    try { request = allowedRequest(input, options); } catch { /* A hostile options object. */ }
    if (!request) return this.#fail('REQUEST_REFUSED');
    const { href, method } = request;
    if (this.#state.attemptedRequests >= this.#reservedUnits) this.#fail('RESERVATION_EXHAUSTED');
    // One absolute deadline bounds the admission checks, the durable record,
    // the request and its body.
    const controller = new AbortController();
    const { signal } = controller;
    const timeout = setTimeout(() => controller.abort(), this.#remaining());
    const mutation = method === 'POST';
    const outgoing: { sent?: Promise<Response> } = {};
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await this.#admit(() => this.#verifyAdmission(new Date(this.#deadline)), signal);
      this.#remaining();
      await this.#admit(() => this.#recordAttempt(this.#state.attemptedRequests + 1, mutation), signal);
      // Recheck after the durable write; a pause must not turn an expired lease
      // into an outgoing mutation. A crash here is conservatively UNKNOWN.
      await this.#admit(() => this.#verifyAdmission(new Date(this.#deadline)), signal);
      this.#remaining();
      if (signal.aborted) this.#fail('DEADLINE_EXPIRED');
      this.#state.attemptedRequests++;
      if (mutation) {
        this.#state.attemptedMutations++;
        this.#state.mutationMayHaveLeft = true;
      }
      // Called without a receiver: the provider fetch never sees this transport.
      const providerFetch = this.#fetch;
      response = await beforeAbort(() => {
        outgoing.sent = Promise.resolve(providerFetch(href, {
          method, redirect: 'error', credentials: 'omit', signal,
        }));
        return outgoing.sent;
      }, signal);
      const status = response.status;
      if (!Number.isSafeInteger(status) || status < 200 || status >= 600) this.#fail('TRANSPORT_FAILED');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d{1,16}$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
        this.#fail('RESPONSE_TOO_LARGE');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const body = response.body;
      if (body) {
        const opened = body.getReader();
        reader = opened;
        for (;;) {
          const chunk = await beforeAbort(() => opened.read(), signal);
          if (chunk.done) break;
          const value: unknown = chunk.value;
          if (!ArrayBuffer.isView(value)) return this.#fail('TRANSPORT_FAILED');
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) this.#fail('RESPONSE_TOO_LARGE');
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      }
      this.#remaining();
      if (signal.aborted) this.#fail('DEADLINE_EXPIRED');
      this.#state.completedRequests++;
      if (status === 429 || status >= 500 || (mutation && status >= 300)) {
        this.#state.failure ??= 'PROVIDER_REJECTED';
      }
      // Only bounded response bytes reach the adapter; no provider headers or
      // request URL are retained in exceptions, logs or durable evidence.
      return new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
        status, headers: { 'content-type': 'application/json' },
      });
    } catch {
      // Only #fail chooses a code; a provider or port error cannot.
      return this.#fail(this.#state.failure ?? (signal.aborted ? 'DEADLINE_EXPIRED' : 'TRANSPORT_FAILED'));
    } finally {
      clearTimeout(timeout);
      const opened = reader;
      const answered = response;
      const pending = outgoing.sent;
      if (opened) cancelLater(() => opened);
      // a body refused by status or length before it was opened
      else if (answered) cancelLater(() => answered.body);
      // an answer arriving after the deadline
      else if (pending) void pending.then((late) => cancelLater(() => late?.body), ignore);
    }
  }
}
