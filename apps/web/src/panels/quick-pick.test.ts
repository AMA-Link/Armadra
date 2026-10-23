import { afterEach, describe, expect, it, vi } from "vitest";

import { quickPickKeyDown, quickPickNumber, runQuickPick } from "./quick-pick";

function key(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", init);
}

afterEach(() => {
  document.body.innerHTML = "";
});

/** 一个 cmdk 根：输入框 + 若干行，第 3 行禁用。 */
function palette(rows = 6) {
  document.body.innerHTML = `
    <div cmdk-root>
      <input data-testid="input" />
      <div cmdk-list>
        ${Array.from(
          { length: rows },
          (_, i) =>
            `<div cmdk-item aria-disabled="${i === 2}" data-i="${i + 1}"></div>`,
        ).join("")}
      </div>
    </div>`;
  const input = document.querySelector("input") as HTMLInputElement;
  const clicks: string[] = [];
  document.querySelectorAll<HTMLElement>("[cmdk-item]").forEach((row) => {
    row.addEventListener("click", () => clicks.push(row.dataset.i as string));
  });
  return { input, clicks };
}

describe("quickPickNumber", () => {
  it.each([1, 2, 3, 4, 5])("Mod+%i 是 %i 号", (n) => {
    // 测试环境的 Mod 在非 mac 上是 Ctrl，在 mac 上是 Meta：两个都试
    const hit =
      quickPickNumber(key({ key: String(n), metaKey: true })) ??
      quickPickNumber(key({ key: String(n), ctrlKey: true }));
    expect(hit).toBe(n);
  });

  it("6、0、不带修饰键、多带 Shift / Alt 都不算", () => {
    for (const init of [
      { key: "6", metaKey: true },
      { key: "6", ctrlKey: true },
      { key: "0", metaKey: true },
      { key: "1" },
      { key: "1", metaKey: true, shiftKey: true },
      { key: "1", ctrlKey: true, altKey: true },
    ])
      expect(quickPickNumber(key(init))).toBeNull();
  });
});

describe("runQuickPick", () => {
  it("点第 N 个没被禁用的行（禁用的行不占号）", () => {
    const { input, clicks } = palette();
    expect(runQuickPick(input, 1)).toBe(true);
    expect(runQuickPick(input, 3)).toBe(true);
    expect(clicks).toEqual(["1", "4"]);
  });

  it("行数不够 / 不在 cmdk 里：不点", () => {
    const { input, clicks } = palette(2);
    expect(runQuickPick(input, 5)).toBe(false);
    expect(clicks).toEqual([]);
    const loose = document.createElement("input");
    expect(runQuickPick(loose, 1)).toBe(false);
  });
});

describe("quickPickKeyDown", () => {
  it("命中才拦下事件", () => {
    const { input, clicks } = palette();
    const preventDefault = vi.fn();
    const mac = /mac/i.test(navigator.platform);
    quickPickKeyDown({
      nativeEvent: key({ key: "2", metaKey: mac, ctrlKey: !mac }),
      currentTarget: input,
      preventDefault,
    });
    expect(clicks).toEqual(["2"]);
    expect(preventDefault).toHaveBeenCalledTimes(1);

    quickPickKeyDown({
      nativeEvent: key({ key: "a" }),
      currentTarget: input,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});
