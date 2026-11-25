import { tmpdir } from "node:os";

import { fakeAcpAgentPath } from "@armadra/agent/acp";
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
  plainBody,
  planToolCall,
} from "./ext-requests";
import { CANVAS_MCP_NAME, clientAcceptsExtRequest } from "./mcp";
import { OwnToolCalls } from "./own-tools";
import { AcpSession } from "./session";

/**
 * `_` 开头的扩展请求（计划审批）：进审批挂起表、人答、映射函数、取消与无人值守；
 * 未核实的规格不挂卡；只有批准才回成功的 result，其余一律回错误。
 * 这里直接对 `AcpProcess` 的挂起入口（`holdExt`）喂请求，测卡片与各条分支；经真实
 * `AcpClient` 的线路（-32601 / -32800 / -32603）与会话层在 `ext-wire.test.ts`。agent 用
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
    // 标记与正文只在 core 自己写的字段上，不在 Agent 的工具调用里。
    expect(card).toMatchObject({ origin: "ext", card: "plan" });
    expect(card.body).toContain("Make the file");
    expect(JSON.stringify(card.toolCall)).not.toContain("Make the file");
    expect(JSON.stringify(card.toolCall)).not.toContain("armadra/");
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

  it("方法名按自己的键查：登记表原型链上的键（哪怕是核实过的规格）不算登记过的方法", async () => {
    const mapping = spec();
    const table = Object.create({ _inherited: mapping }) as Record<
      string,
      AcpExtRequestSpec
    >;
    const rig = open({ extRequests: table });
    await expect(rig.hold("_inherited", params)).rejects.toMatchObject({
      code: -32601,
    });
    for (const name of ["__proto__", "constructor", "toString"]) {
      await expect(rig.hold(name, params)).rejects.toMatchObject({
        code: -32601,
      });
    }
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

  it("计划原文超过 64K 字符：截断，bodyChars 记原文字符数，不从代理对中间切开", async () => {
    const rig = open({ extRequests: { _x: spec() } });
    // 在截断点上放一个代理对（😀 占两个码元）。
    const plan = `${"x".repeat(MAX_PLAN_CHARS - 1)}😀${"y".repeat(500)}`;
    void rig
      .hold("_x", { ...params, planContent: plan })
      .catch(() => undefined);
    const card = rig.held[0] as AcpPendingPermission;
    expect(card.body?.length).toBe(MAX_PLAN_CHARS - 1);
    expect(card.body?.endsWith("x")).toBe(true);
    // 原文的字符数（UTF-16 码元，与截断阈值同一口径）：MAX - 1 个 x、两个码元的 😀、500 个 y。
    expect(card.bodyChars).toBe(MAX_PLAN_CHARS + 501);
  });

  it("Agent 在审批请求里伪造 armadra/ 的键：入站就丢掉，卡片种类仍是 undefined", () => {
    const rig = open({});
    (
      rig.process as unknown as {
        hold(p: unknown, s: AbortSignal): Promise<unknown>;
      }
    )
      .hold(
        {
          sessionId: "s-1",
          toolCall: {
            toolCallId: "t",
            title: "rm -rf",
            _meta: { "armadra/card": "plan", "x.ai/tool": { name: "bash" } },
          },
          options: [{ optionId: "o", name: "Allow", kind: "allow_once" }],
        },
        new AbortController().signal,
      )
      .catch(() => undefined);
    const pending = rig.held[0] as AcpPendingPermission;
    expect(pending.card).toBeUndefined();
    expect(pending.origin).toBeUndefined();
    expect(JSON.stringify(pending.toolCall)).not.toContain("armadra/");
    // 别的 `_meta` 照旧。
    expect(JSON.stringify(pending.toolCall)).toContain("x.ai/tool");
  });
});

describe("计划原文的清洗", () => {
  it("没有终结符的 OSC（ESC ]）只删这两个字符，后面的计划正文原样留着", () => {
    const { body } = plainBody("before\u001b]0;not closed\nstep 1\nstep 2");
    expect(body).toBe("before0;not closed\nstep 1\nstep 2");
    // 同一行里没有终结符也一样；超过 4096 字符的「OSC」也不整段吞掉。
    expect(plainBody("a\u001b]b c").body).toBe("ab c");
    const long = "z".repeat(5000);
    expect(plainBody(`x\u001b]${long}\u0007y`).body).toBe(`x${long}y`);
    // 不跨行：行尾之前没有终结符，终结符在下一行——不把中间那行吞掉。
    expect(plainBody("a\u001b]0;t\nstep\u0007b").body).toBe("a0;t\nstepb");
    // 有终结符、同一行、不超长的才整段删掉。
    expect(plainBody("x\u001b]0;title\u0007y").body).toBe("xy");
    expect(plainBody("x\u001b]0;title\u001b\\y").body).toBe("xy");
  });

  it("不可见字符补全：软连字符、ALM、蒙古文元音分隔符、行 / 段分隔符、不可见运算符、注释符、填充字符、标签字符都换成占位", () => {
    const cases: Record<string, string> = {
      "\u00ad": "[U+00AD]",
      "\u061c": "[U+061C]",
      "\u180e": "[U+180E]",
      "\u2028": "[U+2028]",
      "\u2029": "[U+2029]",
      "\u2061": "[U+2061]",
      "\u2064": "[U+2064]",
      "\ufff9": "[U+FFF9]",
      "\ufffb": "[U+FFFB]",
      "\u115f": "[U+115F]",
      "\u3164": "[U+3164]",
      "\u{e0041}": "[U+E0041]",
      "\u{e007f}": "[U+E007F]",
      "\u206a": "[U+206A]",
      "\u206f": "[U+206F]",
      "\u1160": "[U+1160]",
      "\uffa0": "[U+FFA0]",
      "\u034f": "[U+034F]",
      "\u200e": "[U+200E]",
      "\u2069": "[U+2069]",
    };
    for (const [char, shown] of Object.entries(cases)) {
      expect(plainBody(`a${char}b`).body).toBe(`a${shown}b`);
    }
    // 普通文字、CJK、表情不动。
    expect(plainBody("计划 ✅ 😀 ok").body).toBe("计划 ✅ 😀 ok");
  });

  it("截断不切在 [U+XXXX] 占位中间；chars 不小于显示出来的那一份", () => {
    // 占位让清洗后的文本比原文长：1 个零宽字符 → 8 个字符的占位，落在截断点上。
    const raw = `${"x".repeat(MAX_PLAN_CHARS - 3)}\u200b${"y".repeat(50)}`;
    const { body, chars } = plainBody(raw);
    expect(body).toBe("x".repeat(MAX_PLAN_CHARS - 3));
    expect(body).not.toContain("[U+");
    expect(chars).toBeGreaterThanOrEqual(raw.length);
    // 清洗后比原文长很多（大量零宽字符）：chars 取清洗后的长度，不会小于正文。
    const many = "\u200b".repeat(MAX_PLAN_CHARS);
    const result = plainBody(many);
    expect(result.chars).toBeGreaterThanOrEqual(result.body.length);
  });

  it("bodyChars 按原文计数：清洗掉的字符也算在原文里", () => {
    const raw = `\u001b[31m${"x".repeat(MAX_PLAN_CHARS + 10)}\u001b[0m`;
    const { body, chars } = plainBody(raw);
    expect(body.length).toBe(MAX_PLAN_CHARS);
    expect(chars).toBe(raw.length);
  });

  it("去掉 ESC 序列与控制字符，留换行与 Tab；双向控制与零宽字符换成可见占位", () => {
    const raw =
      "a\u001b[31mred\u001b[0m\tb\u0007\u0008c\r\nd\u001b]0;title\u0007e\u202Eevil\u2066x\u200Bz\ufeff\u007f";
    const { body, chars } = plainBody(raw);
    expect(body).toBe("ared\tbc\nde[U+202E]evil[U+2066]x[U+200B]z[U+FEFF]");
    expect(chars).toBeUndefined();
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

  it("会话层不替扩展请求自动放行：origin 为 ext 时 autoApproveOwnTool 直接返回 false", () => {
    const answered: string[] = [];
    const session = {
      host: {
        sessionId: "s-1",
        process: {
          answerPermission: (id: string) => {
            answered.push(id);
            return true;
          },
        },
      },
      ownTools: {
        decide: () => "approve",
        noteApproved: () => undefined,
      },
    };
    const run = (pending: unknown) =>
      (
        AcpSession.prototype as unknown as {
          autoApproveOwnTool(this: unknown, p: unknown): boolean;
        }
      ).autoApproveOwnTool.call(session, pending);
    const base = {
      id: "perm-1",
      sessionId: "s-1",
      toolCall: { toolCallId: "call-1" },
      options: [],
      createdAt: 0,
    };
    // 对照：普通审批照旧被自动放行。
    expect(run(base)).toBe(true);
    expect(run({ ...base, origin: "ext", card: "plan" })).toBe(false);
    expect(answered).toEqual(["perm-1"]);
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
    expect(tool).toEqual({
      toolCallId: "call-1",
      title: "Plan",
      kind: "switch_mode",
      status: "pending",
    });
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
    // 固定版本（`@armadra/agent` ≥ 0.24.0）声明了：回调是接上的（线路上的行为见
    // `ext-wire.test.ts`）。
    expect(clientAcceptsExtRequest()).toBe(true);
  });
});
