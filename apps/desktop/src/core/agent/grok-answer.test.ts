import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerApproval,
  cancelStaleCardApprovals,
  approvalAudit,
  answerKeys,
  getApproval,
  insertApproval,
} from "./approvals";
import { type AgentFixture, agentFixture } from "./fixture";
import {
  GROK_CARD_PROTOCOL,
  type GrokCardSource,
  type GrokLaunch,
  type GrokOutcome,
  deliverGrokAnswer,
  cardAnswerGate,
  grokAnswerGate,
  launchOfProcess,
  registerGrokCardSource,
  resetGrokVersionProbe,
  useGrokVerifiedVersions,
} from "./grok-answer";
import { parseGrokApprovalCard } from "./grok-card";
import { cardNoticeOf, clearCardNotice } from "./pending-cards";

/** 键盘上答 grok 的审批卡（契约 §127）：核对、发键、事后核对。 */

const screen = (name: string) =>
  readFileSync(
    join(__dirname, "__fixtures__/grok-card", `${name}.txt`),
    "utf8",
  );

const CARD = screen("default-120");
const HASH = parseGrokApprovalCard(CARD)?.hash ?? "";
const OFFSET = 1200;

let fixture: AgentFixture;
let nodeId: string;
let sessionId: string;
let open: { sessionId: string; offset: number; tool: string }[];
let outcome: (written: string[]) => GrokOutcome;
let off: () => void;
/** 这个会话的 grok 进程实际的启动方式（读 argv 得来的；节点上声明的不算）。 */
let launch: GrokLaunch;

const source: GrokCardSource = {
  requests: () => open,
  outcomeAfter: () => outcome(fixture.terminal.writes.map((w) => w.data)),
  launch: () => launch,
};

function record(overrides: Record<string, unknown> = {}) {
  insertApproval(fixture.collab, {
    pendingId: "g-1",
    nodeId,
    workspaceId: fixture.workspaceId,
    request: {
      protocol: GROK_CARD_PROTOCOL,
      sessionId: "grok-1",
      offset: OFFSET,
      hash: HASH,
      tool: "run_terminal_command",
      title: "probe",
      body: [],
      options: [],
      ...overrides,
    },
  });
}

beforeEach(() => {
  fixture = agentFixture();
  nodeId = fixture.agentNode("Grok", "grok");
  sessionId = fixture.session(nodeId, "grok");
  open = [
    { sessionId: "grok-1", offset: OFFSET, tool: "run_terminal_command" },
  ];
  outcome = (written) =>
    written.includes("3")
      ? "allow"
      : written.includes("4")
        ? "deny"
        : "pending";
  fixture.terminal.capture = CARD;
  off = registerGrokCardSource(nodeId, source);
  // 两道门与模式：清单有这个版本、设置开、节点是 `--permission-mode` 启动的。
  useGrokVerifiedVersions(["1.0.92"]);
  resetGrokVersionProbe("1.0.92");
  launch = { mode: "auto-edit", exe: "/opt/grok/bin/grok" };
  record();
});

afterEach(() => {
  useGrokVerifiedVersions(undefined);
  resetGrokVersionProbe();
  off();
  clearCardNotice(nodeId);
  fixture.close();
});

const writes = () => fixture.terminal.writes.map((w) => w.data);

describe("核对通过：只发那一个数字键", () => {
  it("允许一次 → 3，不带回车；删除线之外 Always / Never 的数字（1、5）一个都不碰", async () => {
    const result = await answerApproval(fixture.collab, "g-1", {
      decision: "allow",
    });
    expect(result.route).toBe("keys");
    expect(result.delivery).toBe("confirmed");
    expect(writes()).toEqual(["3"]);
    expect(getApproval(fixture.collab, "g-1").answer).toBe("allow");
    expect(sessionId).toBeDefined();
  });

  it("拒绝 → 4", async () => {
    const result = await answerApproval(fixture.collab, "g-1", {
      decision: "deny",
    });
    expect(result.delivery).toBe("confirmed");
    expect(writes()).toEqual(["4"]);
  });

  it("没被看到生效：头部提示挂上，confirmed 不挂", async () => {
    outcome = () => "deny";
    const result = await answerApproval(fixture.collab, "g-1", {
      decision: "allow",
    });
    expect(result.delivery).toBe("mismatch");
    expect(cardNoticeOf(nodeId)).toBe("mismatch");
    clearCardNotice(nodeId);
  });

  it("HTTP 应答带 delivery", async () => {
    const response = await fixture.call("POST", "/api/approvals/g-1/answer", {
      decision: "allow",
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      route: "keys",
      delivery: "confirmed",
    });
  });
});

describe("预检：不对就 409，记录保持打开，一个键都不发", () => {
  async function refused(reason: string) {
    await expect(
      answerApproval(fixture.collab, "g-1", { decision: "allow" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(getApproval(fixture.collab, "g-1").answer).toBeNull();
    expect(writes()).toEqual([]);
    expect(approvalAudit(fixture.collab, "g-1").at(-1)).toMatchObject({
      accepted: false,
      refusal: reason,
    });
  }

  it("并行请求：同时有两条未决，一律不代答", async () => {
    open.push({
      sessionId: "grok-1",
      offset: 1500,
      tool: "run_terminal_command",
    });
    await refused("card_changed");
  });

  it("偏移对不上：前一张被答掉、后一张顶上", async () => {
    open = [
      { sessionId: "grok-1", offset: 1500, tool: "run_terminal_command" },
    ];
    await refused("card_changed");
  });

  it("没有未决请求（已经答了）", async () => {
    open = [];
    await refused("card_changed");
  });

  it("画面上的正文变了（哈希对不上）", async () => {
    fixture.terminal.capture = CARD.replace("echo x", "echo y");
    await refused("card_changed");
  });

  it.each(["ask-120", "plan-120", "esc-120", "edit-120", "readout-120"])(
    "画面是 %s：不是可代答的卡",
    async (name) => {
      fixture.terminal.capture = screen(name);
      await refused("card_unrecognized");
    },
  );

  it("抓屏期间有人敲了键（inputRevision 变了）", async () => {
    fixture.terminal.onCapture = () => {
      fixture.terminal.inputRevisionValue += 1;
    };
    await refused("input_changed");
  });

  it("抓屏期间卡换了（又来一条请求）", async () => {
    fixture.terminal.onCapture = () => {
      open.push({ sessionId: "grok-1", offset: 1500, tool: "x" });
    };
    await refused("card_changed");
  });

  it("槽没登记（读不到进程与文件）：门先过不了", async () => {
    off();
    await refused("gate_closed");
  });
});

describe("落库之后卡换了：记录已答，但不发键，如实说没送到", () => {
  it("预检过了、发送前再核一遍时多了一条请求", async () => {
    let calls = 0;
    const flaky: GrokCardSource = {
      requests: () => {
        calls += 1;
        // 预检的两次读（前后）过，发送时的第一次读就不对。
        return calls <= 2
          ? open
          : [...open, { sessionId: "grok-1", offset: 1500, tool: "x" }];
      },
      outcomeAfter: () => "pending",
      launch: () => launch,
    };
    off();
    off = registerGrokCardSource(nodeId, flaky);
    const result = await answerApproval(fixture.collab, "g-1", {
      decision: "allow",
    });
    expect(result.route).toBe("none");
    // 一个键都没发：说「没发」，不能说「没确认」。
    expect(result.delivery).toBe("not_sent");
    expect(writes()).toEqual([]);
    expect(approvalAudit(fixture.collab, "g-1").at(-1)).toMatchObject({
      accepted: true,
      refusal: "card_changed",
    });
  });
});

describe("发完之后的核对", () => {
  const clock = () => {
    let at = 0;
    return { sleep: async (ms: number) => void (at += ms), now: () => at };
  };
  const approval = () => getApproval(fixture.collab, "g-1");

  it.each([
    ["allow", "allow", "confirmed"],
    ["allow", "deny", "mismatch"],
    ["allow", "ambiguous", "ambiguous"],
    ["allow", "pending", "unconfirmed"],
    ["allow", "unknown", "unconfirmed"],
  ] as const)(
    "决定 %s，文件里是 %s → %s（不重发）",
    async (decision, seen, delivery) => {
      outcome = () => seen;
      const sent = await deliverGrokAnswer(
        fixture.collab,
        approval(),
        decision,
        clock(),
      );
      expect(sent).toEqual({ sent: true, delivery });
      expect(writes()).toEqual(["3"]);
    },
  );
});

describe("两道门与模式", () => {
  const base = {
    setting: true,
    permissionMode: "auto-edit",
    version: "1.0.92",
    verified: ["1.0.92"],
  };
  it("全满足才开", () => {
    expect(grokAnswerGate(base)).toEqual({ open: true });
    expect(grokAnswerGate({ ...base, permissionMode: "plan" })).toEqual({
      open: true,
    });
  });
  it("版本清单为空、版本不在清单、探不到版本都不开", () => {
    expect(grokAnswerGate({ ...base, verified: [] })).toMatchObject({
      reason: "unverified_version",
    });
    expect(grokAnswerGate({ ...base, version: "1.0.93" })).toMatchObject({
      reason: "unverified_version",
    });
    expect(grokAnswerGate({ ...base, version: undefined })).toMatchObject({
      reason: "unverified_version",
    });
  });
  it("设置不是 true 不开（缺省关）", () => {
    expect(grokAnswerGate({ ...base, setting: undefined })).toMatchObject({
      reason: "setting_off",
    });
  });
  it("缺省模式（auto-review）、always-approve、不知道的模式不开", () => {
    for (const mode of ["default", "full-auto", undefined]) {
      expect(grokAnswerGate({ ...base, permissionMode: mode })).toMatchObject({
        reason: "mode_excluded",
      });
    }
  });
  it("代码里的清单：只有 e2e 过了的那个版本", () => {
    useGrokVerifiedVersions(undefined);
    const gate = (version: string) =>
      grokAnswerGate({
        setting: true,
        permissionMode: "plan",
        version,
      });
    expect(gate("1.0.92")).toEqual({ open: true });
    expect(gate("1.0.93")).toMatchObject({ reason: "unverified_version" });
    expect(gate("1.0.91")).toMatchObject({ reason: "unverified_version" });
  });
});

describe("答复时门与节点还得成立（预检里再核一遍）", () => {
  async function refused(reason: string) {
    await expect(
      answerApproval(fixture.collab, "g-1", { decision: "allow" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(getApproval(fixture.collab, "g-1").answer).toBeNull();
    expect(writes()).toEqual([]);
    expect(approvalAudit(fixture.collab, "g-1").at(-1)).toMatchObject({
      accepted: false,
      refusal: reason,
    });
  }

  it("清单换成不含这个版本", async () => {
    useGrokVerifiedVersions(["1.0.93"]);
    await refused("gate_closed");
  });

  it("进程的 argv 里没有 --permission-mode（节点声明的再怎么写都不算）", async () => {
    // 节点数据里写着 auto-edit，grok 实际是缺省的 auto-review 起的。
    fixture.database
      .prepare(
        "UPDATE nodes SET data_json = json_set(data_json, '$.agent.permissionMode', 'auto-edit') WHERE id = ?",
      )
      .run(nodeId);
    launch = launchOfProcess({
      exe: "/opt/grok/bin/grok",
      args: ["/opt/grok/bin/grok", "--no-memory"],
    });
    await refused("gate_closed");
  });

  it("读不到 argv：按模式不在范围算", async () => {
    launch = launchOfProcess(undefined);
    await refused("gate_closed");
  });

  it("形状像 grok-card 的请求落在别家的节点上：不发键", async () => {
    fixture.database
      .prepare(
        "UPDATE nodes SET data_json = json_set(data_json, '$.agent.id', 'claude') WHERE id = ?",
      )
      .run(nodeId);
    await refused("not_grok");
  });
});

describe("cardAnswerGate：三样先过，才探版本", () => {
  const probeOnce = () => {
    let exes: (string | undefined)[] = [];
    return {
      exes: () => exes,
      probe: async (exe: string | undefined) => {
        exes = [...exes, exe];
        return "1.0.92";
      },
    };
  };
  const at = (mode: string | undefined): GrokLaunch => ({
    mode,
    exe: "/opt/grok/bin/grok",
  });

  it("清单是空的（缺省）、设置关、模式不在范围：一次都不探", async () => {
    for (const input of [
      { verified: [], setting: true, launch: at("auto-edit") },
      { verified: ["1.0.92"], setting: false, launch: at("auto-edit") },
      { verified: ["1.0.92"], setting: true, launch: at("default") },
      { verified: ["1.0.92"], setting: true, launch: at(undefined) },
    ]) {
      const probe = probeOnce();
      const gate = await cardAnswerGate({ ...input, probe: probe.probe });
      expect(gate.open).toBe(false);
      expect(probe.exes()).toEqual([]);
    }
  });

  it("三样都过了才探一次，探的是进程实际跑的那个可执行文件；版本在清单里才开", async () => {
    const probe = probeOnce();
    expect(
      await cardAnswerGate({
        verified: ["1.0.92"],
        setting: true,
        launch: at("plan"),
        probe: probe.probe,
      }),
    ).toEqual({ open: true });
    expect(probe.exes()).toEqual(["/opt/grok/bin/grok"]);
    expect(
      await cardAnswerGate({
        verified: ["1.0.93"],
        setting: true,
        launch: at("plan"),
        probe: probe.probe,
      }),
    ).toMatchObject({ open: false, reason: "unverified_version" });
  });

  it("读不到可执行文件：版本探不到，不开", async () => {
    resetGrokVersionProbe();
    expect(
      await cardAnswerGate({
        verified: ["1.0.92"],
        setting: true,
        launch: { mode: "plan", exe: undefined },
      }),
    ).toMatchObject({ open: false, reason: "unverified_version" });
  });
});

describe("launchOfProcess：按 argv 认权限模式", () => {
  const mode = (...args: string[]) =>
    launchOfProcess({ exe: "/g/grok", args: ["/g/grok", ...args] }).mode;
  it("acceptEdits 与 plan，两种写法", () => {
    expect(mode("--permission-mode", "acceptEdits")).toBe("auto-edit");
    expect(mode("--permission-mode", "plan")).toBe("plan");
    expect(mode("--permission-mode=acceptEdits")).toBe("auto-edit");
  });
  it("多次出现取最后一个", () => {
    expect(
      mode("--permission-mode", "plan", "--permission-mode", "default"),
    ).toBe("default");
  });
  it("没有旗标、别的取值、读不到 argv 都不是可放开的模式", () => {
    expect(mode()).toBeUndefined();
    expect(mode("--permission-mode", "default")).toBe("default");
    expect(mode("--always-approve")).toBeUndefined();
    expect(launchOfProcess(undefined).mode).toBeUndefined();
    expect(launchOfProcess({ exe: "/g/grok" }).mode).toBeUndefined();
  });
  it("-- 之后是用户的提示词，写什么都不算", () => {
    expect(mode("--", "please", "--permission-mode", "plan")).toBeUndefined();
    expect(mode("--permission-mode", "plan", "--", "x")).toBe("plan");
  });
});

describe("盲发键", () => {
  it("grok 与 agy 都没有可以盲发的键", () => {
    expect(answerKeys("grok", "allow")).toBe("");
    expect(answerKeys("agy", "allow")).toBe("");
    expect(answerKeys("agy", "deny")).toBe("");
  });
});

describe("启动时关掉上一个进程留下的终端卡审批", () => {
  it("只关没答的 grok-card，答过的、别的协议的不动，并发结算事件", () => {
    insertApproval(fixture.collab, {
      pendingId: "g-2",
      nodeId,
      workspaceId: fixture.workspaceId,
      request: {
        protocol: GROK_CARD_PROTOCOL,
        sessionId: "x",
        offset: 1,
        hash: "h",
      },
    });
    insertApproval(fixture.collab, {
      pendingId: "acp-1",
      nodeId,
      workspaceId: fixture.workspaceId,
      request: { protocol: "acp", options: [] },
    });
    fixture.database
      .prepare(
        "UPDATE agent_approvals SET answer = 'allow', revision = 1 WHERE id = 'g-2'",
      )
      .run();
    const published: unknown[] = [];
    const closed = cancelStaleCardApprovals(
      {
        database: fixture.database,
        publish: (_workspace, event) => void published.push(event),
      },
      GROK_CARD_PROTOCOL,
    );
    expect(closed).toBe(1);
    expect(getApproval(fixture.collab, "g-1")).toMatchObject({
      answer: "cancelled",
      answeredBy: "core",
    });
    expect(getApproval(fixture.collab, "g-2").answer).toBe("allow");
    expect(getApproval(fixture.collab, "acp-1").answer).toBeNull();
    expect(published).toHaveLength(1);
  });
});
