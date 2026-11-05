import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSecret } from "../paths";
import { protectKeyFile } from "../windows/acl";

/**
 * `<data>/pipe.key` — the root secret of the private channels that do not
 * derive theirs from something else (contract §102.3).
 *
 * 32 random bytes, hex. Written 0600 and, on Windows, narrowed to this user
 * with `icacls`; **a failure to narrow it throws**, and the channel that needed
 * it stays closed: a key every account on the machine can read proves nothing.
 */
export const PIPE_KEY_FILE = "pipe.key";
const KEY_BYTES = 32;

export function pipeKeyPath(dataDir: string): string {
  return join(dataDir, PIPE_KEY_FILE);
}

/** Reads the key; throws when it is missing or malformed. Never creates one. */
export function readPipeKey(dataDir: string): Buffer {
  const path = pipeKeyPath(dataDir);
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(`${path} is not a ${KEY_BYTES}-byte hex key`);
  }
  return key;
}

/**
 * The key, created on first use (the core's side only: a client that minted one
 * would hold a second secret instead of the shared one). Hardened after every
 * start, so a file left by an earlier build is narrowed too.
 */
export function ensurePipeKey(dataDir: string): Buffer {
  let key: Buffer;
  try {
    key = readPipeKey(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    key = randomBytes(KEY_BYTES);
    writeSecret(pipeKeyPath(dataDir), `${key.toString("hex")}\n`);
  }
  protectKeyFile(pipeKeyPath(dataDir));
  return key;
}
