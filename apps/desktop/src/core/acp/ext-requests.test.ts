import { tmpdir } from "node:os";

import { AcpClient, fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it } from "vitest";

import { acpAdapter } from "./adapters";
import {
  type AcpPendingPermission,
  type AcpPermissionSettlement,
  AcpProcess,
} from "./client";
import {
  type AcpExtRequestSpec,
  GROK_EXIT_PLAN_MODE,
  MAX_PLAN_CHARS,
  planToolCall,
} from "./ext-requests";
import { CANVAS_MCP_NAME, clientAcceptsExtRequest } from "./mcp";
import { OwnToolCalls } from "./own-tools";

/**
 * `_` 开头的扩展请求（计划审批）：进审批挂起表、人答、映射函数、取消与无人值守；
 * 未核实的规格不挂卡；只有批准才回成功的 result，其余一律回错误。
 * 固定版本的 `AcpClient`（0.23.0）还没有 `onExtRequest`，所以这里直接对 `AcpProcess`
 * 的挂起入口（`holdExt`）喂请求——它就是升级之后客户端回调会进的那一处；agent 用
 * 上游的假 Agent（真子进程），不起任何真 CLI。
 */

const started: AcpProcess[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((p) => p.terminate()));
});

const PLAN = "# Plan\n1. Make the file\n";
const params = {
  sessionId: "s-1",
  toolCallId: "call-1",
  planContent: PLAN,
};

/** 一个核实过的假规格（管线测试用）：批准时把调用记下来，应答里带上 toolCallId。 */
function spec(
  over: Partial<AcpExtRequestSpec> = {},
): AcpExtRequestSpec & { replies: number } {
  const made = {
    kind: "plan-approval" as const,
    verified: true,
    card: GROK_EXIT_PLAN_MODE.card,
    reply(given: unknown) {
      made.replies += 1;
      return { ok: (given as { toolCallId: string }).toolCallId };
    },
    replies: 0,
    ...over,
  };
  return made;
}

function open(options: {
  extRequests?: Record<string, AcpExtRequestSpec>;
  watch?: boolean;
}) {
  const held: AcpPendingPermission[] = [];
  const settled: { id: string; settlement: AcpPermissionSettlement }[] = [];
  const process_ = AcpProcess.spawn({
    program: process.execPath,
    args: [fakeAcpAgentPath()],
    cwd: tmpdir(),
    ...(options.extRequests === undefined
      ? {}
      : { extRequests: options.extRequests }),
    ...(options.watch === false
      ? {}
      : {
          onPermission: (pending: AcpPendingPermission) => held.push(pending),
          onPermissionSettled: (
            pending: AcpPendingPermission,
            settlement: AcpPermissionSettlement,
          ) => settled.push({ id: pending.id, settlement }),
        }),
  });
  started.push(process_);
  const hold = (
    method: string,
    given: unknown,
    signal = new AbortController().signal,
  ): Promise<unknown> =>
    (
      process_ as unknown as {
        holdExt(m: string, p: unknown, s: AbortSignal): Promise<unknown>;
      }
    ).holdExt(method, given, signal);
  return { process: process_, held, settled, hold };
}

describe("计划审批进审批挂起表", () => {
  it("卡片正文是计划，关联 toolCallId，选项是批准 / 拒绝；批准才回成功的 result", async () => {
    const mapping = spec();
    const rig = open({ extRequests: { _x: mapping } });
    const answer = rig.hold("_x", params);
    expect(rig.held).toHaveLength(1);
    const card = rig.held[0] as AcpPendingPermission;
    expect(card.sessionId).toBe("s-1");
    expect(card.toolCall.toolCallId).toBe("call-1");
    expect(JSON.stringify(card.toolCall)).toContain("Make the file");
    expect(card.options.map((o) => [o.optionId, o.kind])).toEqual([
      ["approve", "allow_once"],
      ["reject", "reject_once"],
    ]);
    // 同一张表：`pendingPermissions` 里就有它，`answerPermission` 能答。
    expect(rig.process.pendingPermissions().map((p) => p.id)).toEqual([
      card.id,
    ]);
    expect(rig.process.answerPermission(card.id, "approve")).toBe(true);
    expect(await answer).toEqual({ ok: "call-1" });
    expect(mapping.replies).toBe(1);
    expect(rig.process.pendingPermissions()).toEqual([]);
    expect(rig.settled[0]?.settlement.by).toBe("answer");
  });

  it("拒绝、人什么都没选（cancelled）：回 -32800，不经映射函数，从不回成功", async () => {
    const mapping = spec();
    const rig = open({ extRequests: { _x: mapping } });
    const first = rig.hold("_x", params);
    rig.process.answerPermission(
      (rig.held[0] as AcpPendingPermission).id,
      "reject",
    );
    await expect(first).rejects.toMatchObject({ code: -32800 });
    const second = rig.hold("_x", params);
    rig.process.answerPermission(
      (rig.held[1] as AcpPendingPermission).id,
      null,
    );
    await expect(second).rejects.toMatchObject({ code: -32800 });
    expect(mapping.replies).toBe(0);
  });

  it("signal 触发（对端撤回请求）：卡片收掉，回 -32800", async () => {
    const mapping = spec();
    const rig = open({ extRequests: { _x: mapping } });
    const controller = new AbortController();
    const answer = rig.hold("_x", params, controller.signal);
    expect(rig.process.pendingPermissions()).toHaveLength(1);
    controller.abort();
    await expect(answer).rejects.toMatchObject({ code: -32800 });
    expect(rig.process.pendingPermissions()).toEqual([]);
    expect(rig.settled[0]?.settlement.by).toBe("cancelled");
    expect(mapping.replies).toBe(0);
  });

  it("进程被终止：挂着的计划审批的 Promise 以错误结束（对端已经没了，没有人可回）", async () => {
    const mapping = spec();
    const rig = open({ extRequests: { _x: mapping } });
    const answer = rig.hold("_x", params);
    await rig.process.terminate();
    await expect(answer).rejects.toMatchObject({ code: -32800 });
    expect(mapping.replies).toBe(0);
  });

  it("无人值守（没有审批消费者）：不挂着，立刻回 -32800，不进表，不经映射函数", async () => {
    const mapping = spec();
    const rig = open({ extRequests: { _x: mapping }, watch: false });
    await expect(rig.hold("_x", params)).rejects.toMatchObject({
      code: -32800,
    });
    expect(rig.process.pendingPermissions()).toEqual([]);
    expect(mapping.replies).toBe(0);
  });

  it("应答形状没核实的规格（verified: false）不挂卡：回 -32601，与现状一样", async () => {
    const mapping = spec({ verified: false });
    const rig = open({ extRequests: { _x: mapping } });
    await expect(rig.hold("_x", params)).rejects.toMatchObject({
      code: -32601,
    });
    expect(rig.held).toEqual([]);
    expect(mapping.replies).toBe(0);
  });

  it("不认识的方法与认不出的参数：回错误，不挂卡", async () => {
    const rig = open({ extRequests: { _x: spec() } });
    await expect(rig.hold("_y", params)).rejects.toMatchObject({
      code: -32601,
    });
    await expect(rig.hold("_x", { nope: 1 })).rejects.toMatchObject({
      code: -32602,
    });
    expect(rig.held).toEqual([]);
  });

  it("映射函数抛了非 RpcError：Promise 以那个错误结束（上游客户端把它回成 -32603）", async () => {
    const boom = new Error("boom");
    const rig = open({
      extRequests: {
        _x: spec({
          reply() {
            throw boom;
          },
        }),
      },
    });
    const answer = rig.hold("_x", params);
    rig.process.answerPermission(
      (rig.held[0] as AcpPendingPermission).id,
      "approve",
    );
    await expect(answer).rejects.toBe(boom);
  });

  it("计划原文超过 64K 字符：截断并加省略标记", async () => {
    const rig = open({ extRequests: { _x: spec() } });
    void rig
      .hold("_x", { ...params, planContent: "x".repeat(MAX_PLAN_CHARS + 500) })
      .catch(() => undefined);
    const text = JSON.stringify(rig.held[0]?.toolCall.content);
    expect(text.length).toBeLessThan(MAX_PLAN_CHARS + 200);
    expect(text).toContain("…");
  });
});

describe("计划卡不会被自家工具的免审批代答", () => {
  it("同一 toolCallId 先到的是自家工具的 tool_call：计划卡照样交给人（OwnToolCalls.decide 不放行）", () => {
    const own = new OwnToolCalls();
    own.record({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "canvas_list",
      _meta: {
        claudeCode: { toolName: `mcp__${CANVAS_MCP_NAME}__canvas_list` },
      },
    });
    const card = GROK_EXIT_PLAN_MODE.card(params)!;
    const tool = planToolCall(card);
    const options = [
      { optionId: "approve", name: "Approve", kind: "allow_once" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ];
    // 对照：记录确实生效——同一 toolCallId、不带任何身份信息的审批会被放行。
    expect(own.decide({ toolCallId: "call-1" } as never, options)).toBe(
      "approve",
    );
    expect(own.decide(tool, options)).toBeUndefined();
  });
});

describe("grok 的计划审批登记", () => {
  it("适配器表登记了 _x.ai/exit_plan_mode；plan 仍没有落点", () => {
    const adapter = acpAdapter("grok");
    expect(adapter?.extRequests?.["_x.ai/exit_plan_mode"]).toBe(
      GROK_EXIT_PLAN_MODE,
    );
    expect(adapter?.modes.plan).toBeNull();
    // 应答形状没核实：规格没标 verified，计划请求依旧回 -32601。
    expect(GROK_EXIT_PLAN_MODE.verified).toBe(false);
  });

  it("请求形状 → 卡片：sessionId、toolCallId、planContent", () => {
    expect(GROK_EXIT_PLAN_MODE.card(params)).toEqual({
      sessionId: "s-1",
      toolCallId: "call-1",
      title: "Plan",
      body: PLAN,
    });
    expect(GROK_EXIT_PLAN_MODE.card({ sessionId: "s" })).toBeUndefined();
    expect(GROK_EXIT_PLAN_MODE.card(null)).toBeUndefined();
    const tool = planToolCall(GROK_EXIT_PLAN_MODE.card(params)!);
    expect(tool).toMatchObject({ toolCallId: "call-1", kind: "switch_mode" });
  });

  it("批准 → 应答 JSON 是一处孤立的映射（未验证，Armadra#1021）", () => {
    expect(GROK_EXIT_PLAN_MODE.reply(params)).toEqual({ approved: true });
  });

  it("grok 的真规格在核实之前：请求回 -32601，不挂卡", async () => {
    const rig = open({
      extRequests: { "_x.ai/exit_plan_mode": GROK_EXIT_PLAN_MODE },
    });
    await expect(
      rig.hold("_x.ai/exit_plan_mode", params),
    ).rejects.toMatchObject({ code: -32601 });
    expect(rig.held).toEqual([]);
  });
});

describe("特征检测", () => {
  it("只有声明了 features.extRequest 才接；固定版本的客户端不接", () => {
    expect(clientAcceptsExtRequest({ features: { extRequest: true } })).toBe(
      true,
    );
    expect(clientAcceptsExtRequest({})).toBe(false);
    expect(clientAcceptsExtRequest({ features: { extRequest: 1 } })).toBe(
      false,
    );
    // 固定版本的客户端声明了才接（0.23.0 还没有；升级之后这一行自己跟着变）。
    expect(clientAcceptsExtRequest()).toBe(
      (AcpClient as unknown as { features?: { extRequest?: unknown } }).features
        ?.extRequest === true,
    );
  });
});
