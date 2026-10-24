import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import type { OpenedDatabase } from "../db/open";
import { tempDir } from "../testing/temp-dir";
import { migrationsDir } from "../workspaces/fixture";
import { saveRelayRoute } from "./rows";
import { SourcesStore } from "./store";

/** 契约 §86.1：挂载落库对团队的取舍。 */

let opened: OpenedDatabase;
let store: SourcesStore;
const SOURCE = "a".repeat(32);

beforeEach(() => {
  opened = openFreshDatabase(
    join(tempDir("armadra-rows-"), "canvas.db"),
    migrationsDir(),
  );
  store = new SourcesStore(opened.database);
});

afterEach(() => opened.close());

const save = (input: {
  share: { ownerName: string; role: "viewer"; expiresAtMs: number } | null;
  team?: { teamId: string; teamName: string };
  issuer?: string;
  determined?: boolean;
}) =>
  saveRelayRoute(store, 1_000, {
    sourceId: SOURCE,
    existing: store.get(SOURCE),
    label: "host",
    defaultLabel: "host",
    relayOrigin: "https://relay.test",
    principalHint: "",
    ...input,
    issuer: input.issuer ?? "https://cloud.test",
  });

describe("saveRelayRoute 的团队", () => {
  it("SaaS 团队挂载后再经分享链接加入（不带团队），团队不变", () => {
    const first = save({
      share: { ownerName: "Alice", role: "viewer", expiresAtMs: 0 },
      team: { teamId: "team-1", teamName: "研发组" },
    });
    expect(first).toMatchObject({ origin: "shared", teamId: "team-1" });
    const again = save({
      share: { ownerName: "Alice", role: "viewer", expiresAtMs: 0 },
    });
    expect(again).toMatchObject({
      origin: "shared",
      teamId: "team-1",
      teamName: "研发组",
    });
  });

  it("没有已有团队时个人链接挂载团队为空", () => {
    expect(
      save({ share: { ownerName: "Alice", role: "viewer", expiresAtMs: 0 } }),
    ).toMatchObject({ origin: "shared", teamId: "", teamName: "" });
  });

  it("旧 core 不报分享信息：云没变时沿用分享方，云变了则清空，已确定时沿用", () => {
    save({ share: { ownerName: "Alice", role: "viewer", expiresAtMs: 5 } });
    expect(save({ share: null })).toMatchObject({
      origin: "shared",
      ownerLabel: "Alice",
      shareRole: "viewer",
      shareExpiresAtMs: 5,
    });
    expect(save({ share: null, issuer: "https://other.test" })).toMatchObject({
      origin: "shared",
      ownerLabel: "",
      shareRole: "",
    });
    save({ share: { ownerName: "Bob", role: "viewer", expiresAtMs: 0 } });
    expect(
      save({ share: null, issuer: "https://other.test", determined: true }),
    ).toMatchObject({ ownerLabel: "Bob" });
  });
});
