/**
 * 把一段 Markdown 切成顶层块（设计 §3.1：已完成的块逐块 memo，只重解析最后一块）。
 *
 * 切分是前缀稳定的：文本只在末尾增长时，除最后一块外的各块字符串保持不变，
 * 所以按字符串做 memo 的块组件不会重渲染。各块首尾相接，`blocks.join("")`
 * 恒等于原文（块之间的空行归前一块）。
 *
 * 规则：围栏代码块里的空行不切；列表项之间、缩进的续行不切（否则有序列表会
 * 每块重新从 1 编号）。
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:\s|$)/;
const INDENTED = /^(?: {2,}|\t)/;

export function splitMarkdownBlocks(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let blockIsList = false;
  let pendingBlank = false;

  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join(""));
    current = [];
  };

  lines.forEach((line, index) => {
    const isLast = index === lines.length - 1;
    const suffix = isLast ? "" : "\n";
    const piece = line + suffix;
    if (fence !== null) {
      current.push(piece);
      const close = FENCE.exec(line);
      if (
        close &&
        (close[1] as string)[0] === fence[0] &&
        (close[1] as string).length >= fence.length &&
        line.trim() === (close[1] as string)
      ) {
        fence = null;
      }
      return;
    }
    if (line.trim() === "") {
      current.push(piece);
      pendingBlank = true;
      return;
    }
    if (pendingBlank) {
      const continues =
        INDENTED.test(line) || (blockIsList && LIST_ITEM.test(line));
      if (!continues) {
        flush();
        blockIsList = false;
      }
      pendingBlank = false;
    }
    if (current.length === 0) blockIsList = LIST_ITEM.test(line);
    current.push(piece);
    const open = FENCE.exec(line);
    if (open) fence = open[1] as string;
  });
  flush();
  return blocks;
}
