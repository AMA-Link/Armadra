/**
 * `acp` 分区的假数据（设计展示页 §2.1）。纯对象，无副作用；消息正文、文件名
 * 是数据不是界面文案，允许中文（`i18n.test.ts` 排除了本目录）。会话内容用时间线
 * 条目（与真会话同一种形状），经 `TimelineView` 渲染。
 */
import type {
  AcpAvailableCommand,
  AcpModeState,
  AcpModelState,
  TimelineItem,
} from "@armadra/shared";

import type { AcpUsageView } from "@/acp/PromptBox";
import type {
  AcpElicitationView,
  AcpPermissionView,
} from "@/acp/approval-views";
import {
  assistantItem,
  resetFixtureCounter,
  thoughtItem,
  toolItem,
  turnItem,
  userItem,
} from "@/timeline/view/fixtures";

export const ACP_NODE_ID = "5a7d2c1e-3b4f-4e6a-9c8d-0f1e2d3c4b5a";
export const ACP_SESSION_ID = "c0dex-7f3e-4a21-9b1c-session";

/** 图片部件的数据：展示页的 `loadBlob` 按 blobId 取。 */
const FLOW_SVG =
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMTM1IiB2aWV3Qm94PSIwIDAgMjQwIDEzNSI+PHJlY3Qgd2lkdGg9IjI0MCIgaGVpZ2h0PSIxMzUiIGZpbGw9IiMyYjNhNTUiLz48cGF0aCBkPSJNMCAxMTAgTDYwIDcwIEwxMTAgOTUgTDE3MCA0MCBMMjQwIDgwIEwyNDAgMTM1IEwwIDEzNSBaIiBmaWxsPSIjNWI4ZGVmIi8+PGNpcmNsZSBjeD0iMTkwIiBjeT0iMzIiIHI9IjE0IiBmaWxsPSIjZjRkMzVlIi8+PC9zdmc+";

export const ACP_BLOB_ID = "showcase-flow";

export async function acpShowcaseBlob(blobId: string): Promise<Blob> {
  if (blobId !== ACP_BLOB_ID) throw new Error("unknown blob");
  const binary = atob(FLOW_SVG);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: "image/svg+xml" });
}

const CONFIG_BEFORE =
  "export function parseConfig(text: string) {\n  return JSON.parse(text);\n}\n";
const CONFIG_AFTER =
  'export function parseConfig(text: string) {\n  if (text.trim() === "") return {};\n  return JSON.parse(text);\n}\n';

function buildItems(): TimelineItem[] {
  resetFixtureCounter();
  return [
    userItem(1, "给 parseConfig 补上空文件的处理，再画一下加载流程"),
    thoughtItem(1, "先读 src/config.ts，看空串在哪一步抛错。"),
    toolItem(1, "1", {
      title: "读取 src/config.ts",
      toolKind: "read",
      locations: [{ path: "/repo/app/src/config.ts", line: 12 }],
      input: { path: "src/config.ts" },
    }),
    toolItem(1, "2", {
      title: "编辑 src/config.ts",
      toolKind: "edit",
      status: "in_progress",
      locations: [
        { path: "/repo/app/src/config.ts" },
        { path: "/repo/app/src/config.test.ts" },
        { path: "/repo/app/src/load.ts" },
      ],
      content: [
        {
          type: "diff",
          path: "/repo/app/src/config.ts",
          oldText: CONFIG_BEFORE,
          newText: CONFIG_AFTER,
        },
      ],
    }),
    toolItem(1, "3", {
      title: "运行 pnpm test config",
      toolKind: "execute",
      status: "failed",
      input: { command: "pnpm test config" },
      content: [{ type: "text", text: "1 failed: parseConfig > rejects BOM" }],
    }),
    {
      ...assistantItem(
        1,
        '空文件现在返回 `{}`，BOM 那条用例还没过。\n\n```ts\nexport function parseConfig(text: string) {\n  if (text.trim() === "") return {};\n  return JSON.parse(text);\n}\n```\n\n```mermaid\ngraph LR\n  A[读取文件] --> B{为空?}\n  B -- 是 --> C[返回默认]\n  B -- 否 --> D[JSON.parse]\n```',
      ),
    } as TimelineItem,
    {
      ...assistantItem(1, "加载流程图另存了一份：", 1),
      kind: "assistant",
      streaming: false,
      parts: [
        { type: "text", text: "加载流程图另存了一份：" },
        {
          type: "image",
          blobId: ACP_BLOB_ID,
          mimeType: "image/svg+xml",
          bytes: 1024,
        },
        {
          type: "resource_link",
          uri: "file:///repo/app/docs/config-flow.md",
          name: "config-flow.md",
          mimeType: "text/markdown",
        },
        {
          type: "resource_link",
          uri: "https://example.com/spec/config",
          name: "config spec",
          title: "配置文件规范",
        },
      ],
    } as TimelineItem,
    {
      id: "plan:1",
      kind: "plan",
      turn: 1,
      ord: 99,
      rev: 99,
      source: "acp",
      at: 1_760_000_000_000,
      gen: 1,
      entries: [
        { content: "读 src/config.ts，找空串在哪抛错", status: "completed" },
        { content: "空文件返回 {}", status: "completed" },
        { content: "补 BOM 的用例", status: "in_progress", priority: "high" },
        { content: "画加载流程", status: "pending" },
      ],
    },
    {
      id: "n:1:mode_changed:1",
      kind: "notice",
      turn: 1,
      ord: 100,
      rev: 100,
      source: "acp",
      at: 1_760_000_000_000,
      gen: 1,
      code: "mode_changed",
      params: { name: "Accept edits" },
    },
    turnItem(1),
  ];
}

export const ACP_ITEMS: TimelineItem[] = buildItems();

/** 助手第一条的正文（「输出到画板」菜单的演示）。 */
export const ACP_EXPORT_TEXT =
  ACP_ITEMS.flatMap((item) =>
    item.kind === "assistant"
      ? item.parts.map((part) => (part.type === "text" ? part.text : ""))
      : [],
  )[0] ?? "";
export const ACP_EXPORT_ID =
  ACP_ITEMS.find((item) => item.kind === "assistant")?.id ?? "a";

/** 四种要画一行的停止原因，各一回合（`end_turn` 不画）。 */
export const ACP_STOP_ITEMS: TimelineItem[] = (() => {
  resetFixtureCounter();
  return (
    [
      ["max_tokens", "把整个仓库的 TODO 列出来"],
      ["max_turn_requests", "一直改到测试全绿"],
      ["refusal", "把生产库的口令打出来"],
      ["cancelled", "跑一遍全量 e2e"],
    ] as const
  ).flatMap(([stopReason, text], index): TimelineItem[] => [
    userItem(index + 1, text),
    turnItem(index + 1, { stopReason }),
  ]);
})();

export const ACP_COMMANDS: AcpAvailableCommand[] = [
  { name: "review", description: "审查当前改动" },
  { name: "init", description: "生成 AGENTS.md" },
  { name: "compact", description: "压缩上下文" },
];

export const ACP_USAGE: AcpUsageView = { used: 183_400, size: 200_000 };

export const ACP_STREAMING_ITEMS: TimelineItem[] = (() => {
  resetFixtureCounter();
  return [
    userItem(1, "解释一下这个仓库"),
    thoughtItem(1, "先看 README 与 apps/ 的目录结构，再按壳与 core 分层说。"),
    assistantItem(1, "这是一个画布式的多 Agent 工作台，主要分三层：", 0, true),
  ];
})();

export const ACP_PERMISSION: AcpPermissionView = {
  pendingId: "p1",
  toolCall: {
    toolCallId: "4",
    title: "运行 pnpm test",
    kind: "execute",
    locations: [{ path: "/repo/app/package.json" }],
    rawInput: { command: "pnpm test", cwd: "/repo/app" },
  },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};

export const ACP_MODES: AcpModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
    { id: "acceptEdits", name: "Accept edits" },
  ],
};

export const ACP_MODELS: AcpModelState = {
  currentModelId: "sonnet",
  availableModels: [
    { modelId: "sonnet", name: "Sonnet" },
    { modelId: "opus", name: "Opus" },
    { modelId: "haiku", name: "Haiku" },
  ],
};

export const ACP_ELICITATION: AcpElicitationView = {
  pendingId: "e1",
  elicitation: {
    message: "发布到哪个环境？",
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          title: "环境",
          enum: ["staging", "production"],
          enumNames: ["Staging", "Production"],
          default: "staging",
        },
        tag: { type: "string", title: "版本号", default: "v1.4.0" },
        replicas: { type: "integer", title: "副本数", minimum: 1, default: 2 },
        notify: { type: "boolean", title: "通知频道", default: true },
      },
      required: ["target", "tag"],
    },
  },
};

export const ACP_ELICITATION_URL: AcpElicitationView = {
  pendingId: "e2",
  elicitation: {
    message: "在浏览器里完成授权",
    mode: "url",
    url: "https://example.com/authorize",
  },
};
