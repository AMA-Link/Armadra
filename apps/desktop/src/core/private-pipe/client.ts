import { type Socket, connect } from "node:net";
import { type Channel, ClientHandshake } from "./handshake";

/** A server that has not proven the key within this long is not our server. */
export const CONNECT_TIMEOUT_MS = 5_000;

export class PrivatePipeError extends Error {
  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(`private pipe: ${reason}`, cause === undefined ? {} : { cause });
    this.name = "PrivatePipeError";
  }
}

/**
 * Connects to a private pipe (or a Unix socket in tests) and completes
 * `armadra-pipe/1`. The returned socket is ready for the request; nothing of
 * the request was sent before the server proved it holds the key, so a process
 * squatting the pipe name gets a random number and nothing else.
 */
export function connectPrivate(
  path: string,
  channel: Channel,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const handshake = new ClientHandshake(channel);
    let settled = false;
    const fail = (error: PrivatePipeError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("connect", onConnect);
    };
    const timer = setTimeout(
      () => fail(new PrivatePipeError("timeout")),
      timeoutMs,
    );
    timer.unref();
    const onError = (error: Error): void =>
      fail(new PrivatePipeError("connect", error));
    const onClose = (): void => fail(new PrivatePipeError("closed"));
    const onConnect = (): void => {
      socket.write(handshake.hello());
    };
    const onReadable = (): void => {
      let chunk: Buffer | null;
      while (!settled && (chunk = socket.read() as Buffer | null) !== null) {
        const step = handshake.push(chunk);
        if (step.kind === "rejected") {
          fail(new PrivatePipeError(step.reason));
        } else if (step.kind === "proven") {
          settled = true;
          cleanup();
          socket.write(step.data);
          if (step.rest.length > 0) socket.unshift(step.rest);
          resolve(socket);
        }
      }
    };
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("connect", onConnect);
    socket.on("readable", onReadable);
  });
}
