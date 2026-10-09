# @tencent-connect/qqbot-nodejs

> **English** (this file) · [简体中文](./README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/@tencent-connect/qqbot-nodejs.svg)](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs)
[![CI](https://github.com/tencent-connect/qqbot-nodejs/actions/workflows/ci.yml/badge.svg)](https://github.com/tencent-connect/qqbot-nodejs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/node/v/@tencent-connect/qqbot-nodejs.svg)](https://nodejs.org)

Tencent QQ Open Platform Node.js SDK. Provides every protocol-layer capability
needed to integrate with the QQ Bot Open Platform: HTTP REST, dual WebSocket /
Webhook transport, a Koa-style middleware pipeline, messaging, media upload
(including chunked upload for large files), and C2C streaming messages
(`stream_messages`).

## Requirements

- Node.js **>= 20** (uses global `fetch` / `AbortController`)
- Pure ESM (`"type": "module"`); CJS consumers should use dynamic `import()`

## Install

```bash
pnpm add @tencent-connect/qqbot-nodejs
# or
npm install @tencent-connect/qqbot-nodejs
```

## Quick Start

```ts
import { QQBot } from "@tencent-connect/qqbot-nodejs";

const bot = new QQBot({
  appId: process.env.QQBOT_APP_ID!,
  appSecret: process.env.QQBOT_APP_SECRET!,
  logger: console,
});

bot.on("message", async (ctx, msg) => {
  // ctx — Koa-style MiddlewareContext carrying data injected by middleware
  await bot.sendText(msg.replyTarget, `Echo: ${msg.content}`);
});

await bot.start();
```

See the complete examples under [examples/](./examples/):

| Example | Description |
|------|------|
| [playground](./examples/playground/) | Core capabilities demo (text, streaming, media, commands) |
| [middleware](./examples/middleware/) | Full 13-layer Koa-style middleware pipeline |
| [webhook](./examples/webhook/) | Webhook (HTTP callback) transport |
| [send-plain-100](./examples/send-plain-100/) | Plain-text send baseline |
| [send-streaming-100](./examples/send-streaming-100/) | Streaming-message send baseline |

> Examples read `QQBOT_APP_ID` / `QQBOT_APP_SECRET` from `process.env` **only
> for demo convenience**. The SDK itself never reads environment variables —
> credentials are always injected via `new QQBot({ appId, appSecret })`.

## Features

### 1. Dual transport (WebSocket / Webhook)

```ts
// WebSocket (default) — long-lived connection + heartbeat + RESUME
const bot = new QQBot({ appId, appSecret });

// Webhook — HTTP callback, suited to Serverless / horizontal scaling
const bot = new QQBot({
  appId, appSecret,
  transport: "webhook",
  webhook: { port: 8080, path: "/callback" },
});
```

Middleware, event listeners and send APIs are identical in both modes.

### 2. Koa-style middleware

The SDK uses an onion-model middleware chain; `bot.on("message")` is the
innermost downstream:

```ts
import { errorHandler, messageFilter, contentSanitizer, mentionGate } from "@tencent-connect/qqbot-nodejs";

bot.use(errorHandler());
bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5000 } }));
bot.use(contentSanitizer({ stripBotMention: true }));
bot.use(mentionGate({ requireMentionInGroup: true }));

// Custom middleware
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  ctx.log.debug?.(`elapsed: ${Date.now() - start}ms`);
});
```

Built-in middleware:

| Middleware | Purpose |
|--------|------|
| `errorHandler` | Unified error capture + friendly reply |
| `messageFilter` | Bot echo filtering + message dedup |
| `rateLimiter` | Three-tier rate limiting (sender / group / global) |
| `concurrencyGuard` | Serial processing per user / group (avoids stream races) |
| `accessPolicy` | Allow / block lists |
| `contentSanitizer` | Strip @markers / face tags / whitespace |
| `mentionGate` | Group @bot gating |
| `quoteRef` | Message index recording + quoted-message resolution |
| `historyBuffer` | Group history buffer |
| `envelopeFormatter` | Assemble LLM prompt context (XML tags) |
| `typingIndicator` | Automatic C2C typing |
| `slashCommand` | /cmd command framework |

### 3. Text messages

```ts
await bot.sendText(target, "hello");
```

### 4. Files / images / voice

`sendImage` / `sendVoice` / `sendVideo` / `sendFile` are convenience wrappers
over `sendMedia`. Sources ≥ 5 MB switch to chunked upload automatically.

```ts
await bot.sendImage(target, { localPath: "/tmp/cat.jpg" });

await bot.sendFile(
  target,
  { buffer: bigBuffer },
  {
    fileName: "report.pdf",
    onProgress: (uploaded, total) => console.log(`${uploaded}/${total}`),
  },
);
```

### 5. C2C streaming messages

```ts
const stream = bot.openStream({ target });
for (const partial of generator) {
  await stream.update(partial);
}
await stream.complete();
```

QQ Open Platform constraint: `stream_messages` is available for C2C (private chat) only.

### 6. Events

```ts
bot.on("ready", () => console.log("connected"));
bot.on("resumed", () => console.log("reconnected"));
bot.on("disconnected", ({ code, willReconnect }) => console.log("closed", code, willReconnect));
bot.on("error", (err) => console.error(err)); // recoverable failures; never ends start()
bot.on("message", (ctx, msg) => { /* C2C / Group / Guild / DM */ });
bot.on("interaction", (ctx, event) => { /* button click etc. */ });
```

### 7. Lifecycle

WebSocket mode reconnects forever by default. `start()` resolves on `stop()` /
abort, and rejects — after releasing the connection and token refresher — only
when it cannot recover:

| Rejection | Cause | Handling |
|---|---|---|
| `GatewayError` `GATEWAY_FATAL_CLOSE` | 4914 offline / sandbox-only, 4915 banned | Needs operator action; don't restart |
| `GatewayError` `GATEWAY_RETRY_EXHAUSTED` | Only with a finite `reconnect.maxAttempts` | Restart with backoff |
| `Error` | Startup token fetch failed (default `tokenPrefetch: "sync"`) | Check credentials / network |

```ts
import { GatewayErrorCode, QQBot } from "@tencent-connect/qqbot-nodejs";

// Set a limit only when an outer supervisor owns process-level restarts
const bot = new QQBot({ appId, appSecret, reconnect: { maxAttempts: 10 } });
try {
  await bot.start(signal);
} catch (err) {
  if ((err as { code?: string }).code === GatewayErrorCode.FATAL_CLOSE) markBlocked(err);
  else scheduleRestart(err);
}
```

`bot.stop(); bot.start();` restarts in place. See [USAGE.md §7](./USAGE.md#7-生命周期管理)
for close-code handling.

### 8. Protocol-level access

```ts
import {
  ApiClient,
  TokenManager,
  GatewayConnection,
  withRetry,
} from "@tencent-connect/qqbot-nodejs/protocol";
```

## Documentation

- **[USAGE.md](./USAGE.md)** — complete usage guide (currently in Chinese;
  contributions to translate are very welcome).

## Optional dependencies

These `peerDependencies` are declared as optional. Install them only if you
need the feature:

| Package           | Enables                                    |
| ----------------- | ------------------------------------------ |
| `silk-wasm`       | Sending voice messages (SILK encoding)     |
| `mpg123-decoder`  | Decoding MP3 audio to PCM before encoding  |

## Contributing

Bug reports, feature proposals and pull requests are welcome. Please read:

- [CONTRIBUTING.md](./CONTRIBUTING.md) — dev workflow & commit convention
- [SECURITY.md](./SECURITY.md) — how to report vulnerabilities privately

## Module structure

```
src/
├── QQBot.ts                ← High-level facade
├── streaming.ts            ← C2C streaming-message controller
├── index.ts                ← Public API
├── middleware/              ← Koa-style middleware
│   ├── types.ts                  Middleware types + onion runner
│   ├── error-handler.ts          Unified error capture
│   ├── message-filter.ts         Echo filtering + dedup
│   ├── rate-limiter.ts           Three-tier rate limiting
│   ├── concurrency-guard.ts     Serial processing per user / group
│   ├── access-policy.ts          Allow / block lists
│   ├── content-sanitizer.ts      Content sanitizing
│   ├── mention-gate.ts           @bot gating
│   ├── quote-ref.ts              Quote resolution + message index
│   ├── history-buffer.ts         Group history buffer
│   ├── envelope-formatter.ts     LLM prompt assembly
│   ├── typing-indicator.ts       Typing state
│   └── slash-command.ts          Command framework
└── protocol/               ← Protocol layer
    ├── api/
    │   ├── api-client.ts         HTTP client
    │   ├── token.ts              access_token management
    │   ├── messages.ts           Message sending
    │   ├── media.ts              Small-file upload
    │   ├── media-chunked.ts      Chunked large-file upload
    │   ├── retry.ts              Retry engine
    │   └── routes.ts             Route templates
    ├── gateway/
    │   ├── constants.ts          opcode / intent / close code
    │   ├── codec.ts              Message decoding
    │   ├── reconnect.ts          Reconnect state machine + reconnect policy
    │   ├── errors.ts             GatewayError (terminal start() errors)
    │   ├── event-dispatcher.ts   Event → InboundMessage
    │   └── gateway-connection.ts WebSocket lifecycle
    ├── transport/
    │   ├── types.ts              EventTransport interface
    │   ├── webhook.ts            Webhook transport
    │   ├── webhook-verify.ts     Ed25519 signature verification
    │   └── webhook-server-node.ts  Built-in node:http adapter
    ├── utils/
    │   ├── format.ts             Formatting helpers
    │   ├── file-utils.ts         File helpers
    │   └── upload-cache.ts       file_info TTL cache
    ├── types.ts                  All public types + errors
    └── index.ts                  protocol sub-entry
```

## Contributors

Thanks to everyone who has contributed to this project!

<a href="https://github.com/tencent-connect/qqbot-nodejs/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=tencent-connect/qqbot-nodejs" alt="Contributors" />
</a>

<sub>Contributor avatars are rendered by [contrib.rocks](https://contrib.rocks).</sub>

## License

[MIT](./LICENSE) © Tencent
