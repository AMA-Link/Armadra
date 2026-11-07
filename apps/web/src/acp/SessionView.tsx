import { scoped } from "../sources/scope";
import * as React from "react";
import { toast } from "@/ui/toast";
import {
  sessionDisplay,
  type AcpStartPhase,
  type SessionActivity,
  type TerminalNodeData,
  type TimelineApprovalItem,
  type TimelineAttachment,
  type TimelineElicitationItem,
  type TimelineItem,
  type TimelineUserItem,
} from "@armadra/shared";

import { RuntimeRequestError, runtimeApi } from "@/api/client";
import { onWorkspaceConnection, onWorkspaceEvent } from "@/api/events";
import { useT } from "@/app/preferences-store";
import { useCanAnswer } from "@/app/use-access";
import { useCanvasStore } from "@/store/canvas-store";
import { putLocalBlob } from "@/timeline/blobs";
import type { TimelineViewServices } from "@/timeline/view/services";
import { latestPlan, PlanBar } from "@/timeline/view/PlanBar";
import { TimelineView } from "@/timeline/view/TimelineView";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { DeferredSkeleton } from "@/loading/DeferredSkeleton";
import { SkeletonTurns } from "@/ui/skeletons";
import { Spinner } from "@/ui/spinner";
import { filesOf } from "@/terminal/file-paste";
import { acpApi } from "./api";
import { linkTarget, openLink } from "./open-link";
import {
  type PromptAttachment,
  DropOverlay,
  usePromptAttachments,
} from "./PromptAttachments";
import { useTimelineTitle } from "@/meta/timeline-title";
import { PromptBox, type PromptPrefill } from "./PromptBox";
import { EMPTY_DELIVERY, useAcpStore, type PendingPrompt } from "./store";
import {
  ApprovalCard,
  ElicitationItemCard,
  ToolLookupProvider,
} from "./TimelineCards";
import { visibleUsage } from "./pickers";
import { useAcpPickers } from "./use-pickers";
import { SignInMethods } from "./SignInMethods";
import {
  authMethodsOf,
  startFailureKey,
  startFailureNote,
} from "./start-failure";
import { isReadOnly } from "@/store/canvas/presence";
import { trace } from "./diag";
import { useSessionFeed } from "./use-session-feed";

/**
 * 会话就绪前输入的第一条（契约 §51）。只走一条路：会话开好、内容读到了之后经
 * `POST …/prompt` 发，带这里起好的 `clientTurnId`，core 回显认得它，重发也只投递
 * 一次（§39.9）。不再随 `createSession` 的 `prompt` 一起发：那条路没有回合 id，
 * 请求在路上被取消、重试或工作空间晚到时，页面无从知道 core 收没收到，也对不上回显。
 */
interface QueuedPrompt {
  readonly text: string;
  readonly clientTurnId: string;
}

/** 「加载配置」超过这么久时追加「首次启动较慢」。 */
const COLD_AFTER_MS = 3_000;

/** 节点数据里此刻记的会话 id。 */
function storedSessionId(nodeId: string): string | null {
  const node = useCanvasStore
    .getState()
    .document?.nodes.find((candidate) => candidate.id === nodeId);
  return (node?.data as { sessionId?: string } | undefined)?.sessionId ?? null;
}

/** 把会话 id 写回节点数据；只读时写不进去，答是否落下。 */
function persistSessionId(nodeId: string, id: string): boolean {
  const state = useCanvasStore.getState();
  state.updateNodeData(
    nodeId,
    { sessionId: id, lastExitCode: null },
    { history: "ignore" },
  );
  const landed = storedSessionId(nodeId) === id;
  trace("write-back", {
    landed,
    readOnly: isReadOnly(useCanvasStore.getState()),
  });
  return landed;
}

/** 补写的间隔：只读通常几秒内放开，放开就写，不必每帧查。 */
const PERSIST_RETRY_MS = 500;

/** 反复尝试写回，落下就停；返回停止函数。 */
function watchSessionId(nodeId: string, id: string): () => void {
  const timer = setInterval(() => {
    if (storedSessionId(nodeId) === id || persistSessionId(nodeId, id)) {
      clearInterval(timer);
    }
  }, PERSIST_RETRY_MS);
  return () => clearInterval(timer);
}

/**
 * 会话没有就起一个（`POST /api/acp/sessions`），id 写回节点数据——与终端
 * 节点同一个做法：重开应用靠它接回同一行，它不是用户的编辑，不进撤销栈。
 *
 * 起的过程中跟着 `acp.starting` 记阶段（契约 §51），页面据此画一行提示。
 */
function useAcpSession(
  nodeId: string,
  data: TerminalNodeData,
  workspaceId: string | null,
  enabled: boolean,
) {
  const t = useT();
  const tRef = React.useRef(t);
  tRef.current = t;
  const [starting, setStarting] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [failureNote, setFailureNote] = React.useState<string | null>(null);
  const [authMethods, setAuthMethods] = React.useState<
    ReturnType<typeof authMethodsOf>
  >([]);
  const [phase, setPhase] = React.useState<AcpStartPhase | null>(null);
  const [cold, setCold] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  // 起会话请求答回来的 id。节点数据里有了就以节点数据为准（见 `persistSessionId`）。
  const [createdId, setCreatedId] = React.useState<string | null>(null);
  const sessionId = data.sessionId ?? createdId;
  const agent = data.agent;
  React.useEffect(() => {
    trace("data.sessionId", { sessionId, stored: data.sessionId ?? null });
  }, [sessionId, data.sessionId]);
  // 节点数据补上之后本地记的这一份就没用了；以后节点数据又清空时不能把旧 id 翻出来。
  React.useEffect(() => {
    if (data.sessionId) setCreatedId(null);
  }, [data.sessionId]);
  // 写回没落下（只读）时守着补写，直到落下、节点没了或视图卸载。
  React.useEffect(() => {
    if (createdId === null || data.sessionId) return;
    return watchSessionId(nodeId, createdId);
  }, [createdId, data.sessionId, nodeId]);

  // 没有会话时就听着：请求发出之前订阅好，第一帧不会漏。
  React.useEffect(() => {
    if (sessionId || !enabled) return;
    return onWorkspaceEvent("acp.starting", (event) => {
      if (event.nodeId === nodeId) setPhase(event.phase);
    });
  }, [sessionId, nodeId, enabled]);

  React.useEffect(() => {
    setCold(false);
    if (phase !== "session") return;
    const timer = setTimeout(() => setCold(true), COLD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  React.useEffect(() => {
    if (sessionId || !agent || !enabled) return;
    const store = useCanvasStore.getState();
    const workspace = store.workspace;
    if (!workspace) return;
    let cancelled = false;
    setStarting(true);
    setFailed(false);
    setFailure(null);
    setFailureNote(null);
    setAuthMethods([]);
    setPhase(null);
    trace("create:start", { attempt });
    acpApi
      .createSession({
        workspaceId: workspace.id,
        nodeId,
        cwd: data.cwd ?? workspace.rootPath,
        agentId: agent.id,
        ...(agent.permissionMode
          ? { permissionMode: agent.permissionMode }
          : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.sessionId ? { resume: agent.sessionId } : {}),
      })
      .then((session) => {
        trace("create:ok", { cancelled, id: session.id });
        if (cancelled) return;
        // 先收起「正在起」：写回会话 id 会让这个 effect 自己被清理（依赖
        // 变了），清理之后的 `finally` 不再动状态，骨架屏就永远不走。
        setStarting(false);
        setPhase(null);
        // 写回节点数据不一定落得下：实时板在同步层放行写入之前是只读的（高延迟
        // 中继上这一段可达数秒），`updateNodeData` 此时静默什么都不做。所以会话 id
        // 先记在本地，页面照样往下走；节点数据另有一个 effect 守着补写。
        setCreatedId(session.id);
        persistSessionId(nodeId, session.id);
      })
      .catch((error: unknown) => {
        trace("create:error", {
          cancelled,
          error: String(error).slice(0, 120),
        });
        if (cancelled) return;
        setFailure(
          error instanceof RuntimeRequestError ? (error.code ?? null) : null,
        );
        setFailureNote(startFailureNote(error, tRef.current));
        setAuthMethods(authMethodsOf(error));
        setFailed(true);
        setStarting(false);
        setPhase(null);
      });
    return () => {
      cancelled = true;
    };
    // 只在「没有会话」、工作空间刚读到与重试时起；节点数据的其余改动不该再起
    // 一个。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, nodeId, workspaceId, attempt]);

  return {
    sessionId,
    starting,
    failed,
    failure,
    failureNote,
    authMethods,
    phase,
    cold,
    retry: () => setAttempt((value) => value + 1),
  };
}

/** 一轮的客户端 id；非安全上下文（局域网 http）没有 `randomUUID`。 */
function newClientTurnId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** core 明确拒绝了这一轮（4xx 带码）：没有投递，照旧当场判失败。 */
function refusedByCore(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== undefined
  );
}

/** 附件被 core 拒绝（契约 §56）：那句话本身就说清了原因。 */
function attachmentRefusal(error: unknown): error is RuntimeRequestError {
  return (
    error instanceof RuntimeRequestError &&
    (error.code === "acp_image_unsupported" ||
      error.code === "acp_attachment_unsupported" ||
      error.code === "acp_attachment_too_large")
  );
}

/** 一个主机上的绝对路径 → `file://` 地址（只用来显示）。 */
function fileUrl(path: string): string {
  const portable = path.replace(/\\/g, "/");
  return `file://${portable.startsWith("/") ? "" : "/"}${encodeURI(portable)}`;
}

/** 「确认中」重读镜像的间隔：第一次立刻读，之后等连接缓一缓。 */
const RECONCILE_DELAYS_MS = [0, 1000, 3000] as const;

function useConnected(workspaceId: string | null): boolean {
  const [connected, setConnected] = React.useState(true);
  React.useEffect(() => {
    if (!workspaceId) return;
    return onWorkspaceConnection((id, next) => {
      if (id === workspaceId) setConnected(next);
    });
  }, [workspaceId]);
  return connected;
}

/** 读屏在回合结束时念的那一段最多这么长。 */
const ANNOUNCE_CHARS = 280;

/** 资源链接怎么打开：工作区里的文件进编辑器，网页进浏览器节点，其余不画「打开」。 */
function openUri(uri: string): void {
  const target = linkTarget(uri, useCanvasStore.getState().workspace?.rootPath);
  if (target !== null) openLink(target);
}

function assistantText(item: TimelineItem): string {
  if (item.kind !== "assistant") return "";
  return item.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/**
 * 流式分块不逐块念（消息区 `aria-live="off"`）：回合结束时把最后一条助手文字放进一个
 * 稳定的 `role="status"` 区域，念一次（ACP 会话视图 §5.7）。
 */
function useTurnAnnouncement(
  items: readonly TimelineItem[],
  streaming: boolean,
): string {
  const [said, setSaid] = React.useState("");
  const was = React.useRef(streaming);
  React.useEffect(() => {
    if (was.current && !streaming) {
      const last = [...items]
        .reverse()
        .find((item) => item.kind === "assistant");
      setSaid(
        last === undefined ? "" : assistantText(last).slice(0, ANNOUNCE_CHARS),
      );
    }
    was.current = streaming;
  }, [items, streaming]);
  return said;
}

function lastTurn(items: readonly TimelineItem[]): number {
  let turn = 0;
  for (const item of items) if (item.turn > turn) turn = item.turn;
  return turn;
}

/** 页面先画上的提问：core 回显（带同一个 `clientTurnId` 的用户条目）之前用它。 */
function pendingItem(prompt: PendingPrompt, turn: number): TimelineUserItem {
  return {
    id: `u:pending:${prompt.clientTurnId}`,
    kind: "user",
    turn,
    ord: 1,
    rev: 0,
    source: "core",
    at: prompt.at,
    gen: 0,
    text: prompt.text,
    clientTurnId: prompt.clientTurnId,
    ...(prompt.attachments.length > 0
      ? { attachments: [...prompt.attachments] }
      : {}),
  };
}

/** 会话就绪前排着的那一条：先画成本页的用户消息。 */
function queuedItem(text: string): TimelineUserItem {
  return {
    id: "u:queued",
    kind: "user",
    turn: 1,
    ord: 1,
    rev: 0,
    source: "core",
    at: 0,
    gen: 0,
    text,
  };
}

const SUBMITTING = (since: number): SessionActivity => ({
  phase: "submitting",
  since,
  rev: `local:${since}`,
});

/**
 * ACP 驱动的终端节点的节点体（ACP 设计 §6，设计系统 §5.1，ACP 会话视图 §5）。
 * 头部、徽标、菜单都在 `TerminalNode`，这里只有时间线、审批卡与输入框。
 *
 * 内容来自会话时间线（`useSessionFeed`，走 `timeline.*`）；这里只负责投递——发 prompt、请求断在路上时对账、先把提问画出来。
 *
 * 根上 `select-text nopan nodrag nowheel`：React Flow 给节点的 `user-select: none`
 * 在这里撤掉（字能选、能复制），手形工具开着时按在会话里也不平移画布、不拖节点，
 * 滚轮归消息流。`readOnly`：终端驱动的节点看会话内容（输入仍走终端），没有输入框。
 */
export function SessionView({
  nodeId,
  data,
  readOnly = false,
  sessionId: fixedSessionId,
  initialRect,
}: {
  nodeId: string;
  data: TerminalNodeData;
  /** 只读：不起会话、没有输入框与答复入口（终端驱动节点的「会话」节点体）。 */
  readOnly?: boolean;
  /** 只读时的会话行 id（`terminal_sessions.id`）。 */
  sessionId?: string | null;
  /** 首次布局前的视口尺寸（测试用）。 */
  initialRect?: { width: number; height: number };
}) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const queuedRef = React.useRef<QueuedPrompt | null>(null);
  const [queued, setQueued] = React.useState<string | null>(null);
  const session = useAcpSession(nodeId, data, workspaceId, !readOnly);
  const sessionId = readOnly ? (fixedSessionId ?? null) : session.sessionId;
  const answerable = useCanAnswer(workspaceId ?? "", sessionId);
  const canAnswer = answerable && !readOnly;
  const feed = useSessionFeed({ sessionId });
  useTimelineTitle(nodeId, feed.head.title);
  const connected = useConnected(workspaceId);
  const delivery = useAcpStore((state) =>
    sessionId
      ? (state.sessions[scoped(sessionId)] ?? EMPTY_DELIVERY)
      : EMPTY_DELIVERY,
  );
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  // 对账与重发里读的都是「此刻」的值：放进 ref，回调引用保持稳定。
  const feedRef = React.useRef(feed);
  feedRef.current = feed;

  // 页面先画上的提问：core 回显之前（带同一个 `clientTurnId` 的用户条目还没到）。
  const pending = delivery.pending;
  const echoed =
    pending !== null &&
    feed.items.some(
      (item) =>
        item.kind === "user" && item.clientTurnId === pending.clientTurnId,
    );
  React.useEffect(() => {
    if (sessionId === null || pending === null || !echoed) return;
    useAcpStore.getState().ack(sessionId, pending.clientTurnId, true);
  }, [sessionId, pending, echoed]);
  const overlay = React.useMemo(
    () =>
      pending !== null && !echoed
        ? pendingItem(pending, lastTurn(feed.items) + 1)
        : null,
    // 回合号只在挂出来那一刻定；之后内容增长不挪它。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pending, echoed],
  );
  const items = React.useMemo<readonly TimelineItem[]>(
    () => (overlay === null ? feed.items : [...feed.items, overlay]),
    [feed.items, overlay],
  );
  const plan = React.useMemo(() => latestPlan(items), [items]);

  // 回合在进行：活动层说了算（core 算）；活动还没来时看
  // 最后一个回合条目有没有结束。页面先画上的提问也算（还没送达 / 被拒的不算）。
  const stuck = delivery.undelivered || delivery.failed;
  const busyFromFeed = React.useMemo(() => {
    if (feed.activity !== undefined) {
      return sessionDisplay({ activity: feed.activity, alive: true }).busy;
    }
    for (let i = feed.items.length - 1; i >= 0; i--) {
      const item = feed.items[i] as TimelineItem;
      if (item.kind === "turn") return item.endedAt === undefined;
    }
    return false;
  }, [feed.activity, feed.items]);
  const streaming = !stuck && (overlay !== null || busyFromFeed);
  const announcement = useTurnAnnouncement(feed.items, streaming);
  const activity =
    overlay !== null && !stuck && !busyFromFeed
      ? SUBMITTING(overlay.at)
      : feed.activity;

  // 审批挂在对应的工具行下面（同一回合里有同一个 `toolCallId` 的工具行）；没有工具行
  // 可挂的审批与提问，只有一条时钉在输入框上方（出现时焦点落到第一枚允许钮），多条
  // 随时间线内联。
  const pendingCards = React.useMemo(() => {
    const out: (TimelineApprovalItem | TimelineElicitationItem)[] = [];
    for (const item of feed.items) {
      if (
        (item.kind === "approval" || item.kind === "elicitation") &&
        item.state === "pending"
      ) {
        out.push(item);
      }
    }
    return out;
  }, [feed.items]);
  const toolRowKeys = React.useMemo(() => {
    const keys = new Set<string>();
    for (const item of feed.items) {
      if (item.kind === "tool") keys.add(`${item.turn}:${item.toolCallId}`);
    }
    return keys;
  }, [feed.items]);
  const orphans = React.useMemo(
    () =>
      pendingCards.filter(
        (card) =>
          card.kind === "elicitation" ||
          card.toolCallId === undefined ||
          !toolRowKeys.has(`${card.turn}:${card.toolCallId}`),
      ),
    [pendingCards, toolRowKeys],
  );
  const pinned =
    !readOnly && orphans.length === 1
      ? (orphans[0] as TimelineApprovalItem | TimelineElicitationItem)
      : undefined;
  const pinnedId = pinned?.pendingId;
  // 只有一条待答时，不论钉在上方还是挂在工具行下，都读出来并把焦点交给它。
  const sole =
    !readOnly && pendingCards.length === 1
      ? (pendingCards[0] as TimelineApprovalItem | TimelineElicitationItem)
      : undefined;
  const focusInput = React.useCallback(
    () => inputRef.current?.focus({ preventScroll: true }),
    [],
  );
  // 待答的那张卡出现时读一次（焦点不一定能落过去：人可能正在输入框里打字）。
  const needAnnouncement = React.useMemo(() => {
    if (sole === undefined) return "";
    if (sole.kind === "elicitation")
      return t("acp.elicitation.announce", {
        title: sole.message.slice(0, ANNOUNCE_CHARS),
      });
    const tool = feed.items.find(
      (item) => item.kind === "tool" && item.toolCallId === sole.toolCallId,
    );
    return t("acp.permission.announce", {
      title: (tool?.kind === "tool" ? tool.title : "").slice(0, ANNOUNCE_CHARS),
    });
  }, [sole, feed.items, t]);

  const soleId = sole?.pendingId;
  const renderApproval = React.useCallback(
    (approval: TimelineApprovalItem) =>
      approval.pendingId === pinnedId ? null : (
        <ApprovalCard
          approval={approval}
          canAnswer={canAnswer}
          pinned={approval.pendingId === soleId}
          onAnswered={focusInput}
        />
      ),
    [canAnswer, pinnedId, soleId, focusInput],
  );
  const renderElicitation = React.useCallback(
    (item: TimelineElicitationItem) =>
      item.pendingId === pinnedId ? null : (
        <ElicitationItemCard item={item} canAnswer={canAnswer} />
      ),
    [canAnswer, pinnedId],
  );

  /**
   * 请求断在路上（网络错误、没有答复）时不当场判失败：进入「确认中」，补一次同步
   * 看回显的用户条目对账（契约 §39.9）。core 收到了就按真实回合画，
   * 确认没收到才判没送达；重试沿用同一个 `clientTurnId`，core 只投递一次。
   */
  const confirmTurn = React.useCallback(
    async (id: string, clientTurnId: string) => {
      const waiting = () => {
        const view = useAcpStore.getState().sessions[scoped(id)];
        return view?.confirming === true && view.clientTurnId === clientTurnId;
      };
      for (const delay of RECONCILE_DELAYS_MS) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (!waiting()) return;
        try {
          const delivered = await feedRef.current.confirm(clientTurnId);
          const store = useAcpStore.getState();
          if (delivered) store.delivered(id);
          else store.undeliver(id);
          return;
        } catch {
          // 读不到就再等一会儿；读到了，结论由上面下。
        }
      }
      // 一直读不到：无从确认，判没送达；重试同一个 id，重复不了。
      if (waiting()) useAcpStore.getState().undeliver(id);
    },
    [],
  );

  const send = React.useCallback(
    async (
      text: string,
      retryTurnId?: string,
      uploadIds: readonly string[] = [],
      shown: readonly TimelineAttachment[] = [],
    ) => {
      trace("send", {
        sessionId: sessionId ?? null,
        queued: queuedRef.current !== null,
        failed: session.failed,
      });
      if (!sessionId) {
        // 会话就绪前的第一条（契约 §51）：先画出来，等会话开好再发。再多的
        // 等它就绪。回合 id 此刻就定下，之后不论哪条路发都是它。
        if (queuedRef.current !== null || session.failed) return false;
        queuedRef.current = { text, clientTurnId: newClientTurnId() };
        setQueued(text);
        return true;
      }
      const store = useAcpStore.getState();
      const clientTurnId = retryTurnId ?? newClientTurnId();
      const prompt = { clientTurnId, text, attachments: shown };
      store.begin(sessionId, prompt);
      trace("prompt:begin", { sessionId, clientTurnId });
      try {
        await (uploadIds.length > 0
          ? acpApi.prompt(sessionId, text, clientTurnId, uploadIds)
          : acpApi.prompt(sessionId, text, clientTurnId));
        trace("prompt:ok", { sessionId, clientTurnId });
      } catch (error) {
        trace("prompt:error", {
          sessionId,
          clientTurnId,
          error: String(error).slice(0, 120),
        });
        if (refusedByCore(error)) {
          store.fail(sessionId);
          toast.error(
            attachmentRefusal(error) ? error.message : t("acp.prompt.failed"),
          );
          return true;
        }
        store.confirm(sessionId);
        void confirmTurn(sessionId, clientTurnId);
      }
      return true;
    },
    [sessionId, t, confirmTurn, session.failed],
  );

  const promptDisabled = !connected || session.failed;
  const [dragging, setDragging] = React.useState(false);
  const attachments = usePromptAttachments(
    sessionId ? feed.promptCapabilities : null,
    Boolean(data.ssh),
  );

  /**
   * 输入框交上来的一句（契约 §56）：有附件时先逐个上传到会话所在的 core，再带着
   * 上传 id 发 prompt。上传失败不发、输入框里的字与附件留着。
   */
  const submit = React.useCallback(
    async (text: string, attachments: readonly PromptAttachment[] = []) => {
      if (attachments.length === 0) return send(text);
      if (!sessionId || !workspaceId) {
        toast.error(t("acp.attach.unavailable"));
        return false;
      }
      let uploads;
      try {
        uploads = await Promise.all(
          attachments.map((item) =>
            runtimeApi.uploadAgentFile(workspaceId, item.file, item.file.name),
          ),
        );
      } catch {
        toast.error(t("acp.attach.failed"));
        return false;
      }
      const shown = attachments.map((item, index): TimelineAttachment => {
        const upload = uploads[index]!;
        if (item.preview) {
          // 缩略图读登记在内存里的那份文件；预览地址用不上了。
          URL.revokeObjectURL(item.preview);
          return {
            kind: "image",
            mimeType: item.file.type,
            name: item.file.name,
            blobId: putLocalBlob(item.file),
          };
        }
        return {
          kind: "file",
          uri: fileUrl(upload.path),
          name: upload.name,
          ...(upload.mimeType ? { mimeType: upload.mimeType } : {}),
        };
      });
      return send(
        text,
        undefined,
        uploads.map((upload) => upload.id),
        shown,
      );
    },
    [send, sessionId, workspaceId, t],
  );

  // 会话开好、内容读到了（读不到也一样：投递不靠它）：把排着的那一条交出去。
  // 先清掉再发：这个 effect 可能紧接着再跑一次（`send` 的引用变了），不能发两遍。
  React.useEffect(() => {
    const first = queuedRef.current;
    if (!sessionId || feed.phase === "loading" || first === null) return;
    queuedRef.current = null;
    setQueued(null);
    trace("flush", { sessionId, phase: feed.phase });
    void send(first.text, first.clientTurnId);
  }, [sessionId, feed.phase, send]);

  /**
   * 重发一条提问（重新发送、重新生成）。只有「没送达」的那一轮沿用它的
   * `clientTurnId`（契约 §39.9，core 只投递一次）；跑完了的回合再发是新的
   * 一轮，换一个 id，否则会被 core 当成同一轮去重掉。
   */
  const resend = React.useCallback(
    (text: string) => {
      if (!sessionId) return;
      const current = useAcpStore.getState().sessions[scoped(sessionId)];
      const reuse =
        current?.undelivered && current.lastPrompt === text
          ? (current.clientTurnId ?? undefined)
          : undefined;
      void send(text, reuse);
    },
    [sessionId, send],
  );

  // 回合尾的「重试 / 继续」读此刻的最后一句提问，回调引用不随内容变。
  const lastPromptRef = React.useRef<string | null>(null);
  lastPromptRef.current =
    delivery.lastPrompt ??
    [...feed.items]
      .reverse()
      .find((item): item is TimelineUserItem => item.kind === "user")?.text ??
    null;
  const onRetry = React.useCallback(() => {
    const text = lastPromptRef.current;
    if (text) resend(text);
  }, [resend]);
  const onContinue = React.useCallback(() => {
    void send(t("acp.turn.continuePrompt"));
  }, [send, t]);

  // 「编辑后重发」：把这句填回输入框，不发；同一句可以再填一次（seq 变）。
  const [prefill, setPrefill] = React.useState<PromptPrefill | null>(null);
  const prefillSeq = React.useRef(0);
  const onEdit = React.useCallback((text: string) => {
    prefillSeq.current += 1;
    setPrefill({ text, seq: prefillSeq.current });
  }, []);
  // 「重新生成」：重发最后一回合的提问，是新的一轮。回合在跑、有挂起的审批
  // 或提问、没送达时不给。
  const canRegenerate = !streaming && !stuck && pendingCards.length === 0;
  const onRegenerate = React.useCallback(
    (text: string) => void send(text),
    [send],
  );

  const cancel = React.useCallback(() => {
    if (sessionId) void acpApi.cancel(sessionId).catch(() => undefined);
  }, [sessionId]);

  // 模式与模型：Agent 报回的来自时间线头部；还没报时用候选，新建后就有得选（#685）。
  const {
    modes,
    models,
    configOptions,
    selectMode,
    selectModel,
    selectConfig,
  } = useAcpPickers({
    nodeId,
    sessionId,
    agent: data.agent,
    head: feed.head,
  });
  // 上下文余量等首条消息成功发出之后才显示。
  const usage = React.useMemo(
    () => visibleUsage(feed.head.usage, feed.items),
    [feed.head.usage, feed.items],
  );

  const services = React.useMemo<TimelineViewServices>(
    () => ({
      loadBlob: feed.loadBlob,
      openUri,
      ...(sessionId ? { source: { nodeId, sessionId } } : {}),
    }),
    [feed.loadBlob, nodeId, sessionId],
  );

  // 排着的第一条在时一直画排队气泡：请求还没发出去（工作空间晚到）时也是。
  const loading =
    queued !== null ||
    (!readOnly && session.starting) ||
    (sessionId !== null && feed.phase === "loading" && items.length === 0);
  const empty =
    !loading &&
    feed.phase !== "failed" &&
    items.length === 0 &&
    pendingCards.length === 0;
  const timelineLoading = feed.phase === "loading";

  let body: React.ReactNode;
  if (session.failed) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>{t(startFailureKey(session.failure))}</AlertTitle>
        {session.failureNote !== null && (
          <AlertDescription data-slot="acp-start-note">
            {session.failureNote}
          </AlertDescription>
        )}
        {session.authMethods.length > 0 && data.agent && (
          <SignInMethods
            agentId={data.agent.id}
            methods={session.authMethods}
            onDone={session.retry}
          />
        )}
        <AlertAction>
          <Button size="xs" variant="outline" onClick={session.retry}>
            {t("acp.error.retry")}
          </Button>
        </AlertAction>
      </Alert>
    );
  } else if (loading) {
    body = (
      <div className="flex flex-col gap-2 p-2.5" data-slot="acp-loading">
        {session.phase && (
          <div
            data-slot="acp-starting"
            className="flex items-center gap-1.5 text-caption text-muted-foreground"
          >
            <Spinner size={12} />
            <span>{t(`acp.starting.${session.phase}`)}</span>
            {session.cold && <span>{t("acp.starting.cold")}</span>}
          </div>
        )}
        {queued !== null ? (
          <TimelineView
            items={[queuedItem(queued)]}
            {...(initialRect === undefined ? {} : { initialRect })}
          />
        ) : (
          <DeferredSkeleton>
            <SkeletonTurns label={t("state.loading")} className="p-0" />
          </DeferredSkeleton>
        )}
      </div>
    );
  } else if (feed.phase === "failed") {
    body = (
      <div className="p-2.5">
        <Alert variant="destructive">
          <AlertTitle>{t("acp.error.log")}</AlertTitle>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={feed.retry}>
              {t("acp.error.retry")}
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  } else if (empty) {
    body = (
      <Empty className="h-full border-0 p-4">
        <EmptyHeader>
          <EmptyTitle className="text-body font-normal text-muted-foreground">
            {t(readOnly ? "acp.empty.readOnly" : "acp.empty")}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <TimelineView
        items={items}
        activity={activity}
        loading={timelineLoading}
        onLoadOlder={feed.hasMore ? feed.loadMore : undefined}
        loadingMore={feed.loadingMore}
        resetKey={sessionId ?? undefined}
        services={services}
        renderApproval={renderApproval}
        renderElicitation={renderElicitation}
        onRetry={readOnly ? undefined : onRetry}
        onContinue={readOnly ? undefined : onContinue}
        onEdit={readOnly ? undefined : onEdit}
        onRegenerate={readOnly || !canRegenerate ? undefined : onRegenerate}
        {...(initialRect === undefined ? {} : { initialRect })}
      />
    );
  }

  return (
    <ToolLookupProvider value={feed.byId}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- 整块拖放目标：文件从系统拖进来，键盘用户走输入框里的附件按钮 */}
      <div
        data-slot="acp-session-view"
        data-read-only={readOnly || undefined}
        className="nopan nodrag nowheel relative flex h-full w-full cursor-auto flex-col bg-card select-text"
        // 拖进会话视图任何地方的文件都成输入框的附件（契约 §56），不交给画布。
        onDragOver={(event) => {
          if (readOnly) return;
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = promptDisabled ? "none" : "copy";
          setDragging(true);
        }}
        onDragLeave={(event) => {
          // 移到子元素上也会触发：只有真正离开会话视图才收起覆盖层。
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(event) => {
          setDragging(false);
          if (readOnly) return;
          const files = filesOf(event.dataTransfer);
          if (files.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          if (!promptDisabled) attachments.add(files);
        }}
        onClick={(event) => {
          // 空态那一句话是「点一下就能说」：点空白处把焦点交给输入框。
          if (empty && !readOnly && event.target === event.currentTarget)
            inputRef.current?.focus();
        }}
      >
        {dragging && !readOnly && <DropOverlay disabled={promptDisabled} />}
        {!connected && (
          <Alert className="rounded-none border-x-0 border-t-0 py-1.5">
            <AlertTitle className="text-meta">{t("acp.offline")}</AlertTitle>
          </Alert>
        )}
        <div className="flex min-h-0 flex-1 flex-col">{body}</div>
        {delivery.confirming && (
          <Alert data-slot="acp-confirming" className="mx-2 mb-1.5 w-auto">
            <Spinner aria-hidden />
            <AlertTitle>{t("acp.turn.confirming")}</AlertTitle>
          </Alert>
        )}
        {(delivery.failed || delivery.undelivered) && !streaming && (
          <Alert variant="destructive" className="mx-2 mb-1.5 w-auto">
            <AlertTitle>
              {t(
                delivery.undelivered
                  ? "acp.error.undelivered"
                  : "acp.error.turn",
              )}
            </AlertTitle>
            {delivery.lastPrompt && (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => resend(delivery.lastPrompt as string)}
                >
                  {t("acp.error.retry")}
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
        <div role="status" className="sr-only">
          {announcement}
        </div>
        <div aria-live="polite" className="sr-only">
          {needAnnouncement}
        </div>
        <PlanBar plan={plan} className="mb-1" />
        {pinned?.kind === "approval" && (
          <ApprovalCard
            key={pinned.pendingId}
            approval={pinned}
            canAnswer={canAnswer}
            pinned
            className="mx-2 mb-1.5"
            onAnswered={focusInput}
          />
        )}
        {pinned?.kind === "elicitation" && (
          <ElicitationItemCard
            key={pinned.pendingId}
            item={pinned}
            canAnswer={canAnswer}
            className="mx-2 mb-1.5"
            onAnswered={focusInput}
          />
        )}
        {!readOnly && (
          <PromptBox
            sessionId={sessionId}
            inputRef={inputRef}
            disabled={promptDisabled}
            streaming={streaming}
            modes={modes}
            models={models}
            configOptions={configOptions}
            onSubmit={submit}
            attachments={attachments}
            onCancel={cancel}
            onMode={selectMode}
            onModel={selectModel}
            onConfig={selectConfig}
            commands={feed.head.commands ?? []}
            usage={usage}
            prefill={prefill}
          />
        )}
      </div>
    </ToolLookupProvider>
  );
}

export default SessionView;
