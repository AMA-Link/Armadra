/**
 * Agent 状态的前端镜像（§5.4 / §13.4）。
 *
 * 真相在 core（`hook/reduce.ts`）；这里只是把它推来的帧收进一张表，不再自己
 * 归约（acp-progressive-view S9/S10）：
 *
 *  - **done 的保持窗口、审批的过期**都在 core 算完才下发。页面曾经各存一份
 *    （`DONE_HOLDOFF` 与 5 分钟 TTL），与 core 不一致时节点头和会话视图会各说各话。
 *  - **乱序丢弃**：`updatedAt` 比现有的旧的一律忽略；活动按 `activity.rev` 判断，
 *    core 重启过（`bootId` 变了）就取后到的。
 *  - **进程死活**：补齐（`hydrate`）时带上 `alive`，死了的节点不再冒充「需要你」。
 *  - **未读**：`done` 到达时，如果该节点没被选中、或窗口没有焦点，
 *    就置未读；`markRead` 清除（点开节点即视为已读）。
 *
 * 显示一律经 `agent/display.ts` 的 `sessionDisplay()`，这里不出胶囊也不出色调。
 */
import { create } from "zustand";
import {
  compareActivityRev,
  sessionDisplay,
  type AgentStatus,
  type SessionActivity,
  type SessionSummary,
  type WorkspaceEvent,
} from "@armadra/shared";

import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { agentGateway } from "./gateway";
import { currentSource } from "../api/source";
import { activeSourceId, scoped } from "../sources/scope";

/**
 * 镜像里的一条：core 推来的状态，加上页面补齐时才知道的进程死活与活动。
 * `alive` 缺省按活着算（事件帧只来自活的进程）；补齐出 `false` 的节点不再
 * 被算作「在等人」。
 */
export type MirroredStatus = AgentStatus & {
  alive?: boolean;
  activity?: SessionActivity;
};

/** 归约时需要知道的「用户此刻在不在看这个节点」。测试里显式传入。 */
export interface StatusContext {
  selected?: boolean;
  focused?: boolean;
  now?: number;
  /** `false` 时不发已读回执（测试用）。 */
  remote?: boolean;
}

export interface AgentStatusState {
  /** 键是 `${sourceId}:${nodeId}`（`sources/scope.ts`）：两个源里同名的节点不碰撞。 */
  statuses: Record<string, MirroredStatus>;
  upsert: (status: AgentStatus, context?: StatusContext) => void;
  /**
   * 清未读：本地立刻清，同时把回执 POST 给 Runtime（否则重连 / 重启后
   * `GET /sessions` 又会把未读补回来）。`remote: false` 只在测试里用。
   */
  markRead: (
    nodeId: string,
    options?: { remote?: boolean; sourceId?: string },
  ) => void;
  /** 权限已答复：丢掉 `pendingId`，头部按钮随之消失。过期由 core 清（S9）。 */
  resolveApproval: (pendingId: string) => void;
  /** 一个节点的活动（细粒度阶段）；比现有的旧就丢。 */
  setActivity: (
    nodeId: string,
    activity: SessionActivity,
    sourceId?: string,
  ) => void;
  hydrate: (
    sessions: SessionSummary[],
    workspaceId?: string,
    sourceId?: string,
  ) => void;
  handleEvent: (event: WorkspaceEvent, context?: StatusContext) => void;
  reset: () => void;
}

function isNodeSelected(nodeId: string): boolean {
  const canvas = useCanvasStore.getState();
  // 选区属于画布所在的那个源；别的源推来的帧不算「正在看」。
  return (
    canvas.sourceId === activeSourceId() &&
    canvas.selectedNodeIds.includes(nodeId)
  );
}

function isWindowFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.hasFocus();
}

function millis(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? 0 : value;
}

/* ------------------------------- 已读回执 -------------------------------- */

interface OptionalRuntimeApi {
  markAgentRead?: (nodeId: string) => Promise<unknown>;
}

/**
 * 清掉一个节点的未读标记。
 *
 * 带上 workspace 就走网关：agent 域搬到 Host 之后这张标记是 Host 的记录，
 * `POST /api/agent-status/{id}/read` 会回 409 `ownership_moved`（业务迁移
 * §2.7）。不带 workspace 的调用（旧调用点、测试）保留原来的软引用路径。
 */
export async function postAgentRead(
  nodeId: string,
  workspaceId?: string,
): Promise<void> {
  if (workspaceId) {
    await agentGateway.markRead(workspaceId, nodeId);
    return;
  }
  const optional = runtimeApi as unknown as OptionalRuntimeApi;
  if (typeof optional.markAgentRead === "function") {
    await optional.markAgentRead(nodeId);
    return;
  }
  if (typeof fetch !== "function") return;
  const source = currentSource();
  await source.fetch(
    `${source.httpBase}/api/agent-status/${encodeURIComponent(nodeId)}/read`,
    { method: "POST" },
  );
}

export const useAgentStatusStore = create<AgentStatusState>((set, get) => ({
  statuses: {},

  upsert: (incoming, context) => {
    const key = scoped(incoming.nodeId);
    const previous = get().statuses[key];

    // 乱序帧：只按时间戳判断，不按到达顺序。
    if (previous && millis(incoming.updatedAt) < millis(previous.updatedAt)) {
      return;
    }

    // `terminal.exit` 已经把镜像条目删掉了；60s 后巡检才补出来的那条合成
    // 收尾不该把它重新变出来，否则终端都凉了一分钟，节点上又冒出个胶囊。
    if (!previous && isSyntheticClose(incoming)) return;

    // 迟到的 `working` 不该复活刚结束的回合：这个保持窗口在 core 的归约里
    // （`hook/reduce.ts` 的 `DONE_HOLDOFF_SECONDS`），推下来的帧已经是定论。
    const state = incoming.state;

    // 未读只由 Runtime 置位、由已读回执清除（§5.4）。开新回合**不算**看过：
    // §5.7 的消息投递正是靠往目标 PTY 写一行来开新回合，那时用户可能根本
    // 没看过上一回合的结果；在这里清掉徽标，恰好清在它最有信息量的时候。
    // 所以这里只把 Runtime 的值原样带过来，不做「非 done 即已读」的清除。
    let unread = incoming.unread;
    // 唯一的本地判断：回合结束的那一刻用户正盯着这个节点，那他就是看到了。
    // 只有客户端知道这件事，所以由客户端补一条已读回执，让 SQLite 跟上——
    // 否则刷新一次徽标又会回来。
    let watched = false;
    if (state === "done" && incoming.unread) {
      const selected = context?.selected ?? isNodeSelected(incoming.nodeId);
      const focused = context?.focused ?? isWindowFocused();
      const entered = previous?.state !== "done";
      watched = entered && selected && focused;
      if (watched) unread = false;
    }

    // 活动与进程死活不在状态帧上：沿用补齐时记下的活动，进程死活按事件帧
    // 来自活的进程处理。
    const next: MirroredStatus = {
      ...incoming,
      state,
      unread,
      ...(previous?.activity ? { activity: previous.activity } : {}),
    };
    set((current) => ({
      statuses: { ...current.statuses, [key]: next },
    }));
    if (watched && context?.remote !== false) {
      // 已知竞态（不修）：回执在途时如果又结束了一个回合，Runtime 会先把
      // `unread` 重新置起来、再被这条回执清掉，于是第二个回合被当成看过了。
      // 要修得给回执带上它确认的那一帧（序号或时间戳），代价高于收益——
      // 触发它需要两个回合在一个来回的往返时间内先后结束。
      void postAgentRead(incoming.nodeId).catch(() => undefined);
    }
  },

  markRead: (nodeId, options) => {
    const key = scoped(nodeId, options?.sourceId);
    const status = get().statuses[key];
    if (!status || !status.unread) return;
    set((current) => ({
      statuses: {
        ...current.statuses,
        [key]: { ...current.statuses[key]!, unread: false },
      },
    }));
    if (options?.remote === false) return;
    // 回执失败不回滚：本地已读是用户看见的事实，下一条状态帧会重新对齐。
    void postAgentRead(nodeId).catch(() => undefined);
  },

  resolveApproval: (pendingId) =>
    set((current) => {
      const entry = Object.entries(current.statuses).find(
        ([, status]) => status.pendingId === pendingId,
      );
      if (!entry) return current;
      const [key, status] = entry;
      const { pendingId: _dropped, ...rest } = status;
      return { statuses: { ...current.statuses, [key]: rest } };
    }),

  setActivity: (nodeId, activity, sourceId) =>
    set((current) => {
      const key = scoped(nodeId, sourceId);
      const previous = current.statuses[key];
      if (!previous) return current;
      if (previous.activity) {
        // 同一个 core 进程内按序号；`bootId` 变了（core 重启过）取后到的。
        const order = compareActivityRev(previous.activity.rev, activity.rev);
        if (order !== null && order >= 0) return current;
      }
      return {
        statuses: { ...current.statuses, [key]: { ...previous, activity } },
      };
    }),

  /**
   * 用 `GET /sessions` 的结果补齐镜像（冷启动、重连后）。
   * 只补有 Agent 的会话——普通终端没有状态可镜像——并且不覆盖更新的本地条目。
   */
  hydrate: (sessions, workspaceId, sourceId) =>
    set((current) => {
      const statuses = { ...current.statuses };
      let changed = false;
      for (const session of sessions) {
        if (!session.agentId) continue;
        const key = scoped(session.nodeId, sourceId);
        const previous = statuses[key];
        if (previous && millis(session.updatedAt) <= millis(previous.updatedAt))
          continue;
        statuses[key] = {
          nodeId: session.nodeId,
          workspaceId: workspaceId ?? previous?.workspaceId ?? "",
          agentId: session.agentId,
          state: session.state,
          // 来源徽标只在 `agent.status` 帧里带就会「刷新即消失」：重连后要等
          // 该节点下一个回合才回来。会话列表现在也带这一列（协作通道 §3.2），
          // 于是镜像重建出来的条目和事件推来的条目形状一致。
          stateSource: session.stateSource,
          unread: session.unread,
          sessionId: session.sessionId,
          pendingId: session.pendingId,
          sessionPhase: session.sessionPhase,
          ...(session.errored === undefined
            ? {}
            : { errored: session.errored }),
          verified: previous?.verified ?? false,
          restored: true,
          alive: session.alive,
          ...(session.activity ? { activity: session.activity } : {}),
          updatedAt: session.updatedAt,
          ...(session.interrupted === undefined
            ? {}
            : { interrupted: session.interrupted }),
        };
        changed = true;
      }
      return changed ? { statuses } : current;
    }),

  handleEvent: (event, context) => {
    switch (event.type) {
      case "agent.status":
        get().upsert(event.status, context);
        return;
      case "agent.approval": {
        // 已答复的那一份（`answer` 已写、或显式 `resolved`）不是新请求，
        // 而是「这条没了」：直接丢 `pendingId`，不等下一条 `agent.status`。
        if (isResolvedApproval(event.request)) {
          get().resolveApproval(event.pendingId);
          return;
        }
        // Runtime 在 approval 之前已经推过一条 `blocked` 状态；这里只补
        // `pendingId`，不凭空造状态条目（缺 workspaceId / agentId）。
        const key = scoped(event.nodeId);
        const previous = get().statuses[key];
        if (!previous) return;
        set((current) => ({
          statuses: {
            ...current.statuses,
            [key]: {
              ...previous,
              state: "blocked",
              pendingId: event.pendingId,
            },
          },
        }));
        return;
      }
      case "timeline.activity":
        // 渐进式状态（契约 §82）：只补活动，粗状态仍由 `agent.status` 说了算。
        get().setActivity(event.nodeId, event.activity);
        return;
      case "terminal.exit": {
        // 进程没了就没有 Agent 状态可言，会话行改由 `alive=false` 表达。
        if (!event.nodeId) return;
        const key = scoped(event.nodeId);
        if (!get().statuses[key]) return;
        set((current) => {
          const statuses = { ...current.statuses };
          delete statuses[key];
          return { statuses };
        });
        return;
      }
      default:
        return;
    }
  },

  reset: () => set({ statuses: {} }),
}));

export function useAgentStatus(
  nodeId: string,
  sourceId?: string,
): MirroredStatus | undefined {
  return useAgentStatusStore(
    (state) => state.statuses[scoped(nodeId, sourceId)],
  );
}

/**
 * 需要你：等待权限或等待回答。与通知共用 `sessionDisplay().need`（契约 §81），
 * 进程已死（`alive === false`）不算。
 */
export function isAttention(status: {
  state?: AgentStatus["state"];
  pendingId?: string;
  alive?: boolean;
}): boolean {
  const need = sessionDisplay({ status, alive: status.alive }).need;
  return need === "approval" || need === "input";
}

/* ------------------------------ 权限请求形状 ------------------------------ */

/**
 * `agent.approval.request` 是 Runtime 的 `AgentApproval` 记录（`request` 是
 * hook 的原始载荷）。判定「已了结」时同时认两种形状：写了 `answer` 的记录，
 * 以及显式带 `resolved: true` 的通知帧。
 */
export function isResolvedApproval(request: unknown): boolean {
  if (!request || typeof request !== "object") return false;
  const record = request as {
    resolved?: unknown;
    answer?: unknown;
    answeredAt?: unknown;
  };
  if (record.resolved === true) return true;
  return (
    (typeof record.answer === "string" && record.answer.length > 0) ||
    (typeof record.answeredAt === "string" && record.answeredAt.length > 0)
  );
}

/* -------------------------------- 显示映射 -------------------------------- */

/**
 * Runtime **合成**的收尾，而不是某个回合真的跑出了结果。两种来源，
 * 都由 60s 巡检写出，靠 `lastMessage` 的前缀自报家门：
 *
 *  - `stale=true`：20 分钟没有 hook 回报（`reduce::stale_event`）。
 *  - `terminated=true`：终端在回合结束前就没了，CLI 被杀，没机会发 `Stop`。
 *
 * 两者都只是「让节点别再声称 RUNNING」，不是对回合的判决。Runtime 已经
 * 把这一点编码进数据了：合成收尾的 `errored` / `interrupted` 都是 `false`
 * （不冒充 TURN FAILED / PAUSED），并且标了 `silent`，所以它不置未读。
 * 于是显示侧不必再拦一道——胶囊读判决与未读即可，看到什么都是真的。
 *
 * 这个判据用来挡掉合成的收尾边：它不是一次真实的回合，不该当成新状态处理
 * （`upsert` 里也靠它避免把已经删掉的镜像条目重新变出来）。
 */
const SYNTHETIC_CLOSE_MARKERS = ["stale=true", "terminated=true"] as const;

export function isSyntheticClose(status: AgentStatus): boolean {
  const message = status.lastMessage;
  if (!message) return false;
  return SYNTHETIC_CLOSE_MARKERS.some((marker) => message.startsWith(marker));
}
