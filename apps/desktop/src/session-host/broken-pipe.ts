/**
 * Keeps one broken console pipe from taking every session with it.
 *
 * node-pty's Windows backend turns a pipe that breaks while a console is
 * being torn down into an exception nobody can catch (microsoft/node-pty#960,
 * #512): the conout socket's `error` handler rethrows anything but `EIO`, and
 * the conin socket and the conout worker's sockets have no `error` listener
 * at all. In an ordinary program that ends one terminal. Here it ends the
 * process that owns **every** ConPTY, so one `destroy` racing its own output
 * killed the host and all the shells it held (#659).
 *
 * The pipe in question belongs to a console that is already going away —
 * node-pty has closed its side before the error surfaces, and the session's
 * `exit` follows from the socket's `close`. Nothing this process holds is
 * left inconsistent, so the error is written down and the host carries on.
 * Anything else that reaches the top is still fatal: it is logged, and the
 * process leaves with a failure code, as it would have without this.
 */

/** Errors a pipe raises when the other end went away mid-read or mid-write. */
const PIPE_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTCONN",
  "EOF",
  "EIO",
  // libuv's name for a Windows pipe error it has no mapping for; node-pty's
  // conout worker raises `write UNKNOWN` when a terminal exits.
  "UNKNOWN",
]);

const PIPE_MESSAGE = new RegExp(
  `^(?:read|write) (?:${[...PIPE_CODES].join("|")})\\b`,
);

/**
 * Whether `error` is a pipe read or write failing because its peer is gone.
 *
 * Decided by `code` and `syscall` where they survive, and by the message
 * otherwise: an error thrown inside node-pty's conout worker reaches this
 * thread re-created from a copy, and the message (`read EPIPE`) is the part
 * that is certain to make the trip.
 */
export function isBrokenConsolePipe(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, syscall } = error as NodeJS.ErrnoException;
  if (typeof code === "string" && PIPE_CODES.has(code)) {
    return syscall === undefined || syscall === "read" || syscall === "write";
  }
  return PIPE_MESSAGE.test(error.message);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { code, syscall } = error as NodeJS.ErrnoException;
  const tags = [code, syscall].filter((part) => typeof part === "string");
  return tags.length > 0
    ? `${error.message} (${tags.join(", ")})`
    : (error.stack ?? error.message);
}

/** The slice of `process` the guard needs; an emitter stands in for tests. */
export interface UncaughtSource {
  on(event: "uncaughtException", listener: (error: unknown) => void): unknown;
  off(event: "uncaughtException", listener: (error: unknown) => void): unknown;
}

/**
 * Installs the guard and returns the function that removes it.
 *
 * A broken console pipe is logged and survived; anything else is logged and
 * ends the process through `exit(1)`. Both lines go to the host's log, which
 * is the only place a host started without a console can leave a reason.
 */
export function guardConsolePipes(
  log: (line: string) => void,
  source: UncaughtSource = process,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  const onUncaught = (error: unknown): void => {
    if (isBrokenConsolePipe(error)) {
      log(`kept serving after a console pipe broke: ${describe(error)}`);
      return;
    }
    log(`session host stopped by an uncaught exception: ${describe(error)}`);
    exit(1);
  };
  source.on("uncaughtException", onUncaught);
  return () => {
    source.off("uncaughtException", onUncaught);
  };
}
