import { describe, expect, it } from "vitest";
import {
  agentHumanNeed,
  handoffHumanNeed,
  isAwaitingHuman,
} from "../src/human-need.js";

describe("agentHumanNeed", () => {
  it("等待审批：blocked 或带 pendingId", () => {
    expect(agentHumanNeed({ state: "blocked" })).toBe("approval");
    expect(agentHumanNeed({ state: "working", pendingId: "p1" })).toBe(
      "approval",
    );
  });

  it("等待输入：waiting", () => {
    expect(agentHumanNeed({ state: "waiting" })).toBe("input");
  });

  it("审批比等待回答优先", () => {
    expect(agentHumanNeed({ state: "waiting", pendingId: "p1" })).toBe(
      "approval",
    );
  });

  it("出错只在没人看过时算，看过即消失", () => {
    expect(agentHumanNeed({ state: "done", errored: true, unread: true })).toBe(
      "error",
    );
    expect(agentHumanNeed({ state: "error", unread: true })).toBe("error");
    expect(
      agentHumanNeed({ state: "done", errored: true, unread: false }),
    ).toBeNull();
  });

  it.each([
    [{ state: "idle" }],
    [{ state: "working" }],
    [{ state: "working", unread: true }],
    [{ state: "done", unread: true }],
    [{ state: "done", errored: false, unread: true }],
    [{}],
  ])("空闲、运行中、正常完成、未知都不算：%j", (subject) => {
    expect(agentHumanNeed(subject)).toBeNull();
  });

  it("进程已经没了就没有人能回答", () => {
    expect(agentHumanNeed({ state: "blocked", alive: false })).toBeNull();
    expect(agentHumanNeed({ state: "waiting", alive: false })).toBeNull();
    expect(agentHumanNeed({ state: "blocked", alive: true })).toBe("approval");
  });
});

describe("handoffHumanNeed", () => {
  it("只有冻结未批准的交接要人处理", () => {
    expect(handoffHumanNeed("prepared")).toBe("handoff");
    expect(handoffHumanNeed("queued")).toBeNull();
    expect(handoffHumanNeed("acknowledged")).toBeNull();
    expect(handoffHumanNeed("cancelled")).toBeNull();
  });
});

describe("isAwaitingHuman", () => {
  it("审批与等待回答才挡写入，出错不挡", () => {
    expect(isAwaitingHuman({ state: "blocked" })).toBe(true);
    expect(isAwaitingHuman({ state: "waiting" })).toBe(true);
    expect(
      isAwaitingHuman({ state: "done", errored: true, unread: true }),
    ).toBe(false);
  });
});
