# @tencent-connect/qqbot-nodejs

> English (this file) · [简体中文](./README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/@tencent-connect/qqbot-nodejs.svg)](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs)
[![CI](https://github.com/tencent-connect/qqbot-nodejs/actions/workflows/ci.yml/badge.svg)](https://github.com/tencent-connect/qqbot-nodejs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/node/v/@tencent-connect/qqbot-nodejs.svg)](https://nodejs.org)

Node.js SDK for the **QQ Open Platform**. Ships every protocol primitive you
need to talk to the platform:

- HTTP REST client with token management & retry policies
- Dual transport: **WebSocket Gateway** and **Webhook**
- Koa-style **middleware pipeline** with 12 batteries-included stages
- Text / media (image / voice / video / file) messaging, including
  automatic **chunked upload** for large files
- C2C **streaming messages** (`stream_messages`, replace-mode)
- First-class TypeScript types

Positioned like [`@line/bot-sdk`](https://github.com/line/line-bot-sdk-nodejs)
and [`@larksuiteoapi/node-sdk`](https://github.com/larksuite/node-sdk):
**protocol + types only, no business logic**.

## Requirements

- Node.js **>= 20** (uses global `fetch` / `AbortController`)
- Pure ESM (`"type": "module"`); consumers on CJS should use dynamic `import()`

## Install

```bash
pnpm add @tencent-connect/qqbot-nodejs
# or
npm  install @tencent-connect/qqbot-nodejs
# or
yarn add     @tencent-connect/qqbot-nodejs
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
  await bot.sendText(msg.replyTarget, `Echo: ${msg.content}`);
});

await bot.start();
```

Full runnable examples live in [`examples/`](./examples/):

| Example                                                | Description                                            |
| ------------------------------------------------------ | ------------------------------------------------------ |
| [`playground`](./examples/playground/)                 | Text / streaming / media / commands demo               |
| [`middleware`](./examples/middleware/)                 | The full Koa-style middleware pipeline                 |
| [`webhook`](./examples/webhook/)                       | HTTP callback transport (serverless-friendly)          |
| [`send-plain-100`](./examples/send-plain-100/)         | Regular text send-path baseline                        |
| [`send-streaming-100`](./examples/send-streaming-100/) | Streaming send-path baseline                           |

> Examples read `QQBOT_APP_ID` / `QQBOT_APP_SECRET` from `process.env` **only
> for demo convenience**. The SDK itself never reads environment variables —
> credentials are always injected via `new QQBot({ appId, appSecret })`.

## Features

### Dual transport (WebSocket / Webhook)

```ts
// WebSocket (default) — long-lived, heartbeat + RESUME
const bot = new QQBot({ appId, appSecret });

// Webhook — HTTP callback, ideal for Serverless / horizontal scaling
const bot = new QQBot({
  appId, appSecret,
  transport: "webhook",
  webhook: { port: 8080, path: "/callback" },
});
```

Middleware, event listeners and send APIs are **identical** across transports.

### Koa-style middleware

The SDK ships an onion-model pipeline; `bot.on("message", ...)` is the
innermost downstream:

```ts
import {
  errorHandler,
  messageFilter,
  contentSanitizer,
  mentionGate,
} from "@tencent-connect/qqbot-nodejs";

bot.use(errorHandler());
bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5000 } }));
bot.use(contentSanitizer({ stripBotMention: true }));
bot.use(mentionGate({ requireMentionInGroup: true }));

bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  ctx.log.debug?.(`elapsed: ${Date.now() - start}ms`);
});
```

Built-in middleware:

| Middleware          | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `errorHandler`      | Unified error capture with friendly reply                      |
| `messageFilter`     | Echo suppression + message dedup                               |
| `rateLimiter`       | Three-tier limiting (sender / group / global)                  |
| `concurrencyGuard`  | Per-target serial processing (avoids stream races)             |
| `accessPolicy`      | Allow / block lists                                            |
| `contentSanitizer`  | Strip @-marker / face tags / whitespace                        |
| `mentionGate`       | Group `@bot` gating                                            |
| `quoteRef`          | Message-id index + quoted-message resolution                   |
| `historyBuffer`     | In-memory group history                                        |
| `envelopeFormatter` | Assemble LLM prompt context (XML tags)                         |
| `typingIndicator`   | Auto "typing…" in C2C                                          |
| `slashCommand`      | `/cmd` command framework                                       |

### Media

`sendImage` / `sendVoice` / `sendVideo` / `sendFile` are convenience wrappers
over `sendMedia`. Files **≥ 5 MB** transparently switch to chunked upload.

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

### C2C streaming messages

```ts
const stream = bot.openStream({ target });
for (const partial of generator) {
  await stream.update(partial); // always the full text so far, NOT a delta
}
await stream.complete();
```

QQ platform constraint: `stream_messages` is available for **C2C only**.

### Command panel

Publish the list clients show when the user taps "/" in the input box:

```ts
await bot.createPanel({
  scope: "c2c",
  target_type: "all",
  panel: {
    remark: "my-bot",
    items: [{ type: "command", name: "/help", desc: "list commands" }],
  },
});
```

Panels accumulate per application — tag yours via `panel.remark`, find it with
`listPanels()` and `updatePanel()` it rather than creating one on every start.
See [USAGE.md](./USAGE.md#13-指令面板v2panels).

### Events

```ts
bot.on("ready",       () => console.log("connected"));
bot.on("resumed",     () => console.log("reconnected"));
bot.on("error",       (err) => console.error(err));
bot.on("message",     (ctx, msg) => { /* C2C / Group / Guild / DM */ });
bot.on("interaction", (ctx, event) => { /* button clicks */ });
```

### Protocol-level access

For custom retry policies, session persistence, raw WebSocket frames etc.:

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
- **[README.zh-CN.md](./README.zh-CN.md)** — this README in Chinese.

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

## Contributors

Thanks to all the wonderful people who have contributed to this project!

<a href="https://github.com/tencent-connect/qqbot-nodejs/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=tencent-connect/qqbot-nodejs" alt="Contributors" />
</a>

<sub>Contributor avatars are rendered by [contrib.rocks](https://contrib.rocks).</sub>

## License

[MIT](./LICENSE) © Tencent
