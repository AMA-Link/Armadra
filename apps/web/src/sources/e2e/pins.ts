/**
 * core 身份公钥的钉扎（设计 §4.9）：第一次连上时记下（TOFU）或由配对二维码、访客
 * 链接的片段给出；之后公钥变化一律拒绝并提示「这台电脑的身份变了」，由人在设置里
 * 「忘记」。
 *
 * 存在页面的 `localStorage`（按签发方 + 源，一个源一把）：中继托管的页面与手机、
 * 桌面窗口都有它。它不是秘密，丢了只是退回 TOFU。
 */

const STORAGE_KEY = "armadra.e2e.pins";

export interface PinStore {
  get(issuer: string, sourceId: string): Uint8Array | null;
  set(issuer: string, sourceId: string, identityPub: Uint8Array): void;
  forget(issuer: string, sourceId: string): void;
}

function key(issuer: string, sourceId: string): string {
  return `${issuer}\u0000${sourceId}`;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
      out[index] = binary.charCodeAt(index);
    return out.length === 32 ? out : null;
  } catch {
    return null;
  }
}

/** 存在 `Storage` 里的钉扎；没有存储（测试、隐私模式）时只在内存。 */
export function storagePins(
  storage: Pick<
    Storage,
    "getItem" | "setItem"
  > | null = globalThis.localStorage ?? null,
): PinStore {
  const memory = new Map<string, string>();
  const read = (): Record<string, string> => {
    if (storage === null) return Object.fromEntries(memory);
    try {
      const parsed = JSON.parse(
        storage.getItem(STORAGE_KEY) ?? "{}",
      ) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };
  const write = (value: Record<string, string>) => {
    if (storage === null) {
      memory.clear();
      for (const [name, pin] of Object.entries(value)) memory.set(name, pin);
      return;
    }
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      /* 存不下就只是退回 TOFU。 */
    }
  };
  return {
    get(issuer, sourceId) {
      const found = read()[key(issuer, sourceId)];
      return found === undefined ? null : decode(found);
    },
    set(issuer, sourceId, identityPub) {
      write({ ...read(), [key(issuer, sourceId)]: encode(identityPub) });
    },
    forget(issuer, sourceId) {
      const next = read();
      delete next[key(issuer, sourceId)];
      write(next);
    },
  };
}
