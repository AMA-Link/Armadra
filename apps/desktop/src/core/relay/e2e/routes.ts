/**
 * `devices.*`（契约 §77）与 `e2e.*`（§78）的旧路径与 procedure。
 *
 * - `devices.*`：owner（`settings:*`），列、批、拒、撤、删、改名。
 * - `e2e.identity`：匿名，本机的身份公钥与指纹。
 * - `e2e.wait`：匿名，只在端到端通道上、只认这条通道自己的设备钥申请的记录。
 * - `e2e.sign`：只在回环（`loopbackOnlyPath`）、owner，用本机设备钥签一次转录。
 *
 * 匿名的两条只经旧路径，RPC 上不登记（与 Gateway 的短码换票同一个做法）。
 */

import { createHash } from "node:crypto";

import type { TrustedDevice } from "@armadra/shared";

import { CoreFailure, fail, failureResult } from "../../http/errors";
import type { CoreRequest, HandlerResult } from "../../http/router";
import { type DomainHandlers, registerProcedures } from "../../http/rpc";
import type { CoreServer } from "../../http/server";
import { E2E_IDENTITY_PATH, E2E_WAIT_PATH } from "../../identity/transport";
import type { DeviceKey } from "./device-key";
import { DeviceError, type DeviceRegistry, type DeviceView } from "./devices";
import { channelPeerOf } from "./peer";

/** 等候一次最长多久。 */
export const WAIT_TIMEOUT_MS = 25_000;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32（小写、无填充）。 */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** 公钥指纹：`base32(SHA-256(pub))`，52 字符。 */
export function keyFingerprint(publicKey: Uint8Array): string {
  return base32(createHash("sha256").update(publicKey).digest()).slice(0, 52);
}

export function deviceWire(row: DeviceView): TrustedDevice {
  return {
    deviceId: row.deviceId,
    principalId: row.principalId,
    principalName: row.principalName,
    principalKind: row.principalKind,
    label: row.label,
    platform: row.platform,
    status: row.status,
    pendingId: row.status === "pending" ? row.requestId : null,
    approvedBy: row.approvedBy,
    issuer: row.issuer,
    fingerprint: keyFingerprint(row.publicKey),
    createdAtMs: row.createdAtMs,
    approvedAtMs: row.approvedAtMs,
    lastSeenAtMs: row.lastSeenAtMs,
    revokedAtMs: row.revokedAtMs,
  };
}

export interface E2eRouteDeps {
  readonly devices: DeviceRegistry;
  /** 本机代连别的电脑时，问对端这台设备的待确认（`sources` 域的那组通道）。 */
  readonly waitSource?: (
    sourceId: string,
    pendingId: string,
  ) => Promise<"pending" | "trusted" | "rejected" | "revoked">;
  /** 这台 core 的 `sourceId` 与身份公钥（源钥）。 */
  readonly identity: () => Promise<{ sourceId: string; publicKey: Uint8Array }>;
  readonly deviceKey: DeviceKey;
}

function refusal(error: DeviceError): CoreFailure {
  switch (error.code) {
    case "sas_mismatch":
      return fail("sas_mismatch", error.message);
    case "sas_expired":
      return fail("sas_expired", error.message);
    case "not_found":
      return fail("not_found", error.message);
    case "conflict":
      return fail("conflict", error.message);
    case "device_limit":
      return fail("forbidden", error.message);
  }
}

function rethrow(error: unknown): never {
  if (error instanceof DeviceError) throw refusal(error);
  throw error;
}

function text(value: unknown, name: string, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw fail("bad_request", `${name} 必须是 1–${max} 个字符`);
  return value;
}

/** 旧路径与 procedure 共用的那一份；拒绝抛 {@link CoreFailure}。 */
export function e2eOperations(deps: E2eRouteDeps) {
  const { devices } = deps;
  const find = (deviceId: string, principalId: string) =>
    devices
      .list()
      .find(
        (row) => row.deviceId === deviceId && row.principalId === principalId,
      );
  return {
    list: () => ({ devices: devices.list().map(deviceWire) }),
    approve: (input: { pendingId: unknown; sas: unknown }) => {
      const pendingId = text(input.pendingId, "pendingId", 64);
      const sas = text(input.sas, "sas", 16);
      try {
        const row = devices.approve(pendingId, sas);
        const view = find(row.deviceId, row.principalId);
        if (view === undefined) throw fail("not_found", "没有这台设备");
        return { device: deviceWire(view) };
      } catch (error) {
        return rethrow(error);
      }
    },
    reject: (input: { pendingId: unknown }) => {
      try {
        devices.reject(text(input.pendingId, "pendingId", 64));
        return { ok: true as const };
      } catch (error) {
        return rethrow(error);
      }
    },
    revoke: (input: { deviceId: unknown; principalId: unknown }) => {
      try {
        devices.revoke(
          text(input.deviceId, "deviceId", 64),
          text(input.principalId, "principalId", 64),
        );
        return { ok: true as const };
      } catch (error) {
        return rethrow(error);
      }
    },
    forget: (input: { deviceId: unknown; principalId: unknown }) => {
      try {
        devices.forget(
          text(input.deviceId, "deviceId", 64),
          text(input.principalId, "principalId", 64),
        );
        return { ok: true as const };
      } catch (error) {
        return rethrow(error);
      }
    },
    rename: (input: {
      deviceId: unknown;
      principalId: unknown;
      label: unknown;
    }) => {
      try {
        devices.rename(
          text(input.deviceId, "deviceId", 64),
          text(input.principalId, "principalId", 64),
          text(input.label, "label").trim(),
        );
        return { ok: true as const };
      } catch (error) {
        return rethrow(error);
      }
    },
    identity: async () => {
      const { sourceId, publicKey } = await deps.identity();
      return {
        sourceId,
        identityPub: Buffer.from(publicKey).toString("base64url"),
        fingerprint: keyFingerprint(publicKey),
      };
    },
    sign: async (input: { transcript: unknown }) => {
      const encoded = text(input.transcript, "transcript", 64);
      const transcript = Buffer.from(encoded, "base64url");
      if (transcript.length !== 32)
        throw fail("bad_request", "transcript 应为 32 字节");
      const [publicKey, signature] = await Promise.all([
        deps.deviceKey.publicKey(),
        deps.deviceKey.signTranscript(transcript),
      ]);
      return {
        publicKey: Buffer.from(publicKey).toString("base64url"),
        signature: Buffer.from(signature).toString("base64url"),
      };
    },
    waitSource: async (input: { sourceId: unknown; pendingId: unknown }) => {
      const sourceId = text(input.sourceId, "sourceId", 128);
      const pendingId = text(input.pendingId, "pendingId", 64);
      const status =
        (await deps.waitSource?.(sourceId, pendingId)) ?? "pending";
      return { status };
    },
    /** 只在通道上：这条通道自己的设备钥申请的那条记录。 */
    wait: async (input: { pendingId: unknown }, request: CoreRequest) => {
      const peer = channelPeerOf(request.raw.socket);
      if (peer === undefined) throw fail("not_found", "没有这条待确认记录");
      try {
        const status = await devices.wait(
          text(input.pendingId, "pendingId", 64),
          peer.deviceId,
          WAIT_TIMEOUT_MS,
        );
        return { status };
      } catch (error) {
        return rethrow(error);
      }
    },
  };
}

function body(request: CoreRequest): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = request.body.length === 0 ? {} : request.json();
  } catch {
    throw fail("bad_request", "请求体不是 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw fail("bad_request", "请求体必须是对象");
  return parsed as Record<string, unknown>;
}

async function answer(work: () => unknown): Promise<HandlerResult> {
  try {
    return { status: 200, body: (await work()) as Record<string, unknown> };
  } catch (error) {
    if (error instanceof CoreFailure) return failureResult(error);
    throw error;
  }
}

export function installE2eRoutes(server: CoreServer, deps: E2eRouteDeps): void {
  const run = e2eOperations(deps);
  registerProcedures(server, "devices", {
    list: () => run.list(),
    approve: (input) => run.approve(input),
    reject: (input) => run.reject(input),
    revoke: (input) => run.revoke(input),
    forget: (input) => run.forget(input),
    rename: (input) => run.rename(input),
  } satisfies DomainHandlers<"devices">);
  // 匿名的两条只经旧路径（RPC 上答 501）。
  const procedures = {
    sign: (input) => run.sign(input),
    waitSource: (input) => run.waitSource(input),
  } satisfies Omit<DomainHandlers<"e2e">, "identity" | "wait">;
  registerProcedures(
    server,
    "e2e",
    procedures as unknown as DomainHandlers<"e2e">,
  );

  const { router } = server;
  router.handle("GET", "/api/devices", () => answer(run.list));
  for (const action of [
    "approve",
    "reject",
    "revoke",
    "forget",
    "rename",
  ] as const) {
    router.handle("POST", `/api/devices/${action}`, (_match, request) =>
      answer(() => run[action](body(request) as never)),
    );
  }
  router.handle("GET", E2E_IDENTITY_PATH, () => answer(run.identity));
  router.handle("POST", E2E_WAIT_PATH, (_match, request) =>
    answer(() => run.wait(body(request) as never, request)),
  );
  router.handle("POST", "/api/e2e/sign", (_match, request) =>
    answer(() => run.sign(body(request) as never)),
  );
  router.handle("POST", "/api/e2e/sources/wait", (_match, request) =>
    answer(() => run.waitSource(body(request) as never)),
  );
}
