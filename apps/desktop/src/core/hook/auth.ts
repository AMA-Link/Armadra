import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hardenDirectory, writeSecret } from "../paths";
import type { SecretStore } from "../secrets";
import {
  HOOK_SECRET_BYTES,
  type HookSecretState,
  legacyHookSecretFile,
} from "./secret";

/**
 * Hook credentials — contract §5.2.
 *
 * Two secrets, two very different lifetimes:
 *
 *   * the **app bearer** (`ARMADRA_HOOK_TOKEN`) proves "this process may talk
 *     to the hook routes at all". It lives in the endpoint file and is
 *     regenerated only when that file has none.
 *   * the **per-node token** proves "this report is about *that* node". It is
 *     derived, never stored: `<data>/node-tokens/<nodeId>` is a cache of a
 *     value that can always be recomputed from the instance secret.
 *
 * Deriving instead of storing is what makes the three-way verdict possible: a
 * token minted by a previous install carries a foreign `kid`, so it is
 * `legacy` (accepted, flagged) rather than `forged` (rejected).
 *
 * The derivation is unchanged, so a node token minted before the secret moved
 * into the secret store (contract §102) is still `verified` afterwards.
 */

/**
 * Domain separators. Both are versioned so a future scheme can coexist with
 * tokens minted today instead of silently changing their meaning.
 */
const KID_DOMAIN = "armadra-node-kid-v1";
const MAC_DOMAIN_PREFIX = "armadra-node-v1|";
/**
 * Characters of the base64url key id kept in a token. Eight is enough to tell
 * installs apart and short enough to keep the file readable.
 */
const KID_LENGTH = 8;
const SECRET_BYTES = HOOK_SECRET_BYTES;

/** How a hook report authenticated itself for the node it claims. */
export type Verdict = "verified" | "legacy" | "forged";

/**
 * A node id is joined onto a filesystem path, so it is validated before it is
 * ever touched: no separators, no `..`, no empty string.
 */
export function validNodeId(nodeId: string): boolean {
  return (
    nodeId.length > 0 && nodeId.length <= 80 && /^[A-Za-z0-9_-]+$/.test(nodeId)
  );
}

function hmac(secret: Buffer, message: string): Buffer {
  return createHmac("sha256", secret).update(message, "utf8").digest();
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function deriveKid(secret: Buffer): string {
  return base64url(hmac(secret, KID_DOMAIN)).slice(0, KID_LENGTH);
}

function deriveMac(secret: Buffer, nodeId: string): string {
  return base64url(hmac(secret, `${MAC_DOMAIN_PREFIX}${nodeId}`));
}

/**
 * Constant time throughout: a length-only mismatch must not be faster to
 * discover than a byte mismatch. `timingSafeEqual` throws on a length
 * difference, so the length is folded in first — the comparison itself stays
 * branch-free.
 */
function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomToken(): string {
  return base64url(randomBytes(SECRET_BYTES));
}

function decodeSecret(stored: string | undefined): Buffer | undefined {
  if (stored === undefined) return undefined;
  const bytes = Buffer.from(stored, "base64url");
  return bytes.length === SECRET_BYTES ? bytes : undefined;
}

/** The old plaintext file, only for the run in which the store was unreachable. */
function readLegacySecret(dataDir: string): Buffer | undefined {
  try {
    const bytes = readFileSync(legacyHookSecretFile(dataDir));
    return bytes.length === SECRET_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

interface Loaded {
  readonly secret: Buffer;
  readonly state: HookSecretState;
}

/**
 * Loads the instance secret from the secret store, minting it on first use.
 *
 * The store being *unreachable* (locked Keychain, an SSH session, a shell that
 * hung up) is not the same as the secret being *absent*: in the first case
 * nothing is minted and nothing is overwritten, because a fresh value would
 * replace one that is only temporarily out of reach. The run reads the old
 * file if the migration has not moved it yet, and otherwise uses a secret that
 * lives in memory only; the next start tries again.
 */
async function loadOrCreateSecret(
  dataDir: string,
  store: SecretStore,
): Promise<Loaded> {
  mkdirSync(dataDir, { recursive: true });
  hardenDirectory(dataDir);
  const kind = store.backend();
  try {
    const existing = decodeSecret(await store.readStrict());
    if (existing !== undefined) return { secret: existing, state: kind };
    // Absent (or malformed). A valid old file here means the migration did not
    // finish: keep using it rather than minting a second secret.
    const legacy = readLegacySecret(dataDir);
    if (legacy !== undefined) return { secret: legacy, state: "legacy-file" };
    const minted = randomBytes(SECRET_BYTES);
    await store.write(minted.toString("base64url"));
    // Read back: a store that accepts a write it cannot return is unavailable.
    const back = decodeSecret(await store.readStrict());
    if (back === undefined || !back.equals(minted)) {
      throw new Error("read-back mismatch");
    }
    return { secret: minted, state: kind };
  } catch {
    const legacy = readLegacySecret(dataDir);
    return legacy !== undefined
      ? { secret: legacy, state: "legacy-file" }
      : { secret: randomBytes(SECRET_BYTES), state: "ephemeral" };
  }
}

export class HookAuth {
  readonly kid: string;

  private constructor(
    private readonly secret: Buffer,
    readonly bearer: string,
    /** Where the secret of this run lives; `ephemeral` dies with the process. */
    readonly state: HookSecretState,
  ) {
    this.kid = deriveKid(secret);
  }

  /**
   * `bearer` is the token already present in the endpoint file, if any:
   * reusing it keeps terminals that outlive the core working. A bearer that is
   * missing or obviously truncated is replaced.
   */
  static async open(
    dataDir: string,
    store: SecretStore,
    bearer?: string | undefined,
  ): Promise<HookAuth> {
    const { secret, state } = await loadOrCreateSecret(dataDir, store);
    const kept =
      bearer !== undefined && bearer.length >= 16 ? bearer : randomToken();
    return new HookAuth(secret, kept, state);
  }

  /** In-memory only: for tests and for a data directory we could not write. */
  static ephemeral(): HookAuth {
    return new HookAuth(randomBytes(SECRET_BYTES), randomToken(), "ephemeral");
  }

  /** `kid.mac` — what a hook client presents as `X-Armadra-Node-Token`. */
  nodeToken(nodeId: string): string {
    return `${this.kid}.${deriveMac(this.secret, nodeId)}`;
  }

  bearerMatches(presented: string | undefined): boolean {
    if (presented === undefined) return false;
    return constantTimeEqual(presented, this.bearer);
  }

  verdict(nodeId: string, presented: string | undefined): Verdict {
    const token = presented?.trim();
    if (token === undefined || token === "") return "legacy";
    const separator = token.indexOf(".");
    if (separator < 0) return "legacy";
    const kid = token.slice(0, separator);
    const mac = token.slice(separator + 1);
    if (!constantTimeEqual(kid, this.kid)) {
      // Another install's token. Contract §5.2 accepts it and flags the row.
      return "legacy";
    }
    return constantTimeEqual(mac, deriveMac(this.secret, nodeId))
      ? "verified"
      : "forged";
  }

  /**
   * Writes `<tokenDir>/<nodeId>` (0600) atomically and returns the token.
   * A node id that could escape the directory is refused before the write.
   */
  writeNodeToken(tokenDir: string, nodeId: string): string {
    if (!validNodeId(nodeId)) {
      throw new Error("node id is not path safe");
    }
    const token = this.nodeToken(nodeId);
    mkdirSync(tokenDir, { recursive: true });
    hardenDirectory(tokenDir);
    writeSecret(join(tokenDir, nodeId), token);
    return token;
  }
}
