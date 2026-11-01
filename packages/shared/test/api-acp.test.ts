import { describe, expect, it } from "vitest";

import {
  acpElicitationAnswerSchema,
  acpElicitationFormSchema,
  acpPermissionRequestSchema,
  agentAcpInfoSchema,
  acpToolCallSchema,
  answerApprovalRequestSchema,
  answerApprovalResponseSchema,
  createAcpSessionRequestSchema,
  sessionSummarySchema,
  workspaceEventSchema,
} from "../src/index.js";

describe("ACP session shapes (contract §14.2–§14.4)", () => {
  it("parses the ACP events on the workspace stream", () => {
    const turn = workspaceEventSchema.parse({
      type: "acp.turn",
      sessionId: "s1",
      nodeId: "n1",
      turnId: "t1",
      stopReason: "something_new",
    });
    expect(turn.type === "acp.turn" && turn.stopReason).toBeUndefined();
    expect(
      workspaceEventSchema.parse({
        type: "acp.driver",
        nodeId: "n1",
        driver: "acp",
        sessionId: "s2",
        resumed: false,
      }).type,
    ).toBe("acp.driver");
  });

  it("keeps a tool call whose kind or status it does not know", () => {
    const call = acpToolCallSchema.parse({
      toolCallId: "t1",
      kind: "teleport",
      status: "done-ish",
      content: [
        { type: "diff", path: "/a", oldText: null, newText: "x" },
        { type: "content", content: { type: "text", text: "ok" } },
      ],
    });
    expect(call.kind).toBeUndefined();
    expect(call.status).toBeUndefined();
    expect(call.content).toHaveLength(2);
  });

  it("reads a permission request", () => {
    const request = acpPermissionRequestSchema.parse({
      protocol: "acp",
      toolCall: { toolCallId: "t1", title: "pnpm test" },
      options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
    });
    expect(request.options[0]?.kind).toBe("allow_once");
  });

  it("carries the option and the acp route on approval answers", () => {
    expect(
      answerApprovalRequestSchema.parse({ decision: "allow", optionId: "a" })
        .optionId,
    ).toBe("a");
    expect(
      answerApprovalResponseSchema.parse({
        id: "p1",
        nodeId: "n1",
        answer: "allow",
        answeredAt: "2026-10-03T00:00:00.000Z",
        revision: 1,
        route: "acp",
      }).route,
    ).toBe("acp");
  });

  it("validates a session request and a session row's backend", () => {
    expect(() =>
      createAcpSessionRequestSchema.parse({
        workspaceId: "w",
        nodeId: "n",
        cwd: "/",
        agentId: "codex",
        permissionMode: "plan",
      }),
    ).not.toThrow();
    expect(
      sessionSummarySchema.parse({
        nodeId: "n",
        boardId: "b",
        sessionId: "s",
        kind: "terminal",
        title: "t",
        cwd: "/",
        updatedAt: "2026-10-03T00:00:00.000Z",
        alive: true,
        backend: "acp",
      }).backend,
    ).toBe("acp");
  });
});

describe("acp info of an agents row (contract §14.1)", () => {
  const base = {
    support: "official",
    program: "codex-acp",
    installed: true,
    resume: "load",
  };

  it("stays valid without the capabilities of the last initialize", () => {
    expect(agentAcpInfoSchema.parse(base).capabilities).toBeUndefined();
  });

  it("carries the capabilities and the auth methods without terminal args", () => {
    const parsed = agentAcpInfoSchema.parse({
      ...base,
      capabilities: {
        load: true,
        resume: true,
        list: true,
        close: false,
        logout: false,
        image: true,
        audio: false,
        embeddedContext: true,
        mcpHttp: false,
        mcpSse: false,
        authMethods: [
          { id: "login", name: "Log in", type: "terminal", supported: true },
        ],
      },
    });
    expect(parsed.capabilities?.list).toBe(true);
    expect(parsed.capabilities?.authMethods[0]).toMatchObject({
      id: "login",
      type: "terminal",
    });
  });
});

describe("elicitation forms (contract §26.1)", () => {
  it("draws a multi-select field and accepts its array answer", () => {
    const form = acpElicitationFormSchema.parse({
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { enum: ["a", "b"], enumNames: ["A", "B"] },
          minItems: 1,
          default: ["a"],
        },
      },
    });
    expect(form.properties.tags?.type).toBe("array");
    expect(
      acpElicitationAnswerSchema.parse({
        action: "accept",
        content: { tags: ["a"], name: "x", n: 2, ok: true },
      }).content,
    ).toEqual({ tags: ["a"], name: "x", n: 2, ok: true });
  });

  it("still refuses an array that is not a list of strings", () => {
    expect(
      acpElicitationAnswerSchema.safeParse({
        action: "accept",
        content: { tags: [1] },
      }).success,
    ).toBe(false);
  });
});
