import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../settings", () => ({
  settingsDomain: () => ({ settings: { get: () => settings.value } }),
}));

import {
  resetGrokVersionProbe,
  useGrokVerifiedVersions,
} from "../agent/grok-answer";
import type { CoreContext } from "../main";
import type { TerminalFacts } from "../timeline/sources";
import { linkTimeline } from "./timeline-link";
import type { TerminalManager } from "./manager";

/** 终端域给读取槽的 `answerCards`（契约 §127）：设置、进程的启动方式、版本。 */

let facts: TerminalFacts;
let probed: (string | undefined)[];

beforeEach(() => {
  probed = [];
  linkTimeline(
    { db: { database: {} } } as unknown as CoreContext,
    {} as TerminalManager,
    {
      setLiveness: () => undefined,
      sources: {
        setTerminalFacts: (given: TerminalFacts | undefined) => {
          facts = given as TerminalFacts;
        },
      },
    } as never,
  );
  useGrokVerifiedVersions(["1.0.92"]);
});
afterEach(() => {
  settings.value = undefined;
  useGrokVerifiedVersions(undefined);
  resetGrokVersionProbe();
});

const ask = (mode: string | undefined) =>
  facts.answerCards!("session", "node", { mode, exe: "/opt/grok/bin/grok" });

describe("linkTimeline 的 answerCards", () => {
  it("设置关着（缺省）：{ open: false, reason: setting_off }，不探版本", async () => {
    settings.value = undefined;
    resetGrokVersionProbe("1.0.92");
    expect(await ask("auto-edit")).toEqual({
      open: false,
      reason: "setting_off",
    });
    settings.value = false;
    expect(await ask("plan")).toEqual({ open: false, reason: "setting_off" });
  });

  it("设置开着但进程不是 --permission-mode 起的：mode_excluded", async () => {
    settings.value = true;
    expect(await ask(undefined)).toEqual({
      open: false,
      reason: "mode_excluded",
    });
    expect(await ask("default")).toEqual({
      open: false,
      reason: "mode_excluded",
    });
  });

  it("三样都过：版本在清单里才开，不在清单里是 unverified_version", async () => {
    settings.value = true;
    resetGrokVersionProbe("1.0.92");
    expect(await ask("auto-edit")).toEqual({ open: true });
    useGrokVerifiedVersions(["1.0.93"]);
    expect(await ask("auto-edit")).toEqual({
      open: false,
      reason: "unverified_version",
    });
    expect(probed).toEqual([]);
  });
});
