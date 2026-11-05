import { randomBytes } from "node:crypto";
import type { CoreContext } from "../main";
import { pendingDir } from "../paths";
import { channelKey } from "../private-pipe";
import { HOOK_LABEL } from "../private-pipe/labels";
import { secretsFor } from "../secrets";
import { timelineDomainOf } from "../timeline";
import { startApprovalSweep } from "./approvals";
import type { IngestContext } from "./ingest";
import { HookServer } from "./server";
import { HookService, hookService, setHookService } from "./service";
import { markAgentStatusRestored } from "./store";
import { startStaleSweep } from "./sweep";
import { installRoutes } from "./routes";

export { HookService, hookService } from "./service";
export { issueNodeToken } from "./tokens";
export {
  PERM_WAIT_SECONDS,
  sweepOrphans,
  validPendingId,
  writeAnswerFile,
} from "./approvals";
export { registerCollabDispatcher } from "./collab";
export type {
  CollabAnswer,
  CollabCaller,
  CollabDispatcher,
  CollabRequest,
} from "./collab";
export { answerApproval, getApproval } from "./store";

/**
 * The hook domain's one assembly point.
 *
 * The start-up order is the Rust `hook::start`'s and is not arbitrary:
 *
 *   1. mark every surviving `agent_status` row as restored — a row read back
 *      after a restart is not live knowledge;
 *   2. bind the socket;
 *   3. publish the endpoint file, and withdraw it again if the bind failed.
 *
 * Publishing last is what keeps the file from ever naming an address nothing
 * answers on (W0.3). Every failure is logged rather than thrown: the core is
 * still useful without a hook surface, and a hard failure here would mean no
 * canvas at all.
 */
export interface HookDomain {
  readonly service: HookService;
  readonly server: HookServer;
  stop(): Promise<void>;
}

export async function install(context: CoreContext): Promise<HookDomain> {
  // The secret is loaded before anything listens or publishes: an endpoint
  // file must never name a surface that cannot verify a token yet.
  const service = await HookService.open(
    context.dataDir,
    undefined,
    (message, detail) =>
      context.log.warn(message, {
        ...(detail === undefined ? {} : { error: describe(detail) }),
      }),
    secretsFor(context),
  );
  setHookService(service);

  const ingestContext: IngestContext = {
    database: context.db.database,
    bus: context.bus,
    hooks: service,
    onHook: (nodeId, event) =>
      timelineDomainOf(context.server)?.sources.onHook(nodeId, event),
    log: {
      warn: (message, detail) =>
        context.log.warn(message, { detail: describe(detail) }),
      debug: (message, detail) =>
        context.log.debug(message, { detail: describe(detail) }),
    },
  };

  markAgentStatusRestored(context.db.database);
  installRoutes(context, service);

  const server = new HookServer({ ...ingestContext });
  const socketPath = service.socketPath();
  const stopSweeps: (() => void)[] = [
    startStaleSweep(ingestContext),
    // Contract §5.5: pending permission files left by a client that was killed
    // mid-wait are cleared at start-up and hourly.
    startApprovalSweep(context.dataDir, (removed) =>
      context.log.info("cleared orphaned permission requests", { removed }),
    ),
  ];

  const start = async (): Promise<void> => {
    let bound = false;
    if (socketPath !== undefined) {
      try {
        await server.listen({ kind: "unix", path: socketPath });
        bound = true;
        context.log.info("hook socket is listening", { path: socketPath });
      } catch (error) {
        context.log.warn("could not bind the hook socket", {
          path: socketPath,
          error: describe(error),
        });
      }
    }
    let pipeBound = false;
    if (process.platform === "win32") {
      // Windows has no socket file: the surface is a named pipe whose name is
      // new every start and whose connections complete the `armadra-pipe/1`
      // handshake, keyed from the bearer the client already reads from the
      // endpoint file (contract §102.5). A DACL that cannot be tightened is a
      // warning, not a reason to go without hooks: the handshake still holds.
      const name = `armadra-hook-${randomBytes(16).toString("hex")}`;
      service.usePipe(name);
      try {
        await server.listen(
          { kind: "pipe", name },
          {
            channel: {
              label: HOOK_LABEL,
              key: channelKey(service.bearer(), HOOK_LABEL),
            },
            onWarning: (message, detail) =>
              context.log.warn(message, { detail: describe(detail) }),
          },
        );
        pipeBound = true;
        context.log.info("hook pipe is listening", { name });
      } catch (error) {
        context.log.warn("could not bind the hook pipe", {
          name,
          error: describe(error),
        });
      }
    }
    try {
      service.publishEndpoint(undefined);
      if (socketPath !== undefined && !bound) {
        // The endpoint file would otherwise advertise a socket that will never
        // accept a connection, and a hook client only moves on from a
        // *transport* failure — every attempt would burn its connect budget
        // here first (W0.3).
        service.withdrawSocket();
      }
      if (service.pipePath() !== undefined && !pipeBound)
        service.withdrawPipe();
    } catch (error) {
      context.log.warn("hook clients will not find this core", {
        error: describe(error),
      });
      // A stale file from a previous run must not go on describing a process
      // that never actually started serving hooks.
      service.withdraw();
    }
    context.log.debug("hook pending directory", {
      path: pendingDir(context.dataDir),
    });
  };
  // Awaited: on Windows the pipe is bound, hardened and only then published,
  // and a `/health` asked right after start-up must already see the endpoint
  // (otherwise `hook.ok` is false for as long as the DACL helper runs).
  await start();

  return {
    service,
    server,
    stop: async () => {
      for (const stop of stopSweeps) stop();
      await server.close();
      service.withdraw();
      if (hookService() === service) setHookService(undefined);
    },
  };
}

/**
 * One line of detail for the log.
 *
 * `String(detail)` on the object the hook server passes — `{ path, error }` —
 * is `[object Object]`, and that is what every failed hook request logged:
 * the path and the reason were both collected and both thrown away. The
 * fields the caller assembled are worth more than the class of the value.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}
