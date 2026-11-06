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
import type { IntakeCandidate } from "./api";
import { nodeOfItem, outcomeOf, pageCount } from "./model";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/ui/toast", async (original) => ({
  ...(await original<typeof import("@/ui/toast")>()),
  toast: Object.assign(vi.fn(), toasts),
}));

const api = vi.hoisted(() => ({ intake: vi.fn(), reviewIntake: vi.fn() }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  coordinatorApi: api,
}));

const { IntakeTab } = await import("./IntakeTab");

/** 分派抽屉的「候选」页（契约 §104.7）。 */

function candidate(
  number: number,
  patch: Partial<IntakeCandidate> = {},
): IntakeCandidate {
  return {
    id: `intake:github.com/acme/app#${number}:issue:x`,
    sourceId: "s1",
    kind: "issue",
    repo: "github.com/acme/app",
    number,
    title: `标题 ${number}`,
    author: "alice",
    url: `https://github.com/acme/app/issues/${number}`,
    authorized: true,
    seenAt: "2026-11-06T08:00:00.000Z",
    verdict: null,
    reason: null,
    verdictAt: null,
    modeAtVerdict: null,
    review: null,
    itemId: null,
    outcome: null,
    ...patch,
  };
}

beforeAll(() => installDomPolyfills());
beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  api.intake.mockReset();
  api.reviewIntake.mockReset();
  toasts.error.mockReset();
});
afterEach(() => cleanup());

function mount(props: Partial<React.ComponentProps<typeof IntakeTab>> = {}) {
  const onOpenNode = vi.fn();
  render(
    <TestProviders>
      <IntakeTab
        boardId="b1"
        offline={false}
        canEdit
        active
        nodeOf={(id) => (id === "sess:pi" ? "node-pi" : undefined)}
        onOpenNode={onOpenNode}
        {...props}
      />
    </TestProviders>,
  );
  return { onOpenNode };
}

const page = (candidates: IntakeCandidate[], total = candidates.length) => ({
  candidates,
  total,
  next: null,
});

describe("model", () => {
  it("outcomeOf, pageCount and nodeOfItem", () => {
    expect(outcomeOf("dispatched")).toEqual({ kind: "dispatched" });
    expect(outcomeOf("refused:rules_changed")).toEqual({
      kind: "refused",
      code: "rules_changed",
    });
    expect(outcomeOf(null)).toBeNull();
    expect(pageCount(0)).toBe(1);
    expect(pageCount(21)).toBe(2);
    expect(nodeOfItem([{ taskId: "t", nodeId: "n" } as never], "t")).toBe("n");
    expect(nodeOfItem([], null)).toBeUndefined();
  });
});

describe("IntakeTab", () => {
  it("asks for the undecided page first and shows link, title, author and authorization", async () => {
    api.intake.mockResolvedValue(page([candidate(7)]));
    mount();
    await screen.findByText("标题 7");
    expect(api.intake).toHaveBeenCalledWith("b1", {
      decided: false,
      offset: 0,
    });
    const link = screen.getByRole("link", { name: "打开 #7" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/app/issues/7",
    );
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    expect(screen.getByText("已授权")).toBeTruthy();
    expect(
      document
        .querySelector('[data-slot="candidate-verdict"]')
        ?.getAttribute("data-verdict"),
    ).toBe("none");
  });

  it("only web addresses become links", async () => {
    api.intake.mockResolvedValue(page([candidate(1, { url: "javascript:x" })]));
    mount();
    await screen.findByText("标题 1");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("an older core reads as an empty page", async () => {
    api.intake.mockResolvedValue(page([]));
    mount();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="intake-empty"]')).toBeTruthy(),
    );
  });

  it("switches to the decided page and resets to the first page", async () => {
    api.intake.mockResolvedValue(page([candidate(1)], 45));
    mount();
    await screen.findByText("标题 1");
    fireEvent.click(screen.getByLabelText("第 2 页"));
    await waitFor(() =>
      expect(api.intake).toHaveBeenLastCalledWith("b1", {
        decided: false,
        offset: 20,
      }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "已判定" }));
    await waitFor(() =>
      expect(api.intake).toHaveBeenLastCalledWith("b1", {
        decided: true,
        offset: 0,
      }),
    );
  });

  it("reviews a decided candidate, and clears it by pressing the pressed one", async () => {
    const decided = candidate(3, {
      verdict: "accept",
      reason: "是 bug",
      modeAtVerdict: "observe",
    });
    api.intake.mockResolvedValue(page([decided]));
    api.reviewIntake.mockResolvedValue(decided);
    mount();
    await screen.findByText("标题 3");
    fireEvent.click(screen.getByRole("radio", { name: "不同意" }));
    await waitFor(() =>
      expect(api.reviewIntake).toHaveBeenCalledWith(decided.id, "disagree"),
    );
  });

  it("clears a pressed review", async () => {
    const decided = candidate(3, { verdict: "skip", review: "agree" });
    api.intake.mockResolvedValue(page([decided]));
    api.reviewIntake.mockResolvedValue(decided);
    mount();
    await screen.findByText("标题 3");
    fireEvent.click(screen.getByRole("radio", { name: "同意" }));
    await waitFor(() =>
      expect(api.reviewIntake).toHaveBeenCalledWith(decided.id, null),
    );
  });

  it("an undecided candidate cannot be reviewed, nor can a read-only visitor", async () => {
    api.intake.mockResolvedValue(
      page([candidate(1), candidate(2, { verdict: "accept" })]),
    );
    mount({ canEdit: false });
    await screen.findByText("标题 1");
    const groups = document.querySelectorAll('[data-slot="candidate-review"]');
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      for (const radio of within(group as HTMLElement).getAllByRole("radio")) {
        expect((radio as HTMLButtonElement).disabled).toBe(true);
      }
    }
  });

  it("a dispatched candidate jumps to the member node; a refused one shows its code", async () => {
    api.intake.mockResolvedValue(
      page([
        candidate(1, { outcome: "dispatched", itemId: "sess:pi" }),
        candidate(2, { outcome: "refused:rules_changed" }),
      ]),
    );
    const { onOpenNode } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "已派发" }));
    expect(onOpenNode).toHaveBeenCalledWith("node-pi");
    expect(screen.getByText("规则已变更")).toBeTruthy();
    expect(screen.queryByText("rules_changed")).toBeNull();
  });

  it("result reasons follow the UI language; an unknown code shows the code", async () => {
    usePreferencesStore.setState({ locale: "en" });
    api.intake.mockResolvedValue(
      page([
        candidate(1, { outcome: "refused:forge_not_wired" }),
        candidate(2, { outcome: "refused:not_authorized" }),
        candidate(3, { outcome: "refused:intake_rate_limited" }),
        candidate(4, { outcome: "refused:brand_new_code" }),
      ]),
    );
    mount();
    expect(await screen.findByText("Forge not connected")).toBeTruthy();
    expect(
      screen.getByText("Not authorized", { selector: "[data-code]" }),
    ).toBeTruthy();
    expect(screen.getByText("Rate limited")).toBeTruthy();
    expect(screen.getByText("brand_new_code")).toBeTruthy();
  });

  it("a failed read shows its own copy and no rows; a failed review toasts a localized message", async () => {
    api.intake.mockRejectedValue(new Error("down"));
    mount();
    expect(await screen.findByText("读不到候选")).toBeTruthy();
    expect(screen.queryByText("读不到分派记录")).toBeNull();
    expect(document.querySelector('[data-slot="candidate-row"]')).toBeNull();
  });

  it("a review refused with a core code toasts the localized message", async () => {
    api.intake.mockResolvedValue(
      page([candidate(1, { verdict: "accept", reason: "r" })]),
    );
    api.reviewIntake.mockRejectedValue(
      Object.assign(new Error("x"), {
        code: "candidate_not_found",
        coreMessage: "候选不存在了",
      }),
    );
    mount();
    fireEvent.click(await screen.findByRole("radio", { name: "同意" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("候选不存在"),
    );
  });

  it("rows are cards that fit the drawer, not a table", async () => {
    api.intake.mockResolvedValue(page([candidate(1)]));
    mount();
    await screen.findByText("标题 1");
    expect(document.querySelector("table")).toBeNull();
  });

  it("does not fetch while the tab is not active", () => {
    mount({ active: false });
    expect(api.intake).not.toHaveBeenCalled();
  });
});
