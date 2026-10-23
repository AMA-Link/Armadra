import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inputIsKeyboard,
  installInstantOverlays,
  resetInputModality,
} from "./instant";

/**
 * 键盘触发的浮层直接渲染终态（设计系统 §8.1）：输入方式是键盘时，挂进 body 的
 * 对话框 / 遮罩 / 菜单 / Sheet / Tooltip 带 `data-instant`；指针开的不带；Esc 让
 * 已打开的浮层即时关闭。
 */

let stop: () => void;

beforeEach(() => {
  resetInputModality();
  stop = installInstantOverlays();
});

afterEach(() => {
  stop();
  document.body.innerHTML = "";
});

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function key(name: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: name }));
}

function pointer(type: "pointerdown" | "pointermove", movement?: number) {
  const event = new Event(type, { bubbles: true });
  if (movement !== undefined) {
    Object.defineProperty(event, "movementX", { value: movement });
    Object.defineProperty(event, "movementY", { value: 0 });
  }
  window.dispatchEvent(event);
}

/** Radix 的 Portal：一个 div 里先遮罩后内容，直接挂在 body 下。 */
function portal(kind: "dialog" | "pop" | "tip" | "sheet" = "dialog") {
  const wrapper = document.createElement("div");
  const overlay = document.createElement("div");
  overlay.className = "motion-overlay";
  const content = document.createElement("div");
  content.className = `motion-${kind}`;
  content.dataset.state = "open";
  wrapper.append(overlay, content);
  document.body.append(wrapper);
  return { wrapper, overlay, content };
}

describe("输入方式", () => {
  it("键盘 → 指针 → 键盘", () => {
    expect(inputIsKeyboard()).toBe(false);
    key("Enter");
    expect(inputIsKeyboard()).toBe(true);
    pointer("pointerdown");
    expect(inputIsKeyboard()).toBe(false);
    key(",");
    expect(inputIsKeyboard()).toBe(true);
  });

  it("真的移动了指针才算指针；位移为 0 的合成移动不算", () => {
    key("k");
    pointer("pointermove", 0);
    expect(inputIsKeyboard()).toBe(true);
    pointer("pointermove", 3);
    expect(inputIsKeyboard()).toBe(false);
  });
});

describe("挂载时打标", () => {
  it("键盘打开：内容和遮罩都带 data-instant", async () => {
    key(",");
    const { overlay, content } = portal("dialog");
    await flush();
    expect(content.hasAttribute("data-instant")).toBe(true);
    expect(overlay.hasAttribute("data-instant")).toBe(true);
  });

  it("指针打开：不带，出场动画照播", async () => {
    key(",");
    pointer("pointerdown");
    const { overlay, content } = portal("dialog");
    await flush();
    expect(content.hasAttribute("data-instant")).toBe(false);
    expect(overlay.hasAttribute("data-instant")).toBe(false);
  });

  it.each(["pop", "tip", "sheet"] as const)("%s 同样处理", async (kind) => {
    key("Enter");
    const { content } = portal(kind);
    await flush();
    expect(content.hasAttribute("data-instant")).toBe(true);
  });

  it("本身就带 data-instant 的内容（命令面板），指针打开时遮罩也跟着即时", async () => {
    pointer("pointerdown");
    const wrapper = document.createElement("div");
    const overlay = document.createElement("div");
    overlay.className = "motion-overlay";
    const content = document.createElement("div");
    content.className = "motion-dialog";
    content.dataset.instant = "true";
    wrapper.append(overlay, content);
    document.body.append(wrapper);
    await flush();
    expect(overlay.hasAttribute("data-instant")).toBe(true);
  });

  it("不是浮层的节点不碰", async () => {
    key("Enter");
    const plain = document.createElement("div");
    document.body.append(plain);
    await flush();
    expect(plain.hasAttribute("data-instant")).toBe(false);
  });
});

describe("Esc 关闭即时", () => {
  it("给已打开的浮层打标，已关闭的不管", () => {
    pointer("pointerdown");
    const open = portal("dialog");
    const closed = portal("pop");
    closed.content.dataset.state = "closed";
    key("Escape");
    expect(open.content.hasAttribute("data-instant")).toBe(true);
    expect(open.overlay.hasAttribute("data-instant")).toBe(false);
    expect(closed.content.hasAttribute("data-instant")).toBe(false);
  });

  it("Base UI 风格的 data-open 也算已打开", () => {
    pointer("pointerdown");
    const { content } = portal("pop");
    delete content.dataset.state;
    content.setAttribute("data-open", "");
    key("Escape");
    expect(content.hasAttribute("data-instant")).toBe(true);
  });
});

describe("卸载", () => {
  it("卸载后不再追踪也不再打标", async () => {
    stop();
    key("Enter");
    const { content } = portal("dialog");
    await flush();
    expect(content.hasAttribute("data-instant")).toBe(false);
    stop = installInstantOverlays();
  });
});
