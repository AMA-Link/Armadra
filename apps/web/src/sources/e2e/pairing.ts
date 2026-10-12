/**
 * 扫到的配对二维码（契约 §80.1）：`armadra://pair-e2e?d=<base64url(JSON)>`，载荷是
 * 这台电脑的 sourceId、身份公钥、一次性配对秘密、登记到的远程服务与到期。
 *
 * 扫到之后先记下（`localStorage`，到期即丢，用过即删）；之后经中继连这台电脑时，
 * 通道管理用它钉住身份（不走 TOFU）并在握手里带 proof，于是不必等主人核对校验码。
 */

const STORAGE_KEY = "armadra.e2e.pairing";

export interface PairingOffer {
  readonly sourceId: string;
  readonly identityPub: Uint8Array;
  readonly secret: Uint8Array;
  readonly issuers: readonly string[];
  readonly expiresAtMs: number;
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(
      text.replace(/-/g, "+").replace(/_/g, "/") +
        "===".slice((text.length + 3) % 4),
    );
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
      out[index] = binary.charCodeAt(index);
    return out;
  } catch {
    return null;
  }
}

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 认不出（含不是配对二维码、已过期）是 `null`。 */
export function parsePairingUri(
  text: string,
  now: number = Date.now(),
): PairingOffer | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "armadra:" || url.hostname !== "pair-e2e") return null;
  const raw = fromBase64url(url.searchParams.get("d") ?? "");
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  const data = value as {
    v?: unknown;
    s?: unknown;
    k?: unknown;
    p?: unknown;
    i?: unknown;
    e?: unknown;
  };
  if (
    data.v !== 1 ||
    typeof data.s !== "string" ||
    !/^[0-9a-f]{32}$/.test(data.s)
  )
    return null;
  const identityPub = typeof data.k === "string" ? fromBase64url(data.k) : null;
  const secret = typeof data.p === "string" ? fromBase64url(data.p) : null;
  if (identityPub?.length !== 32 || secret === null || secret.length < 16)
    return null;
  const issuers = Array.isArray(data.i)
    ? data.i.filter((one): one is string => typeof one === "string")
    : [];
  const expiresAtMs = typeof data.e === "number" ? data.e : 0;
  if (expiresAtMs <= now) return null;
  return { sourceId: data.s, identityPub, secret, issuers, expiresAtMs };
}

type Stored = Record<
  string,
  { k: string; p: string; i: readonly string[]; e: number }
>;

function read(storage: Pick<Storage, "getItem"> | null): Stored {
  try {
    return JSON.parse(storage?.getItem(STORAGE_KEY) ?? "{}") as Stored;
  } catch {
    return {};
  }
}

export interface PairingStore {
  remember(offer: PairingOffer): void;
  /** 这台电脑的配对（没过期的）；没有是 `null`。 */
  get(sourceId: string): PairingOffer | null;
  /** 用过了：删掉（秘密是一次性的）。 */
  consume(sourceId: string): void;
}

export function storagePairings(
  storage: Pick<
    Storage,
    "getItem" | "setItem"
  > | null = globalThis.localStorage ?? null,
  now: () => number = Date.now,
): PairingStore {
  const write = (value: Stored) => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      /* 存不下就只是退回校验码核对。 */
    }
  };
  return {
    remember(offer) {
      const next = read(storage);
      for (const [sourceId, entry] of Object.entries(next))
        if (entry.e <= now()) delete next[sourceId];
      next[offer.sourceId] = {
        k: toBase64url(offer.identityPub),
        p: toBase64url(offer.secret),
        i: offer.issuers,
        e: offer.expiresAtMs,
      };
      write(next);
    },
    get(sourceId) {
      const entry = read(storage)[sourceId];
      if (entry === undefined || entry.e <= now()) return null;
      const identityPub = fromBase64url(entry.k);
      const secret = fromBase64url(entry.p);
      if (identityPub === null || secret === null) return null;
      return {
        sourceId,
        identityPub,
        secret,
        issuers: entry.i,
        expiresAtMs: entry.e,
      };
    },
    consume(sourceId) {
      const next = read(storage);
      delete next[sourceId];
      write(next);
    },
  };
}
