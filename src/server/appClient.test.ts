import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchState,
  isTransientNetworkError,
  NETWORK_RETRY_DELAY_MS,
  recalibrateRemote,
  requestRemoteMeter,
  runRemotePress,
  saveState,
  ServerAuthError,
} from '@/server/appClient';

const config = { url: 'http://127.0.0.1:9', publishableKey: 'publishable-placeholder' };
const appKey = 'local-check';

function lost(): TypeError {
  return new TypeError('fetch failed: The network connection was lost.');
}

describe('transient network errors', () => {
  const original = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original;
    vi.useRealTimers();
  });

  it('classifies dropped connections, fetch failures, and timeouts', () => {
    expect(isTransientNetworkError(lost())).toBe(true);
    expect(isTransientNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error('Network request failed'), { name: 'FetchError' }))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientNetworkError(new Error('The request timed out'))).toBe(true);
    expect(isTransientNetworkError(new ServerAuthError())).toBe(false);
    expect(isTransientNetworkError(new Error('Server request failed (500).'))).toBe(false);
    expect(isTransientNetworkError('fetch failed')).toBe(false);
  });

  it('retries an idempotent read once and then returns the recovered response', async () => {
    vi.useFakeTimers();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw lost();
      }
      return new Response(JSON.stringify({ version: 4 }), { status: 200 });
    }) as typeof fetch;
    const pending = fetchState(config, appKey);
    await vi.advanceTimersByTimeAsync(NETWORK_RETRY_DELAY_MS);
    await expect(pending).resolves.toMatchObject({ version: 4 });
    expect(calls).toBe(2);
  });

  it('retries the meter read once and gives up when the retry also fails', async () => {
    vi.useFakeTimers();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      throw lost();
    }) as typeof fetch;
    const pending = requestRemoteMeter(config, appKey);
    const assertion = expect(pending).rejects.toThrow(/network connection was lost/);
    await vi.advanceTimersByTimeAsync(NETWORK_RETRY_DELAY_MS);
    await assertion;
    expect(calls).toBe(2);
  });

  it('does not retry a state write, a press, a recalibration, or an HTTP error', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      throw lost();
    }) as typeof fetch;
    await expect(saveState(config, appKey, { version: 1, roomLabel: 'Home' })).rejects.toThrow(/network connection was lost/);
    await expect(runRemotePress(config, appKey, { target: 70, source: { kind: 'manual' } })).rejects.toThrow(
      /network connection was lost/,
    );
    await expect(recalibrateRemote(config, appKey, 70)).rejects.toThrow(/network connection was lost/);
    expect(calls).toBe(3);

    calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'Server request failed (500).' }), { status: 500 });
    }) as typeof fetch;
    await expect(fetchState(config, appKey)).rejects.toThrow(/Server request failed/);
    expect(calls).toBe(1);
  });
});
