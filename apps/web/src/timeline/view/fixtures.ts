import type {
  SessionActivity,
  TimelineItem,
  TimelineToolItem,
} from "@armadra/shared";

/**
 * 假数据夹具（storybook 风格）：测试与本地预览共用，不接真实数据。
 * 文案只用英文，避免与界面文案混淆。
 */

const BASE_AT = 1_760_000_000_000;

let counter = 0;

export function resetFixtureCounter(): void {
  counter = 0;
}

function base(turn: number, id: string, kind: TimelineItem["kind"]) {
  counter += 1;
  return {
    id,
    turn,
    ord: counter,
    rev: counter,
    source: "acp" as const,
    at: BASE_AT + counter * 1000,
    gen: 1,
    kind,
  };
}

export function userItem(turn: number, text: string): TimelineItem {
  return { ...base(turn, `u:${turn}`, "user"), kind: "user", text };
}

export function assistantItem(
  turn: number,
  text: string,
  n = 0,
  streaming = false,
): TimelineItem {
  return {
    ...base(turn, `a:${turn}:${n}`, "assistant"),
    kind: "assistant",
    parts: [{ type: "text", text }],
    streaming,
  };
}

export function thoughtItem(
  turn: number,
  text: string,
  n = 0,
  streaming = false,
): TimelineItem {
  return {
    ...base(turn, `th:${turn}:${n}`, "thought"),
    kind: "thought",
    text,
    streaming,
    ...(streaming ? {} : { durationMs: 12_000 }),
  };
}

export function toolItem(
  turn: number,
  toolCallId: string,
  patch: Partial<TimelineToolItem> = {},
): TimelineToolItem {
  return {
    ...base(turn, `tool:${toolCallId}`, "tool"),
    kind: "tool",
    toolCallId,
    toolKind: "read",
    title: "Read file",
    status: "completed",
    locations: [],
    content: [],
    startedAt: BASE_AT,
    endedAt: BASE_AT + 1200,
    ...patch,
  };
}

export function turnItem(
  turn: number,
  patch: Partial<Extract<TimelineItem, { kind: "turn" }>> = {},
): TimelineItem {
  return {
    ...base(turn, `turn:t${turn}`, "turn"),
    kind: "turn",
    turnId: `t${turn}`,
    startedAt: BASE_AT,
    endedAt: BASE_AT + 5000,
    stopReason: "end_turn",
    permissionWaitMs: 0,
    ...patch,
  };
}

/** 一个长会话：每回合一问一答，带一次读文件的工具调用。 */
export function longSession(turns: number): TimelineItem[] {
  resetFixtureCounter();
  const items: TimelineItem[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    items.push(userItem(turn, `Question ${turn}`));
    items.push(
      toolItem(turn, `c${turn}`, {
        title: `Read src/file-${turn}.ts`,
        locations: [{ path: `/repo/src/file-${turn}.ts`, line: 1 }],
      }),
    );
    items.push(
      assistantItem(
        turn,
        `Answer ${turn}\n\n${"Some explanation text. ".repeat(12)}\n\n- one\n- two`,
      ),
    );
    items.push(turnItem(turn));
  }
  return items;
}

/** 覆盖设计 §3.1 每一种内容的演示回合。 */
export function showcaseSession(): TimelineItem[] {
  resetFixtureCounter();
  const items: TimelineItem[] = [
    userItem(1, "Fix the failing test and show me the output"),
    thoughtItem(
      1,
      "The test fails on a stale snapshot.\n\nCheck the **fixture** first.",
    ),
    toolItem(1, "r1", {
      title: "Read src/sum.ts",
      locations: [{ path: "/repo/src/sum.ts", line: 3 }],
      input: { path: "/repo/src/sum.ts", line: 3 },
    }),
    toolItem(1, "s1", {
      toolKind: "search",
      title: "Search for sum",
      input: { query: "export function sum" },
    }),
    toolItem(1, "e1", {
      toolKind: "edit",
      title: "Edit src/sum.ts",
      locations: [{ path: "/repo/src/sum.ts", line: 1 }],
      content: [
        {
          type: "diff",
          path: "/repo/src/sum.ts",
          oldText: "export const sum = (a, b) => a - b;\n",
          newText: "export const sum = (a: number, b: number) => a + b;\n",
        },
      ],
    }),
    toolItem(1, "x1", {
      toolKind: "execute",
      title: "Run pnpm test",
      input: {
        command: "pnpm test",
        fields: [{ key: "cwd", value: "/repo" }],
      },
      content: [
        {
          type: "terminal",
          terminalId: "term-1",
          command: "pnpm test",
          output:
            "\u001b[32m PASS \u001b[0m src/sum.test.ts\n\u001b[2mTests:\u001b[22m \u001b[1;32m3 passed\u001b[0m\n",
          exitCode: 0,
        },
      ],
    }),
    {
      ...base(1, "a:1:0", "assistant"),
      kind: "assistant",
      streaming: false,
      parts: [
        {
          type: "text",
          text: "The test passes now.\n\n```ts\nexport const sum = (a: number, b: number) => a + b;\n```\n",
        },
        { type: "image", blobId: "img1", mimeType: "image/png", bytes: 2048 },
        {
          type: "resource_link",
          uri: "file:///repo/README.md",
          name: "README.md",
          mimeType: "text/markdown",
        },
        {
          type: "resource",
          uri: "file:///repo/notes.txt",
          name: "notes.txt",
          mimeType: "text/plain",
          text: "remember to bump the version\n",
        },
        { type: "audio", blobId: "aud1", mimeType: "audio/wav", bytes: 40_000 },
      ],
    },
    turnItem(1),
  ];
  return items;
}

export function activity(
  phase: SessionActivity["phase"],
  patch: Partial<SessionActivity> = {},
): SessionActivity {
  return { phase, since: BASE_AT, rev: "boot:1", ...patch };
}
