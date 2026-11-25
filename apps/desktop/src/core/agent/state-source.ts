import {
  AGENT_STATE_SOURCES,
  REPORTED_STATE_SOURCES,
  RUN_REPORT_STATE_SOURCES,
  stateSourceIsObserved,
  stateSourceIsReported,
  stateSourceIsRunReport,
} from "@armadra/shared";

/**
 * 状态来源：core 里的词汇表与「是否上报」判定的唯一入口。
 *
 * 词汇表与三个判定函数在 `@armadra/shared` 的 `domain/primitives.ts`（线上形状
 * 在那里，页面也问它）；这里只补 core 才有的两件事：每个来源的常量名，以及
 * 「哪家 CLI 走哪条通道」的 {@link stateSourceFor}。`agent/registry.ts`、
 * `agent/target-state.ts`、`hook/store.ts` 都从这里转出，各处不得再手写来源
 * 字面量（`agent/state-source.test.ts` 守着）。
 */

export {
  AGENT_STATE_SOURCES,
  REPORTED_STATE_SOURCES,
  RUN_REPORT_STATE_SOURCES,
  stateSourceIsObserved,
  stateSourceIsReported,
  stateSourceIsRunReport,
};

/** A command Hook the CLI forked: `armadra-hook <provider>` over `hook.sock`. */
export const STATE_SOURCE_HOOK = "hook";
/**
 * An extension inside the CLI's own process, speaking the same HTTP on the
 * same socket. Same bearer, same node token, same terminal binding — it is the
 * in-process form of the command Hook, not a more trusted one.
 */
export const STATE_SOURCE_EXTENSION = "extension";
/**
 * The PTY-side guess for a terminal with no adapter at all. A display-level
 * hint and nothing more; see {@link stateSourceIsReported}.
 */
export const OBSERVED = "observed";
/**
 * A session the core drives over the Agent Client Protocol (ACP 会话视图设计
 * §4.1): the protocol itself reports every turn and every permission request,
 * so it is as much a report as `hook`. Set by `core/acp`, never by a client.
 */
export const STATE_SOURCE_ACP = "acp";
/**
 * Core reads a CLI's own session record (grok's `events.jsonl`) for the process
 * the node's terminal is running — no hook, no extension, no protocol of its own
 * (contract §122). A report like the others: a local file the CLI wrote, read
 * by the core itself, so a client cannot claim it.
 */
export const STATE_SOURCE_TRANSCRIPT = "transcript";

/**
 * 状态由 core 自己产生的 provider（读它的会话记录，没有 hook 客户端、没有扩展）：
 * `/hook/<provider>` 上来的任何东西都不是它的上报，`ingest` 整条丢掉。
 */
export function providerReportsInternally(provider: string): boolean {
  return stateSourceFor(provider) === STATE_SOURCE_TRANSCRIPT;
}

/**
 * Which channel a provider's status reports arrive on.
 *
 * A property of how that adapter is installed, not of the request: an
 * extension and a command Hook post the same body with the same headers, so
 * trusting a client's own claim would let any of them name the strongest
 * source. `undefined` is a provider with no adapter.
 */
export function stateSourceFor(provider: string): string | undefined {
  switch (provider) {
    case "claude":
    case "codex":
    case "copilot":
      return STATE_SOURCE_HOOK;
    // Pi, Oh My Pi and opencode report from a module inside the CLI's own
    // process. Same socket, same bearer, same node token: a different
    // transport, not a different authority.
    // `ama` reports through its host adapter, a module inside its own process
    // (docs/design/coordinator-agent.md §2.3).
    case "pi":
    case "omp":
    case "opencode":
    case "ama":
      return STATE_SOURCE_EXTENSION;
    // grok：没有 hook 客户端，也没有扩展；core 读它自己的会话记录（契约 §122）。
    // 这是 provider 的通道，**不是**这个节点一定有通道：远程节点、Windows、读不到
    // `active_sessions.json` 的由 `registerNodeChannelGate` 收窄。
    case "grok":
      return STATE_SOURCE_TRANSCRIPT;
    default:
      return undefined;
  }
}

/* ------------------------------ 按节点判通道 ------------------------------ */

/**
 * 一个节点自己的事实：provider 的通道在这个节点上成不成立，不由 provider 一个
 * 名字决定（审查 P1-6）。`remote`：节点的会话在 SSH 主机上。后续按需加字段
 * （版本门、`schema` 是否对得上），每加一个都要在门里有人用。
 */
export interface NodeChannelFacts {
  readonly remote: boolean;
  /**
   * The channel's own reader found the CLI's record unreadable on this node
   * (`hook/sources/grok-events.ts`): the gate then takes the observed path
   * rather than waiting for a first report that cannot come.
   */
  readonly unbound?: boolean;
}

/** 返回 `false` = 这个 provider 的通道在这个节点上不存在（退回观察路径）。 */
export type NodeChannelGate = (facts: NodeChannelFacts) => boolean;

const gates = new Map<string, NodeChannelGate>();

const unbound = new Set<string>();

/** A slot's reader found this node's CLI record unreadable (the gate goes observed). */
export function markChannelUnbound(nodeId: string, value: boolean): void {
  if (value) unbound.add(nodeId);
  else unbound.delete(nodeId);
}

export function channelUnbound(nodeId: string): boolean {
  return unbound.has(nodeId);
}

/* ---------------- 判 idle 之前补读一次（状态读取槽，契约 §122） ---------------- */

const refreshers = new Map<string, () => void>();

/** 一个节点的状态读取槽登记「现在同步读一次」；返回撤销函数。 */
export function registerStateRefresher(
  nodeId: string,
  refresh: () => void,
): () => void {
  refreshers.set(nodeId, refresh);
  return () => {
    if (refreshers.get(nodeId) === refresh) refreshers.delete(nodeId);
  };
}

/**
 * 在判一个节点空不空闲**之前**调：读取槽自己的轮询有个窗口，文件已经写了
 * `turn_started`、库里的行还写着 `done`，这一刻的投递就会落进正在干活的 pane。
 * 没有槽的节点什么也不做；读失败不影响投递（下一拍再读）。
 */
export function refreshNodeState(nodeId: string): void {
  try {
    refreshers.get(nodeId)?.();
  } catch {
    // the slot logs its own failures
  }
}

/**
 * 登记 provider 对节点的约束；返回撤销函数。没登记的 provider 通道在每个节点上
 * 都成立（今天的七家：hook 或扩展经 `hook.sock`，与节点在哪台机器上无关）。
 */
export function registerNodeChannelGate(
  provider: string,
  gate: NodeChannelGate,
): () => void {
  gates.set(provider, gate);
  return () => {
    if (gates.get(provider) === gate) gates.delete(provider);
  };
}

/**
 * 这个节点上，这家 CLI 的状态通道是哪一条；没有（provider 没有适配，或节点不满足
 * 它的门）答 `undefined`。`send` 等「等第一条上报」的地方问这个，而不是
 * {@link stateSourceFor}：后者只回答 provider，答不了「这个节点会不会报」。
 */
export function nodeStateChannel(
  provider: string,
  facts: NodeChannelFacts,
): string | undefined {
  const source = stateSourceFor(provider);
  if (source === undefined) return undefined;
  const gate = gates.get(provider);
  return gate === undefined || gate(facts) ? source : undefined;
}
