import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { RepositoryService } from "../git/repository/service";
import { temporary, type Temporary } from "../files/workspace.fixture";
import { type RemoteCaller, setRemoteCaller } from "../remote/execute";
import { OPERATIONS } from "../remote/operations";
import {
  createRemoteWorkspace,
  createWorkspace,
  getWorkspace,
} from "../workspaces/table";
import {
  checkFileId,
  defaultFileId,
  exportFileId,
  fileRef,
  listWorkflowFiles,
  normalizeDescription,
  readWorkflowFile,
  textHash,
  upsertFileTemplate,
  writeWorkflowFile,
} from "./files";
import { templateById, insertTemplate, updateTemplate } from "./store";
import { parseDraft } from "./draft";
import type { WorkflowDraft } from "./types";
import { validAgentId } from "../agent/registry";

/** `.ama/workflows` 的列表、读写与模板落库（契约 §121）。 */

const FILE = (title: string, agent = "codex") => `---
version: 2
title: ${title}
roles:
  - id: a
    agentId: ${agent}
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
`;

const DRAFT: WorkflowDraft = parseDraft(
  {
    version: 2,
    title: "导出的流程",
    roles: [{ id: "a", agentId: "codex" }],
    steps: [{ id: "s", kind: "prompt", role: "a", prompt: "x" }],
  },
  { validAgentId },
);

let f: AgentFixture;

beforeEach(() => {
  f = agentFixture();
});
afterEach(() => f.close());

const workspace = () => getWorkspace(f.database, f.workspaceId);
const dir = () => join(f.directory, ".ama", "workflows");
function put(name: string, text: string): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), name), text);
}

describe("listWorkflowFiles", () => {
  it("答空数组：目录不在", async () => {
    expect(await listWorkflowFiles(workspace(), f.database)).toEqual([]);
  });

  it("含有效、无效与已导入的，只看直接下层的 .md", async () => {
    put("good.md", FILE("好的"));
    put("broken.md", "没有围栏");
    put("acp.md", FILE("画布不认", "acp:other"));
    put("bad name.md", FILE("名字不合法"));
    put("notes.txt", "x");
    mkdirSync(join(dir(), "nested.md"));
    const before = await listWorkflowFiles(workspace(), f.database);
    expect(before.map((entry) => [entry.id, entry.valid])).toEqual([
      ["acp", false],
      ["bad name", false],
      ["broken", false],
      ["good", true],
    ]);
    const byId = Object.fromEntries(before.map((entry) => [entry.id, entry]));
    expect(byId.good).toMatchObject({
      path: ".ama/workflows/good.md",
      title: "好的",
      error: null,
      templateId: null,
    });
    expect(byId.broken?.error).toMatch(/frontmatter/);
    expect(byId.acp?.error).toMatch(/acp:other/);
    expect(byId.acp?.title).toBe("画布不认");
    expect(byId["bad name"]?.title).toBeNull();
    const { template } = upsertFileTemplate(
      f.database,
      fileRef(f.workspaceId, "good"),
      (await readWorkflowFile(workspace(), "good")).draft,
      1_000,
    );
    const after = await listWorkflowFiles(workspace(), f.database);
    expect(after.find((entry) => entry.id === "good")?.templateId).toBe(
      template.id,
    );
  });

  it("读不了的工作空间被拒", async () => {
    const closed = createWorkspace(f.database, {
      name: "closed",
      rootPath: join(f.directory, "closed"),
      permissions: { read: false, write: false, execute: false },
    });
    await expect(listWorkflowFiles(closed, f.database)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("readWorkflowFile", () => {
  it("答规整后的草案与原文的 sha256", async () => {
    const text = FILE("读我");
    put("one.md", text);
    const { draft, hash } = await readWorkflowFile(workspace(), "one");
    expect(draft.title).toBe("读我");
    expect(draft.steps[0]).toMatchObject({ after: [] });
    expect(hash).toBe(textHash(text));
  });

  it("带 BOM 的文件，hash 算整段读到的文本（与 ama 同）", async () => {
    const text = `﻿${FILE("带 BOM")}`;
    put("bom.md", text);
    const { hash } = await readWorkflowFile(workspace(), "bom");
    expect(hash).toBe(textHash(text));
  });

  it("没有这份文件 404；id 不合法 400；acp 400 invalid_draft", async () => {
    await expect(readWorkflowFile(workspace(), "nope")).rejects.toMatchObject({
      status: 404,
    });
    await expect(readWorkflowFile(workspace(), "../etc")).rejects.toMatchObject(
      { status: 400 },
    );
    put("acp.md", FILE("x", "acp:other"));
    await expect(readWorkflowFile(workspace(), "acp")).rejects.toMatchObject({
      status: 400,
      code: "invalid_draft",
    });
    put("bad.md", "---\nversion: 1\n---\n");
    await expect(readWorkflowFile(workspace(), "bad")).rejects.toMatchObject({
      status: 400,
      code: "invalid_draft",
    });
  });
});

describe("writeWorkflowFile", () => {
  it("建 .ama/workflows 并写出 ama 能读回的文件", async () => {
    expect(await writeWorkflowFile(workspace(), "out", DRAFT, false)).toEqual({
      path: ".ama/workflows/out.md",
    });
    const text = readFileSync(join(dir(), "out.md"), "utf8");
    expect(text).toMatch(/^---\nversion: 2\ntitle: 导出的流程\n/);
    expect(text).not.toMatch(/after: \[\]/);
    expect((await readWorkflowFile(workspace(), "out")).draft).toEqual(DRAFT);
  });

  it("已存在且没 overwrite：409 workflow_file_exists，文件不变；overwrite 覆盖", async () => {
    put("out.md", FILE("原来的"));
    await expect(
      writeWorkflowFile(workspace(), "out", DRAFT, false),
    ).rejects.toMatchObject({ status: 409, code: "workflow_file_exists" });
    expect(readFileSync(join(dir(), "out.md"), "utf8")).toBe(FILE("原来的"));
    await writeWorkflowFile(workspace(), "out", DRAFT, true);
    expect(readFileSync(join(dir(), "out.md"), "utf8")).toContain("导出的流程");
    expect(readdirSync(dir())).toEqual(["out.md"]);
  });

  it("ama 校验不过回 400 invalid_draft，不落盘", async () => {
    await expect(
      writeWorkflowFile(workspace(), "out", { ...DRAFT, title: "" }, false),
    ).rejects.toMatchObject({ status: 400, code: "invalid_draft" });
    expect(existsSync(join(dir(), "out.md"))).toBe(false);
  });

  it("只读工作空间、不合法的 id 被拒", async () => {
    const readonly = createWorkspace(f.database, {
      name: "ro",
      rootPath: join(f.directory, "ro"),
      permissions: { read: true, write: false, execute: false },
    });
    await expect(
      writeWorkflowFile(readonly, "out", DRAFT, false),
    ).rejects.toMatchObject({ status: 403 });
    for (const bad of ["", "../x", "a/b", "1abc", "a".repeat(33)]) {
      expect(() => checkFileId(bad)).toThrow();
    }
  });
});

describe("upsertFileTemplate", () => {
  const ref = "w/flow";

  it("created、unchanged、updated（修订号 +1）；改过名字的保留", () => {
    const first = upsertFileTemplate(f.database, ref, DRAFT, 1_000);
    expect(first.change).toBe("created");
    expect(first.template).toMatchObject({
      version: 1,
      fileRef: ref,
      name: "导出的流程",
    });
    const same = upsertFileTemplate(f.database, ref, DRAFT, 2_000);
    expect(same.change).toBe("unchanged");
    expect(same.template.version).toBe(1);
    expect(same.template.updatedAt).toBe(1_000);
    updateTemplate(f.database, first.template.id, "我改的名", DRAFT, 3_000, 1);
    const changed = upsertFileTemplate(
      f.database,
      ref,
      { ...DRAFT, title: "新标题" },
      4_000,
    );
    expect(changed.change).toBe("updated");
    expect(changed.template).toMatchObject({
      id: first.template.id,
      version: 3,
      name: "我改的名",
    });
    expect(changed.template.template.title).toBe("新标题");
  });

  it("名字跟着标题走", () => {
    upsertFileTemplate(f.database, ref, DRAFT, 1_000);
    const renamed = upsertFileTemplate(
      f.database,
      ref,
      { ...DRAFT, title: "跟着走" },
      2_000,
    );
    expect(renamed.template.name).toBe("跟着走");
  });
});

describe("upsertFileTemplate 与 source", () => {
  const ref = "w/flow";
  const LOCAL = { boardId: "b-local", nodeIds: ["n1"], sessionId: "s-local" };
  const withSource = { ...DRAFT, source: LOCAL };

  it("新建不存 source", () => {
    const made = upsertFileTemplate(f.database, ref, withSource, 1_000);
    expect(made.change).toBe("created");
    expect(made.template.template.source).toBeUndefined();
  });

  it("比较忽略 source：只有 source 不同算 unchanged", () => {
    const row = insertTemplate(f.database, {
      id: "0190aaaa-0000-7000-8000-000000000001",
      name: DRAFT.title,
      template: withSource,
      createdFromDraft: null,
      fileRef: ref,
      createdAt: 1_000,
    });
    const same = upsertFileTemplate(f.database, ref, DRAFT, 2_000);
    expect(same.change).toBe("unchanged");
    expect(same.template.version).toBe(row.version);
    const other = upsertFileTemplate(
      f.database,
      ref,
      { ...DRAFT, source: { ...LOCAL, boardId: "elsewhere" } },
      3_000,
    );
    expect(other.change).toBe("unchanged");
  });

  it("更新保留库里原有的 source，文件里的丢弃", () => {
    insertTemplate(f.database, {
      id: "0190aaaa-0000-7000-8000-000000000002",
      name: DRAFT.title,
      template: withSource,
      createdFromDraft: null,
      fileRef: ref,
      createdAt: 1_000,
    });
    const changed = upsertFileTemplate(
      f.database,
      ref,
      { ...DRAFT, title: "新标题", source: { boardId: "from-file" } },
      2_000,
    );
    expect(changed.change).toBe("updated");
    expect(changed.template.template.source).toEqual(LOCAL);
    expect(changed.template.template.title).toBe("新标题");
  });

  it("读文件时丢弃 source；导出的文件不带 source", async () => {
    put(
      "src.md",
      `${FILE("带来历")}`.replace(
        "\n---\n",
        "\nsource:\n  boardId: b-1\n  nodeIds: [n1]\n---\n",
      ),
    );
    expect(readFileSync(join(dir(), "src.md"), "utf8")).toContain("boardId");
    const read = await readWorkflowFile(workspace(), "src");
    expect(read.draft.source).toBeUndefined();
    await writeWorkflowFile(workspace(), "out", withSource, false);
    expect(readFileSync(join(dir(), "out.md"), "utf8")).not.toMatch(
      /source|b-local|s-local/,
    );
  });
});

describe("description 的往返", () => {
  const ref = "w/flow";

  it("normalizeDescription：CRLF 与单独的 CR 变 LF，去首尾空白行，空正文没有", () => {
    expect(normalizeDescription("\n \t\nA\r\nB\rC\n\n  \n")).toBe("A\nB\nC");
    expect(normalizeDescription("  行首空格保留\n")).toBe("  行首空格保留");
    expect(normalizeDescription(" \r\n\n")).toBeUndefined();
  });

  it("导出再导入：带 CRLF 与首尾空行的 description 是 unchanged", async () => {
    const draft = { ...DRAFT, description: "\n\n第一行\r\n\r\n第三行\r\n\n" };
    const made = upsertFileTemplate(f.database, ref, draft, 1_000);
    expect(made.template.template.description).toBe("第一行\n\n第三行");
    await writeWorkflowFile(workspace(), "d", draft, false);
    const { draft: back } = await readWorkflowFile(workspace(), "d");
    expect(back.description).toBe("第一行\n\n第三行");
    const again = upsertFileTemplate(f.database, ref, back, 2_000);
    expect(again.change).toBe("unchanged");
    expect(again.template.version).toBe(1);
  });

  it("库里原有的不规整 description 也与文件读回的相等", () => {
    insertTemplate(f.database, {
      id: "0190aaaa-0000-7000-8000-000000000003",
      name: DRAFT.title,
      template: { ...DRAFT, description: "说明\r\n\r\n" },
      createdFromDraft: null,
      fileRef: ref,
      createdAt: 1_000,
    });
    const same = upsertFileTemplate(
      f.database,
      ref,
      { ...DRAFT, description: "说明" },
      2_000,
    );
    expect(same.change).toBe("unchanged");
  });
});

describe("exportFileId", () => {
  const row = (id: string, name: string, fileRef: string | null = null) =>
    insertTemplate(f.database, {
      id,
      name,
      template: DRAFT,
      createdFromDraft: null,
      fileRef,
      createdAt: 1,
    });

  it("默认 id 没人占或占的是自己：原样", () => {
    const mine = row("0190aaaa-0000-7000-8000-000000000010", "Review");
    expect(exportFileId(f.database, "w", mine)).toBe("review");
    const owned = row("0190aaaa-0000-7000-8000-000000000011", "x", "w/mine");
    expect(exportFileId(f.database, "w", owned)).toBe("mine");
  });

  it("默认 id 的文件引用属于别的模板：补 -<模板 id 前 8 位>，总长 ≤ 32", () => {
    row("0190aaaa-0000-7000-8000-000000000012", "Other", "w/review");
    const mine = row("0190bbbb-0000-7000-8000-000000000013", "Review");
    expect(exportFileId(f.database, "w", mine)).toBe("review-0190bbbb");
    // 别的工作空间里没人占：不加后缀。
    expect(exportFileId(f.database, "v", mine)).toBe("review");
    row("0190aaaa-0000-7000-8000-000000000014", "L", `w/${"a".repeat(32)}`);
    const long = row("0190cccc-0000-7000-8000-000000000015", "a".repeat(60));
    const id = exportFileId(f.database, "w", long);
    expect(id).toBe(`${"a".repeat(23)}-0190cccc`);
    expect(id.length).toBe(32);
  });
});

describe("defaultFileId", () => {
  const row = (name: string, fileRef: string | null = null) =>
    insertTemplate(f.database, {
      id: `0190aaaa-0000-7000-8000-${String(Math.random()).slice(2, 14).padEnd(12, "0")}`,
      name,
      template: DRAFT,
      createdFromDraft: null,
      fileRef,
      createdAt: 1,
    });

  it("取文件引用里的，再取名字的短横线形式，再取 workflow-<id 前 8 位>", () => {
    expect(defaultFileId(row("随便", "w/from-ref"))).toBe("from-ref");
    expect(defaultFileId(row("Code Review: Two  Reviewers!"))).toBe(
      "code-review-two-reviewers",
    );
    const chinese = row("双人审查");
    expect(defaultFileId(chinese)).toBe(`workflow-${chinese.id.slice(0, 8)}`);
    const digits = row("123 go");
    expect(defaultFileId(digits)).toBe(`workflow-${digits.id.slice(0, 8)}`);
    expect(defaultFileId(row("a".repeat(60)))).toBe("a".repeat(32));
  });
});

describe("远端执行主机上的工作空间", () => {
  let far: Temporary;
  let state: Temporary;
  let previous: RemoteCaller | undefined;
  const calls: string[] = [];

  beforeEach(() => {
    far = temporary("armadra-wf-far-");
    state = temporary("armadra-wf-state-");
    calls.length = 0;
    // 「那台机器」就是本进程里同一张操作表，根是另一处。
    previous = setRemoteCaller(async (_host, operation, payload) => {
      calls.push(operation);
      return await OPERATIONS[operation]!.run(
        {
          service: new RepositoryService(),
          freshDiscovery: true,
          stateDir: state.path,
        },
        payload.root,
        payload.args ?? {},
      );
    });
  });
  afterEach(() => {
    setRemoteCaller(previous);
    far.remove();
    state.remove();
  });

  it("列表、读与写都走执行主机，不碰控制端磁盘", async () => {
    const remote = createRemoteWorkspace(f.database, {
      name: "far",
      executionHostId: "far",
      rootPath: far.path,
    });
    mkdirSync(join(far.path, ".ama", "workflows"), { recursive: true });
    writeFileSync(join(far.path, ".ama", "workflows", "far.md"), FILE("远端"));
    // 控制端同名路径放一份不同的，读到它就是回退到了本机。
    mkdirSync(join(f.directory, ".ama", "workflows"), { recursive: true });
    writeFileSync(
      join(f.directory, ".ama", "workflows", "far.md"),
      FILE("本机"),
    );
    const listed = await listWorkflowFiles(remote, f.database);
    expect(listed.map((entry) => [entry.id, entry.title])).toEqual([
      ["far", "远端"],
    ]);
    expect((await readWorkflowFile(remote, "far")).draft.title).toBe("远端");
    await writeWorkflowFile(remote, "made", DRAFT, false);
    expect(existsSync(join(far.path, ".ama", "workflows", "made.md"))).toBe(
      true,
    );
    expect(existsSync(join(f.directory, ".ama", "workflows", "made.md"))).toBe(
      false,
    );
    await expect(
      writeWorkflowFile(remote, "made", DRAFT, false),
    ).rejects.toMatchObject({ status: 409, code: "workflow_file_exists" });
    expect(calls).toEqual(
      expect.arrayContaining(["files.list", "files.read", "files.write"]),
    );
    expect(templateById(f.database, "none")).toBeUndefined();
  });

  it("没装配远端调用时是 501，不回退本机", async () => {
    const remote = createRemoteWorkspace(f.database, {
      name: "far2",
      executionHostId: "far",
      rootPath: far.path,
    });
    setRemoteCaller(undefined);
    await expect(listWorkflowFiles(remote, f.database)).rejects.toMatchObject({
      status: 501,
    });
  });
});
