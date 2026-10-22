import type { IDisposable, IParser } from "@xterm/xterm";

/**
 * 程序是否开启了「能区分 Ctrl+Enter」的键盘协议。
 *
 * xterm.js 6.0 没有实现 kitty 键盘协议和 modifyOtherKeys，Ctrl+Enter 与 Enter
 * 都是 `\r`。这里只跟踪程序发来的开关序列（不回答、不吞掉），程序开了才在
 * 按键层把 Ctrl+Enter 翻译成 CSI-u；没开就保持旧行为，不影响不认识它的程序。
 *
 * - kitty：`CSI > flags u` 压栈、`CSI < n u` 出栈、`CSI = flags ; mode u` 设置。
 *   flags 的 bit 0（消歧）或 bit 3（报告所有按键）开了，Ctrl+Enter 就要单独上报。
 * - modifyOtherKeys：`CSI > 4 ; n m`，n >= 1 开启，0 或 `CSI > 4 m` 关闭。
 * - `CSI ! p`（软复位）与 `ESC c`（RIS）清空两者。
 */
export const CTRL_ENTER_CSI_U = "\x1b[13;5u";

const KITTY_REPORTS_ENTER = 0b1001;
const KITTY_STACK_LIMIT = 16;

export interface KeyProtocolState {
  /** 程序当前是否要求把 Ctrl+Enter 与 Enter 区分开。 */
  readonly distinguishesCtrlEnter: boolean;
  dispose(): void;
}

type Params = ReadonlyArray<number | number[]>;

function first(params: Params, fallback: number): number {
  const value = params[0];
  const n = Array.isArray(value) ? value[0] : value;
  return typeof n === "number" && n > 0 ? n : fallback;
}

export function trackKeyProtocol(
  parser: Pick<IParser, "registerCsiHandler" | "registerEscHandler">,
): KeyProtocolState {
  let kitty: number[] = [];
  let modifyOtherKeys = 0;
  const top = () => (kitty.length ? kitty[kitty.length - 1]! : 0);
  const reset = () => {
    kitty = [];
    modifyOtherKeys = 0;
  };

  const disposables: IDisposable[] = [
    parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
      kitty.push(first(params, 0) || 0);
      if (kitty.length > KITTY_STACK_LIMIT) kitty.shift();
      return false;
    }),
    parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
      kitty.length = Math.max(0, kitty.length - first(params, 1));
      return false;
    }),
    parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      const flags =
        Number(Array.isArray(params[0]) ? params[0][0] : params[0]) || 0;
      const rawMode = params[1];
      const mode = Number(Array.isArray(rawMode) ? rawMode[0] : rawMode) || 1;
      const current = top();
      const next =
        mode === 2 ? current | flags : mode === 3 ? current & ~flags : flags;
      if (kitty.length) kitty[kitty.length - 1] = next;
      else kitty.push(next);
      return false;
    }),
    parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
      const resource = Array.isArray(params[0]) ? params[0][0] : params[0];
      if (resource !== 4) return false;
      const raw = params[1];
      modifyOtherKeys = Number(Array.isArray(raw) ? raw[0] : raw) || 0;
      return false;
    }),
    parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      reset();
      return false;
    }),
    parser.registerEscHandler({ final: "c" }, () => {
      reset();
      return false;
    }),
  ];

  return {
    get distinguishesCtrlEnter() {
      return (top() & KITTY_REPORTS_ENTER) !== 0 || modifyOtherKeys >= 1;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** 纯 Ctrl+Enter（不带 Shift / Alt / Meta），按下事件。 */
export function isPlainCtrlEnter(
  event: Pick<
    KeyboardEvent,
    "type" | "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
  >,
): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Enter" &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  );
}

/** 要替这次按键发给 pty 的序列；`null` 表示按原有路径处理。 */
export function ctrlEnterInput(
  event: Parameters<typeof isPlainCtrlEnter>[0],
  state: Pick<KeyProtocolState, "distinguishesCtrlEnter">,
): string | null {
  return state.distinguishesCtrlEnter && isPlainCtrlEnter(event)
    ? CTRL_ENTER_CSI_U
    : null;
}
