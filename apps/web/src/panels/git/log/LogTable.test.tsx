import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GitLogCommit } from "@armadra/shared";

import { installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { LogTable } from "./LogTable";

installDomPolyfills();

/**
 * jsdom 不排版，`offsetHeight` 恒为 0，虚拟列表于是量不出可视高度。给一个固定
 * 高度，行数才是「窗口能装下的那些」而不是全部——这正是要测的东西。
 */
const VIEWPORT = 240;

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.slot === "git-log-rows"
        ? VIEWPORT
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  // virtual-core 3.19 起量的是 clientHeight / clientWidth（content-box）。
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.slot === "git-log-rows"
        ? VIEWPORT
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 800,
  });
});
afterEach(cleanup);

const oid = (index: number) => index.toString(16).padStart(40, "0");

const commit = (index: number, repositoryPath = "."): GitLogCommit => ({
  repositoryPath,
  oid: oid(index),
  parents: index > 0 ? [oid(index - 1)] : [],
  subject: `commit ${index}`,
  authorName: "Ada",
  authorEmail: "ada@example.invalid",
  authorTime: "2026-09-01T00:00:00Z",
  committerTime: "2026-09-01T00:00:00Z",
  refs: [],
});

function table(overrides: Partial<Parameters<typeof LogTable>[0]> = {}) {
  const props = {
    commits: [commit(2), commit(1), commit(0)],
    colors: new Map([[".", 0]]),
    selected: null,
    onSelect: () => undefined,
    uncommitted: [],
    compact: false,
    showHash: true,
    myEmail: null,
    hasMore: false,
    loading: false,
    onLoadMore: () => undefined,
    ...overrides,
  } as Parameters<typeof LogTable>[0];
  return render(<LogTable {...props} />);
}

describe("提交图表格", () => {
  it("画出四列表头，hash 列可以关掉", () => {
    const view = table();
    expect(screen.getByText("Message")).toBeTruthy();
    expect(screen.getByText("Author")).toBeTruthy();
    expect(screen.getByText("Date")).toBeTruthy();
    expect(screen.getByText("Hash")).toBeTruthy();
    view.unmount();
    table({ showHash: false });
    expect(screen.queryByText("Hash")).toBeNull();
  });

  it("每个提交一行，图上一个点", () => {
    const { container } = table();
    expect(container.querySelectorAll("[data-commit]").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("commit 2")).toBeTruthy();
  });

  it("只渲染看得见的那些行，而不是全部", () => {
    const commits = Array.from({ length: 500 }, (_, index) =>
      commit(500 - index),
    );
    const { container } = table({ commits });
    const rows = container.querySelectorAll("[data-index]");
    expect(rows.length).toBeGreaterThan(0);
    // 240px / 24px = 10 行，加上 overscan 也远少于 500。
    expect(rows.length).toBeLessThan(60);
  });

  it("HEAD 脏的时候最上面多一条虚线的「未提交的变更」", () => {
    const { container } = table({ uncommitted: ["."] });
    expect(screen.getByText("Uncommitted changes")).toBeTruthy();
    expect(
      container.querySelector('[data-slot="git-log-uncommitted"]'),
    ).not.toBeNull();
  });

  it("多仓库才画左侧颜色条", () => {
    const single = table();
    expect(
      single.container.querySelector('[data-slot="git-log-repository-color"]'),
    ).toBeNull();
    single.unmount();
    const many = table({
      commits: [commit(2), commit(1, "packages/foo")],
      colors: new Map([
        [".", 0],
        ["packages/foo", 1],
      ]),
    });
    expect(
      many.container.querySelector('[data-slot="git-log-repository-color"]'),
    ).not.toBeNull();
  });

  it("最后一行进入视野就续页", () => {
    const onLoadMore = vi.fn();
    table({ hasMore: true, onLoadMore });
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("已经在读的时候不再重复要下一页", () => {
    const onLoadMore = vi.fn();
    table({ hasMore: true, loading: true, onLoadMore });
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  describe("按合并折叠（#927 B1）", () => {
    // 主线：merge(3) → 0；merge 的第二父是分支提交 2 → 1 → 0。
    const merged = () => {
      const merge: GitLogCommit = {
        ...commit(3),
        parents: [oid(0), oid(2)],
        subject: "Merge pull request #919 from AMA-Link/chore/minimatch-11",
      };
      const side2: GitLogCommit = { ...commit(2), parents: [oid(1)] };
      const side1: GitLogCommit = { ...commit(1), parents: [oid(0)] };
      return [merge, side2, side1, commit(0)];
    };

    it("合并只占一行，标题换成分支名与 PR 号，计数说明藏了几个", () => {
      const { container } = table({ commits: merged(), collapseMerges: true });
      expect(screen.getByText("chore/minimatch-11")).toBeTruthy();
      expect(screen.getByText("#919")).toBeTruthy();
      expect(screen.queryByText("commit 2")).toBeNull();
      const toggle = container.querySelector(
        '[data-slot="git-log-merge-toggle"]',
      )!;
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.textContent).toContain("2");
    });

    it("点计数交给回调，不选中这一行", () => {
      const onToggleMerge = vi.fn();
      const onSelect = vi.fn();
      const { container } = table({
        commits: merged(),
        collapseMerges: true,
        onToggleMerge,
        onSelect,
      });
      fireEvent.click(
        container.querySelector('[data-slot="git-log-merge-toggle"]')!,
      );
      expect(onToggleMerge).toHaveBeenCalledWith(`.:${oid(3)}`);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("展开后分支提交回到表里，文字降一级，图上不是主线", () => {
      const { container } = table({
        commits: merged(),
        collapseMerges: true,
        expanded: new Set([`.:${oid(3)}`]),
      });
      const side = screen.getByText("commit 2");
      expect(side.getAttribute("data-side")).toBe("true");
      expect(
        container
          .querySelector(`g[data-commit="${oid(2)}"]`)!
          .getAttribute("data-mainline"),
      ).toBe("false");
      expect(
        container
          .querySelector(`g[data-commit="${oid(3)}"]`)!
          .getAttribute("data-mainline"),
      ).toBe("true");
    });

    it("不开折叠时表格照旧，全部提交都在", () => {
      table({ commits: merged() });
      expect(screen.getByText("commit 2")).toBeTruthy();
      expect(screen.getByText(/Merge pull request/)).toBeTruthy();
    });
  });

  it("仓库 HEAD 那一行标出领先 / 落后上游（#927 B2）", () => {
    const head: GitLogCommit = {
      ...commit(2),
      refs: ["HEAD -> refs/heads/main"],
    };
    const { container } = table({
      commits: [head, commit(1), commit(0)],
      sync: new Map([[".", { ahead: 1, behind: 2 }]]),
    });
    const marks = container.querySelectorAll('[data-slot="git-log-sync"]');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe("↑1 ↓2");
  });
});
