import { describe, expect, it } from "vitest";

import type { TeamMember } from "../team/data";
import { buildAccessRows, narrowedBy, shapesFor } from "./access-model";
import type { HostAccess } from "./data";
import type { Grant } from "./grants-data";

const NOW = 1_000_000;
const person = (
  accountId: string,
  role: TeamMember["role"],
  displayName = accountId,
): TeamMember => ({
  accountId,
  email: `${accountId}@x.test`,
  displayName,
  role,
  joinedAtMs: 0,
  groups: [],
});
const OWNER = person("owner", "admin", "所有者");
const ANN = person("ann", "member", "Ann");
const BOB = person("bob", "member", "Bob");
const GUEST = person("gus", "guest", "Gus");
const MEMBERS = [OWNER, ANN, BOB, GUEST];

let n = 0;
const grant = (
  subject: Grant["subject"],
  role: Grant["role"],
  workspaceIds: string[] = [],
  expiresAtMs: number | null = null,
): Grant => ({
  grantId: `g${++n}`,
  sourceId: "h",
  subject,
  role,
  workspaceIds,
  expiresAtMs,
  grantedBy: "owner",
  createdAtMs: 1,
  revokedAtMs: null,
});
const team = (role: Grant["role"]) =>
  grant({ kind: "team", teamId: "t" }, role);
const member = (accountId: string, role: Grant["role"], ws: string[] = []) =>
  grant({ kind: "member", accountId }, role, ws);

const accessRow = (
  accountId: string,
  over: Partial<HostAccess> = {},
): HostAccess => ({
  accountId,
  email: `${accountId}@x.test`,
  via: "team",
  linkId: null,
  grantedAtMs: 1,
  role: "viewer",
  workspaceIds: [],
  expiresAtMs: null,
  ...over,
});

describe("访问清单的行", () => {
  it("团队全员在最前，所有者其次，其余按名字；没有角色的行不要", () => {
    const rows = buildAccessRows(
      [
        accessRow("bob"),
        accessRow("owner", { via: "owner", role: "driver" }),
        accessRow("ann"),
        accessRow("nobody", { role: undefined }),
      ],
      [team("viewer")],
      MEMBERS,
      "研发组",
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["team", "owner", "ann", "bob"]);
    expect(rows.map((row) => row.via)).toEqual([
      "direct",
      "owner",
      "team",
      "team",
    ]);
  });

  it("有本人的授予是「直接授予」；合成角色低于某条来源时标「已降低」", () => {
    const rows = buildAccessRows(
      [accessRow("ann", { role: "viewer" })],
      [team("viewer"), member("ann", "driver", ["w1"])],
      MEMBERS,
      "研发组",
      NOW,
    );
    const ann = rows.find((row) => row.id === "ann")!;
    expect(ann.via).toBe("direct");
    expect(ann.lowered).toBe(true);
    const plain = buildAccessRows(
      [accessRow("ann", { role: "editor" })],
      [member("ann", "editor")],
      MEMBERS,
      "研发组",
      NOW,
    ).find((row) => row.id === "ann")!;
    expect(plain.lowered).toBe(false);
  });

  it("已过期的来源不参与「已降低」的判断", () => {
    const rows = buildAccessRows(
      [accessRow("ann", { role: "viewer" })],
      [team("viewer"), { ...member("ann", "driver", ["w1"]), expiresAtMs: 5 }],
      MEMBERS,
      "研发组",
      NOW,
    );
    expect(rows.find((row) => row.id === "ann")!.lowered).toBe(false);
  });
});

describe("适用的授予", () => {
  it("团队全员只给非访客成员，本人的授予只给本人，所有者另有整台 driver", () => {
    const grants = [team("viewer"), member("ann", "editor")];
    expect(shapesFor("ann", grants, MEMBERS, "owner")).toHaveLength(2);
    expect(shapesFor("bob", grants, MEMBERS, "owner")).toHaveLength(1);
    expect(shapesFor("gus", grants, MEMBERS, "owner")).toHaveLength(0);
    expect(shapesFor("owner", grants, MEMBERS, "owner")[0]).toEqual({
      role: "driver",
      workspaceIds: [],
    });
  });
});

describe("这次改动会收窄谁", () => {
  const ann = member("ann", "driver", ["w1"]);
  const base = { members: MEMBERS, ownerId: "owner", now: NOW } as const;

  it("加团队全员只读整台：Ann 的 driver@w1 被合成成只读，Bob 本来没有权限不算", () => {
    const hit = narrowedBy({
      ...base,
      grants: [ann],
      change: {
        kind: "add",
        subject: { kind: "team", teamId: "t" },
        role: "viewer",
        workspaceIds: [],
        expiresAtMs: null,
      },
    });
    expect(hit.map((one) => one.accountId)).toEqual(["ann"]);
  });

  it("所有者永远不收窄；更高或同样的角色不收窄", () => {
    expect(
      narrowedBy({
        ...base,
        grants: [team("driver")],
        change: {
          kind: "add",
          subject: { kind: "member", accountId: "ann" },
          role: "viewer",
          workspaceIds: [],
          expiresAtMs: null,
        },
      }),
    ).toEqual([]);
  });

  it("改已有授予：降角色、到期提前收窄；升角色、不改到期不收窄", () => {
    const grants = [member("ann", "editor"), member("bob", "viewer")];
    const target = grants[0]!;
    const change = (role: Grant["role"], expiresAtMs?: number | null) =>
      narrowedBy({
        ...base,
        grants,
        change: {
          kind: "update",
          grantId: target.grantId,
          role,
          ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
        },
      }).length;
    expect(change("viewer")).toBe(1);
    expect(change("editor", NOW + 1000)).toBe(1);
    expect(change("driver")).toBe(0);
    expect(change("editor")).toBe(0);
    expect(change("editor", null)).toBe(0);
  });

  it("改团队全员那条：每个成员各自合成，只列真的收窄的人", () => {
    const everyone = team("editor");
    const hit = narrowedBy({
      ...base,
      grants: [everyone, member("ann", "editor")],
      change: { kind: "update", grantId: everyone.grantId, role: "viewer" },
    });
    // Ann 另有本人的 editor，合成不变；Bob 只靠团队全员，被降低。
    expect(hit.map((one) => one.accountId)).toEqual(["bob"]);
  });
});
