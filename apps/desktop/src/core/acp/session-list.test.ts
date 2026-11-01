import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpMirror, mirrorPath } from "./mirror";
import { FAKE_AGENT, type AcpCore, acpCore } from "./fixture";
import { type AcpHostSession, startAcp } from "./host";
import { AcpSession, type AcpSessionSink } from "./session";
import {
  MAX_LISTED_SESSIONS,
  listSessionsOn,
  listedSessions,
} from "./session-list";
import { tempDir } from "../testing/temp-dir";

const caps = (list: boolean) => ({ capabilities: { list } as never });

describe("listedSessions", () => {
  it("keeps id, cwd, title and updatedAt and drops what has no id", () => {
    expect(
      listedSessions([
        { sessionId: "a", cwd: "/w", title: "Fix", updatedAt: "2026-01-01" },
        { sessionId: "b", cwd: "/w", title: null, updatedAt: null },
        { cwd: "/w" },
        null,
        "x",
      ]),
    ).toEqual([
      { sessionId: "a", cwd: "/w", title: "Fix", updatedAt: "2026-01-01" },
      { sessionId: "b", cwd: "/w" },
    ]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_LISTED_SESSIONS + 50 }, (_, i) => ({
      sessionId: `s${i}`,
      cwd: "/w",
    }));
    expect(listedSessions(many)).toHaveLength(MAX_LISTED_SESSIONS);
    expect(listedSessions(undefined)).toEqual([]);
  });
});

describe("listSessionsOn", () => {
  it("pages with listSessions on the 0.11 client and hands the cursor on", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [{ sessionId: "a", cwd: "/w" }],
      nextCursor: "c2",
    });
    const result = await listSessionsOn(
      { ...caps(true), process: { client: { listSessions } } },
      { cwd: "/w", cursor: "c1" },
    );
    expect(listSessions).toHaveBeenCalledWith("/w", "c1", undefined);
    expect(result).toEqual({
      sessions: [{ sessionId: "a", cwd: "/w" }],
      nextCursor: "c2",
    });
  });

  it("prefers listAllSessions when the client has it and no cursor is given", async () => {
    const listAllSessions = vi
      .fn()
      .mockResolvedValue([{ sessionId: "a", cwd: "/w" }]);
    const listSessions = vi.fn();
    const result = await listSessionsOn(
      { ...caps(true), process: { client: { listSessions, listAllSessions } } },
      { cwd: "/w" },
    );
    expect(listAllSessions).toHaveBeenCalledWith("/w", undefined);
    expect(listSessions).not.toHaveBeenCalled();
    expect(result).toEqual({ sessions: [{ sessionId: "a", cwd: "/w" }] });
    // 带游标就按页取。
    listSessions.mockResolvedValue({ sessions: [] });
    await listSessionsOn(
      { ...caps(true), process: { client: { listSessions, listAllSessions } } },
      { cursor: "c" },
    );
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("supportsList() on the client wins over the declared capability", async () => {
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    await expect(
      listSessionsOn({
        ...caps(true),
        process: { client: { supportsList: () => false, listSessions } },
      }),
    ).rejects.toMatchObject({ code: "acp_list_unsupported" });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("answers acp_list_unsupported when the agent did not declare it", async () => {
    await expect(
      listSessionsOn({
        ...caps(false),
        process: { client: { listSessions: vi.fn() } },
      }),
    ).rejects.toMatchObject({ code: "acp_list_unsupported" });
  });
});

let open: AcpCore | undefined;
afterEach(async () => {
  await open?.stop();
  open = undefined;
});

describe("POST /api/acp/agent-sessions", () => {
  it("lists through a short-lived adapter (the fake keeps no history across processes)", async () => {
    open = await acpCore();
    const answer = await open.core.call("POST", "/api/acp/agent-sessions", {
      workspaceId: open.workspaceId,
      agentId: FAKE_AGENT,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toEqual({ sessions: [] });
  });

  it("is refused when the agent does not declare session/list", async () => {
    open = await acpCore({ minimal: true });
    const answer = await open.core.call("POST", "/api/acp/agent-sessions", {
      workspaceId: open.workspaceId,
      agentId: FAKE_AGENT,
    });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "acp_list_unsupported" });
  });

  it("checks the request and refuses SSH nodes", async () => {
    open = await acpCore();
    const missing = await open.core.call("POST", "/api/acp/agent-sessions", {
      workspaceId: open.workspaceId,
    });
    expect(missing.status).toBe(400);
    const nowhere = await open.core.call("POST", "/api/acp/agent-sessions", {
      workspaceId: "nope",
      agentId: FAKE_AGENT,
    });
    expect(nowhere.status).toBe(404);
    const remote = await open.node({ sshHostId: "host-1" });
    const refused = await open.core.call("POST", "/api/acp/agent-sessions", {
      workspaceId: open.workspaceId,
      agentId: FAKE_AGENT,
      nodeId: remote,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "acp_list_unsupported" });
  });
});

describe("session/close on a graceful shutdown", () => {
  const NODE = "11111111-2222-4333-8444-555555555555";

  async function opened(minimal: boolean) {
    const dataDir = tempDir("armadra-acp-close-");
    const sink: AcpSessionSink = {
      signal: () => undefined,
      publish: () => undefined,
      cancelled: () => undefined,
      transcriptPath: (_id, mirror) => mirror,
    };
    const session = new AcpSession({
      rowId: "row-1",
      generation: 1,
      nodeId: NODE,
      workspaceId: "w1",
      agentId: "claude",
      sink,
      mirrorFor: (id) => new AcpMirror(mirrorPath(dataDir, NODE, id)),
    });
    const host: AcpHostSession = await startAcp({
      program: process.execPath,
      args: [fakeAcpAgentPath(), ...(minimal ? ["--minimal"] : [])],
      cwd: tmpdir(),
      ...session.callbacks(),
    });
    session.opened(host);
    return {
      session,
      host,
      cleanup: () => rmSync(dataDir, { recursive: true }),
    };
  }

  it("closes the session before it kills the process when the agent declares close", async () => {
    const { session, host, cleanup } = await opened(false);
    const close = vi.spyOn(host.process.client, "closeSession");
    await session.terminate();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.calls[0]?.[0]).toBe(host.sessionId);
    cleanup();
  });

  it("does not send it when the agent cannot, and never lets it hold the shutdown", async () => {
    const minimal = await opened(true);
    const close = vi.spyOn(minimal.host.process.client, "closeSession");
    await minimal.session.terminate();
    expect(close).not.toHaveBeenCalled();
    minimal.cleanup();

    const stuck = await opened(false);
    vi.spyOn(stuck.host.process.client, "closeSession").mockReturnValue(
      new Promise(() => undefined),
    );
    expect(
      await stuck.host.process.closeSession(stuck.host.sessionId, 30),
    ).toBe(false);
    await stuck.session.terminate();
    stuck.cleanup();
  });
});
