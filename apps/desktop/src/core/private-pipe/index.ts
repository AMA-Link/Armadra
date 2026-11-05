export * from "./handshake";
export { ensurePipeKey, pipeKeyPath, readPipeKey, PIPE_KEY_FILE } from "./key";
export { guardServer, HANDSHAKE_TIMEOUT_MS, MAX_PENDING } from "./server";
export type { GuardOptions } from "./server";
export { connectPrivate, PrivatePipeError, CONNECT_TIMEOUT_MS } from "./client";
