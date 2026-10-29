import {
  E2E_LABELS,
  type E2eSigner,
  ed25519Signer,
  ed25519SignerFromSeed,
} from "@armadra/platform-protocol/e2e";
import type { DevicePlatform } from "@armadra/shared/e2e";
import { z } from "zod";

import { json, request } from "../../api/request";
import { isNativeAppPage } from "../../api/runtime-url";
import { localSource } from "../../api/source";
import { nativeBridge } from "../../mobile/native-bridge";
import { isDesktop } from "../../platform";

/**
 * 端到端通道的设备钥（设计 §4.8、§4.12，契约 §78）：每台客户端设备一把 Ed25519，
 * 握手 m3 里签转录。三种存放：
 *
 * - **手机**：种子在钥匙串 / Keystore（原生 `e2eDeviceSeed`），页面导入为不可导出的
 *   WebCrypto 私钥，只在内存。
 * - **桌面窗口**：钥在本机 core 的 SecretStore（`armadra-device-key`），页面经回环
 *   `POST /api/e2e/sign` 请 core 签，私钥不进页面。
 * - **浏览器**：IndexedDB 里一把不可导出的 `CryptoKey`。清站点数据 = 丢钥，下次要
 *   主人重新确认（Safari 的 7 天清理同理）。
 */

export interface DeviceIdentity {
  readonly signer: E2eSigner;
  readonly platform: DevicePlatform;
}

/** 浏览器 IndexedDB 的库与表。 */
const DB_NAME = "armadra-e2e";
const STORE = "keys";
const KEY = "device";

interface StoredKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opened = indexedDB.open(DB_NAME, 1);
    opened.onupgradeneeded = () => opened.result.createObjectStore(STORE);
    opened.onsuccess = () => resolve(opened.result);
    opened.onerror = () => reject(opened.error);
  });
}

async function idbGet(): Promise<StoredKey | undefined> {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const read = db.transaction(STORE).objectStore(STORE).get(KEY);
      read.onsuccess = () => resolve(read.result as StoredKey | undefined);
      read.onerror = () => reject(read.error);
    });
  } finally {
    db.close();
  }
}

/**
 * 写入新钥，但只在还没有的时候：同一个 `readwrite` 事务里 `add`，键已存在（别的标签页
 * 先写了）就在同一事务里读回那一把。两个标签页第一次同时取钥时由此只留一把——后写的
 * 覆盖先写的会让先写那一把已经提交的待确认作废。不依赖 `navigator.locks`。
 */
async function idbAddOrGet(value: StoredKey): Promise<StoredKey> {
  const db = await idb();
  try {
    return await new Promise<StoredKey>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let kept: StoredKey = value;
      const added = store.add(value, KEY);
      added.onerror = (event) => {
        if (added.error?.name !== "ConstraintError") return;
        // 已经有一把：不让这次失败中止事务，改读那一把。
        event.preventDefault();
        event.stopPropagation();
        const read = store.get(KEY);
        read.onsuccess = () => {
          kept = read.result as StoredKey;
        };
      };
      tx.oncomplete = () => resolve(kept);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** 浏览器：IndexedDB 里不可导出的那把；没有就生成（并发生成时只留先写入的那把）。 */
export async function browserDeviceKey(): Promise<E2eSigner> {
  const stored = await idbGet();
  if (stored !== undefined)
    return ed25519Signer(stored.privateKey, stored.publicKey);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const kept = await idbAddOrGet({ privateKey: pair.privateKey, publicKey });
  return ed25519Signer(kept.privateKey, kept.publicKey);
}

/** 手机：钥匙串里的种子 → 不可导出的私钥。 */
export async function nativeDeviceKey(): Promise<E2eSigner | null> {
  const seed = await nativeBridge().e2eDeviceSeed();
  if (seed === null) return null;
  return ed25519SignerFromSeed(seed);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const binary = atob(
    text.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((text.length + 3) % 4),
  );
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    out[index] = binary.charCodeAt(index);
  return out;
}

const LABEL = new TextEncoder().encode(E2E_LABELS.deviceSignature);

/**
 * 桌面窗口：本机 core 保管的那把（`POST /api/e2e/sign`）。core 只签 32 字节转录，
 * 签名输入（标签 ‖ 转录 ‖ 公钥）由 core 自己拼；这里从握手交来的签名输入里取出
 * 转录。公钥先签一次全零转录取回（真实转录是 SHA-256 输出，不会全零）。
 */
export async function desktopDeviceKey(
  sign: (transcript: string) => Promise<{
    publicKey: string;
    signature: string;
  }> = defaultDesktopSign,
): Promise<E2eSigner> {
  const probe = await sign(base64url(new Uint8Array(32)));
  const publicKey = fromBase64url(probe.publicKey);
  return {
    publicKey,
    async sign(data) {
      const expected = LABEL.length + 32 + publicKey.length;
      if (
        data.length !== expected ||
        LABEL.some((byte, index) => data[index] !== byte)
      )
        throw new Error("e2e.sign: not a handshake transcript");
      const transcript = data.subarray(LABEL.length, LABEL.length + 32);
      const answer = await sign(base64url(transcript));
      return fromBase64url(answer.signature);
    },
  };
}

const signAnswerSchema = z.object({
  publicKey: z.string().min(1),
  signature: z.string().min(1),
});

/**
 * 经 `request` 发：服务器壳的页面是 Cookie 会话，写请求要带 CSRF（契约 §78.3「回环与
 * Gateway」）；桌面窗口是 Bearer，照旧。
 */
function defaultDesktopSign(transcript: string) {
  return request(
    "/api/e2e/sign",
    signAnswerSchema,
    { method: "POST", ...json({ transcript }) },
    localSource,
  );
}

let cached: Promise<DeviceIdentity> | null = null;

/** 这台设备的设备钥（按环境选存放）；同一页面只取一次。 */
export function deviceIdentity(): Promise<DeviceIdentity> {
  cached ??= (async (): Promise<DeviceIdentity> => {
    if (isNativeAppPage()) {
      const signer = await nativeDeviceKey();
      if (signer === null) throw new Error("e2e device key unavailable");
      return {
        signer,
        platform: nativeBridge().platform === "android" ? "android" : "ios",
      };
    }
    if (isDesktop())
      return { signer: await desktopDeviceKey(), platform: "desktop" };
    return { signer: await browserDeviceKey(), platform: "browser" };
  })().catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}

/** 测试用：忘掉缓存的设备钥。 */
export function resetDeviceIdentity(): void {
  cached = null;
}
