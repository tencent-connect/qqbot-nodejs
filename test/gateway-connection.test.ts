import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { GatewayConnection, type GatewayConnectionOptions } from '../src/protocol/gateway/gateway-connection.js';
import { INVALID_SESSION_DELAY } from '../src/protocol/gateway/constants.js';
import { GatewayError, GatewayErrorCode } from '../src/protocol/gateway/errors.js';
import { resolveReconnectPolicy } from '../src/protocol/gateway/reconnect.js';
import {
  FAST_RETRY,
  OP,
  outcome,
  startBlackhole,
  startFakeGateway,
  type FakeGateway,
} from './helpers/fake-gateway.js';

const account = { accountId: 'test', appId: 'test', clientSecret: 'test' };
const controllers: AbortController[] = [];
let gw: FakeGateway;

function connection(overrides: Partial<GatewayConnectionOptions> = {}) {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    controller,
    gateway: new GatewayConnection({
      account,
      abortSignal: controller.signal,
      reconnect: FAST_RETRY,
      getAccessToken: async () => 'test-token',
      getGatewayUrl: async () => gw.url,
      onMessage: () => {},
      ...overrides,
    }),
  };
}

const sessions = (onReady: ReturnType<typeof vi.fn>, onResumed: ReturnType<typeof vi.fn>) =>
  onReady.mock.calls.length + onResumed.mock.calls.length;

beforeEach(async () => {
  gw = await startFakeGateway();
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await gw.close();
  vi.restoreAllMocks();
});

describe('GatewayConnection recovery', () => {
  it('reports a recoverable disconnect and resumes', async () => {
    const onReady = vi.fn();
    const onResumed = vi.fn();
    const onDisconnected = vi.fn();
    const { gateway } = connection({ onReady, onResumed, onDisconnected });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    gw.sockets[0].terminate();

    await vi.waitFor(() => expect(onResumed).toHaveBeenCalledOnce());
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith({ code: 1006, reason: '', willReconnect: true });
    expect(run.status).toBe('pending');
  });

  it.each([1000, 4009, 4900])('reconnects after remote close %i', async (code) => {
    const onReady = vi.fn();
    const onResumed = vi.fn();
    const onDisconnected = vi.fn();
    const { gateway } = connection({ onReady, onResumed, onDisconnected });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    gw.sockets[0].close(code, 'server close');

    await vi.waitFor(() => expect(sessions(onReady, onResumed)).toBe(2));
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith({ code, reason: 'server close', willReconnect: true });
    expect(run.status).toBe('pending');
  });

  it.each([4914, 4915])('rejects with FATAL_CLOSE on remote close %i without reconnecting', async (code) => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const onDisconnected = vi.fn();
    const { gateway } = connection({ onReady, onError, onDisconnected });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    gw.sockets[0].close(code, 'terminal');

    await vi.waitFor(() => expect(run.status).toBe('rejected'));
    expect(run.error).toBeInstanceOf(GatewayError);
    expect(run.error).toMatchObject({ code: GatewayErrorCode.FATAL_CLOSE, closeCode: code });
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith({ code, reason: 'terminal', willReconnect: false });
    expect(onError).not.toHaveBeenCalled();
    await sleep(20);
    expect(gw.sockets).toHaveLength(1);
  });

  it('rejects with RETRY_EXHAUSTED once the budget is spent, and a new instance can restart', async () => {
    let online = true;
    const onReady = vi.fn();
    const onError = vi.fn();
    const outage = new Error('simulated outage');
    const getGatewayUrl = vi.fn(async () => {
      if (!online) throw outage;
      return gw.url;
    });
    const { gateway } = connection({ onReady, onError, getGatewayUrl });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    online = false;
    gw.sockets[0].terminate();

    await vi.waitFor(() => expect(run.status).toBe('rejected'));
    expect(run.error).toMatchObject({
      code: GatewayErrorCode.RETRY_EXHAUSTED,
      message: expect.stringMatching(/reconnect attempts/i),
      cause: outage,
    });
    // 1 initial connect + one call per allowed attempt.
    expect(getGatewayUrl).toHaveBeenCalledTimes(1 + FAST_RETRY.maxAttempts);
    expect(onError).toHaveBeenCalledTimes(FAST_RETRY.maxAttempts);
    expect(onError).toHaveBeenCalledWith(outage);

    online = true;
    const restarted = connection({ onReady });
    outcome(restarted.gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
  });

  it('exhausts the budget when the socket opens but the session never becomes ready (4004 loop)', async () => {
    gw.onConnection = (ws) => {
      ws.send(JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 100_000 } }));
      ws.on('message', () => ws.close(4004, 'invalid token'));
    };
    const clearTokenCache = vi.fn();
    const onDisconnected = vi.fn();
    const { gateway } = connection({ clearTokenCache, onDisconnected });
    const run = outcome(gateway.start());

    await vi.waitFor(() => expect(run.status).toBe('rejected'));
    expect(run.error).toMatchObject({ code: GatewayErrorCode.RETRY_EXHAUSTED, closeCode: 4004 });
    expect(gw.sockets).toHaveLength(1 + FAST_RETRY.maxAttempts);
    expect(clearTokenCache).toHaveBeenCalledTimes(FAST_RETRY.maxAttempts);
    expect(onDisconnected).toHaveBeenLastCalledWith({ code: 4004, reason: 'invalid token', willReconnect: false });
  });

  it('times out a black-holed handshake and keeps retrying', async () => {
    const blackhole = await startBlackhole();
    try {
      const onError = vi.fn();
      const { gateway } = connection({
        onError,
        handshakeTimeoutMs: 50,
        reconnect: { delays: [1], maxAttempts: 1 },
        getGatewayUrl: async () => blackhole.url,
      });
      const run = outcome(gateway.start());

      await vi.waitFor(() => expect(run.status).toBe('rejected'), { timeout: 2000 });
      expect(run.error).toMatchObject({ code: GatewayErrorCode.RETRY_EXHAUSTED });
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/handshake/i) }));
    } finally {
      await blackhole.close();
    }
  });

  it('keeps recovering when user callbacks throw', async () => {
    const log = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const onReady = vi.fn(() => { throw new Error('ready boom'); });
    const onResumed = vi.fn(async () => { throw new Error('resumed boom'); });
    const onDisconnected = vi.fn(() => { throw new Error('disconnect boom'); });
    const { gateway } = connection({ log, onReady, onResumed, onDisconnected });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    gw.sockets[0].terminate();

    await vi.waitFor(() => expect(onResumed).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/onResumed handler threw/)));
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/onDisconnected handler threw/));
    expect(run.status).toBe('pending');
  });

  it('settles a fatal close even when onDisconnected throws', async () => {
    const onReady = vi.fn();
    const { gateway } = connection({ onReady, onDisconnected: () => { throw new Error('boom'); } });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    gw.sockets[0].close(4914, 'offline');

    await vi.waitFor(() => expect(run.status).toBe('rejected'));
  });

  it.each([OP.RECONNECT, OP.INVALID_SESSION])('keeps one replacement connection after gateway opcode %i', async (op) => {
    // Only compress the fixed opcode-9 delay; reconnect backoff comes from FAST_RETRY.
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) =>
      realSetTimeout(callback, delay === INVALID_SESSION_DELAY ? 1 : delay, ...args)) as typeof setTimeout);
    const onReady = vi.fn();
    const onResumed = vi.fn();
    const onDisconnected = vi.fn();
    const { gateway } = connection({ onReady, onResumed, onDisconnected });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    gw.sockets[0].send(JSON.stringify({ op, d: false }));

    await vi.waitFor(() => expect(sessions(onReady, onResumed)).toBe(2));
    await sleep(20);
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 1000, willReconnect: true }));
    expect(gw.sockets).toHaveLength(2);
    expect(gw.sockets[1].readyState).toBe(WebSocket.OPEN);
    expect(run.status).toBe('pending');
  });
});

describe('GatewayConnection abort', () => {
  it('resolves an already-aborted start without fetching credentials', async () => {
    const controller = new AbortController();
    controller.abort();
    const getAccessToken = vi.fn(async () => 'test-token');
    const { gateway } = connection({ abortSignal: controller.signal, getAccessToken });
    await expect(gateway.start()).resolves.toBeUndefined();
    await expect(gateway.start()).resolves.toBeUndefined();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it.each(['token', 'url'])('settles abort during %s lookup and does not open a late socket', async (phase) => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const lookup = vi.fn(() => pending);
    const { gateway, controller } = connection(phase === 'token'
      ? { getAccessToken: lookup }
      : { getGatewayUrl: lookup });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());

    controller.abort();
    await sleep(10);
    expect(run.status).toBe('resolved');

    release(phase === 'token' ? 'test-token' : gw.url);
    await sleep(20);
    expect(gw.sockets).toHaveLength(0);
  });

  it('does not report a disconnect for a local abort', async () => {
    const onReady = vi.fn();
    const onDisconnected = vi.fn();
    const { gateway, controller } = connection({ onReady, onDisconnected });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    controller.abort();

    await vi.waitFor(() => expect(run.status).toBe('resolved'));
    await sleep(20);
    expect(onDisconnected).not.toHaveBeenCalled();
  });
});

describe('GatewayConnection options', () => {
  it.each([
    { maxAttempts: -1 },
    { maxAttempts: 1.5 },
    { delays: [] },
    { delays: [Number.NaN] },
  ])('rejects invalid reconnect policy %o at construction', (reconnect) => {
    expect(() => connection({ reconnect })).toThrow(RangeError);
  });

  it('defaults to an unlimited reconnect budget', () => {
    expect(resolveReconnectPolicy().maxAttempts).toBe(Number.POSITIVE_INFINITY);
    expect(resolveReconnectPolicy({ maxAttempts: Number.POSITIVE_INFINITY }).maxAttempts)
      .toBe(Number.POSITIVE_INFINITY);
    expect(resolveReconnectPolicy({ maxAttempts: 0 }).maxAttempts).toBe(0);
  });

  it('keeps retrying without settling when maxAttempts is left at the default', async () => {
    const attempts = 20;
    const getGatewayUrl = vi.fn(async () => {
      throw new Error('simulated outage');
    });
    // Only the backoff delays are overridden; maxAttempts stays at the unlimited default.
    const { gateway, controller } = connection({ reconnect: { delays: [1] }, getGatewayUrl });
    const run = outcome(gateway.start());

    await vi.waitFor(() => expect(getGatewayUrl.mock.calls.length).toBeGreaterThan(attempts));
    expect(run.status).toBe('pending');

    controller.abort();
    await vi.waitFor(() => expect(run.status).toBe('resolved'));
  });
});
