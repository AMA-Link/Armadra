import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const access = vi.hoisted(() => ({ member: false, remote: false }));
const settings = vi.hoisted(() => ({
  data: { agents: { defaultDriver: "acp" } } as Record<string, unknown>,
}));
const save = vi.hoisted(() => ({ mutate: vi.fn() }));
const runtimeSettings = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../../app/use-access", () => ({
  useAccess: () => ({ member: access.member }),
}));
vi.mock("../remote-access", () => ({
  useRemoteAccess: () => ({ remote: access.remote }),
}));
vi.mock("./remote-access/keys", () => ({
  useLocalName: () => "家里的 Mac mini",
}));
vi.mock("../../../sources/context", () => ({
  useCurrentSource: () => ({ descriptor: { label: "家里的 Mac mini" } }),
}));
vi.mock("../../../app/use-agents", () => ({
  useAgentsQuery: () => ({
    data: [
      { id: "claude", label: "Claude Code" },
      { id: "codex", label: "Codex" },
    ],
  }),
}));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => {
    runtimeSettings.calls += 1;
    return { settings, save };
  },
}));

import { installDomPolyfills, optionLabels } from "../../../app/test-harness";
import { usePreferencesStore } from "../../../app/preferences-store";
import { translate } from "../../../i18n";
import { DefaultsPage } from "./DefaultsPage";
import { TooltipProvider } from "@/ui/tooltip";

installDomPolyfills();
const zh = (key: string, values?: Record<string, string>) =>
  translate("zh-CN", key, values);

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  access.member = false;
  access.remote = false;
  runtimeSettings.calls = 0;
});
afterEach(cleanup);

describe("设置 → 默认（§2.2 映射）", () => {
  it("首行是 Agent 默认视图（主机项，行尾徽标），其后默认 Agent、权限、简洁模式、主题、语言", () => {
    render(
      <TooltipProvider>
        <DefaultsPage />
      </TooltipProvider>,
    );
    const rows = screen
      .getAllByRole("combobox")
      .map((element) => element.getAttribute("aria-label"));
    expect(rows).toEqual([
      zh("acp.settings.defaultDriver"),
      zh("settings.defaultAgent"),
      zh("settings.defaultPermission"),
      zh("settings.theme"),
      zh("settings.locale"),
    ]);
    expect(
      screen.getByRole("switch", { name: zh("acp.settings.simpleMode") }),
    ).toBeTruthy();
    // 本机改本机：作用范围不言自明，不画徽标。
    expect(document.querySelectorAll("[data-settings-scope]")).toHaveLength(0);
  });

  it("页面的本机在别处（手机、经 Gateway 的网页）：徽标写主机与它的名字", () => {
    access.remote = true;
    render(
      <TooltipProvider>
        <DefaultsPage />
      </TooltipProvider>,
    );
    expect(document.querySelector("[data-settings-scope]")?.textContent).toBe(
      zh("settings.scope.hostNamed", { name: "家里的 Mac mini" }),
    );
  });

  it("成员不画主机那一行，也不去读设置文档", () => {
    access.member = true;
    render(
      <TooltipProvider>
        <DefaultsPage />
      </TooltipProvider>,
    );
    expect(
      screen.queryByRole("combobox", {
        name: zh("acp.settings.defaultDriver"),
      }),
    ).toBeNull();
    expect(runtimeSettings.calls).toBe(0);
    expect(
      screen.getByRole("combobox", { name: zh("settings.defaultAgent") }),
    ).toBeTruthy();
  });

  it("默认视图两档：会话视图在前", async () => {
    render(
      <TooltipProvider>
        <DefaultsPage />
      </TooltipProvider>,
    );
    const labels = await optionLabels(
      screen.getByRole("combobox", { name: zh("acp.settings.defaultDriver") }),
    );
    expect(labels).toEqual([zh("acp.view.session"), zh("acp.view.terminal")]);
  });
});

describe("设置 → 默认：背景色板（#474）", () => {
  it("五格按顺序排开，当前那格按下；点一格就换", () => {
    usePreferencesStore.setState({ backdrop: "plain" });
    render(
      <TooltipProvider>
        <DefaultsPage />
      </TooltipProvider>,
    );
    const group = screen.getByRole("radiogroup", {
      name: zh("settings.backdrop"),
    });
    const items = Array.from(group.querySelectorAll("button"));
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(
      ["plain", "petal", "mist", "meadow", "dusk"].map((id) =>
        zh(`settings.backdrop.${id}`),
      ),
    );
    expect(items[0]!.getAttribute("data-state")).toBe("on");
    fireEvent.click(
      screen.getByRole("radio", { name: zh("settings.backdrop.meadow") }),
    );
    expect(usePreferencesStore.getState().backdrop).toBe("meadow");
  });

  it("网页里没有半透明窗口开关", () => {
    render(
      <TooltipProvider>
        <DefaultsPage />
      </TooltipProvider>,
    );
    expect(
      screen.queryByRole("switch", { name: zh("settings.translucentWindow") }),
    ).toBeNull();
  });
});
