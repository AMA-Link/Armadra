import { beforeEach, describe, expect, it } from "vitest";

import { openAfterJoin } from "./join-intent";
import {
  joinedByLink,
  markJoinedByLink,
  originOf,
  shareFieldsOf,
  shareRoleOf,
} from "./origin";
import type { SourceDescriptor } from "./types";

const descriptor = (
  sourceId: string,
  patch: Partial<SourceDescriptor> = {},
): SourceDescriptor => ({
  sourceId,
  kind: "relayed",
  label: sourceId,
  baseUrl: "",
  relayOrigin: "https://relay.test",
  cloudIssuer: "https://relay.test",
  fingerprint: "",
  orderIndex: 1,
  ...patch,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("归属（契约 §68）", () => {
  it("旧 core 不报：缺省是我的；经链接加入过的算别人的", () => {
    expect(originOf(descriptor("a"))).toBe("mine");
    openAfterJoin("a");
    expect(joinedByLink("a")).toBe(true);
    expect(originOf(descriptor("a"))).toBe("shared");
    expect(originOf(descriptor("b"))).toBe("mine");
  });

  it("core 报了以 core 为准；本机总是我的", () => {
    markJoinedByLink("a");
    expect(originOf(descriptor("a", { origin: "mine" }))).toBe("mine");
    expect(originOf(descriptor("c", { origin: "shared" }))).toBe("shared");
    expect(originOf(descriptor("local", { kind: "local" }))).toBe("mine");
  });

  it("本机加入（手机把本机换成加入的主机）不记成别人的", () => {
    openAfterJoin("local");
    expect(joinedByLink("local")).toBe(false);
  });

  it("shareFieldsOf：认得的才带上，名字与到期接受两种拼法", () => {
    expect(shareFieldsOf({})).toEqual({});
    expect(
      shareFieldsOf({
        origin: "shared",
        ownerLabel: " Ann ",
        shareRole: "editor",
        shareExpiresAtMs: 42,
      }),
    ).toEqual({
      origin: "shared",
      ownerName: "Ann",
      shareRole: "editor",
      shareExpiresAt: 42,
    });
    expect(
      shareFieldsOf({
        origin: "other",
        ownerName: "",
        shareRole: "boss",
        shareExpiresAt: -1,
      }),
    ).toEqual({});
  });

  it("权限缺省只读", () => {
    expect(shareRoleOf(descriptor("a"))).toBe("viewer");
    expect(shareRoleOf(descriptor("a", { shareRole: "operator" }))).toBe(
      "operator",
    );
  });
});
