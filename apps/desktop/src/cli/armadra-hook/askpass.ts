/**
 * `SSH_ASKPASS` on Windows — contract §102.8.
 *
 * `ssh` runs `$SSH_ASKPASS <prompt>` and reads one line from its stdout. On
 * Windows the program is `<data>/ssh/askpass.exe`, the hook client's launcher
 * copied under another name; the core's `ssh` environment marks it with
 * {@link MODE_ENV} so this module, not the hook client, runs. It asks the
 * core's private askpass pipe: `armadra-pipe/1` handshake first (the key is
 * derived from the file `ARMADRA_ASKPASS_KEYFILE` names), then one request
 * carrying the one-time token and the prompt, which waits for the person.
 *
 * Exit 0 with the answer on stdout, or non-zero with nothing on stdout — the
 * contract the POSIX `sh` + `curl` helper keeps. Nothing but the answer is ever
 * printed: not the token, not the prompt, not an error's detail.
 */

import { readFileSync } from "node:fs";

import { requestControl } from "../../core/identity/control-client.js";
import { channelKey } from "../../core/private-pipe/handshake.js";
import { ASKPASS_LABEL } from "../../core/private-pipe/labels.js";

/** One second above the core's own wait, so the core is the side that gives up. */
export const ASKPASS_TIMEOUT_MS = 125_000;

export const SOCKET_ENV = "ARMADRA_ASKPASS_SOCKET";
export const TOKEN_ENV = "ARMADRA_ASKPASS_TOKEN";
export const HOST_ENV = "ARMADRA_ASKPASS_HOST";
export const MODE_ENV = "ARMADRA_ASKPASS_MODE";
export const KEY_FILE_ENV = "ARMADRA_ASKPASS_KEYFILE";

export function askpassMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MODE_ENV] === "1";
}

export interface AskpassIo {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (text: string) => void;
}

export async function run(
  argv: readonly string[],
  io: AskpassIo = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const pipe = env[SOCKET_ENV];
  const token = env[TOKEN_ENV];
  const host = env[HOST_ENV];
  const keyFile = env[KEY_FILE_ENV];
  if (!pipe || !token || !host || !keyFile) return 1;
  let root: Buffer;
  try {
    root = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
    if (root.length !== 32) return 1;
  } catch {
    return 1;
  }
  try {
    const answer = await requestControl(
      {
        path: pipe,
        channel: {
          label: ASKPASS_LABEL,
          pipe,
          key: channelKey(root, ASKPASS_LABEL),
        },
      },
      {
        method: "POST",
        path: "/askpass",
        body: Buffer.from(argv.join(" "), "utf8"),
        contentType: "text/plain; charset=utf-8",
        headers: {
          authorization: `Bearer ${token}`,
          "x-armadra-host": host,
        },
        timeoutMs: ASKPASS_TIMEOUT_MS,
        limit: 64 * 1024,
      },
    );
    if (answer.status !== 200) return 1;
    (io.stdout ?? ((text) => void process.stdout.write(text)))(
      answer.body.toString("utf8"),
    );
    return 0;
  } catch {
    return 1;
  }
}
