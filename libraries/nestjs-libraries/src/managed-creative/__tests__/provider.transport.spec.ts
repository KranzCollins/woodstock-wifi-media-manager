import { safeProviderCode } from '../contracts';
import { readBounded, readBoundedBytes, ProviderResponse } from '../providers/provider.transport';

describe('bounded provider body', () => {
  it('does not echo a token merely because it looks like a provider code', () => {
    expect(safeProviderCode('SECRET_PROVIDER_TOKEN')).toBeUndefined();
    expect(safeProviderCode('rate_limit_exceeded')).toBe('rate_limit_exceeded');
  });
  it('ends an uncooperative body at the caller deadline and cancels without waiting', async () => {
    const ac = new AbortController();
    const cancel = jest.fn(() => new Promise<void>(() => undefined));
    const response: ProviderResponse = { status: 200, body: { getReader: () => ({ read: () => new Promise(() => undefined), cancel }) } };
    const pending = readBounded(response, 100, ac.signal);
    ac.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'read_failed' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('replaces stream-open exceptions that contain provider credentials', async () => {
    const response: ProviderResponse = { status: 200, body: { getReader: () => { throw new Error('https://secret.invalid/?token=SECRET'); } } };
    await expect(readBounded(response, 100)).resolves.toEqual({ ok: false, reason: 'read_failed' });
  });
  it('refuses excess bytes even when cancellation throws', async () => {
    const response: ProviderResponse = { status: 200, body: { getReader: () => ({ read: async () => ({ done: false, value: Buffer.from('long') }), cancel: () => { throw new Error('SECRET'); } }) } };
    await expect(readBounded(response, 3)).resolves.toEqual({ ok: false, reason: 'too_large' });
  });
  it('rejects malformed UTF-8 rather than silently changing a provider answer', async () => {
    let done = false;
    const response: ProviderResponse = { status: 200, body: { getReader: () => ({ read: async () => {
      if (done) return { done: true }; done = true; return { done: false, value: new Uint8Array([0xff]) };
    }, cancel: async () => undefined }) } };
    await expect(readBounded(response, 10)).resolves.toEqual({ ok: false, reason: 'read_failed' });
  });
});

describe('bounded binary provider body', () => {
  it('reads bytes up to the bound and refuses past it', async () => {
    await expect(readBoundedBytes(new Response(new Uint8Array([0xff, 0xfb, 0x90])), 3)).resolves.toEqual({
      ok: true,
      bytes: Buffer.from([0xff, 0xfb, 0x90]),
    });
    await expect(readBoundedBytes(new Response(new Uint8Array(4)), 3)).resolves.toEqual({ ok: false, reason: 'too_large' });
  });
  it('an abort that lands while the reader is opened ends the read instead of hanging', async () => {
    const ac = new AbortController();
    const cancel = jest.fn(async () => undefined);
    const response: ProviderResponse = { status: 200, body: { getReader: () => {
      ac.abort();
      return { read: () => new Promise(() => undefined), cancel };
    } } };
    await expect(readBoundedBytes(response, 100, ac.signal)).resolves.toEqual({ ok: false, reason: 'read_failed' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('a pre-aborted signal never opens the body', async () => {
    const ac = new AbortController();
    ac.abort();
    const getReader = jest.fn();
    await expect(readBoundedBytes({ status: 200, body: { getReader } }, 100, ac.signal)).resolves.toEqual({ ok: false, reason: 'read_failed' });
    expect(getReader).not.toHaveBeenCalled();
  });
  it('a cancel that throws or returns nothing never escapes', async () => {
    for (const cancel of [() => { throw new Error('SECRET'); }, () => undefined]) {
      const response = { status: 200, body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(4) }), cancel }) } };
      await expect(readBoundedBytes(response as unknown as ProviderResponse, 3)).resolves.toEqual({ ok: false, reason: 'too_large' });
    }
  });
  it('a read that throws a provider url is only read_failed', async () => {
    const response: ProviderResponse = { status: 200, body: { getReader: () => ({ read: async () => {
      throw new Error('https://scratch.invalid/x?X-Amz-Signature=SECRET');
    }, cancel: async () => undefined }) } };
    await expect(readBoundedBytes(response, 10)).resolves.toEqual({ ok: false, reason: 'read_failed' });
  });
});
