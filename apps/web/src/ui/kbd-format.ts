/**
 * 把给人看的按键串（`⌘K`、`Ctrl+Shift+K`、`↵`、`Esc`）翻成 `aria-keyshortcuts` 的写法
 * （`Meta+K`、`Control+Shift+K`、`Enter`、`Escape`），让 `Button / IconButton /
 * TooltipContent` 的 `shortcut` 属性同时服务读屏与辅助技术。
 * 显示串由调用方经 `keybindings/chords.ts` 的 `formatKeys` 给出，这里不碰平台判断。
 */
const SYMBOLS: Record<string, string> = {
  "⌘": "Meta",
  "⌃": "Control",
  "⌥": "Alt",
  "⇧": "Shift",
};

const NAMES: Record<string, string> = {
  "↵": "Enter",
  "⏎": "Enter",
  Return: "Enter",
  Esc: "Escape",
  "⎋": "Escape",
  "⌫": "Backspace",
  "⇥": "Tab",
  "←": "ArrowLeft",
  "→": "ArrowRight",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  Ctrl: "Control",
  Win: "Meta",
  Cmd: "Meta",
  Option: "Alt",
};

export function ariaKeyShortcuts(shortcut: string): string {
  const parts: string[] = [];
  let rest = shortcut.trim();
  // mac 写法把修饰键直接连在键名前：⌘⇧K
  while (rest.length > 0 && SYMBOLS[rest[0]!] !== undefined) {
    parts.push(SYMBOLS[rest[0]!]!);
    rest = rest.slice(1);
  }
  const tail = rest.length > 0 ? rest.split("+") : [];
  for (const piece of tail) {
    const name = NAMES[piece] ?? piece;
    parts.push(name.length === 1 ? name.toUpperCase() : name);
  }
  return parts.join("+");
}
