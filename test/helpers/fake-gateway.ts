import { once } from 'node:events';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';

/** Fast, deterministic reconnect budget for tests (replaces global timer spies). */
export const FAST_RETRY = { delays: [1], maxAttempts: 3 };

export const OP = { DISPATCH: 0, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10 } as const;

/** Default server behaviour: HELLO, then READY / RESUMED for IDENTIFY / RESUME. */
export function serveSession(ws: WebSocket): void {
  ws.send(JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 100_000 } }));
  ws.on('message', (data) => {
    const { op } = JSON.parse(data.toString()) as { op: number };
    if (op === OP.IDENTIFY || op === OP.RESUME) {
      ws.send(JSON.stringify({
        op: OP.DISPATCH,
        t: op === OP.RESUME ? 'RESUMED' : 'READY',
        s: 1,
        d: { session_id: 'test-session' },
      }));
    }
  });
}

export interface FakeGateway {
  url: string;
  sockets: WebSocket[];
  /** Per-connection behaviour; replace to script failures. */
  onConnection: (ws: WebSocket) => void;
  close: () => Promise<void>;
}

export async function startFakeGateway(): Promise<FakeGateway> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const gateway: FakeGateway = {
    url: `ws://127.0.0.1:${address.port}`,
    sockets: [],
    onConnection: serveSession,
    close: async () => {
      for (const ws of server.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  server.on('connection', (ws) => {
    gateway.sockets.push(ws);
    gateway.onConnection(ws);
  });
  return gateway;
}

/** TCP server that accepts connections but never answers the WebSocket upgrade. */
export async function startBlackhole(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Observe a promise's settlement without awaiting it. */
export function outcome(run: Promise<void>) {
  const result = { status: 'pending' as 'pending' | 'resolved' | 'rejected', error: undefined as unknown };
  void run.then(
    () => { result.status = 'resolved'; },
    (error: unknown) => { result.status = 'rejected'; result.error = error; },
  );
  return result;
}
