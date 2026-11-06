import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import type { IntakeSource } from "./api";
import { parseAllow, rulesState } from "./model";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/ui/toast", async (original) => ({
  ...(await original<typeof import("@/ui/toast")>()),
  toast: Object.assign(vi.fn(), toasts),
}));

const api = vi.hoisted(() => ({
  sources: vi.fn(),
  saveSource: vi.fn(),
  deleteSource: vi.fn(),
}));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  coordinatorApi: api,
}));

const { SourcesTab, SourcesView } = await import("./SourcesTab");

/** 分派抽屉的「来源」页（契约 §104.7）。 */

const LEAD = "node-lead";
const COORDINATORS = [{ nodeId: LEAD, title: "ama" }];

function source(patch: Partial<IntakeSource> = {}): IntakeSource {
  return {
    id: "s1",
    coordinatorNodeId: LEAD,
    repo: "github.com/acme/app",
    kinds: ["issue"],
    mode: "observe",
    allow: ["alice"],
    enabled: true,
    rulesHash: "aaaa",
    rulesCurrentHash: "aaaa",
    rulesPresent: true,
    stats: { decided: 20, accepted: 18, agreed: 17, disagreed: 2, window: 20 },
    ...patch,
  };
}

beforeAll(() => installDomPolyfills());
beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  for (const fn of Object.values(api)) fn.mockReset();
  toasts.error.mockReset();
});
afterEach(() => cleanup());

function mount(canEdit = true, offline = false) {
  return render(
    <TestProviders>
      <SourcesTab
        boardId="b1"
        coordinators={COORDINATORS}
        defaultCoordinator={LEAD}
        offline={offline}
        canEdit={canEdit}
        active
      />
    </TestProviders>,
  );
}

describe("model", () => {
  it("rulesState reads the four states", () => {
    expect(rulesState(source())).toBe("confirmed");
    expect(rulesState(source({ rulesCurrentHash: "bbbb" }))).toBe("changed");
    expect(rulesState(source({ rulesHash: "" }))).toBe("unconfirmed");
    expect(rulesState(source({ rulesPresent: false }))).toBe("missing");
  });

  it("parseAllow splits on commas and spaces, drops @ and duplicates", () => {
    expect(parseAllow("@Alice, bob  alice，carol,")).toEqual([
      "Alice",
      "bob",
      "alice",
      "carol",
    ]);
  });
});

describe("SourcesView", () => {
  it("shows the row: repo, kinds, mode, allow list, rules state and the three numbers", async () => {
    api.sources.mockResolvedValue([source()]);
    mount();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="source-row"]')).toBeTruthy(),
    );
    const row = document.querySelector(
      '[data-slot="source-row"]',
    ) as HTMLElement;
    expect(within(row).getByText("github.com/acme/app")).toBeTruthy();
    expect(within(row).getByText("Issue")).toBeTruthy();
    expect(
      (within(row).getByLabelText("允许名单") as HTMLInputElement).value,
    ).toBe("alice");
    expect(
      row
        .querySelector('[data-slot="source-rules"]')
        ?.getAttribute("data-state"),
    ).toBe("confirmed");
    expect(row.querySelector('[data-slot="source-stats"]')?.textContent).toBe(
      "20 · 17 · 2",
    );
    // 已确认时没有「确认」按钮。
    expect(row.querySelector('[data-slot="source-confirm"]')).toBeNull();
  });

  it("an older core without the procedures reads as an empty page", async () => {
    api.sources.mockResolvedValue([]);
    mount();
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="sources-empty"]'),
      ).toBeTruthy(),
    );
    expect(document.querySelector('[data-slot="sources-error"]')).toBeNull();
  });

  it("commits the allow list on blur, only when it changed", async () => {
    api.sources.mockResolvedValue([source()]);
    api.saveSource.mockResolvedValue(source());
    mount();
    const input = (await screen.findByLabelText(
      "允许名单",
    )) as HTMLInputElement;
    fireEvent.blur(input);
    expect(api.saveSource).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "@Alice, bob" } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.saveSource).toHaveBeenCalledTimes(1));
    expect(api.saveSource).toHaveBeenCalledWith({
      id: "s1",
      coordinatorNodeId: LEAD,
      repo: "github.com/acme/app",
      kinds: ["issue"],
      mode: "observe",
      allow: ["Alice", "bob"],
      enabled: true,
    });
  });

  it("confirms the rules for a changed file and toggles enabled", async () => {
    api.sources.mockResolvedValue([source({ rulesCurrentHash: "bbbb" })]);
    api.saveSource.mockResolvedValue(source());
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(api.saveSource).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1", confirmRules: true }),
      ),
    );
    fireEvent.click(screen.getByRole("switch", { name: "启用" }));
    await waitFor(() =>
      expect(api.saveSource).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      ),
    );
  });

  it("a refused switch to auto toasts core's message and keeps observe", async () => {
    api.sources.mockResolvedValue([source()]);
    api.saveSource.mockRejectedValue(
      Object.assign(new Error("x"), {
        coreMessage: "切到 auto 需要先确认规则文件",
      }),
    );
    mount();
    const trigger = await screen.findByRole("combobox", { name: "模式" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "自动" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("切到 auto 需要先确认规则文件"),
    );
    await waitFor(() => expect(api.sources).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("combobox", { name: "模式" }).textContent,
    ).toContain("观察");
  });

  it("adds a source with the default coordinator and kinds", async () => {
    api.sources.mockResolvedValue([]);
    api.saveSource.mockResolvedValue(source());
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "添加" }));
    fireEvent.change(screen.getByLabelText("仓库"), {
      target: { value: " https://github.com/acme/app " },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "PR" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.saveSource).toHaveBeenCalledWith({
        coordinatorNodeId: LEAD,
        repo: "https://github.com/acme/app",
        kinds: ["issue", "pull"],
        mode: "observe",
        allow: [],
        enabled: true,
      }),
    );
  });

  it("deletes after confirming", async () => {
    api.sources.mockResolvedValue([source()]);
    api.deleteSource.mockResolvedValue(true);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect(api.deleteSource).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.deleteSource).toHaveBeenCalledWith("s1"));
  });

  it("read-only visitors see the row but cannot change or add anything", async () => {
    api.sources.mockResolvedValue([source({ rulesCurrentHash: "bbbb" })]);
    mount(false);
    const input = (await screen.findByLabelText(
      "允许名单",
    )) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(
      (screen.getByRole("switch", { name: "启用" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("combobox", { name: "模式" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.queryByRole("button", { name: "添加" })).toBeNull();
  });

  it("offline disables the controls", () => {
    render(
      <TestProviders>
        <SourcesView sources={[source()]} coordinators={COORDINATORS} offline />
      </TestProviders>,
    );
    expect(
      (screen.getByRole("switch", { name: "启用" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "添加" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
