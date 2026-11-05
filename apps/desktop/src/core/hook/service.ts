import { rmSync } from "node:fs";
import { join } from "node:path";
import type { HookHealth } from "../http/health";
import { hookEndpointFile, nodeTokenDir } from "../paths";
import type { ResolvedSecrets } from "../secrets";
import { HookAuth, type Verdict } from "./auth";
import * as endpointFile from "./endpoint";
import { type Memory, newMemory } from "./reduce";
import { fileHookSecretStore, hookSecretStore } from "./secret";

/**
 * The hello a Claude Code mod sends at `session.start` (`POST /node/mod`,
 * contract §57): versions and the transport, nothing else.
 */
export interface ModHello {
  readonly nodeId: string;
  readonly engine: string;
  readonly version: string;
  readonly base: string | null;
  readonly surface: string | null;
  readonly isInteractive: boolean;
  readonly profile: "terminal" | "acp";
  readonly transport: "socket" | "tcp" | "process";
  readonly modRevision: number;
  readonly reportedAt: string;
}

/** How many nodes' hellos are kept; the oldest goes first past this. */
export const MAX_MOD_HELLOS = 512;

/**
 * The hook service — contract §5.2 / §5.4.
 *
 * Three surfaces, one router:
 *
 *   * the core's own TCP listener, so a client that cannot reach the socket
 *     (Windows, a stale socket path) still has somewhere to go;
 *   * a Unix socket at `<dataDir>/hook.sock`, which is the preferred path
 *     because it is not reachable from another machine at all;
 *   * `<dataDir>/hook-endpoint.env`, which tells a client where those two are.
 *
 * `HookService` (built with {@link HookService.open}) owns the credentials and
 * the reducer's per-node memory.
 */
export class HookService {
  private readonly memory = new Map<string, Memory>();
  /** In memory only: a core restart starts with none (contract §57). */
  private readonly modHellos = new Map<string, ModHello>();
  private currentPort: number | undefined;

  /**
   * Use {@link HookService.open}: the instance secret comes out of the secret
   * store, which is asynchronous, so a service only exists once it is loaded.
   */
  private constructor(
    readonly dataDir: string,
    port: number | undefined,
    private readonly auth: HookAuth,
    private readonly onWarning: (message: string, detail: unknown) => void,
  ) {
    this.currentPort = port;
  }

  /**
   * A service over credentials the caller already holds: the fixtures, which
   * must stay synchronous and never touch a secret store.
   */
  static from(
    dataDir: string,
    port: number | undefined,
    auth: HookAuth,
    onWarning: (message: string, detail: unknown) => void = () => {},
  ): HookService {
    return new HookService(dataDir, port, auth, onWarning);
  }

  /**
   * Loads the credentials, then returns the service. Awaited before the hook
   * listener binds and before the endpoint file is published, so nothing is
   * advertised that cannot verify a token yet.
   *
   * A store that cannot be reached is not fatal: the service runs on a secret
   * that lives in memory (`/health` reports `hook.secret: "ephemeral"`) so the
   * rest of the core still starts. Nothing is minted into, or overwritten in,
   * a store that may merely be locked.
   */
  static async open(
    dataDir: string,
    port?: number | undefined,
    onWarning: (message: string, detail: unknown) => void = () => {},
    secrets?: ResolvedSecrets,
  ): Promise<HookService> {
    const existing = endpointFile.read(hookEndpointFile(dataDir));
    const bearer = existing.get("ARMADRA_HOOK_TOKEN");
    const store =
      secrets === undefined
        ? fileHookSecretStore(dataDir)
        : hookSecretStore(secrets);
    let auth: HookAuth;
    try {
      auth = await HookAuth.open(dataDir, store, bearer);
    } catch (error) {
      onWarning(
        "could not open the hook secret; using an ephemeral one",
        error,
      );
      auth = HookAuth.ephemeral();
    }
    if (auth.state === "ephemeral") {
      onWarning(
        "the secret store is unavailable; hook tokens are valid for this run only",
        undefined,
      );
    } else if (auth.state === "legacy-file") {
      onWarning(
        "the secret store is unavailable; the old hook-secret file is used until the next start",
        undefined,
      );
    }
    return new HookService(dataDir, port, auth, onWarning);
  }

  endpointFile(): string {
    return hookEndpointFile(this.dataDir);
  }

  nodeTokenDir(): string {
    return nodeTokenDir(this.dataDir);
  }

  /** `undefined` on Windows, where the surface is a named pipe instead. */
  socketPath(): string | undefined {
    return process.platform === "win32"
      ? undefined
      : join(this.dataDir, "hook.sock");
  }

  private pipeName: string | undefined;
  private readonly withdrawn = new Set<"socket" | "pipe">();

  /**
   * Windows: this run's pipe, `armadra-hook-<128 random bits>`. Chosen before
   * the endpoint file is published and never reused; the handshake, not the
   * name, is what keeps a squatter out.
   */
  usePipe(name: string): void {
    this.pipeName = name;
  }

  pipePath(): string | undefined {
    return this.pipeName === undefined
      ? undefined
      : `\\\\.\\pipe\\${this.pipeName}`;
  }

  /** What the endpoint file advertises right now. */
  private advertised(): {
    socket: string | undefined;
    pipe: string | undefined;
  } {
    return {
      socket: this.withdrawn.has("socket") ? undefined : this.socketPath(),
      pipe: this.withdrawn.has("pipe") ? undefined : this.pipePath(),
    };
  }

  port(): number | undefined {
    return this.currentPort;
  }

  bearer(): string {
    return this.auth.bearer;
  }

  bearerMatches(presented: string | undefined): boolean {
    return this.auth.bearerMatches(presented);
  }

  verdict(nodeId: string, presented: string | undefined): Verdict {
    return this.auth.verdict(nodeId, presented);
  }

  /**
   * Mints (or refreshes) `<dataDir>/node-tokens/<nodeId>`. Called when an
   * agent terminal is created and by the refresh route.
   */
  issueNodeToken(nodeId: string): string {
    return this.auth.writeNodeToken(this.nodeTokenDir(), nodeId);
  }

  /**
   * Runs `action` against this node's reducer memory. JavaScript has one
   * thread of execution per turn, so the lock the Rust version holds here is
   * the synchronous call itself: `action` must not await.
   */
  withMemory<T>(nodeId: string, action: (memory: Memory) => T): T {
    let memory = this.memory.get(nodeId);
    if (memory === undefined) {
      memory = newMemory();
      this.memory.set(nodeId, memory);
    }
    return action(memory);
  }

  /** Keeps the latest hello per node, replacing the one before. */
  recordModHello(hello: ModHello): void {
    this.modHellos.delete(hello.nodeId);
    this.modHellos.set(hello.nodeId, hello);
    while (this.modHellos.size > MAX_MOD_HELLOS) {
      const oldest = this.modHellos.keys().next().value;
      if (oldest === undefined) break;
      this.modHellos.delete(oldest);
    }
  }

  /** The hellos this core has heard, oldest first. */
  modSessions(): readonly ModHello[] {
    return [...this.modHellos.values()];
  }

  /** Writes the endpoint file. Called at start-up and whenever the port moves. */
  publishEndpoint(port: number | undefined): void {
    this.currentPort = port;
    const { socket, pipe } = this.advertised();
    endpointFile.write(this.endpointFile(), {
      port,
      socket,
      pipe,
      token: this.auth.bearer,
      nodeTokenDir: this.nodeTokenDir(),
    });
  }

  /**
   * Republishes the endpoint file without a socket entry — called when the
   * Unix socket listener fails to bind after {@link publishEndpoint} already
   * advertised it optimistically (W0.3). Without this, a client would keep
   * trying a socket that will never accept a connection instead of falling
   * back to the TCP port this run still has, if any.
   *
   * A hook client only ever moves to its next candidate on a *transport*
   * failure, so leaving a dead socket in the file would not just be slower —
   * every attempt against this core would burn its socket-connect budget
   * first.
   */
  withdrawSocket(): void {
    this.withdrawn.add("socket");
    this.republish(
      "could not update the hook endpoint file after a failed socket bind",
    );
  }

  /** The same for the named pipe on Windows: a failed bind is taken back. */
  withdrawPipe(): void {
    this.withdrawn.add("pipe");
    this.republish(
      "could not update the hook endpoint file after a failed pipe bind",
    );
  }

  private republish(failure: string): void {
    const port = this.port();
    const { socket, pipe } = this.advertised();
    try {
      endpointFile.write(this.endpointFile(), {
        port,
        socket,
        pipe,
        token: this.auth.bearer,
        nodeTokenDir: this.nodeTokenDir(),
      });
    } catch (error) {
      this.onWarning(failure, error);
    }
    // No port and no listener either: this run has no hook surface left to
    // advertise at all, so the file itself has to go rather than name a dead
    // address.
    if (port === undefined && socket === undefined && pipe === undefined) {
      this.withdraw();
    }
  }

  /**
   * Removes the endpoint file, so a stale terminal's next hook invocation
   * reads "no endpoint here" instead of an address this process no longer
   * answers on. Called on a clean shutdown and when start-up itself could not
   * publish (W0.3).
   */
  withdraw(): void {
    try {
      rmSync(this.endpointFile(), { force: true });
    } catch (error) {
      this.onWarning("could not remove the hook endpoint file", error);
    }
  }

  /**
   * What `GET /health` reports about the hook surface.
   *
   * The file names this core when the transport it advertises is the one we
   * are actually on: the port when we have one, the socket otherwise. A
   * socket-only core whose file still carries a port is a leftover from a
   * previous run and is reported as not ok.
   */
  health(): HookHealth {
    const published = endpointFile.read(this.endpointFile());
    const port = this.port();
    const sock = this.socketPath();
    const pipe = this.pipePath();
    const ok =
      port !== undefined
        ? published.get("ARMADRA_HOOK_PORT") === String(port)
        : pipe !== undefined
          ? !published.has("ARMADRA_HOOK_PORT") &&
            published.get("ARMADRA_HOOK_PIPE") === pipe
          : !published.has("ARMADRA_HOOK_PORT") &&
            published.get("ARMADRA_HOOK_SOCK") === sock;
    return {
      ...(sock === undefined ? {} : { sock }),
      ...(port === undefined ? {} : { port }),
      ok,
      secret: this.auth.state,
    };
  }
}

/**
 * The service of the running core, for the two places that cannot be handed
 * one: the terminal domain, which mints a node token at creation, and the
 * health document.
 *
 * The same shape `core/events` uses for its stream — a module-level slot
 * rather than a field on `CoreContext`, so a domain that only needs it in one
 * statement does not change the assembly signature for everybody.
 */
let assembled: HookService | undefined;

export function hookService(): HookService | undefined {
  return assembled;
}

export function setHookService(service: HookService | undefined): void {
  assembled = service;
}
