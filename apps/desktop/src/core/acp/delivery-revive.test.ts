import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AgentFixture, agentFixture } from "../agent/fixture";
import { revivableRow } from "./routes";

/** 投递时接回断掉的 ACP 会话：哪一行该接（契约 §129.5）。 */

let fixture: AgentFixture;
let node: string;
let session: string;

function row(status: string, intent: string, backend = "acp"): void {
  fixture.database
    .prepare(
      "UPDATE terminal_sessions SET backend_kind = ?, status = ?, termination_intent = ? WHERE id = ?",
    )
    .run(backend, status, intent, session);
}

beforeEach(() => {
  fixture = agentFixture();
  node = fixture.agentNode("Main", "codex");
  session = fixture.session(node, "codex");
});

afterEach(() => fixture.close());

describe("revivableRow", () => {
  it("core 重启（failed）与适配器自己退出（exited）都接", () => {
    row("failed", "none");
    expect(revivableRow(fixture.database, node)).toEqual({
      id: session,
      agentId: "codex",
    });
    row("exited", "none");
    expect(revivableRow(fixture.database, node)?.id).toBe(session);
  });

  it("人停的、休眠的、还在跑的、不是 ACP 的都不接", () => {
    row("terminated", "session");
    expect(revivableRow(fixture.database, node)).toBeUndefined();
    row("terminated", "hibernate");
    expect(revivableRow(fixture.database, node)).toBeUndefined();
    row("running", "none");
    expect(revivableRow(fixture.database, node)).toBeUndefined();
    row("failed", "none", "tmux");
    expect(revivableRow(fixture.database, node)).toBeUndefined();
  });

  it("没有会话的节点不接", () => {
    expect(revivableRow(fixture.database, "missing")).toBeUndefined();
  });
});
