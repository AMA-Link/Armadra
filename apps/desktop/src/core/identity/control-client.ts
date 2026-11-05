import { Agent, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { CONTROL_SERVICE, read as readEndpoints } from "../endpoints";
import { endpointsFile } from "../paths";
import {
  type Channel,
  channelKey,
  connectPrivate,
  readPipeKey,
} from "../private-pipe";
import { CONTROL_LABEL } from "../private-pipe/labels";
import { CONTROL_SOCKET } from "./control";

/**
 * Reaching the identity private channel from a client that is not the desktop
 * shell (the server shell's `armadra cloud`) — contract §102.4.
 *
 * Unix: the 0600 socket in the data directory. Windows: the pipe whose random
 * name the core published in `endpoints.json`, behind the `armadra-pipe/1`
 * handshake keyed from `pipe.key`.
 */
export interface ControlTarget {
  /** A socket path or `\\.\pipe\<name>`. */
  readonly path: string;
  /** Present for a pipe: the handshake to complete before the request. */
  readonly channel?: Channel;
}

/** `undefined` when there is no channel to reach (no pipe published, no key). */
export function resolveControlTarget(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): ControlTarget | undefined {
  if (platform !== "win32") return { path: join(dataDir, CONTROL_SOCKET) };
  const pipe = readEndpoints(endpointsFile(dataDir))[CONTROL_SERVICE]?.pipe;
  if (pipe === undefined || !/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(pipe)) {
    return undefined;
  }
  try {
    return {
      path: pipe,
      channel: {
        label: CONTROL_LABEL,
        pipe,
        key: channelKey(readPipeKey(dataDir), CONTROL_LABEL),
      },
    };
  } catch {
    return undefined;
  }
}

export interface ControlAnswer {
  readonly status: number;
  readonly body: Buffer;
}

/**
 * One HTTP request to a private channel; a pipe completes the handshake
 * first. Also the askpass helper's transport (contract §102.8).
 */
export function requestControl(
  target: ControlTarget,
  options: {
    readonly method: string;
    readonly path: string;
    readonly body?: Buffer;
    /** Extra request headers (the askpass helper's bearer and host). */
    readonly headers?: Readonly<Record<string, string>>;
    readonly contentType?: string;
    readonly timeoutMs?: number;
    readonly limit?: number;
  },
): Promise<ControlAnswer> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const limit = options.limit ?? 1 << 20;
  const agent = new Agent({ keepAlive: false });
  const channel = target.channel;
  if (channel !== undefined) {
    // `createConnection` with a callback is documented on the agent instance.
    (agent as unknown as { createConnection: unknown }).createConnection = (
      _options: unknown,
      callback: (error: Error | null, socket?: Socket) => void,
    ) => {
      connectPrivate(target.path, channel, timeoutMs).then(
        (socket) => callback(null, socket),
        (error: Error) => callback(error),
      );
    };
  }
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers["content-type"] = options.contentType ?? "application/json";
      headers["content-length"] = String(options.body.byteLength);
    }
    Object.assign(headers, options.headers);
    const outgoing = httpRequest(
      {
        ...(channel === undefined
          ? { socketPath: target.path }
          : { host: "localhost", agent }),
        path: options.path,
        method: options.method,
        headers,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > limit) {
            response.destroy(new Error("response exceeds its limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    outgoing.on("timeout", () => {
      const error: NodeJS.ErrnoException = new Error(
        "control request timed out",
      );
      error.code = "ETIMEDOUT";
      outgoing.destroy(error);
    });
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}
