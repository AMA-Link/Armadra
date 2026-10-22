import { launchLine } from "../dependencies/launch";
import { activeLaunchGate, configDirFor } from "../agent/launch-gate";
import { agentSettings } from "../acp";
import { baseAgent } from "../agent/registry";
import { loadNode } from "../collab/nodes";
import type { CoreContext } from "../main";
import type { TerminalManager } from "./manager";

/** 与页面启动时序同一个判据（`use-launch.ts`）。 */
const QUIET_MS = 400;
const COLD_MS = 3_000;
const POLL_MS = 100;

/**
 * 节点体是会话时间线的终端驱动节点：没有终端表面挂着，起 PTY 之后由 core 自己
 * 敲启动行（契约 §84）。启动行与依赖满足后的启动、页面敲的是同一份
 * （`dependencies/launch.ts::launchLine`，含 `--resume`）。
 *
 * 过启动闸门（同一份配置目录上的 Codex 一个一个起），等提示符安静再敲，敲
 * 之前再看一眼输入是不是被人动过。失败只记日志：会话已经起来，用户切到终端体
 * 还能自己看到并处理。
 */
export function launchInSession(
  context: CoreContext,
  manager: TerminalManager,
  request: {
    readonly sessionId: string;
    readonly generation: number;
    readonly nodeId: string;
    readonly agentId: string;
    readonly shell: string | undefined;
  },
): void {
  void run(context, manager, request).catch((error: unknown) => {
    context.log.warn("could not type the launch line for a session body", {
      nodeId: request.nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function run(
  context: CoreContext,
  manager: TerminalManager,
  request: Parameters<typeof launchInSession>[2],
): Promise<void> {
  const node = loadNode(context.db.database, request.nodeId);
  if (node === undefined) return;
  const settings = agentSettings();
  const line = launchLine(
    { settings, dataDir: context.dataDir },
    request.agentId,
    node.data,
    request.shell,
  );
  const gate = activeLaunchGate();
  if (gate !== undefined && node.data.ssh == null) {
    const base = baseAgent(settings, request.agentId);
    await gate.acquire({
      agentId: base,
      configDir: configDirFor(base),
      nodeId: request.nodeId,
    });
  }
  const started = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const activity = manager.observedActivity(request.sessionId);
    if (activity === undefined) return;
    if (activity.pending === true) return;
    const now = Date.now();
    if (
      activity.lastOutputAt !== undefined &&
      now - activity.lastOutputAt >= QUIET_MS
    )
      break;
    if (now - started >= COLD_MS) break;
  }
  await manager.input(request.sessionId, request.generation, `${line}\r`);
}
