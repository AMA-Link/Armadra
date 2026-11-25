import { describe, expect, it } from "vitest";

import { closeHarness, harness } from "./manager-harness";
import { sshHostOfData, sshHostOfNode } from "./ssh-host";

describe("节点的 SSH 主机", () => {
  it("取节点数据里的 ssh.hostId，其余都是 undefined", () => {
    expect(sshHostOfData({ ssh: { hostId: "h1" } })).toBe("h1");
    for (const data of [
      undefined,
      {},
      { ssh: null },
      { ssh: {} },
      { ssh: { hostId: "" } },
      { ssh: { hostId: 3 } },
    ]) {
      expect(sshHostOfData(data as never)).toBeUndefined();
    }
  });

  it("按节点 id 查库与按数据读同一个答案；不存在的节点、空 id 答 undefined", () => {
    const { database } = harness();
    try {
      database
        .prepare(
          "INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES ('b1', 'ws', 'main', '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z')",
        )
        .run();
      const insert = (id: string, data: unknown) =>
        database
          .prepare(
            "INSERT INTO nodes (id, board_id, type, x, y, title, color, data_json, created_at, updated_at) VALUES (?, ?, 'terminal', 0, 0, 'n', '#000', ?, '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z')",
          )
          .run(id, "b1", JSON.stringify(data));
      insert("n-ssh", { ssh: { hostId: "h1" } });
      insert("n-local", { kind: "terminal" });
      expect(sshHostOfNode(database, "n-ssh")).toBe("h1");
      expect(sshHostOfNode(database, "n-local")).toBeUndefined();
      expect(sshHostOfNode(database, "missing")).toBeUndefined();
      expect(sshHostOfNode(database, null)).toBeUndefined();
    } finally {
      closeHarness();
    }
  });
});
