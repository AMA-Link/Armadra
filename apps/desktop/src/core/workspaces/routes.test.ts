import {
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install as installCanvas } from "../canvas/routes";
import { type Fixture, fixture } from "./fixture";
import { install, workspaceOperations } from "./routes";

/**
 * The workspace routes, ported from the pre-merge implementation.
 *
 * The multipart import test of that file is not here: `POST
 * /api/workspaces/import` is R4's (the route table says so), and a test for a
 * route this build answers 501 for would assert the 501, not the behaviour.
 */
describe("the workspace routes", () => {
  let core: Fixture;

  beforeEach(() => {
    core = fixture([install, installCanvas]);
  });
  afterEach(() => {
    core.close();
  });

  it("registers the original path when the desktop opens a directory", async () => {
    const root = join(core.directory, "project");
    mkdirSync(root);
    writeFileSync(join(root, "a.txt"), "original");

    const first = await core.call("POST", "/api/workspaces/open-directory", {
      name: "project",
      rootPath: root,
    });
    expect(first.status).toBe(200);
    const second = await core.call("POST", "/api/workspaces/open-directory", {
      name: "project",
      rootPath: root,
    });
    expect(second.status).toBe(200);
    const one = first.body as { id: string; rootPath: string };
    const two = second.body as { id: string };
    expect(one.id).toBe(two.id);
    // Nothing was copied: the folder still holds exactly what it held.
    expect(readdirSync(root)).toEqual(["a.txt"]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original");

    // A file is not a workspace root.
    const file = await core.call("POST", "/api/workspaces/open-directory", {
      name: "file",
      rootPath: join(root, "a.txt"),
    });
    expect(file.status).toBe(400);
  });

  it("refuses a root reached through a symbolic link", async () => {
    const real = join(core.directory, "real");
    mkdirSync(real);
    const link = join(core.directory, "link");
    symlinkSync(real, link);
    const answer = await core.call("POST", "/api/workspaces/open-directory", {
      name: "linked",
      rootPath: link,
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "forbidden" });
  });

  it("creates the workspace folder when asked, and only one level", async () => {
    const root = join(core.directory, "fresh");
    const created = await core.call("POST", "/api/workspaces", {
      name: "fresh",
      rootPath: root,
      createDirectory: true,
    });
    expect(created.status).toBe(200);
    // Compared as a path, not as text: the separator is the host's.
    expect(basename((created.body as { rootPath: string }).rootPath)).toBe(
      "fresh",
    );

    // The same call again must not silently reuse the directory.
    const again = await core.call("POST", "/api/workspaces", {
      name: "fresh",
      rootPath: root,
      createDirectory: true,
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "conflict" });

    const deep = await core.call("POST", "/api/workspaces", {
      name: "deep",
      rootPath: join(core.directory, "missing", "deep"),
      createDirectory: true,
    });
    expect(deep.status).toBe(400);
  });

  it("answers the v3 contract for create, list, patch and open", async () => {
    const created = await core.call("POST", "/api/workspaces", {
      name: "Canvas",
      rootPath: core.directory,
      color: "#123456",
    });
    expect(created.status).toBe(200);
    const workspace = created.body as {
      id: string;
      color: string;
      permissions: Record<string, boolean>;
      lastOpenedAt: string;
      executionHostId?: string;
    };
    expect(workspace.color).toBe("#123456");
    expect(workspace.permissions.read).toBe(true);
    expect(typeof workspace.lastOpenedAt).toBe("string");
    // Serde omits an empty execution host entirely; the shared schema
    // defaults it back to `""`.
    expect("executionHostId" in workspace).toBe(false);
    expect("gatewayEnabled" in workspace).toBe(false);

    const listed = await core.call("GET", "/api/workspaces");
    const summaries = listed.body as {
      id: string;
      boards: { name: string }[];
    }[];
    expect(summaries[0]?.id).toBe(workspace.id);
    expect(summaries[0]?.boards[0]?.name).toBe("Default");

    const renamed = await core.call(
      "PATCH",
      `/api/workspaces/${workspace.id}`,
      {
        name: "Renamed",
      },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Renamed", color: "#123456" });

    const opened = await core.call(
      "POST",
      `/api/workspaces/${workspace.id}/open`,
    );
    expect(opened.status).toBe(200);
    expect(
      (opened.body as { lastOpenedAt: string }).lastOpenedAt >
        workspace.lastOpenedAt,
    ).toBe(true);
  });

  it("removes a workspace by cascading its rows and touching no file", async () => {
    const root = join(core.directory, "project");
    mkdirSync(root);
    writeFileSync(join(root, "keep-me.txt"), "untouched");
    const created = await core.call("POST", "/api/workspaces", {
      name: "fixture",
      rootPath: root,
    });
    const workspaceId = (created.body as { id: string }).id;
    const boards = await core.call(
      "GET",
      `/api/workspaces/${workspaceId}/boards`,
    );
    const board = (boards.body as { id: string; updatedAt: string }[])[0];
    if (board === undefined) throw new Error("the default board is missing");

    // A board with two nodes and the edge between them.
    const now = new Date().toISOString().replace("Z", "+00:00");
    const terminalId = "01950000-0000-7000-8000-000000000001";
    const stickyId = "01950000-0000-7000-8000-000000000002";
    const node = (id: string, type: string, data: unknown) => ({
      id,
      boardId: board.id,
      type,
      title: "Claude",
      color: "#0a84ff",
      position: { x: 0, y: 0 },
      labels: [],
      note: "",
      data,
      createdAt: now,
      updatedAt: now,
    });
    const saved = await core.call(
      "PUT",
      `/api/workspaces/${workspaceId}/boards/${board.id}/document`,
      {
        expectedUpdatedAt: board.updatedAt,
        nodes: [
          node(terminalId, "terminal", { kind: "terminal", cwd: "." }),
          node(stickyId, "sticky", { kind: "sticky", content: "note" }),
        ],
        edges: [
          {
            id: "01950000-0000-7000-8000-000000000003",
            boardId: board.id,
            source: stickyId,
            target: terminalId,
            kind: "link",
            createdAt: now,
            updatedAt: now,
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    );
    expect(saved.status).toBe(200);

    const removed = await core.call("DELETE", `/api/workspaces/${workspaceId}`);
    expect(removed.status).toBe(204);
    expect(removed.body).toBeUndefined();

    // Every table that references the workspace, directly or through the
    // board, is empty again — asserted here so a future migration cannot
    // quietly drop one of the cascades.
    for (const [label, sql, value] of [
      [
        "workspaces",
        "SELECT COUNT(*) AS n FROM workspaces WHERE id = ?",
        workspaceId,
      ],
      [
        "boards",
        "SELECT COUNT(*) AS n FROM boards WHERE workspace_id = ?",
        workspaceId,
      ],
      [
        "terminal_sessions",
        "SELECT COUNT(*) AS n FROM terminal_sessions WHERE workspace_id = ?",
        workspaceId,
      ],
      [
        "agent_status",
        "SELECT COUNT(*) AS n FROM agent_status WHERE workspace_id = ?",
        workspaceId,
      ],
      ["nodes", "SELECT COUNT(*) AS n FROM nodes WHERE board_id = ?", board.id],
      ["edges", "SELECT COUNT(*) AS n FROM edges WHERE board_id = ?", board.id],
    ] as const) {
      const row = core.database.prepare(sql).get(value) as { n: number };
      expect(Number(row.n), `${label} still has rows`).toBe(0);
    }

    // 从列表移除, not 删除项目: the directory is untouched.
    expect(readFileSync(join(root, "keep-me.txt"), "utf8")).toBe("untouched");

    // Removal is not silently idempotent.
    const twice = await core.call("DELETE", `/api/workspaces/${workspaceId}`);
    expect(twice.status).toBe(404);
    expect(twice.body).toMatchObject({ code: "not_found" });
  });

  it("announces the removal before the row goes and again once it is gone (#389)", async () => {
    const root = join(core.directory, "announce");
    mkdirSync(root);
    const opened = await core.call("POST", "/api/workspaces/open-directory", {
      name: "announce",
      rootPath: root,
    });
    const id = (opened.body as { id: string }).id;
    const seen: string[] = [];
    const rowExists = () =>
      core.database.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(id) !==
      undefined;
    core.bus.on("workspace.removing", ({ workspaceId }) => {
      seen.push(`removing:${workspaceId}:${rowExists() ? "row" : "gone"}`);
    });
    core.bus.on("workspace.grants", ({ workspaceId, permissions }) => {
      if (permissions === null) {
        seen.push(`grants:${workspaceId}:${rowExists() ? "row" : "gone"}`);
      }
    });
    expect((await core.call("DELETE", `/api/workspaces/${id}`)).status).toBe(
      204,
    );
    expect(seen).toEqual([`removing:${id}:row`, `grants:${id}:gone`]);
    // An unknown id announces nothing.
    await core.call("DELETE", `/api/workspaces/${id}`);
    expect(seen).toHaveLength(2);
  });

  it("archives a workspace out of the list, keeps its rows, and restores it (§89)", async () => {
    const root = join(core.directory, "shelf");
    mkdirSync(root);
    writeFileSync(join(root, "a.txt"), "kept");
    const opened = await core.call("POST", "/api/workspaces/open-directory", {
      name: "shelf",
      rootPath: root,
    });
    const id = (opened.body as { id: string }).id;
    const seen: string[] = [];
    core.bus.on("workspace.archived", ({ workspaceId }) => {
      seen.push(`archived:${workspaceId}`);
    });
    core.bus.on("workspace.grants", ({ workspaceId, permissions }) => {
      seen.push(
        `grants:${workspaceId}:${permissions === null ? "none" : "set"}`,
      );
    });
    const operations = workspaceOperations(core);

    operations.archive(id);
    expect(seen).toEqual([`archived:${id}`, `grants:${id}:none`]);
    // Archiving twice announces nothing and keeps the first time.
    const first = operations.archived()[0]?.archivedAt;
    operations.archive(id);
    expect(seen).toHaveLength(2);
    expect(operations.archived()).toMatchObject([
      { id, name: "shelf", archivedAt: first },
    ]);

    const listed = await core.call("GET", "/api/workspaces");
    expect(
      (listed.body as { id: string }[]).map((one) => one.id),
    ).not.toContain(id);
    // The rows hang on, and nothing on disk moved.
    expect(
      core.database
        .prepare("SELECT COUNT(*) AS n FROM boards WHERE workspace_id = ?")
        .get(id),
    ).toEqual({ n: 1 });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("kept");
    // A stale tab cannot open it back.
    expect((await core.call("POST", `/api/workspaces/${id}/open`)).status).toBe(
      404,
    );

    expect(operations.restore(id)).toMatchObject({ id, name: "shelf" });
    expect(operations.archived()).toEqual([]);
    const back = await core.call("GET", "/api/workspaces");
    expect((back.body as { id: string }[])[0]?.id).toBe(id);
    expect(() => operations.archive("missing")).toThrow();
  });

  it("restores an archived workspace when its folder is added again (§89)", async () => {
    const root = join(core.directory, "again");
    mkdirSync(root);
    const opened = await core.call("POST", "/api/workspaces/open-directory", {
      name: "again",
      rootPath: root,
    });
    const id = (opened.body as { id: string }).id;
    workspaceOperations(core).archive(id);
    const reopened = await core.call("POST", "/api/workspaces/open-directory", {
      name: "again",
      rootPath: root,
    });
    expect((reopened.body as { id: string }).id).toBe(id);
    expect(workspaceOperations(core).archived()).toEqual([]);
    const listed = await core.call("GET", "/api/workspaces");
    expect((listed.body as { id: string }[]).map((one) => one.id)).toContain(
      id,
    );
  });

  it("deletes an archived workspace for good (§89)", async () => {
    const root = join(core.directory, "drop");
    mkdirSync(root);
    const opened = await core.call("POST", "/api/workspaces/open-directory", {
      name: "drop",
      rootPath: root,
    });
    const id = (opened.body as { id: string }).id;
    const operations = workspaceOperations(core);
    operations.archive(id);
    expect((await core.call("DELETE", `/api/workspaces/${id}`)).status).toBe(
      204,
    );
    expect(operations.archived()).toEqual([]);
    expect(
      core.database.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(id),
    ).toBeUndefined();
  });

  it("refuses a remote workspace when no remote execution is assembled, rather than falling back to this machine", async () => {
    const remote = await core.call("POST", "/api/workspaces/remote", {
      name: "remote",
      executionHostId: "host",
      rootPath: "/srv/project",
    });
    expect(remote.status).toBe(501);
    expect(remote.body).toMatchObject({ code: "unsupported" });

    // Request validation still happens first, and still answers 400.
    const relative = await core.call("POST", "/api/workspaces/remote", {
      name: "remote",
      executionHostId: "host",
      rootPath: "relative/path",
    });
    expect(relative.status).toBe(400);
  });
});
