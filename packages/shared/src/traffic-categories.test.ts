import { describe, expect, it } from "vitest";

import { trafficCategory } from "./traffic-categories.js";

describe("trafficCategory（契约 §76）", () => {
  it.each([
    ["ws", "/api/terminals/abc/ws", "terminal"],
    ["http", "/api/terminals/abc/paste", "terminal"],
    ["http", "/api/terminals", "terminal"],
    ["ws", "/api/ws", "events"],
    ["ws", "/api/workspaces/w1/events", "events"],
    ["ws", "/api/workspaces/w1/boards/b1/sync", "canvas"],
    ["http", "/api/workspaces/w1/boards/b1/document", "canvas"],
    ["http", "/api/workspaces/w1/boards/b1/comments/c1", "canvas"],
    ["http", "/api/workspaces/w1/boards", "api"],
    ["http", "/api/workspaces/w1/files?path=a.txt", "files"],
    ["http", "/api/workspaces/w1/file-download", "files"],
    ["http", "/api/workspaces/w1/assets/a1", "files"],
    ["http", "/api/workspaces/w1/exports/e1/png", "files"],
    ["http", "/api/workspaces/w1/agent-uploads", "files"],
    ["http", "/api/workspaces/w1/imports/local", "files"],
    ["http", "/api/media/tkt", "files"],
    ["http", "/api/data/backup", "files"],
    ["http", "/api/data/export", "api"],
    ["http", "/api/acp/sessions/s1/prompt", "agent"],
    ["http", "/api/agents", "agent"],
    ["http", "/api/agent-status/n1/read", "agent"],
    ["http", "/api/rpc/terminals/list", "terminal"],
    ["http", "/api/rpc/boards/get", "canvas"],
    ["http", "/api/rpc/files/read", "files"],
    ["http", "/api/rpc/acp/sessions", "agent"],
    ["http", "/api/rpc/system/hello", "api"],
    ["ws", "/api/ws/extra", "api"],
    ["http", "/api/identity/hello", "api"],
    ["http", "/api", "api"],
    ["http", "/api/workspaces", "api"],
    ["http", "/health", "other"],
    ["http", "/apix", "other"],
    ["http", "/", "other"],
  ] as const)("%s %s → %s", (kind, path, category) => {
    expect(trafficCategory(kind, path)).toBe(category);
  });

  it("查询串与片段不参与匹配", () => {
    expect(trafficCategory("http", "/api/media/x?y=/api/ws")).toBe("files");
    expect(trafficCategory("ws", "/api/ws?t=1")).toBe("events");
    expect(trafficCategory("http", "/x#/api/ws")).toBe("other");
  });
});
