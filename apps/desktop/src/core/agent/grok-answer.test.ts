import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerApproval,
  approvalAudit,
  answerKeys,
  getApproval,
  insertApproval,
} from "./approvals";
import { type AgentFixture, agentFixture } from "./fixture";
import {
  GROK_CARD_PROTOCOL,
  type GrokCardSource,
  type GrokOutcome,
  deliverGrokAnswer,
  grokAnswerGate,
  registerGrokCardSource,
} from "./grok-answer";
import { parseGrokApprovalCard } from "./grok-card";

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

const source: GrokCardSource = {
  requests: () => open,
  outcomeAfter: () => outcome(fixture.terminal.writes.map((w) => w.data)),
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
  record();
});

afterEach(() => {
  off();
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

  it("槽没登记（读不到文件）", async () => {
    off();
    await refused("card_changed");
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
    };
    off();
    off = registerGrokCardSource(nodeId, flaky);
    const result = await answerApproval(fixture.collab, "g-1", {
      decision: "allow",
    });
    expect(result.route).toBe("none");
    expect(result.delivery).toBe("unconfirmed");
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
  it("代码里的清单现在是空的：一个版本都不开", () => {
    expect(
      grokAnswerGate({
        setting: true,
        permissionMode: "plan",
        version: "1.0.92",
      }),
    ).toMatchObject({ open: false });
  });
});

describe("盲发键", () => {
  it("grok 与 agy 都没有可以盲发的键", () => {
    expect(answerKeys("grok", "allow")).toBe("");
    expect(answerKeys("agy", "allow")).toBe("");
    expect(answerKeys("agy", "deny")).toBe("");
  });
});
