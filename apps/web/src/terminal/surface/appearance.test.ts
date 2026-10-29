import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  terminalAppearance,
  terminalSchemeAttribute,
  terminalTheme,
  watchAppTheme,
} from "./appearance";
import { storedTerminalPreferences } from "@/app/preferences/terminal";

/**
 * `terminalTheme` 在「应用主题 × 终端配色」三种组合下的取值（#501）。
 *
 * jsdom 会按层叠算样式并继承自定义属性，所以这里直接把真正的 `tokens.css`
 * 注入文档：测的是真实令牌 + 真实选择器，而不是另写一份期望值的副本。
 */

const DARK = {
  background: "#0a0a0a",
  foreground: "#e6e6e6",
  selectionBackground: "#3a5a8c66",
  black: "#151515",
  red: "#ff453a",
  brightWhite: "#ffffff",
};
const LIGHT = {
  background: "#fafafa",
  foreground: "#1f1f1f",
  selectionBackground: "#007aff33",
  black: "#1f1f1f",
  red: "#c4281c",
  brightWhite: "#595959",
};

let style: HTMLStyleElement;
beforeAll(() => {
  style = document.createElement("style");
  style.textContent = readFileSync(
    resolve(import.meta.dirname, "../../styles/tokens.css"),
    "utf8",
  );
  document.head.appendChild(style);
});
afterAll(() => style.remove());
afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.body.replaceChildren();
});

/** 终端容器的位置：外层 `body`（可带 `data-term-scheme`）里的内层容器。 */
function mount(scheme?: "dark") {
  const body = document.createElement("div");
  const scheme_ = terminalSchemeAttribute(
    scheme === "dark" ? "dark" : "follow",
  );
  if (scheme_) body.setAttribute("data-term-scheme", scheme_);
  const container = document.createElement("div");
  body.appendChild(container);
  document.body.appendChild(body);
  return container;
}

describe("terminalTheme：三种组合", () => {
  it("深色主题 + 跟随：深色调色板", () => {
    expect(terminalTheme(mount())).toMatchObject(DARK);
  });

  it("浅色主题 + 跟随：浅色调色板，十六色整组换掉", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const theme = terminalTheme(mount());
    expect(theme).toMatchObject(LIGHT);
    expect(theme.cursorAccent).toBe(LIGHT.background);
    // 与深色没有一个同值的 ANSI 前景（brightWhite 也换了）
    for (const key of ["red", "green", "yellow", "blue", "magenta", "cyan"]) {
      expect(theme[key as keyof typeof theme], key).not.toBe(
        terminalThemeDark()[key as keyof ReturnType<typeof terminalThemeDark>],
      );
    }
  });

  it("浅色主题 + 始终深色：回到深色调色板", () => {
    document.documentElement.setAttribute("data-theme", "light");
    expect(terminalTheme(mount("dark"))).toMatchObject(DARK);
  });

  it("深色主题 + 始终深色：还是深色（属性不改变深色主题）", () => {
    expect(terminalTheme(mount("dark"))).toMatchObject(DARK);
  });

  it("同一个容器：切换 data-theme 与 data-term-scheme 后立刻读到新值", () => {
    const container = mount();
    const body = container.parentElement!;
    expect(terminalTheme(container).background).toBe(DARK.background);
    document.documentElement.setAttribute("data-theme", "light");
    expect(terminalTheme(container).background).toBe(LIGHT.background);
    body.setAttribute("data-term-scheme", "dark");
    expect(terminalTheme(container).background).toBe(DARK.background);
    body.removeAttribute("data-term-scheme");
    expect(terminalTheme(container).background).toBe(LIGHT.background);
  });

  it("光标取品牌色：始终深色子树里是深色那一份", () => {
    document.documentElement.setAttribute("data-theme", "light");
    expect(terminalTheme(mount()).cursor).toBe("#007aff");
    expect(terminalTheme(mount("dark")).cursor).toBe("#0a84ff");
  });
});

describe("terminalAppearance / 属性 / 监听", () => {
  it("theme 随容器所在的配色一起带进 options", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const preferences = storedTerminalPreferences();
    expect(terminalAppearance(preferences, mount()).theme).toMatchObject(LIGHT);
    expect(terminalAppearance(preferences, mount("dark")).theme).toMatchObject(
      DARK,
    );
  });

  it("默认字体读 --font-term（系统等宽），不跟界面的网页等宽字体", () => {
    const family = terminalAppearance(
      { ...storedTerminalPreferences(), fontFamily: "" },
      mount(),
    ).fontFamily;
    expect(family).toMatch(/^ui-monospace,/);
    expect(family).not.toMatch(/Geist|Inter|Variable/);
  });

  it("偏好里填了字体就用偏好，前后空白去掉", () => {
    const preferences = {
      ...storedTerminalPreferences(),
      fontFamily: "  Menlo  ",
    };
    expect(terminalAppearance(preferences, mount()).fontFamily).toBe("Menlo");
  });

  it("terminalSchemeAttribute：始终深色写 dark，跟随主题不写", () => {
    expect(terminalSchemeAttribute("dark")).toBe("dark");
    expect(terminalSchemeAttribute("follow")).toBeUndefined();
  });

  it("watchAppTheme：data-theme 变了回调一次，解除后不再回调", async () => {
    let calls = 0;
    const stop = watchAppTheme(() => (calls += 1));
    document.documentElement.setAttribute("data-theme", "light");
    await Promise.resolve();
    expect(calls).toBe(1);
    // 别的属性不算
    document.documentElement.setAttribute("data-other", "x");
    await Promise.resolve();
    expect(calls).toBe(1);
    stop();
    document.documentElement.setAttribute("data-theme", "dark");
    await Promise.resolve();
    expect(calls).toBe(1);
    document.documentElement.removeAttribute("data-other");
  });
});

function terminalThemeDark() {
  const saved = document.documentElement.getAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme");
  const theme = terminalTheme(mount());
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  return theme;
}
