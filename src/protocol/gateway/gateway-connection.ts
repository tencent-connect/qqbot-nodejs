/**
 * GatewayConnection — pure protocol-layer WebSocket lifecycle.
 *
 * Owns: WebSocket connection, heartbeat, reconnect, IDENTIFY/RESUME, event
 * dispatch.
 *
 * Does NOT own: token caching (delegated via callbacks), session persistence
 * (delegated via callbacks), business policies, message queueing.
 *
 * All state injected through the constructor — no module-level globals.
 *
 * Lifecycle invariants:
 * - State transitions (reconnect scheduling / settling) happen before any
 *   user callback is notified, and every callback is isolated, so a throwing
 *   handler can never stall the loop.
 * - Terminal failures are reported once, by rejecting `start()`.
 */

import WebSocket from "ws";
import type { GatewayAccount, InteractionEvent, Logger, WSPayload } from "../types.js";
import { decodeGatewayMessageData } from "./codec.js";
import {
  FULL_INTENTS,
  GatewayCloseCode,
  GatewayOp,
  HANDSHAKE_TIMEOUT_MS,
  INVALID_SESSION_DELAY,
  RATE_LIMIT_DELAY,
} from "./constants.js";
import { GatewayError, GatewayErrorCode } from "./errors.js";
import { dispatchEvent, type InboundMessage } from "./event-dispatcher.js";
import { ReconnectState, type ReconnectPolicy } from "./reconnect.js";

/** Persisted session info for RESUME after reconnection. */
export interface PersistedSession {
  sessionId: string;
  lastSeq: number | null;
}

/** Hooks for session persistence (optional). */
export interface SessionPersistencePort {
  load: () => PersistedSession | null;
  save: (session: PersistedSession) => void;
  clear: () => void;
}

/** A transport disconnect, reported before any reconnect attempt. */
export interface GatewayDisconnect {
  /** Remote close code; `1000` for gateway-requested reconnects (opcode 7 / 9). */
  code: number;
  reason: string;
  /** `false` means the retry budget is spent or the close is fatal; `start()` is about to reject. */
  willReconnect: boolean;
}

export interface GatewayConnectionOptions {
  account: GatewayAccount;
  abortSignal: AbortSignal;
  log?: Logger;

  /** User-Agent header sent on the WebSocket upgrade request. */
  userAgent?: string | (() => string);

  /** Resolve a fresh access_token for IDENTIFY / RESUME. */
  getAccessToken: () => Promise<string>;
  /** Force-clear any cached token (called when 4004 invalid token). */
  clearTokenCache?: () => void;
  /** Request the WebSocket gateway URL from the QQ Open Platform. */
  getGatewayUrl: (accessToken: string) => Promise<string>;

  /** Optional: persist session id + last seq across process restarts. */
  session?: SessionPersistencePort;

  /** Custom intent mask. Defaults to FULL_INTENTS. */
  intents?: number;

  /** Reconnect budget. Unlimited by default; set `maxAttempts` when an outer supervisor owns restarts. */
  reconnect?: Partial<ReconnectPolicy>;
  /** WebSocket upgrade timeout in ms. Defaults to {@link HANDSHAKE_TIMEOUT_MS}. */
  handshakeTimeoutMs?: number;

  // ---- Event handlers ----
  onReady?: (data: unknown) => void;
  onResumed?: (data: unknown) => void;
  /** Called when a reconnect sends RESUME (session recovery) before RESUMED/READY arrives. */
  onResuming?: () => void;
  /** Called when a connection sends IDENTIFY (fresh session: first connect, or RESUME was rejected). */
  onIdentifying?: () => void;
  /** Heartbeat ACK latency in milliseconds, measured from heartbeat send to ACK. */
  onHeartbeat?: (latencyMs: number) => void;
  /** Recoverable failures (connect errors, socket errors). Terminal failures reject `start()` instead. */
  onError?: (error: Error) => void;
  onDisconnected?: (event: GatewayDisconnect) => void;
  onMessage: (msg: InboundMessage) => void | Promise<void>;
  onInteraction?: (event: InteractionEvent) => void | Promise<void>;
  onRawEvent?: (type: string, data: unknown) => void | Promise<void>;
}

/** Pure-protocol gateway connection. Single-use: create a new instance to restart. */
export class GatewayConnection {
  private isAborted = false;
  private run: Promise<void> | null = null;
  private finish: (error?: Error) => void = () => {};
  private currentWs: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** Server-provided heartbeat interval of the current connection (0 before HELLO). */
  private heartbeatIntervalMs = 0;
  /** Forces terminate() when the zombie-close handshake stalls in a network black hole. */
  private zombieWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Jittered first heartbeat after HELLO; tracked so cleanup() can release it immediately. */
  private firstBeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a heartbeat is awaiting its ACK; a second beat without ACK means a zombie link. */
  private awaitingHeartbeatAck = false;
  /** Send timestamp of the in-flight heartbeat (0 when none is pending). */
  private lastHeartbeatSentAt = 0;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private isConnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRefreshToken = false;

  private readonly reconnect: ReconnectState;
  private readonly opts: GatewayConnectionOptions;
  private readonly resolveUserAgent: () => string;

  constructor(opts: GatewayConnectionOptions) {
    this.opts = opts;
    this.reconnect = new ReconnectState(opts.account.accountId, opts.log, opts.reconnect);
    const ua = opts.userAgent ?? "qqbot-nodejs/unknown";
    this.resolveUserAgent = typeof ua === "function" ? ua : () => ua;
  }

  /**
   * Start the connection loop.
   *
   * Resolves when `abortSignal` fires. Rejects with a {@link GatewayError} when
   * a finite reconnect budget is exhausted (`RETRY_EXHAUSTED`) or the gateway sends
   * a non-retryable close (`FATAL_CLOSE`). Repeated calls return the same promise.
   */
  start(): Promise<void> {
    this.run ??= new Promise<void>((resolve, reject) => {
      const signal = this.opts.abortSignal;
      const onAbort = () => this.finish();
      this.finish = (error) => {
        if (this.isAborted) return;
        this.isAborted = true;
        signal.removeEventListener("abort", onAbort);
        this.clearReconnectTimer();
        this.cleanup();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      if (signal.aborted) {
        this.finish();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        this.restoreSession();
      } catch (error) {
        this.finish(toError(error));
        return;
      }
      void this.connect();
    });
    return this.run;
  }

  // ============ Session persistence ============

  private restoreSession(): void {
    const saved = this.opts.session?.load();
    if (saved) {
      this.sessionId = saved.sessionId;
      this.lastSeq = saved.lastSeq;
      this.opts.log?.info?.(
        `[${this.opts.account.accountId}] Restored session: sessionId=${saved.sessionId}, lastSeq=${saved.lastSeq}`,
      );
    }
  }

  private saveCurrentSession(): void {
    const { session } = this.opts;
    if (!this.sessionId || !session) {
      return;
    }
    const snapshot = { sessionId: this.sessionId, lastSeq: this.lastSeq };
    this.notify("session.save", () => session.save(snapshot));
  }

  private resetSession(): void {
    this.sessionId = null;
    this.lastSeq = null;
    const { session } = this.opts;
    if (session) this.notify("session.clear", () => session.clear());
  }

  // ============ Callbacks + cleanup ============

  /** Invoke a user callback without letting sync throws or async rejections escape. */
  private notify(name: string, invoke: () => unknown): void {
    const report = (err: unknown) => {
      this.opts.log?.error(
        `[${this.opts.account.accountId}] ${name} handler threw: ${toError(err).message}`,
      );
    };
    try {
      const result = invoke();
      if (isPromiseLike(result)) Promise.resolve(result).catch(report);
    } catch (err) {
      report(err);
    }
  }

  /** Release the socket and heartbeat. Emits nothing. */
  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.awaitingHeartbeatAck = false;
    this.lastHeartbeatSentAt = 0;
    if (this.zombieWatchdog) {
      clearTimeout(this.zombieWatchdog);
      this.zombieWatchdog = null;
    }
    if (this.firstBeatTimer) {
      clearTimeout(this.firstBeatTimer);
      this.firstBeatTimer = null;
    }
    const ws = this.currentWs;
    // Retire ownership before close: ws can emit error/close after a replacement exists.
    this.currentWs = null;
    this.isConnecting = false;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ============ Reconnect ============

  /** Schedule the next attempt, or return the terminal error when the budget is spent. */
  private planReconnect(
    customDelay?: number,
    failure: { closeCode?: number; cause?: unknown } = {},
  ): GatewayError | null {
    if (this.reconnect.isExhausted()) {
      const error = new GatewayError(
        `Max reconnect attempts reached (${this.reconnect.maxAttempts})`,
        GatewayErrorCode.RETRY_EXHAUSTED,
        failure.closeCode,
        { cause: failure.cause },
      );
      this.opts.log?.error(`[${this.opts.account.accountId}] ${error.message}`);
      return error;
    }
    this.clearReconnectTimer();
    const delay = this.reconnect.getNextDelay(customDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    return null;
  }

  /** Report a disconnect after the reconnect decision is made, then settle if terminal. */
  private afterDisconnect(code: number, reason: string, terminal: GatewayError | null): void {
    const { onDisconnected } = this.opts;
    if (onDisconnected) {
      const event: GatewayDisconnect = { code, reason, willReconnect: terminal === null };
      this.notify("onDisconnected", () => onDisconnected(event));
    }
    if (terminal) this.finish(terminal);
  }

  // ============ Connect ============

  private async connect(): Promise<void> {
    const { log, account } = this.opts;

    if (this.isAborted) return;
    if (this.isConnecting) {
      log?.debug?.(`[${account.accountId}] Already connecting, skip`);
      return;
    }
    this.cleanup();
    this.isConnecting = true;

    try {
      if (this.shouldRefreshToken) {
        log?.debug?.(`[${account.accountId}] Refreshing token...`);
        this.opts.clearTokenCache?.();
        this.shouldRefreshToken = false;
      }

      const accessToken = await this.opts.getAccessToken();
      if (this.isAborted) return;
      log?.info(`[${account.accountId}] ✅ Access token obtained`);
      const gatewayUrl = await this.opts.getGatewayUrl(accessToken);
      if (this.isAborted) return;
      log?.info(`[${account.accountId}] Connecting to ${gatewayUrl}`);

      this.openSocket(gatewayUrl, accessToken);
    } catch (err) {
      if (this.isAborted) return;
      this.isConnecting = false;
      const error = toError(err);
      log?.error(`[${account.accountId}] Connection failed: ${error.message}`);
      const terminal = this.planReconnect(
        isRateLimitError(error.message) ? RATE_LIMIT_DELAY : undefined,
        { cause: error },
      );
      const { onError } = this.opts;
      if (onError) this.notify("onError", () => onError(error));
      if (terminal) this.finish(terminal);
    }
  }

  private openSocket(gatewayUrl: string, accessToken: string): void {
    const { log, account } = this.opts;
    const ws = new WebSocket(gatewayUrl, {
      headers: { "User-Agent": this.resolveUserAgent() },
      handshakeTimeout: this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    });
    this.currentWs = ws;

    ws.on("open", () => {
      if (ws !== this.currentWs) return;
      log?.info(`[${account.accountId}] WebSocket connected`);
      this.isConnecting = false;
      this.reconnect.onSocketOpen();
    });

    ws.on("message", (data) => {
      if (ws !== this.currentWs) return;
      try {
        const payload = JSON.parse(decodeGatewayMessageData(data)) as WSPayload;
        this.handlePayload(ws, payload, accessToken);
      } catch (err) {
        log?.error(`[${account.accountId}] Message parse error: ${toError(err).message}`);
      }
    });

    ws.on("close", (code, reason) => {
      if (ws !== this.currentWs) return;
      const reasonText = reason.toString();
      log?.info(`[${account.accountId}] WebSocket closed: ${code} ${reasonText}`);
      this.isConnecting = false;
      this.handleClose(code, reasonText);
    });

    ws.on("error", (err) => {
      if (ws !== this.currentWs) return;
      log?.error(`[${account.accountId}] WebSocket error: ${err.message}`);
      const { onError } = this.opts;
      if (onError) this.notify("onError", () => onError(err));
    });
  }

  // ============ Protocol handlers ============

  private handlePayload(ws: WebSocket, payload: WSPayload, accessToken: string): void {
    const { op, d, s } = payload;

    if (s) {
      this.lastSeq = s;
      this.saveCurrentSession();
    }

    switch (op) {
      case GatewayOp.HELLO:
        this.handleHello(ws, d, accessToken);
        break;

      case GatewayOp.DISPATCH:
        this.handleDispatch(payload);
        break;

      case GatewayOp.HEARTBEAT_ACK: {
        this.awaitingHeartbeatAck = false;
        if (this.lastHeartbeatSentAt !== 0) {
          const latency = Date.now() - this.lastHeartbeatSentAt;
          this.lastHeartbeatSentAt = 0;
          const { onHeartbeat } = this.opts;
          if (onHeartbeat) this.notify("onHeartbeat", () => onHeartbeat(latency));
        }
        break;
      }

      case GatewayOp.RECONNECT:
        this.handleGatewayReconnect("Gateway requested reconnect");
        break;

      case GatewayOp.INVALID_SESSION:
        // d = whether the session can be resumed
        if (!d) {
          this.resetSession();
          this.shouldRefreshToken = true;
        }
        this.handleGatewayReconnect("Invalid gateway session", INVALID_SESSION_DELAY);
        break;
    }
  }

  private handleDispatch(payload: WSPayload): void {
    const { log, account } = this.opts;
    const { d, t } = payload;
    log?.debug?.(`[${account.accountId}] Dispatch event: t=${t} payload=${previewPayload(d)}`);
    const result = dispatchEvent(t ?? "", d, account.accountId, log);

    if (result.action === "ready") {
      this.sessionId = result.sessionId;
      this.reconnect.onConnected();
      this.saveCurrentSession();
      const { onReady } = this.opts;
      if (onReady) this.notify("onReady", () => onReady(result.data));
    } else if (result.action === "resumed") {
      this.reconnect.onConnected();
      this.saveCurrentSession();
      const onResumed = this.opts.onResumed ?? this.opts.onReady;
      if (onResumed) this.notify("onResumed", () => onResumed(result.data));
    } else if (result.action === "interaction") {
      // Interaction 有 handler → 调用；否则 fallback 到 rawEvent
      const { onInteraction, onRawEvent } = this.opts;
      if (onInteraction) {
        this.notify("onInteraction", () => onInteraction(result.event));
      } else if (onRawEvent) {
        this.notify("onRawEvent", () => onRawEvent(t ?? "", d));
      }
    } else if (result.action === "message") {
      this.notify("onMessage", () => this.opts.onMessage(result.msg));
    } else if (result.action === "raw") {
      const { onRawEvent } = this.opts;
      if (onRawEvent) this.notify("onRawEvent", () => onRawEvent(result.type, result.data));
    }
  }

  private handleHello(ws: WebSocket, d: unknown, accessToken: string): void {
    // Validate before IDENTIFY/RESUME: a malformed interval would clamp
    // setInterval to 1ms and cause a heartbeat storm.
    const interval = readHeartbeatInterval(d);
    if (interval === null) {
      const { log, account } = this.opts;
      log?.error(
        `[${account.accountId}] Invalid HELLO heartbeat interval: ${previewPayload(d)}`,
      );
      this.handleGatewayReconnect("Invalid HELLO heartbeat interval");
      return;
    }

    const intents = this.opts.intents ?? FULL_INTENTS;
    if (this.sessionId && this.lastSeq !== null) {
      const { onResuming } = this.opts;
      if (onResuming) this.notify("onResuming", () => onResuming());
      ws.send(
        JSON.stringify({
          op: GatewayOp.RESUME,
          d: {
            token: `QQBot ${accessToken}`,
            session_id: this.sessionId,
            seq: this.lastSeq,
          },
        }),
      );
    } else {
      const { onIdentifying } = this.opts;
      if (onIdentifying) this.notify("onIdentifying", () => onIdentifying());
      ws.send(
        JSON.stringify({
          op: GatewayOp.IDENTIFY,
          d: {
            token: `QQBot ${accessToken}`,
            intents,
            shard: [0, 1],
          },
        }),
      );
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.heartbeatIntervalMs = interval;
    // HELLO 后先以 interval×random 的抖动发首拍（避免大规模部署下
    // 心跳相位与服务器下发时刻对齐），之后按固定间隔
    const jitter = Math.max(1, Math.floor(Math.random() * interval));
    this.firstBeatTimer = setTimeout(() => {
      this.firstBeatTimer = null;
      if (ws === this.currentWs) this.sendHeartbeat(ws);
    }, jitter);
    this.heartbeatInterval = setInterval(() => {
      if (ws !== this.currentWs) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      this.sendHeartbeat(ws);
    }, interval);
  }

  /**
   * Send one heartbeat. A still-unacknowledged previous beat means the link
   * is dead: close with 4009 — the server-side code for "please reconnect" —
   * so the reconnect path runs. The session is preserved server-side, so the
   * reconnect resumes from the last seq and replays missed events. Leave a
   * watchdog too: in a network black hole even the close handshake stalls.
   */
  private sendHeartbeat(ws: WebSocket): void {
    const { log, account } = this.opts;
    if (this.awaitingHeartbeatAck) {
      log?.warn?.(`[${account.accountId}] Heartbeat ACK timeout, closing ${GatewayCloseCode.SESSION_TIMEOUT}`);
      ws.close(GatewayCloseCode.SESSION_TIMEOUT, "heartbeat ACK timeout");
      if (this.zombieWatchdog) clearTimeout(this.zombieWatchdog);
      this.zombieWatchdog = setTimeout(() => {
        this.zombieWatchdog = null;
        if (ws.readyState !== WebSocket.CLOSED) {
          log?.warn?.(`[${account.accountId}] Close handshake stalled, terminating`);
          ws.terminate();
        }
      }, Math.max(1_000, Math.min(this.heartbeatIntervalMs, 5_000)));
      return;
    }
    this.awaitingHeartbeatAck = true;
    this.lastHeartbeatSentAt = Date.now();
    ws.send(JSON.stringify({ op: GatewayOp.HEARTBEAT, d: this.lastSeq }));
  }

  /** Opcode 7 / 9: drop the socket locally and reconnect. */
  private handleGatewayReconnect(reason: string, customDelay?: number): void {
    this.cleanup();
    const terminal = this.planReconnect(customDelay);
    this.afterDisconnect(GatewayCloseCode.NORMAL, reason, terminal);
  }

  private handleClose(code: number, reason: string): void {
    const action = this.reconnect.handleClose(code, this.isAborted);

    if (action.clearSession) {
      this.resetSession();
    }
    if (action.refreshToken) {
      this.shouldRefreshToken = true;
    }

    this.cleanup();

    const terminal = action.shouldReconnect
      ? this.planReconnect(action.reconnectDelay, { closeCode: code })
      : new GatewayError(
          `Gateway closed (${code}): ${action.reason}`,
          GatewayErrorCode.FATAL_CLOSE,
          code,
        );
    this.afterDisconnect(code, reason, terminal);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Read the HELLO heartbeat interval; numeric strings are coerced so a
 * server-side serialization change stays non-breaking. Returns `null` for
 * any value that cannot schedule a sane heartbeat.
 */
function readHeartbeatInterval(d: unknown): number | null {
  const raw = (d as { heartbeat_interval?: unknown }).heartbeat_interval;
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === "function";
}

function isRateLimitError(message: string): boolean {
  return message.includes("Too many requests") || message.includes("100001");
}

/**
 * Serialize a gateway event payload for debug logging.
 *
 * JSON-stringifies the payload; returns `"(non-serializable)"` for cyclic
 * or otherwise unserializable values so logging never throws.
 */
function previewPayload(data: unknown): string {
  if (data === undefined) return "undefined";
  if (data === null) return "null";
  try {
    const s = JSON.stringify(data);
    return s === undefined ? "(non-serializable)" : s;
  } catch {
    return "(non-serializable)";
  }
}
