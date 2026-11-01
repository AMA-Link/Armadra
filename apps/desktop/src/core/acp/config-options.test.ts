import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceEvent } from "../bus";
import { tempDir } from "../testing/temp-dir";
import { type TimelineDomain, install as installTimeline } from "../timeline";
import { type AcpCore, acpCore, until } from "./fixture";
import { AcpFeed } from "./feed";
import { startAcp } from "./host";
import { AcpMirror, mirrorPath } from "./mirror";
import type { AcpSignal } from "./normalize";
import { AcpSession, type AcpSessionSink } from "./session";
import {
  configValueProblem,
  configViewOf,
  modeStateOfConfig,
  withConfigValue,
} from "./models";

/**
 * 配置项、斜杠命令提示与回合用量（AMA-Link/Armadra#687：P2-4、P3-2、P3-8）。
 * 假 Agent 是真子进程：`--config-options` 给模型项，`--config-only` 把模式也放进
 * 配置项（没有 `modes`）。
 */

const NODE = "11111111-2222-4333-8444-555555555555";
const sessions: AcpSession[] = [];
const dirs: string[] = [];
let core: AcpCore | undefined;
let timeline: TimelineDomain | undefined;

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.terminate()));
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  await core?.stop();
  core = undefined;
  timeline = undefined;
});

interface Recorder extends AcpSessionSink {
  readonly events: WorkspaceEvent[];
}

function recorder(): Recorder {
  const events: WorkspaceEvent[] = [];
  return {
    events,
    signal: (_signal: AcpSignal) => undefined,
    publish: (event) => events.push(event),
    cancelled: () => undefined,
    transcriptPath: (_id, mirror) => mirror,
  };
}

async function open(flags: string[]) {
  core = await acpCore();
  timeline = installTimeline(core.core) as TimelineDomain;
  const dataDir = tempDir("armadra-acp-config-");
  dirs.push(dataDir);
  const sink = recorder();
  const session = new AcpSession({
    rowId: "row-1",
    generation: 1,
    nodeId: NODE,
    workspaceId: core.workspaceId,
    agentId: "claude",
    sink,
    mirrorFor: (id) => new AcpMirror(mirrorPath(dataDir, NODE, id)),
    feed: new AcpFeed(timeline, {
      rowId: "row-1",
      nodeId: NODE,
      workspaceId: core.workspaceId,
      generation: 1,
    }),
  });
  const host = await startAcp({
    program: process.execPath,
    args: [fakeAcpAgentPath(), ...flags],
    cwd: tmpdir(),
    ...session.callbacks(),
  });
  session.opened(host);
  sessions.push(session);
  const callbacks = session.callbacks();
  const update = (body: Record<string, unknown>) =>
    callbacks.onUpdate(
      { sessionId: session.acpSessionId!, update: body } as never,
      { replay: false } as never,
    );
  return { session, host, sink, update };
}

const head = () => {
  timeline!.writer.flush();
  return timeline!.store.snapshot("row-1", 5)?.head;
};

describe("configViewOf", () => {
  it("keeps select and boolean options, flattens groups, drops what it cannot show", () => {
    const view = configViewOf([
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { group: "g", name: "G", options: [{ value: "low", name: "Low" }] },
          { value: "high", name: "High", description: "slow" },
          { value: "high", name: "dup" },
        ],
      },
      { id: "think", name: "Think", type: "boolean", currentValue: true },
      { id: "x", name: "X", type: "number", currentValue: 1 },
      {
        id: "empty",
        name: "E",
        type: "select",
        currentValue: "a",
        options: [],
      },
      { name: "no id" },
    ]);
    expect(view).toEqual([
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High", description: "slow" },
        ],
      },
      {
        id: "think",
        name: "Think",
        type: "boolean",
        currentValue: true,
        options: [],
      },
    ]);
    expect(configViewOf("nope")).toEqual([]);
  });

  it("finds the mode option, patches one value and checks a requested change", () => {
    const view = configViewOf([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "plan",
        options: [
          { value: "plan", name: "Plan" },
          { value: "code", name: "Code" },
        ],
      },
      { id: "think", name: "Think", type: "boolean", currentValue: false },
    ]);
    expect(modeStateOfConfig(view)).toEqual({
      configId: "mode",
      state: {
        currentModeId: "plan",
        availableModes: [
          { id: "plan", name: "Plan" },
          { id: "code", name: "Code" },
        ],
      },
    });
    expect(withConfigValue(view, "think", true)[1]?.currentValue).toBe(true);
    expect(configValueProblem(view, "mode", "code")).toBeNull();
    expect(configValueProblem(view, "mode", "nope")).toMatch(/no value/);
    expect(configValueProblem(view, "mode", true)).toMatch(/no value/);
    expect(configValueProblem(view, "think", "yes")).toMatch(/true or false/);
    expect(configValueProblem(view, "think", true)).toBeNull();
    expect(configValueProblem(view, "missing", "x")).toMatch(
      /no config option/,
    );
  });
});

describe("config options (P2-4)", () => {
  it("publishes the full list in the timeline head and sets any option", async () => {
    const { session, host } = await open(["--config-options", "--config-only"]);
    expect(host.configOptions?.map((o) => o.id)).toEqual(["mode", "model"]);
    expect(head()?.configOptions?.map((o) => o.id)).toEqual(["mode", "model"]);
    await session.setConfigOption("model", "large");
    expect(session.models?.currentModelId).toBe("large");
    expect(
      head()?.configOptions?.find((o) => o.id === "model")?.currentValue,
    ).toBe("large");
    expect(head()?.models?.currentModelId).toBe("large");
  });

  it("refuses an option, value or type the agent did not offer", async () => {
    const { session } = await open(["--config-options"]);
    await expect(session.setConfigOption("nope", "x")).rejects.toMatchObject({
      code: "acp_config_unavailable",
    });
    await expect(
      session.setConfigOption("model", "huge"),
    ).rejects.toMatchObject({ code: "acp_config_unavailable" });
    await expect(session.setConfigOption("model", true)).rejects.toMatchObject({
      code: "acp_config_unavailable",
    });
  });

  it("drives the mode picker from a category-mode option when there is no modes list", async () => {
    const { session, host } = await open(["--config-only"]);
    expect(host.modeConfigId).toBe("mode");
    expect(session.modes?.availableModes.map((m) => m.id)).toContain("plan");
    expect(head()?.modes?.currentModeId).toBe(session.modes?.currentModeId);
    await session.setMode("plan");
    expect(session.modes?.currentModeId).toBe("plan");
    expect(head()?.modes?.currentModeId).toBe("plan");
    expect(
      head()?.configOptions?.find((o) => o.id === "mode")?.currentValue,
    ).toBe("plan");
  });

  it("follows config_option_update wholesale, mode and model included", async () => {
    const { session, update } = await open([
      "--config-options",
      "--config-only",
    ]);
    const before = head()?.configOptions ?? [];
    const next = before.map((o) =>
      o.id === "mode" ? { ...o, currentValue: "plan" } : o,
    );
    update({
      sessionUpdate: "config_option_update",
      configOptions: [
        ...next,
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    });
    expect(head()?.configOptions?.map((o) => o.id)).toEqual([
      "mode",
      "model",
      "effort",
    ]);
    expect(head()?.modes?.currentModeId).toBe("plan");
    expect(session.modes?.currentModeId).toBe("plan");
    // 新出现的项马上就能改（core 的列表同步换上了）。
    await expect(
      session.setConfigOption("effort", "high"),
    ).rejects.not.toMatchObject({ code: "acp_config_unavailable" });
  });

  it("publishes nothing without a config list", async () => {
    const { session } = await open([]);
    expect(head()?.configOptions ?? null).toBeNull();
    await expect(session.setConfigOption("model", "x")).rejects.toMatchObject({
      code: "acp_config_unavailable",
    });
  });
});

describe("slash command hint (P3-2)", () => {
  it("keeps input.hint in the head and in the snapshot", async () => {
    const { session, update } = await open([]);
    update({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        {
          name: "web",
          description: "search",
          input: { hint: "query to search" },
        },
        { name: "compact", description: "shrink" },
      ],
    });
    expect(head()?.commands).toEqual([
      { name: "web", description: "search", hint: "query to search" },
      { name: "compact", description: "shrink" },
    ]);
    expect(session.snapshot().availableCommands).toEqual([
      { name: "web", description: "search", hint: "query to search" },
      { name: "compact", description: "shrink" },
    ]);
  });
});

describe("prompt response usage (P3-8)", () => {
  it("fills the head usage when no usage_update arrived and the window size is known", async () => {
    const { session, sink } = await open([]);
    const done = (n: number) =>
      until(
        () => sink.events.filter((e) => e.type === "acp.turn").length,
        (count) => count === n,
      );
    session.prompt("hi");
    await done(1);
    expect(head()?.usage).toMatchObject({ used: 15, size: 1000 });
    // 拒绝的回合没有 usage_update，只有响应里的 usage（第二回合 25 个）。
    session.prompt("[refuse]");
    await done(2);
    expect(head()?.usage).toMatchObject({ used: 25, size: 1000 });
    expect(session.snapshot().usage).toMatchObject({ used: 25, size: 1000 });
  });

  it("does nothing when the window size is unknown", async () => {
    const { session, sink } = await open([]);
    session.prompt("[refuse]");
    await until(
      () => sink.events.filter((e) => e.type === "acp.turn").length,
      (count) => count === 1,
    );
    expect(head()?.usage ?? null).toBeNull();
    expect(session.snapshot().usage).toBeNull();
  });
});
