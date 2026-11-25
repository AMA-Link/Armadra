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
  planToolCall,
} from "./ext-requests";
import { clientAcceptsExtRequest } from "./mcp";

/**
 * `_` 开头的扩展请求（计划审批）：进审批挂起表、人答、映射函数、取消与无人值守。
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

/** 一个假应答映射：把决定原样记下来，应答里带上，好断言「人的决定」到了哪一步。 */
function spec(): AcpExtRequestSpec & { seen: string[] } {
  const seen: string[] = [];
  return {
    kind: "plan-approval",
    card: GROK_EXIT_PLAN_MODE.card,
    reply(decision) {
      seen.push(decision);
      return { decided: decision };
    },
    seen,
  };
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
  it("卡片正文是计划，关联 toolCallId，选项是批准 / 拒绝；批准 → 映射函数收到 approve", async () => {
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
    expect(await answer).toEqual({ decided: "approve" });
    expect(mapping.seen).toEqual(["approve"]);
    expect(rig.process.pendingPermissions()).toEqual([]);
    expect(rig.settled[0]?.settlement.by).toBe("answer");
  });

  it("拒绝 → reject；人什么都没选（cancelled）也是 reject，从不是 approve", async () => {
    const mapping = spec();
    const rig = open({ extRequests: { _x: mapping } });
    const first = rig.hold("_x", params);
    rig.process.answerPermission(
      (rig.held[0] as AcpPendingPermission).id,
      "reject",
    );
    expect(await first).toEqual({ decided: "reject" });
    const second = rig.hold("_x", params);
    rig.process.answerPermission(
      (rig.held[1] as AcpPendingPermission).id,
      null,
    );
    expect(await second).toEqual({ decided: "reject" });
    expect(mapping.seen).toEqual(["reject", "reject"]);
  });

  it("signal 触发（对端撤回请求）：卡片收掉，按拒绝回", async () => {
    const mapping = spec();
    const rig = open({ extRequests: { _x: mapping } });
    const controller = new AbortController();
    const answer = rig.hold("_x", params, controller.signal);
    expect(rig.process.pendingPermissions()).toHaveLength(1);
    controller.abort();
    expect(await answer).toEqual({ decided: "reject" });
    expect(rig.process.pendingPermissions()).toEqual([]);
    expect(rig.settled[0]?.settlement.by).toBe("cancelled");
  });

  it("进程被终止：挂着的计划审批按拒绝回", async () => {
    const mapping = spec();
    const rig = open({ extRequests: { _x: mapping } });
    const answer = rig.hold("_x", params);
    await rig.process.terminate();
    expect(await answer).toEqual({ decided: "reject" });
  });

  it("无人值守（没有审批消费者）：不挂着，立刻按拒绝回，不进表", async () => {
    const mapping = spec();
    const rig = open({ extRequests: { _x: mapping }, watch: false });
    expect(await rig.hold("_x", params)).toEqual({ decided: "reject" });
    expect(rig.process.pendingPermissions()).toEqual([]);
    expect(mapping.seen).toEqual(["reject"]);
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
});

describe("grok 的计划审批登记", () => {
  it("适配器表登记了 _x.ai/exit_plan_mode；plan 仍没有落点", () => {
    const adapter = acpAdapter("grok");
    expect(adapter?.extRequests?.["_x.ai/exit_plan_mode"]).toBe(
      GROK_EXIT_PLAN_MODE,
    );
    expect(adapter?.modes.plan).toBeNull();
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

  it("人的决定 → 应答 JSON 是一处孤立的映射（未验证，Armadra#1021）", () => {
    expect(GROK_EXIT_PLAN_MODE.reply("approve", params)).toEqual({
      approved: true,
    });
    expect(GROK_EXIT_PLAN_MODE.reply("reject", params)).toEqual({
      approved: false,
    });
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
