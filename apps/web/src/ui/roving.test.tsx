import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nextRovingIndex, useRoving, type RovingOptions } from "@/ui/roving";

afterEach(cleanup);

describe("nextRovingIndex", () => {
  it("↓ / ↑ 移动并绕回，焦点不在列表里时落首 / 末项", () => {
    expect(nextRovingIndex(3, 0, "ArrowDown")).toBe(1);
    expect(nextRovingIndex(3, 2, "ArrowDown")).toBe(0);
    expect(nextRovingIndex(3, 0, "ArrowUp")).toBe(2);
    expect(nextRovingIndex(3, -1, "ArrowDown")).toBe(0);
    expect(nextRovingIndex(3, -1, "ArrowUp")).toBe(2);
  });

  it("不绕回时停在两端", () => {
    expect(nextRovingIndex(3, 2, "ArrowDown", "vertical", false)).toBe(2);
    expect(nextRovingIndex(3, 0, "ArrowUp", "vertical", false)).toBe(0);
  });

  it("Home / End 跳首尾；横排认 ←→，竖排不认", () => {
    expect(nextRovingIndex(5, 2, "Home")).toBe(0);
    expect(nextRovingIndex(5, 2, "End")).toBe(4);
    expect(nextRovingIndex(5, 0, "ArrowRight", "horizontal")).toBe(1);
    expect(nextRovingIndex(5, 0, "ArrowDown", "horizontal")).toBeNull();
    expect(nextRovingIndex(5, 0, "ArrowRight", "vertical")).toBeNull();
    expect(nextRovingIndex(5, 0, "ArrowRight", "both")).toBe(1);
    expect(nextRovingIndex(5, 1, "ArrowUp", "both")).toBe(0);
  });

  it("空列表与非导航键返回 null", () => {
    expect(nextRovingIndex(0, -1, "ArrowDown")).toBeNull();
    expect(nextRovingIndex(3, 0, "a")).toBeNull();
    expect(nextRovingIndex(3, 0, "Enter")).toBeNull();
  });
});

function List(
  props: RovingOptions & { disabledAt?: number; current?: number },
) {
  const { disabledAt, current, ...options } = props;
  const roving = useRoving<HTMLUListElement>(options);
  return (
    <ul {...roving}>
      {["甲", "乙", "丙", "丁"].map((name, index) => (
        <li key={name}>
          <button
            data-roving-item
            {...(index === disabledAt ? { "aria-disabled": true } : {})}
            {...(index === current ? { "data-active": "true" } : {})}
          >
            {name}
          </button>
        </li>
      ))}
    </ul>
  );
}

const stops = () =>
  screen.getAllByRole("button").map((button) => button.tabIndex);

describe("useRoving", () => {
  it("同一时刻只有一项是 Tab 停靠点：默认第一项，有当前项就是当前项", () => {
    const { unmount } = render(<List />);
    expect(stops()).toEqual([0, -1, -1, -1]);
    unmount();
    render(<List current={2} />);
    expect(stops()).toEqual([-1, -1, 0, -1]);
  });

  it("↓ ↑ 移动焦点，停靠点跟着走", () => {
    render(<List />);
    const [a, b, c] = screen.getAllByRole("button");
    a!.focus();
    fireEvent.keyDown(a!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(b);
    expect(stops()).toEqual([-1, 0, -1, -1]);
    fireEvent.keyDown(b!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(b);
  });

  it("Home / End；到头绕回；不绕回时停住", () => {
    const { rerender } = render(<List />);
    const buttons = screen.getAllByRole("button");
    buttons[3]!.focus();
    fireEvent.keyDown(buttons[3]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: "End" });
    expect(document.activeElement).toBe(buttons[3]);
    fireEvent.keyDown(buttons[3]!, { key: "Home" });
    expect(document.activeElement).toBe(buttons[0]);
    rerender(<List loop={false} />);
    fireEvent.keyDown(buttons[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("跳过 aria-disabled 的项", () => {
    render(<List disabledAt={1} />);
    const buttons = screen.getAllByRole("button");
    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[2]);
  });

  it("鼠标 / 程序把焦点放到某一项，停靠点跟过去", () => {
    render(<List />);
    screen.getByText("丙").focus();
    expect(stops()).toEqual([-1, -1, 0, -1]);
  });

  it("Esc 交给 onEscape；横排认 ←→", () => {
    const onEscape = vi.fn();
    render(<List onEscape={onEscape} orientation="horizontal" />);
    const buttons = screen.getAllByRole("button");
    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1]!, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("带修饰键的方向键留给别的快捷键", () => {
    render(<List />);
    const buttons = screen.getAllByRole("button");
    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: "ArrowDown", metaKey: true });
    expect(document.activeElement).toBe(buttons[0]);
  });
});
