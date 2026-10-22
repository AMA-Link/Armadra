import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";

import {
  CTRL_ENTER_CSI_U,
  ctrlEnterInput,
  isPlainCtrlEnter,
  trackKeyProtocol,
} from "./key-protocol";

async function setup() {
  const term = new Terminal({ allowProposedApi: true });
  const state = trackKeyProtocol(term.parser);
  const feed = (data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve));
  return { state, feed };
}

const key = (over: Partial<KeyboardEvent> = {}) => ({
  type: "keydown",
  key: "Enter",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});

describe("Ctrl+Enter 键盘协议跟踪", () => {
  it("is off by default and after unrelated sequences", async () => {
    const { state, feed } = await setup();
    expect(state.distinguishesCtrlEnter).toBe(false);
    await feed("hello \x1b[31mred\x1b[0m\x1b[?2004h");
    expect(state.distinguishesCtrlEnter).toBe(false);
  });

  it("turns on with kitty push and off with pop", async () => {
    const { state, feed } = await setup();
    await feed("\x1b[>1u");
    expect(state.distinguishesCtrlEnter).toBe(true);
    await feed("\x1b[<u");
    expect(state.distinguishesCtrlEnter).toBe(false);
  });

  it("ignores kitty flags that do not report Enter", async () => {
    const { state, feed } = await setup();
    await feed("\x1b[>2u");
    expect(state.distinguishesCtrlEnter).toBe(false);
  });

  it("supports kitty set mode and modifyOtherKeys", async () => {
    const { state, feed } = await setup();
    await feed("\x1b[=1;1u");
    expect(state.distinguishesCtrlEnter).toBe(true);
    await feed("\x1b[=1;3u");
    expect(state.distinguishesCtrlEnter).toBe(false);
    await feed("\x1b[>4;2m");
    expect(state.distinguishesCtrlEnter).toBe(true);
    await feed("\x1b[>4;0m");
    expect(state.distinguishesCtrlEnter).toBe(false);
  });

  it("clears on soft reset and RIS", async () => {
    const { state, feed } = await setup();
    await feed("\x1b[>1u\x1b[>4;2m\x1b[!p");
    expect(state.distinguishesCtrlEnter).toBe(false);
    await feed("\x1b[>1u\x1bc");
    expect(state.distinguishesCtrlEnter).toBe(false);
  });
});

describe("isPlainCtrlEnter", () => {
  it("matches only Ctrl+Enter keydown", () => {
    expect(CTRL_ENTER_CSI_U).toBe("\x1b[13;5u");
    expect(isPlainCtrlEnter(key({ ctrlKey: true }))).toBe(true);
    expect(isPlainCtrlEnter(key())).toBe(false);
    expect(isPlainCtrlEnter(key({ ctrlKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isPlainCtrlEnter(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPlainCtrlEnter(key({ shiftKey: true }))).toBe(false);
    expect(isPlainCtrlEnter(key({ altKey: true }))).toBe(false);
    expect(isPlainCtrlEnter(key({ ctrlKey: true, type: "keyup" }))).toBe(false);
  });
});

describe("ctrlEnterInput", () => {
  it("translates only when the program enabled the protocol", async () => {
    const { state, feed } = await setup();
    expect(ctrlEnterInput(key({ ctrlKey: true }), state)).toBeNull();
    await feed("\x1b[>1u");
    expect(ctrlEnterInput(key({ ctrlKey: true }), state)).toBe("\x1b[13;5u");
    expect(ctrlEnterInput(key(), state)).toBeNull();
    expect(ctrlEnterInput(key({ shiftKey: true }), state)).toBeNull();
    expect(ctrlEnterInput(key({ altKey: true }), state)).toBeNull();
    expect(
      ctrlEnterInput(key({ ctrlKey: true, shiftKey: true }), state),
    ).toBeNull();
    expect(
      ctrlEnterInput(key({ ctrlKey: true, altKey: true }), state),
    ).toBeNull();
  });
});
