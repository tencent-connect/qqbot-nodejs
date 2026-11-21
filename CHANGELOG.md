# 1.0.6 (unreleased)

### Features

* **sdk:** `bot.connectionState` reports the transport connection state (`idle` / `connecting` / `resuming` / `connected` / `disconnected`) without subscribing to events; it tracks startup, RESUME recovery, fatal disconnects, and `stop()`
* **sdk:** the `connection` event reports every state transition with the previous state, so consumers no longer need to combine `ready` / `resumed` / `disconnected`
* **sdk:** `bot.ping` and `bot.lastHeartbeatAt` expose heartbeat ACK latency and recency
* **gateway:** a heartbeat that goes unacknowledged for a full interval now closes the socket with 4009 and reconnects instead of leaving a zombie connection; a watchdog terminates the socket if even the close handshake stalls
* **gateway:** the first heartbeat after HELLO is sent with `interval × random` jitter, so deployments no longer align their heartbeat phase with the server-assigned moment
* **gateway:** the state falls back from `resuming` to `connecting` when RESUME is rejected and the client re-identifies

### Behavior changes

* `ConnectionState` gains a `resuming` member and `QQBotEventMap` gains a `connection` event — exhaustive switches over either need updating

# 1.0.5 (2026-10-12)

### Features

* **gateway:** startup now fails fast with a clear reason when the connection can't be established, instead of waiting forever
* **gateway:** new `disconnected` event reports why the connection dropped and whether the SDK will recover on its own
* **gateway:** reconnects are now configurable — cap the attempts and tune the backoff; unrecoverable cases (banned bot, sandbox-only account) are reported once and explicitly
* **sdk:** `bot.getCredentials()` exposes the configured credentials for calling the lower-level APIs directly

### Bug Fixes

* **gateway:** retries are no longer reset by a connection that is accepted then immediately rejected, so a misconfigured bot can't spin in a tight reconnect loop
* **gateway:** fixed several issues that could stall or misjudge the connection: an exception in your own handler, a silently dropped handshake, and a platform-requested reconnect treated as permanent
* **token:** restarting the bot no longer cancels the token refresh belonging to the new session

### Behavior changes

* The SDK now keeps retrying until the failure is clearly unrecoverable (previously it gave up after 100 attempts). Set `reconnect.maxAttempts` for a hard cap.

## 1.0.4 (2026-07-14)

### Bug Fixes

* **token:** fetching an access token now times out, and failures report the HTTP status and server response instead of a generic error
* **token:** fixed edge cases that could leave token refresh stuck or log a crash that never happened

## 1.0.3 (2026-07-13)


### Features

* **sdk:** add universal send(), API gateway, rawEvent, and P1 messaging capabilities
* **media:** auto-fill fileName from localPath/URL in uploadMedia
* **media:** pre-check fileData size before upload
* **middleware:** concurrency-guard merge support
* **middleware:** enhance types & buffered reply
* **concurrency:** add maxProcessingMs timeout with abort
* **concurrency:** add urgentPredicate for priority flush
* **quote-ref:** prefer msg_elements over stored entry
* **quote-ref:** add enrichEntry & extend entry
* **api:** support data in acknowledge interaction
* **sanitizer:** support new face tag format
* **slash:** add per-command authorized check
* export webhook transport types
* update mention-gate


### Bug Fixes

* **slash:** check rawEventType for group @bot detection
* **media:** use raw https for COS chunked upload
* **media:** pass Uint8Array directly to fetch body
* **middleware:** refine mention-gate logic


## 1.0.2 (2026-06-10)


### Features

* **qqbot:** support tokenPrefetch option for sync/async token initialization


## 1.0.1 (2026-05-20)


### Features

* **middleware:** add concurrencyGuard for per-target serial processing
* **middleware:** add ctx.abort() and ctx.signal for async cancellation
* **middleware:** add typing keepalive to typingIndicator
* **middleware:** add receivedAt to MiddlewareContext for latency measurement
* **concurrency:** add merge strategy with dependency-inverted dispatch
* **slash:** add allowFrom option for command access control
* **event:** expose messageScene on C2C inbound messages
* **transport:** add webhook example and update readme
* dataflow middleware pipeline
* check slash scope


### Bug Fixes

* **webhook:** async dispatch to prevent ACK timeout on long-running handlers
* **webhook:** log full event payload in dispatch debug output
* **stream:** ensure DONE frame is sent even when flush is in progress
* **streaming:** catch throttle flush error to prevent unhandledRejection
* **streaming:** fix rate-limit retry storm in flush
* **concurrency-guard:** evict queued waiters on abort to prevent stale replies


# 1.0.0 (2026-04-30)


### Features

* initialize QQ Open Platform Node.js SDK
