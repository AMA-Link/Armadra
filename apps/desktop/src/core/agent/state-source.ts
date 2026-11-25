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
}

/** 返回 `false` = 这个 provider 的通道在这个节点上不存在（退回观察路径）。 */
export type NodeChannelGate = (facts: NodeChannelFacts) => boolean;

const gates = new Map<string, NodeChannelGate>();

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
