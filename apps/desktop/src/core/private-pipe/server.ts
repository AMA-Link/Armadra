import type { Server } from "node:net";
import type { Socket } from "node:net";
import { type Channel, ServerHandshake } from "./handshake";

/** How long a connection may take to finish the handshake. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Connections allowed to sit unauthenticated at once; the rest are dropped. */
export const MAX_PENDING = 32;

export interface GuardOptions {
  readonly channel: Channel;
  readonly timeoutMs?: number;
  readonly maxPending?: number;
  /** Told why a connection was dropped. Never carries bytes from the peer. */
  readonly onReject?: (reason: string) => void;
}

/**
 * Puts the handshake in front of a server: from now on every accepted
 * connection completes `armadra-pipe/1` before any `connection` listener sees
 * it. The listeners registered so far (an `http.Server`'s own) are moved behind
 * the handshake, so the HTTP layer needs no knowledge of it. Call it before
 * `listen`.
 */
export function guardServer(server: Server, options: GuardOptions): void {
  const listeners = server.listeners("connection") as ((s: Socket) => void)[];
  server.removeAllListeners("connection");
  const timeoutMs = options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const maxPending = options.maxPending ?? MAX_PENDING;
  let pending = 0;
  const reject = (socket: Socket, reason: string): void => {
    options.onReject?.(reason);
    socket.destroy();
  };
  server.on("connection", (socket: Socket) => {
    if (pending >= maxPending) return reject(socket, "too many pending");
    pending += 1;
    const handshake = new ServerHandshake(options.channel);
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      pending -= 1;
      clearTimeout(timer);
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const timer = setTimeout(() => {
      finish();
      reject(socket, "handshake timeout");
    }, timeoutMs);
    timer.unref();
    const onError = (): void => {
      finish();
      socket.destroy();
    };
    const onClose = (): void => finish();
    const onReadable = (): void => {
      let chunk: Buffer | null;
      while (!settled && (chunk = socket.read() as Buffer | null) !== null) {
        const step = handshake.push(chunk);
        if (step.kind === "send") {
          socket.write(step.data);
        } else if (step.kind === "rejected") {
          finish();
          reject(socket, step.reason);
        } else if (step.kind === "accepted") {
          finish();
          if (step.rest.length > 0) socket.unshift(step.rest);
          for (const listener of listeners) listener.call(server, socket);
        }
      }
    };
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("readable", onReadable);
  });
}
