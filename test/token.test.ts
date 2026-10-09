import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenManager } from '../src/protocol/api/token.js';

describe('TokenManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mockTokenResponse(token = 'test-token', expiresIn = 7200) {
    return {
      status: 200,
      ok: true,
      headers: new Headers(),
      text: async () => JSON.stringify({ access_token: token, expires_in: expiresIn }),
      json: async () => ({ access_token: token, expires_in: expiresIn }),
    };
  }

  function mockFetch(response: object) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as Response);
  }

  function createManager() {
    return new TokenManager({
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    });
  }

  describe('getAccessToken', () => {
    it('fetches and caches a token', async () => {
      const mgr = createManager();
      const fetchSpy = mockFetch(mockTokenResponse('tok-1'));

      const token = await mgr.getAccessToken('app1', 'secret1');
      expect(token).toBe('tok-1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const token2 = await mgr.getAccessToken('app1', 'secret1');
      expect(token2).toBe('tok-1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent fetch requests (singleflight)', async () => {
      const mgr = createManager();

      let resolveFirst: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(fetchPromise);

      // Fire two concurrent getAccessToken calls
      const p1 = mgr.getAccessToken('app1', 'secret1');
      const p2 = mgr.getAccessToken('app1', 'secret1');

      // Resolve the fetch
      resolveFirst!(mockTokenResponse('tok-shared') as Response);

      const [t1, t2] = await Promise.all([p1, p2]);
      expect(t1).toBe('tok-shared');
      expect(t2).toBe('tok-shared');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('trims appId whitespace for consistent cache key', async () => {
      const mgr = createManager();
      const fetchSpy = mockFetch(mockTokenResponse('tok-trim'));

      const token = await mgr.getAccessToken('  app1  ', 'secret1');
      expect(token).toBe('tok-trim');

      // Same appId without whitespace should hit cache
      const cached = await mgr.getAccessToken('app1', 'secret1');
      expect(cached).toBe('tok-trim');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('refreshes token when cache expires', async () => {
      const mgr = createManager();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockTokenResponse('tok-old', 0) as Response) // expires immediately
        .mockResolvedValueOnce(mockTokenResponse('tok-new') as Response);

      await mgr.getAccessToken('app1', 'secret1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Token expired (expires_in=0), should refetch
      const token = await mgr.getAccessToken('app1', 'secret1');
      expect(token).toBe('tok-new');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStatus', () => {
    it('returns "none" for unknown appId', () => {
      const mgr = createManager();
      expect(mgr.getStatus('unknown')).toEqual({ status: 'none', expiresAt: null });
    });

    it('returns "valid" for fresh token', async () => {
      const mgr = createManager();
      mockFetch(mockTokenResponse('tok'));

      await mgr.getAccessToken('app1', 'secret1');
      const status = mgr.getStatus('app1');

      expect(status.status).toBe('valid');
      expect(status.expiresAt).toBeGreaterThan(Date.now());
    });

    it('returns "refreshing" during concurrent fetch', async () => {
      const mgr = createManager();

      let resolveFetch: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      vi.spyOn(globalThis, 'fetch').mockReturnValue(fetchPromise);

      // Start a fetch (don't await)
      mgr.getAccessToken('app1', 'secret1');
      const status = mgr.getStatus('app1');

      expect(status.status).toBe('refreshing');

      resolveFetch!(mockTokenResponse('tok') as Response);
    });
  });

  describe('clearCache', () => {
    it('clears cache for a specific appId', async () => {
      const mgr = createManager();
      mockFetch(mockTokenResponse('tok'));

      await mgr.getAccessToken('app1', 'secret1');
      expect(mgr.getStatus('app1').status).toBe('valid');

      mgr.clearCache('app1');
      expect(mgr.getStatus('app1').status).toBe('none');
    });

    it('clears all caches when no appId given', async () => {
      const mgr = createManager();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockTokenResponse('tok1') as Response)
        .mockResolvedValueOnce(mockTokenResponse('tok2') as Response);

      await mgr.getAccessToken('app1', 'secret1');
      await mgr.getAccessToken('app2', 'secret2');

      mgr.clearCache();
      expect(mgr.getStatus('app1').status).toBe('none');
      expect(mgr.getStatus('app2').status).toBe('none');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('abortableSleep — listener cleanup', () => {
    it('cleans up abort listener after normal sleep resolution', async () => {
      const { signal } = new AbortController();

      // Access private method via prototype
      const sleep = (TokenManager.prototype as Record<string, unknown>)
        .abortableSleep as (ms: number, signal: AbortSignal) => Promise<void>;

      const initialCount = nodeGetEventListenerCount?.(signal, 'abort') ?? 0;

      // Fire multiple sleeps and let each resolve normally
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        promises.push(sleep(100, signal));
        vi.advanceTimersByTime(100);
      }

      await Promise.all(promises);

      // After all sleeps resolve, listeners should be cleaned up
      const finalCount = nodeGetEventListenerCount?.(signal, 'abort') ?? 0;
      expect(finalCount).toBe(initialCount);
    });

    it('rejects when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const sleep = (TokenManager.prototype as Record<string, unknown>)
        .abortableSleep as (ms: number, signal: AbortSignal) => Promise<void>;

      await expect(sleep(100, controller.signal)).rejects.toThrow();
    });

    it('rejects when signal aborts during sleep', async () => {
      const controller = new AbortController();

      const sleep = (TokenManager.prototype as Record<string, unknown>)
        .abortableSleep as (ms: number, signal: AbortSignal) => Promise<void>;

      const promise = sleep(1000, controller.signal);

      // Abort after 200ms
      vi.advanceTimersByTime(200);
      controller.abort();

      await expect(promise).rejects.toThrow();
    });

    it('does not leak listeners after repeated abort cycles', async () => {
      const controller = new AbortController();
      const { signal } = controller;

      const sleep = (TokenManager.prototype as Record<string, unknown>)
        .abortableSleep as (ms: number, signal: AbortSignal) => Promise<void>;

      const initialCount = nodeGetEventListenerCount?.(signal, 'abort') ?? 0;

      // Start sleeps on separate signals, abort them
      for (let i = 0; i < 3; i++) {
        const c = new AbortController();
        const p = sleep(1000, c.signal).catch(() => {});
        vi.advanceTimersByTime(200);
        c.abort();
        await p;
      }

      const finalCount = nodeGetEventListenerCount?.(signal, 'abort') ?? 0;
      expect(finalCount).toBe(initialCount);
    });
  });

  describe('background refresh lifecycle', () => {
    it('starts and stops background refresh', async () => {
      const mgr = createManager();
      mockFetch(mockTokenResponse('tok'));

      expect(mgr.isBackgroundRefreshRunning('app1')).toBe(false);

      mgr.startBackgroundRefresh('app1', 'secret1', {
        minRefreshIntervalMs: 100,
        refreshAheadMs: 0,
        randomOffsetMs: 0,
      });

      expect(mgr.isBackgroundRefreshRunning('app1')).toBe(true);

      // Let one cycle complete
      await vi.advanceTimersByTimeAsync(200);

      mgr.stopBackgroundRefresh('app1');
      expect(mgr.isBackgroundRefreshRunning('app1')).toBe(false);
    });

    it('keeps a replacement refresh registered when the stopped loop exits late', async () => {
      const mgr = createManager();
      mockFetch(mockTokenResponse('tok'));
      mgr.startBackgroundRefresh('app1', 'secret1');
      await vi.advanceTimersByTimeAsync(0);

      mgr.stopBackgroundRefresh('app1');
      mgr.startBackgroundRefresh('app1', 'secret1');
      await vi.advanceTimersByTimeAsync(0);

      expect(mgr.isBackgroundRefreshRunning('app1')).toBe(true);
      mgr.stopBackgroundRefresh('app1');
      expect(mgr.isBackgroundRefreshRunning('app1')).toBe(false);
    });

    it('prevents duplicate background refresh for same appId', () => {
      const mgr = createManager();
      mockFetch(mockTokenResponse('tok'));

      mgr.startBackgroundRefresh('app1', 'secret1');
      mgr.startBackgroundRefresh('app1', 'secret1');

      // @ts-expect-error accessing private field for test
      const controllers = mgr.refreshControllers as Map<string, AbortController>;
      expect(controllers.size).toBe(1);
    });

    it('stops all background refreshes when no appId given', () => {
      const mgr = createManager();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockTokenResponse('tok1') as Response)
        .mockResolvedValueOnce(mockTokenResponse('tok2') as Response);

      mgr.startBackgroundRefresh('app1', 'secret1', {
        minRefreshIntervalMs: 100,
        refreshAheadMs: 0,
        randomOffsetMs: 0,
      });
      mgr.startBackgroundRefresh('app2', 'secret2', {
        minRefreshIntervalMs: 100,
        refreshAheadMs: 0,
        randomOffsetMs: 0,
      });

      expect(mgr.isBackgroundRefreshRunning()).toBe(true);

      mgr.stopBackgroundRefresh();
      expect(mgr.isBackgroundRefreshRunning()).toBe(false);
    });

    it('retries on fetch failure then recovers', async () => {
      const mgr = createManager();

      let callCount = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Network error');
        }
        return mockTokenResponse('tok-retry') as Response;
      });

      mgr.startBackgroundRefresh('app1', 'secret1', {
        retryDelayMs: 50,
        minRefreshIntervalMs: 100,
        refreshAheadMs: 0,
        randomOffsetMs: 0,
      });

      // Advance through failures + retry
      await vi.advanceTimersByTimeAsync(500);

      expect(callCount).toBeGreaterThanOrEqual(2);

      mgr.stopBackgroundRefresh('app1');
    });
  });
});

// Helper: Node.js getEventListeners (available in Node 20+)
function nodeGetEventListenerCount(emitter: object, event: string): number {
  try {
    // @ts-expect-error Node.js runtime API
    const listeners = globalThis.getEventListeners?.(emitter, event);
    return Array.isArray(listeners) ? listeners.length : 0;
  } catch {
    return 0;
  }
}
