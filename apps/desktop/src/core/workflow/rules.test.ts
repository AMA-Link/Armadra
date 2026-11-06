import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import {
  MAX_RULES_BYTES,
  RULES_PATH,
  RULES_TRUNCATED_NOTE,
  readRules,
  rulesHash,
  rulesOf,
} from "./rules";

/** 规则文件（契约 §104.3）：缺失、截断与标注、哈希按全文、远端工作区。 */

let fixture: AgentFixture;

beforeEach(() => {
  fixture = agentFixture();
});

afterEach(() => fixture.close());

function writeRules(text: string | Buffer): void {
  const path = join(fixture.directory, RULES_PATH);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("rules", () => {
  it("treats a missing or empty file as missing", () => {
    expect(readRules(fixture.database, fixture.workspaceId)).toMatchObject({
      present: false,
      remote: false,
      hash: "",
    });
    writeRules("");
    expect(readRules(fixture.database, fixture.workspaceId).present).toBe(
      false,
    );
  });

  it("reads the file every time and hashes the bytes", () => {
    writeRules("# 接单规则\n- 接：bug\u001b[31m\n");
    const first = readRules(fixture.database, fixture.workspaceId);
    expect(first).toMatchObject({ present: true, truncated: false });
    expect(first.hash).toBe(rulesHash("# 接单规则\n- 接：bug\u001b[31m\n"));
    expect(first.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(first.text).toBe("# 接单规则\n- 接：bug[31m\n");
    writeRules("# 接单规则\n- 接：bug.\n");
    expect(readRules(fixture.database, fixture.workspaceId).hash).not.toBe(
      first.hash,
    );
  });

  it("truncates past 16 KB with a note but hashes the whole file", () => {
    const whole = Buffer.from(`${"规".repeat(6_000)}tail`, "utf8");
    expect(whole.byteLength).toBeGreaterThan(MAX_RULES_BYTES);
    const read = rulesOf(whole);
    expect(read.truncated).toBe(true);
    expect(read.hash).toBe(rulesHash(whole));
    expect(read.text.endsWith(`\n${RULES_TRUNCATED_NOTE}`)).toBe(true);
    expect(read.text).not.toContain("tail");
    expect(read.text).not.toContain("�");
    expect(
      Buffer.byteLength(read.text.slice(0, -RULES_TRUNCATED_NOTE.length - 1)),
    ).toBeLessThanOrEqual(MAX_RULES_BYTES);
  });

  it("answers remote for a workspace on an execution host", () => {
    writeRules("rules");
    fixture.database
      .prepare(
        "UPDATE workspaces SET execution_host_id = 'host-1' WHERE id = ?",
      )
      .run(fixture.workspaceId);
    expect(readRules(fixture.database, fixture.workspaceId)).toMatchObject({
      present: false,
      remote: true,
      hash: "",
    });
  });
});
