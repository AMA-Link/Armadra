import type { AgentState, CanvasNode, WorkflowDraftRow } from "@armadra/shared";
import type { MirroredStatus } from "@/agent/status-store";
import type { SubagentCardModel } from "@/agent/subagent-store";
import type {
  DispatchTask,
  IntakeCandidate,
  IntakeSource,
} from "@/coordinator/api";
import { mirroredFor } from "./status";

/**
 * `coordinator` 分区的假数据（设计展示页 §2.1，设计系统 §5.4）：ama 派出三个
 * 成员（done / working / failed），主从边从 ama 指向每个成员；外加一张
 * `workflow_propose` 的草案卡。纯对象，无副作用；标题是用户内容。
 */

const BOARD = "00000000-0000-4000-8000-0000000000c0";
const AT = "2026-10-03T09:00:00.000Z";

export const COORDINATOR_IDS = {
  lead: "00000000-0000-4000-8000-0000000000c1",
  done: "00000000-0000-4000-8000-0000000000c2",
  working: "00000000-0000-4000-8000-0000000000c3",
  failed: "00000000-0000-4000-8000-0000000000c4",
} as const;

function terminal(
  id: string,
  title: string,
  agentId: string,
  position: { x: number; y: number },
): CanvasNode {
  return {
    id,
    boardId: BOARD,
    type: "terminal",
    title,
    color: "#0a84ff",
    labels: [],
    note: "",
    position,
    // 节点宽 >440 才画头部徽标与状态胶囊（`nodes.css` 的容器查询）。
    size: { width: 456, height: 84 },
    data: { kind: "terminal", agent: { id: agentId } },
    createdAt: AT,
    updatedAt: AT,
  } as CanvasNode;
}

export const COORDINATOR_NODES: CanvasNode[] = [
  terminal(COORDINATOR_IDS.lead, "审查 src/x 与 src/y", "ama", {
    x: 16,
    y: 120,
  }),
  terminal(COORDINATOR_IDS.done, "src/x", "claude", { x: 560, y: 16 }),
  terminal(COORDINATOR_IDS.working, "src/y", "codex", { x: 560, y: 120 }),
  terminal(COORDINATOR_IDS.failed, "文档", "pi", { x: 560, y: 224 }),
];

export const COORDINATOR_EDGES = [
  COORDINATOR_IDS.done,
  COORDINATOR_IDS.working,
  COORDINATOR_IDS.failed,
].map((target) => ({
  id: `edge-${target}`,
  type: "link",
  source: COORDINATOR_IDS.lead,
  target,
  data: { role: "supervises" },
}));

/**
 * 四个节点的状态镜像：节点头胶囊、成员行、顶部 Agent 树都从它经 `displayOfStatus`
 * 取 tone 与文案，展示页不再自己写 tone 表。
 */
export const COORDINATOR_STATUSES: Record<string, MirroredStatus | undefined> =
  {
    [COORDINATOR_IDS.lead]: mirroredFor(COORDINATOR_IDS.lead, "working"),
    [COORDINATOR_IDS.done]: mirroredFor(COORDINATOR_IDS.done, "done"),
    [COORDINATOR_IDS.working]: mirroredFor(COORDINATOR_IDS.working, "working"),
    [COORDINATOR_IDS.failed]: mirroredFor(COORDINATOR_IDS.failed, "failed"),
  };

/** 正在跑的成员此刻派出的两个子代理（顶部 Agent 树的叶子）。 */
export const COORDINATOR_CARDS: Record<string, SubagentCardModel[]> = {
  [COORDINATOR_IDS.working]: [
    {
      id: "k1",
      parentId: COORDINATOR_IDS.working,
      taskLabel: "读取 store",
      startedAt: Date.parse(AT),
      state: "done",
    },
    {
      id: "k2",
      parentId: COORDINATOR_IDS.working,
      taskLabel: "补测试",
      startedAt: Date.parse(AT),
      state: "working",
    },
  ],
};

/** 正在跑的那一个成员是工作流的第几步。 */
export const WORKING_STEP = 2;

export const BODY_LINES: Record<string, string> = {
  [COORDINATOR_IDS.lead]: "canvas_team → 3 成员",
  [COORDINATOR_IDS.done]: "✓ 结论已 post 给 ama",
  [COORDINATOR_IDS.working]: "> 读取 src/y/store.ts",
  [COORDINATOR_IDS.failed]: "✗ 本轮失败：上下文超限",
};

/** 分派抽屉（设计系统 §5.4）：三个成员的任务行，失败那行可重试。 */
function task(
  nodeId: string,
  runnerId: string,
  patch: Partial<DispatchTask>,
): DispatchTask {
  return {
    taskId: `sess:${runnerId}`,
    coordinatorNodeId: COORDINATOR_IDS.lead,
    runnerId,
    nodeId,
    status: "running",
    startedAt: AT,
    endedAt: null,
    reason: null,
    retryable: false,
    title: null,
    stage: null,
    report: null,
    attention: null,
    reply: null,
    pulls: [],
    ...patch,
  };
}

export const DISPATCH_NOW = Date.parse("2026-10-03T09:14:00.000Z");

export const DISPATCH_TASKS: DispatchTask[] = [
  task(COORDINATOR_IDS.done, "claude", {
    status: "done",
    endedAt: "2026-10-03T09:12:00.000Z",
  }),
  task(COORDINATOR_IDS.working, "codex", {
    startedAt: "2026-10-03T09:01:00.000Z",
  }),
  task(COORDINATOR_IDS.failed, "pi", {
    status: "failed",
    startedAt: "2026-10-03T09:02:00.000Z",
    endedAt: "2026-10-03T09:05:30.000Z",
    reason: "turnFailed",
    retryable: true,
  }),
];

export const DISPATCH_STATES: Record<string, AgentState> = {
  [COORDINATOR_IDS.lead]: "working",
  [COORDINATOR_IDS.working]: "working",
};

/** ama 输出到画板的汇总便签。 */
export const SUMMARY_NODE: CanvasNode = {
  id: "00000000-0000-4000-8000-0000000000c5",
  boardId: BOARD,
  type: "sticky",
  title: "审查结论",
  color: "#0a84ff",
  labels: [],
  note: "",
  position: { x: 0, y: 0 },
  data: {
    kind: "sticky",
    content: "",
    source: { nodeId: COORDINATOR_IDS.lead, sessionId: "ama" },
  },
  createdAt: AT,
  updatedAt: AT,
} as CanvasNode;

export const DRAFT: WorkflowDraftRow = {
  id: "draft-1",
  workspaceId: "ws",
  boardId: BOARD,
  proposerNodeId: COORDINATOR_IDS.lead,
  status: "pending",
  templateId: null,
  createdAt: AT,
  updatedAt: AT,
  draft: {
    version: 1,
    title: "双人审查后汇总",
    params: [],
    roles: [
      { id: "a", agentId: "claude", title: "前端" },
      { id: "b", agentId: "codex", title: "后端" },
      { id: "lead", agentId: "ama", title: "汇总" },
    ],
    links: [
      { from: "lead", to: "a", role: "supervises" },
      { from: "lead", to: "b", role: "supervises" },
    ],
    steps: [
      { id: "s1", kind: "prompt", role: "a", prompt: "审查前端", after: [] },
      { id: "s2", kind: "prompt", role: "b", prompt: "审查后端", after: [] },
      {
        id: "s3",
        kind: "collect",
        role: "lead",
        from: ["s1", "s2"],
        prompt: "汇总",
        after: ["s1", "s2"],
      },
    ],
  },
};

/** 来源与候选（契约 §104.7）：一个观察中的来源、一个已确认规则的自动来源。 */
export const INTAKE_SOURCES: IntakeSource[] = [
  {
    id: "src-1",
    coordinatorNodeId: COORDINATOR_IDS.lead,
    repo: "github.com/acme/app",
    kinds: ["issue", "pull"],
    mode: "observe",
    allow: ["alice", "bob"],
    enabled: true,
    rulesHash: "0123456789abcdef",
    rulesCurrentHash: "0123456789abcdef",
    rulesPresent: true,
    stats: { decided: 20, accepted: 18, agreed: 17, disagreed: 2, window: 20 },
  },
  {
    id: "src-2",
    coordinatorNodeId: COORDINATOR_IDS.lead,
    repo: "git.example.com/team/docs",
    kinds: ["issue"],
    mode: "auto",
    allow: ["carol"],
    enabled: false,
    rulesHash: "0123456789abcdef",
    rulesCurrentHash: "fedcba9876543210",
    rulesPresent: true,
    stats: { decided: 3, accepted: 2, agreed: 0, disagreed: 0, window: 20 },
  },
];

function candidate(
  number: number,
  patch: Partial<IntakeCandidate>,
): IntakeCandidate {
  return {
    id: `intake:github.com/acme/app#${number}:issue:x`,
    sourceId: "src-1",
    kind: "issue",
    repo: "github.com/acme/app",
    number,
    title: "",
    author: "alice",
    url: `https://github.com/acme/app/issues/${number}`,
    authorized: true,
    seenAt: AT,
    verdict: null,
    reason: null,
    verdictAt: null,
    modeAtVerdict: null,
    review: null,
    itemId: null,
    outcome: null,
    ...patch,
  };
}

export const INTAKE_CANDIDATES: IntakeCandidate[] = [
  candidate(41, { title: "登录页白屏" }),
  candidate(42, {
    title: "补充迁移说明",
    author: "mallory",
    authorized: false,
    verdict: "skip",
    reason: "不在规则范围内",
    verdictAt: AT,
    modeAtVerdict: "observe",
  }),
  candidate(43, {
    title: "导出 CSV 乱码",
    verdict: "accept",
    reason: "是缺陷，有复现步骤",
    verdictAt: AT,
    modeAtVerdict: "observe",
    review: "agree",
  }),
  candidate(44, {
    title: "升级依赖",
    verdict: "accept",
    reason: "符合规则",
    verdictAt: AT,
    modeAtVerdict: "auto",
    outcome: "refused:rules_changed",
  }),
];
