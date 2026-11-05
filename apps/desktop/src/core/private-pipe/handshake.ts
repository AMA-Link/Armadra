import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * `armadra-pipe/1` — the conversation layer of a private Windows pipe
 * (contract §102.3).
 *
 * A named pipe made by `node:net` can be created first by someone else (before
 * the core starts, or after it crashed) and has no peer identity to check. The
 * DACL ({@link ../windows/acl}) narrows who may connect; this handshake makes
 * both ends prove they hold the channel key before anything of value crosses:
 *
 * ```text
 * client -> server   "APH1" ‖ nonce_c                       (20 bytes)
 * server -> client   nonce_s ‖ HMAC(K, "server" ‖ …)        (48 bytes)
 * client -> server   HMAC(K, "client" ‖ …)                  (32 bytes), then the request
 * ```
 *
 * where the HMAC input is `role ‖ 0 ‖ label ‖ 0 ‖ pipe ‖ 0 ‖ nonce_c ‖ nonce_s`.
 * Both nonces are fresh, so there is no replay window, and the server speaks
 * only after seeing a client nonce while the client sends nothing but its own
 * nonce until the server's proof checked out: a process squatting the pipe
 * name learns one random number and nothing else. Binding the label and the
 * pipe name into the input keeps a proof for one channel from being used on
 * another.
 *
 * The key `K` is derived per channel ({@link channelKey}) from a root secret:
 * the hook channel's root is its bearer, every other channel's is
 * `<data>/pipe.key`.
 *
 * Everything here is pure — bytes in, steps out — so the vectors run on every
 * platform; sockets are in `server.ts` and `client.ts`.
 */

export const PROTOCOL = "armadra-pipe/1";
const MAGIC = Buffer.from("APH1", "latin1");
export const NONCE_BYTES = 16;
export const MAC_BYTES = 32;
export const CLIENT_HELLO_BYTES = MAGIC.length + NONCE_BYTES;
export const SERVER_REPLY_BYTES = NONCE_BYTES + MAC_BYTES;
export const CLIENT_PROOF_BYTES = MAC_BYTES;

const KEY_DOMAIN = "armadra-pipe-key/1";

/** The key of one channel, derived from the root secret. */
export function channelKey(root: Buffer | string, label: string): Buffer {
  return createHmac("sha256", root)
    .update(`${KEY_DOMAIN}\0${label}`, "utf8")
    .digest();
}

/** `\\.\pipe\Name` and `name` are the same pipe. */
export function normalizePipe(pipe: string): string {
  return pipe.replace(/^\\\\\.\\pipe\\/i, "").toLowerCase();
}

export type Role = "server" | "client";

export function proof(
  key: Buffer,
  role: Role,
  label: string,
  pipe: string,
  nonceC: Buffer,
  nonceS: Buffer,
): Buffer {
  return createHmac("sha256", key)
    .update(role, "utf8")
    .update("\0")
    .update(label, "utf8")
    .update("\0")
    .update(normalizePipe(pipe), "utf8")
    .update("\0")
    .update(nonceC)
    .update(nonceS)
    .digest();
}

function same(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface Channel {
  /** What the proofs are bound to: `runtime`, `control`, `hook`, `askpass`… */
  readonly label: string;
  /** The pipe name or path; case and the `\\.\pipe\` prefix do not matter. */
  readonly pipe: string;
  readonly key: Buffer;
}

export type ServerStep =
  | { readonly kind: "wait" }
  /** Send `data` and keep waiting for the client's proof. */
  | { readonly kind: "send"; readonly data: Buffer }
  /** The client proved the key; `rest` is whatever followed its proof. */
  | { readonly kind: "accepted"; readonly rest: Buffer }
  | { readonly kind: "rejected"; readonly reason: string };

/** The server's side, fed the bytes that arrive. */
export class ServerHandshake {
  private buffer: Buffer = Buffer.alloc(0);
  private stage: "hello" | "proof" | "done" = "hello";
  private nonceC: Buffer = Buffer.alloc(0);

  constructor(
    private readonly channel: Channel,
    private readonly nonceS: Buffer = randomBytes(NONCE_BYTES),
  ) {}

  push(chunk: Buffer): ServerStep {
    if (this.stage === "done") {
      return { kind: "rejected", reason: "already finished" };
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.stage === "hello") {
      if (this.buffer.length < CLIENT_HELLO_BYTES) return { kind: "wait" };
      if (!this.buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
        this.stage = "done";
        return { kind: "rejected", reason: "bad hello" };
      }
      this.nonceC = Buffer.from(
        this.buffer.subarray(MAGIC.length, CLIENT_HELLO_BYTES),
      );
      this.buffer = this.buffer.subarray(CLIENT_HELLO_BYTES);
      this.stage = "proof";
      const reply = Buffer.concat([
        this.nonceS,
        proof(
          this.channel.key,
          "server",
          this.channel.label,
          this.channel.pipe,
          this.nonceC,
          this.nonceS,
        ),
      ]);
      // The client cannot have sent its proof yet — it needs the reply — so
      // anything buffered beyond the hello is a protocol violation.
      if (this.buffer.length > 0) {
        this.stage = "done";
        return { kind: "rejected", reason: "data before the server proof" };
      }
      return { kind: "send", data: reply };
    }
    if (this.buffer.length < CLIENT_PROOF_BYTES) return { kind: "wait" };
    const presented = this.buffer.subarray(0, CLIENT_PROOF_BYTES);
    const expected = proof(
      this.channel.key,
      "client",
      this.channel.label,
      this.channel.pipe,
      this.nonceC,
      this.nonceS,
    );
    this.stage = "done";
    if (!same(presented, expected)) {
      return { kind: "rejected", reason: "bad client proof" };
    }
    return {
      kind: "accepted",
      rest: Buffer.from(this.buffer.subarray(CLIENT_PROOF_BYTES)),
    };
  }
}

export type ClientStep =
  | { readonly kind: "wait" }
  /** The server proved the key: send `data` (our proof), then the request. */
  | {
      readonly kind: "proven";
      readonly data: Buffer;
      /** Bytes the server sent after its reply; empty from a correct server. */
      readonly rest: Buffer;
    }
  | { readonly kind: "rejected"; readonly reason: string };

/** The client's side. Sends nothing but its nonce until the server proved the key. */
export class ClientHandshake {
  private buffer: Buffer = Buffer.alloc(0);
  private finished = false;

  constructor(
    private readonly channel: Channel,
    private readonly nonceC: Buffer = randomBytes(NONCE_BYTES),
  ) {}

  hello(): Buffer {
    return Buffer.concat([MAGIC, this.nonceC]);
  }

  push(chunk: Buffer): ClientStep {
    if (this.finished) return { kind: "rejected", reason: "already finished" };
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length < SERVER_REPLY_BYTES) return { kind: "wait" };
    this.finished = true;
    const nonceS = this.buffer.subarray(0, NONCE_BYTES);
    const presented = this.buffer.subarray(NONCE_BYTES, SERVER_REPLY_BYTES);
    const expected = proof(
      this.channel.key,
      "server",
      this.channel.label,
      this.channel.pipe,
      this.nonceC,
      nonceS,
    );
    if (!same(presented, expected)) {
      return { kind: "rejected", reason: "bad server proof" };
    }
    return {
      kind: "proven",
      data: proof(
        this.channel.key,
        "client",
        this.channel.label,
        this.channel.pipe,
        this.nonceC,
        nonceS,
      ),
      rest: Buffer.from(this.buffer.subarray(SERVER_REPLY_BYTES)),
    };
  }
}
