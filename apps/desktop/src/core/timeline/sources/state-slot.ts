import type { AgentEvent } from "../../hook/normalize";
import type { InternalReport } from "../../hook/report";
import type { StatFn, TailTimers, WatchFn } from "./tailer";

/**
 * 状态读取槽（审查 P0b）：一个 CLI 的状态**不经 hook、扩展或 ACP**，由 core 自己
 * 去读它写下的东西（会话文件、进程表……）时，读取者挂在这里。
 *
 * 与转录适配器（{@link import("./types").TranscriptAdapter}）的区别：
 *
 *   * 转录适配器的触发是 hook 门铃——没有第一条 hook，就没有读取者。槽不等任何
 *     上报：**终端会话一起来**（`running` 的 `terminal_sessions` 行出现）管理器就
 *     调 {@link StateSlotProvider.open}，因为第一条上报要靠它去读才会有；
 *   * 槽的产出是状态上报（走 `reportInternal`），不是时间线条目。
 *
 * 声明级别（{@link StateSlotLevel}）：
 *
 *   * `reported`：读到的是 CLI 自己写的权威记录，且读取者能证明它属于**这个**
 *     节点的进程（G2 的按 pid 绑定就是这个意思）。事件的来源（`stateSource`）由
 *     槽写死，必须是词汇表里的上报级来源，能满足空闲门；
 *   * `observed`：只能看出个大概（读不到进程绑定、读不到审批等待）。事件来源被
 *     管理器强制写成 `observed`，只用于显示，不满足任何一道门。
 *
 * 一个 provider 一个槽；槽对一个终端会话开一次，会话行不再是 `running` 时停掉。
 */

export type StateSlotLevel = "reported" | "observed";

/** 槽打开时拿到的事实与它能用的唯一出口 {@link StateSlotContext.report}。 */
export interface StateSlotContext {
  readonly nodeId: string;
  readonly workspaceId: string;
  /** `baseAgent` 之后的 id。 */
  readonly agentId: string;
  /** 终端会话 id（会话行的主键）与代次。 */
  readonly sessionId: string;
  readonly generation: number;
  readonly cwd: string;
  readonly startedAtMs: number;
  /** 这个会话的 PTY 进程号；读不到（远程、休眠）答 `undefined`。 */
  pid(): number | undefined;
  /** 这个会话是不是跑在远程主机上（本机文件读不到）。 */
  remote(): boolean;
  /** 这个会话启动环境里的一个变量（节点自己的 `GROK_HOME` 之类）；没有答 `undefined`。 */
  env?(name: string): string | undefined;
  /** 取这个会话此刻的画面（最后几十行）；取不到答 `undefined`。 */
  screen?(): Promise<string | undefined>;
  /**
   * 这个节点的审批卡现在可不可以在终端里代答（两道门与启动模式都过了，契约 §127）。
   * 缺省 / 没装配 = 不可以。只有问「要不要为这张卡建审批记录」时用。
   */
  answerCards?(): Promise<boolean>;
  /**
   * 只关审批记录、不报状态：一条记录对应的卡没人能再答了（槽停了、槽起来时前一个
   * 槽留下的）。`pendingId` 关一条，`protocol` 关这个节点上这一种的所有开着的。
   */
  settleApprovals?(settles: {
    readonly pendingId?: string;
    readonly protocol?: string;
    readonly answer: "cancelled";
  }): void;
  /**
   * 报一条状态。级别由管理器按槽声明的执行：`reported` 的事件必须自带上报级来源；
   * `observed` 的事件来源一律改写成 `observed`。`bind: true` 另给事件自造终端绑定。
   * 没装配上报口（用例、只起部分域的构建）时是空操作，答 `false`。
   */
  report(
    event: AgentEvent,
    options?: Pick<InternalReport, "rawPayload"> & { readonly bind?: boolean },
  ): boolean;
  readonly timers: TailTimers;
  readonly watch?: WatchFn | undefined;
  readonly stat?: StatFn | undefined;
  readonly log: {
    warn(message: string, fields?: Record<string, unknown>): void;
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

/** 管理器对一个已打开的槽的全部要求。 */
export interface StateSlot {
  start(): void;
  /**
   * 有 hook 响了、或别处有理由认为文件刚变过：马上读一次。可缺省。
   * 必须幂等：槽自己的上报也会敲门铃再叫回这里，读不到新东西就不能再报。
   */
  poke?(): void;
  /** 停之前最后读一次（会话行已经不是 `running`）。可缺省。 */
  readNow?(): void;
  stop(): void;
}

export interface StateSlotProvider {
  /** `baseAgent` 之后的 id；一个 id 只登记一个。 */
  readonly agentId: string;
  readonly level: StateSlotLevel;
  /**
   * 给这个会话开槽；这个节点上没有可读的（远程、版本不够……）答 `undefined`，
   * 节点照常起，状态走观察路径。
   */
  open(context: StateSlotContext): StateSlot | undefined;
}

const providers = new Map<string, StateSlotProvider>();

/** 登记一个槽；返回撤销函数。同一个 id 再登记会替换（用例里反复装配）。 */
export function registerStateSlot(provider: StateSlotProvider): () => void {
  providers.set(provider.agentId, provider);
  return () => {
    if (providers.get(provider.agentId) === provider) {
      providers.delete(provider.agentId);
    }
  };
}

export function stateSlotProviderFor(
  agentId: string | undefined,
): StateSlotProvider | undefined {
  return agentId === undefined ? undefined : providers.get(agentId);
}
