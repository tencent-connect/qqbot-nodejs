import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, GatewayErrorCode, QQBot, type QQBotOptions } from '../src/index.js';
import type { EventTransport } from '../src/protocol/transport/types.js';
import { FAST_RETRY, OP, outcome, startFakeGateway, type FakeGateway } from './helpers/fake-gateway.js';

describe('QQBot construction', () => {
  it('throws when appId is missing', () => {
    expect(() => new QQBot({ appId: '', appSecret: 'x' })).toThrow(/appId/);
  });

  it('throws when appSecret is missing', () => {
    expect(() => new QQBot({ appId: 'x', appSecret: '' })).toThrow(/appSecret/);
  });

  it('exposes the protocol-layer primitives', () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    expect(bot.tokenManager).toBeDefined();
    expect(bot.apiClient).toBeDefined();
    expect(bot.messageApi).toBeDefined();
    expect(bot.mediaApi).toBeDefined();
    expect(bot.chunkedMediaApi).toBeDefined();
  });

  it('returns a chainable on() handle', () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    const handle = bot.on('ready', () => {});
    expect(handle).toBe(bot);
  });

  it('rejects sendTyping for non-c2c targets', async () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    await expect(
      bot.sendTyping({ scope: 'group', targetId: 'g1' }),
    ).rejects.toThrow(/c2c/i);
  });

  it('rejects openStream for non-c2c targets', () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    expect(() =>
      bot.openStream({ target: { scope: 'group', targetId: 'g1', msgId: 'm1' } }),
    ).toThrow(/c2c/i);
  });

  it('rejects openStream when msgId is missing', () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    expect(() =>
      bot.openStream({ target: { scope: 'c2c', targetId: 'u1' } }),
    ).toThrow(/msgId/i);
  });

  it('rejects an invalid reconnect policy at construction', () => {
    expect(() => new QQBot({ appId: 'app', appSecret: 'secret', reconnect: { maxAttempts: -1 } }))
      .toThrow(RangeError);
  });
});

describe('QQBot lifecycle', () => {
  let gw: FakeGateway;
  const bots: QQBot[] = [];

  function createBot(overrides: Partial<QQBotOptions> = {}) {
    const bot = new QQBot({ appId: 'test', appSecret: 'test', reconnect: FAST_RETRY, ...overrides });
    vi.spyOn(bot.tokenManager, 'getAccessToken').mockResolvedValue('test-token');
    vi.spyOn(bot.messageApi, 'getGatewayUrl').mockImplementation(async () => gw.url);
    bots.push(bot);
    return bot;
  }

  beforeEach(async () => {
    gw = await startFakeGateway();
  });

  afterEach(async () => {
    for (const bot of bots.splice(0)) bot.stop();
    await gw.close();
    vi.restoreAllMocks();
  });

  it('does not start a transport or token refresher after stop during initialization', async () => {
    const bot = createBot();
    let release!: (value: string) => void;
    vi.mocked(bot.tokenManager.getAccessToken).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const run = outcome(bot.start());

    bot.stop();
    release('test-token');

    await vi.waitFor(() => expect(run.status).toBe('resolved'));
    expect(bot.messageApi.getGatewayUrl).not.toHaveBeenCalled();
    expect(bot.tokenManager.isBackgroundRefreshRunning()).toBe(false);
  });

  it('rejects with a typed fatal error, forwards the disconnect, and can restart', async () => {
    const bot = createBot();
    const onReady = vi.fn();
    const onDisconnected = vi.fn();
    bot.on('ready', onReady).on('disconnected', onDisconnected);
    const run = outcome(bot.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    gw.sockets[0].close(4914, 'offline');

    await vi.waitFor(() => expect(run.status).toBe('rejected'));
    expect(run.error).toBeInstanceOf(GatewayError);
    expect(run.error).toMatchObject({ code: GatewayErrorCode.FATAL_CLOSE, closeCode: 4914 });
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith({ code: 4914, reason: 'offline', willReconnect: false });
    expect(bot.tokenManager.isBackgroundRefreshRunning()).toBe(false);

    const restarted = outcome(bot.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
    bot.stop();
    await vi.waitFor(() => expect(restarted.status).toBe('resolved'));
  });

  it('allows start() immediately after a synchronous stop() without the old run tearing down the new one', async () => {
    const bot = createBot();
    const onReady = vi.fn();
    bot.on('ready', onReady);
    const first = outcome(bot.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    bot.stop();
    const second = outcome(bot.start());

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
    expect(first.status).toBe('resolved');
    expect(second.status).toBe('pending');
    expect(bot.tokenManager.isBackgroundRefreshRunning('test')).toBe(true);

    bot.stop();
    await vi.waitFor(() => expect(second.status).toBe('resolved'));
    expect(bot.tokenManager.isBackgroundRefreshRunning()).toBe(false);
  });

  it('exposes the transport connection state across the lifecycle', async () => {
    const bot = createBot();
    expect(bot.connectionState).toBe('idle');

    const run = outcome(bot.start());
    expect(bot.connectionState).toBe('connecting');
    await vi.waitFor(() => expect(bot.connectionState).toBe('connected'));

    gw.sockets[0].close(4914, 'offline');
    await vi.waitFor(() => expect(run.status).toBe('rejected'));
    expect(bot.connectionState).toBe('disconnected');

    const restarted = outcome(bot.start());
    await vi.waitFor(() => expect(bot.connectionState).toBe('connected'));
    bot.stop();
    await vi.waitFor(() => expect(restarted.status).toBe('resolved'));
    expect(bot.connectionState).toBe('idle');
  });

  it('reports disconnected when startup fails', async () => {
    const bot = createBot();
    vi.mocked(bot.messageApi.getGatewayUrl).mockRejectedValue(new Error('gateway lookup failed'));
    const run = outcome(bot.start());
    await vi.waitFor(() => expect(run.status).toBe('rejected'));
    expect(bot.connectionState).toBe('disconnected');
  });

  it('emits connection transitions without duplicates', async () => {
    const bot = createBot();
    const transitions: string[] = [];
    bot.on('connection', (state, previous) => { transitions.push(`${previous}->${state}`); });
    expect(bot.connectionState).toBe('idle');

    const run = outcome(bot.start());
    await vi.waitFor(() => expect(bot.connectionState).toBe('connected'));
    expect(transitions).toEqual(['idle->connecting', 'connecting->connected']);

    bot.stop();
    await vi.waitFor(() => expect(run.status).toBe('resolved'));
    expect(transitions.at(-1)).toBe('connected->idle');
    expect(bot.connectionState).toBe('idle');
  });

  it('reports resuming while a reconnect recovers the session', async () => {
    gw.onConnection = (ws) => {
      ws.send(JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 100_000 } }));
      ws.on('message', (data) => {
        const { op } = JSON.parse(data.toString()) as { op: number };
        if (op === OP.IDENTIFY) {
          ws.send(JSON.stringify({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 's1' } }));
        }
        if (op === OP.RESUME) {
          setTimeout(() => {
            ws.send(JSON.stringify({ op: OP.DISPATCH, t: 'RESUMED', s: 2, d: {} }));
          }, 100);
        }
      });
    };
    const bot = createBot();
    const states: string[] = [];
    bot.on('connection', (state) => { states.push(state); });
    const run = outcome(bot.start());
    await vi.waitFor(() => expect(bot.connectionState).toBe('connected'));

    gw.sockets[0]?.terminate();
    await vi.waitFor(() => expect(states).toContain('resuming'));
    await vi.waitFor(() => expect(bot.connectionState).toBe('connected'));

    bot.stop();
    await vi.waitFor(() => expect(run.status).toBe('resolved'));
  });

  it('falls back from resuming to connecting when RESUME is rejected', async () => {
    gw.onConnection = (ws) => {
      ws.send(JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 100_000 } }));
      ws.on('message', (data) => {
        const { op } = JSON.parse(data.toString()) as { op: number };
        if (op === OP.IDENTIFY) {
          ws.send(JSON.stringify({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 's1' } }));
        }
        if (op === OP.RESUME) {
          ws.send(JSON.stringify({ op: OP.INVALID_SESSION, d: false }));
        }
      });
    };
    const bot = createBot();
    const states: string[] = [];
    bot.on('connection', (state) => { states.push(state); });
    const run = outcome(bot.start());
    await vi.waitFor(() => expect(bot.connectionState).toBe('connected'));

    gw.sockets[0]?.terminate();
    await vi.waitFor(() => expect(states).toContain('resuming'));
    // RESUME 被拒（session 失效）→ 重新 IDENTIFY：状态回到 connecting，READY 后再次 connected。
    // INVALID_SESSION 的重连退避为 3s，waitFor 放宽到 5s
    await vi.waitFor(() => expect(bot.connectionState).toBe('connected'), { timeout: 5000 });
    const resumingAt = states.lastIndexOf('resuming');
    expect(states.indexOf('connecting', resumingAt)).toBeGreaterThan(resumingAt);

    bot.stop();
    await vi.waitFor(() => expect(run.status).toBe('resolved'));
  });

  it('closes with 4009 after a missed heartbeat ACK and re-identifies', async () => {
    let beats = 0;
    gw.onConnection = (ws) => {
      ws.send(JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 10 } }));
      ws.on('message', (data) => {
        const { op } = JSON.parse(data.toString()) as { op: number };
        if (op === OP.HEARTBEAT) {
          beats += 1;
          return; // 不回 ACK：触发僵尸连接检测
        }
        if (op === OP.IDENTIFY) {
          ws.send(JSON.stringify({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 's1' } }));
        }
      });
    };
    const bot = createBot();
    const run = outcome(bot.start());
    await vi.waitFor(() => expect(beats).toBeGreaterThanOrEqual(2));
    // 4009 → clearSession → 重连 IDENTIFY → 新连接 READY
    await vi.waitFor(() => expect(gw.sockets.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(bot.connectionState).toBe('connected'));

    bot.stop();
    await vi.waitFor(() => expect(run.status).toBe('resolved'));
  });

  it('measures heartbeat latency and marks the last ACK', async () => {
    gw.onConnection = (ws) => {
      ws.send(JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 10 } }));
      ws.on('message', (data) => {
        const { op } = JSON.parse(data.toString()) as { op: number };
        if (op === OP.HEARTBEAT) ws.send(JSON.stringify({ op: OP.HEARTBEAT_ACK }));
        if (op === OP.IDENTIFY) {
          ws.send(JSON.stringify({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 's1' } }));
        }
      });
    };
    const bot = createBot();
    expect(bot.ping).toBe(-1);
    const run = outcome(bot.start());

    await vi.waitFor(() => expect(bot.ping).toBeGreaterThanOrEqual(0));
    expect(bot.lastHeartbeatAt).toBeTypeOf('number');

    bot.stop();
    await vi.waitFor(() => expect(run.status).toBe('resolved'));
  });

  it('stops a custom transport when the bot stops', async () => {
    let resolveStart!: () => void;
    const transport: EventTransport = {
      start: vi.fn(() => new Promise<void>((resolve) => { resolveStart = resolve; })),
      stop: vi.fn(() => resolveStart()),
    };
    const bot = createBot({ transport });
    const run = outcome(bot.start());
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalledOnce());

    bot.stop();

    await vi.waitFor(() => expect(run.status).toBe('resolved'));
    expect(transport.stop).toHaveBeenCalledOnce();
  });
});
