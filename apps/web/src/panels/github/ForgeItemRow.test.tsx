import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { usePreferencesStore } from "../../app/preferences-store";
import { ForgeItemRow } from "./ForgeItemRow";

const item = {
  number: 5,
  title: "feat: search",
  state: "open" as const,
  author: "alice",
  updatedAtMs: 1_788_557_900_000,
};

afterEach(cleanup);

describe("条目行的右侧列", () => {
  it("PR：CI 通过数/总数、审查圆点、评论数", () => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    const { container } = render(
      <ForgeItemRow
        kind="pull"
        locale="zh-CN"
        item={{
          ...item,
          checks: { rollup: "failure", passed: 5, total: 7 },
          reviewDecision: "changesRequested",
          commentCount: 3,
        }}
      />,
    );
    const ci = container.querySelector("[data-slot=forge-row-ci]");
    expect(ci?.textContent).toBe("5/7");
    expect(ci?.getAttribute("data-rollup")).toBe("failure");
    expect(
      container
        .querySelector("[data-slot=forge-row-review]")
        ?.getAttribute("data-decision"),
    ).toBe("changesRequested");
    expect(
      container.querySelector("[data-slot=forge-row-comments]")?.textContent,
    ).toBe("3");
  });

  it("旧 core 不给这些字段：CI 与评论列不画，审查圆点只占位", () => {
    const { container } = render(
      <ForgeItemRow kind="pull" locale="zh-CN" item={item} />,
    );
    expect(container.querySelector("[data-slot=forge-row-ci]")).toBeNull();
    expect(
      container.querySelector("[data-slot=forge-row-comments]"),
    ).toBeNull();
    expect(
      container
        .querySelector("[data-slot=forge-row-review]")
        ?.getAttribute("data-decision"),
    ).toBe("none");
  });

  it("issue 没有 CI 与审查列；关掉 columns 一列都没有", () => {
    const issue = render(
      <ForgeItemRow
        kind="issue"
        locale="zh-CN"
        item={{ ...item, commentCount: 2 }}
      />,
    );
    expect(
      issue.container.querySelector("[data-slot=forge-row-review]"),
    ).toBeNull();
    expect(
      issue.container.querySelector("[data-slot=forge-row-comments]")
        ?.textContent,
    ).toBe("2");
    cleanup();
    const bare = render(
      <ForgeItemRow
        kind="issue"
        locale="zh-CN"
        columns={false}
        item={{ ...item, commentCount: 2 }}
      />,
    );
    expect(
      bare.container.querySelector("[data-slot=forge-row-comments]"),
    ).toBeNull();
  });
});
