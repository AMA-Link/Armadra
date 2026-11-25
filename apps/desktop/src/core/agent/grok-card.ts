import { createHash } from "node:crypto";

/**
 * grok 的权限审批卡（Grok Build 1.0.92 真画面，契约 §127）。
 *
 * ```
 *   ┃
 *   ┃  ›  probe
 *   ┃  │ sh -c "echo x > out.txt"
 *   ┃  e edit pattern
 *   ┃
 *   ┃  1 (○) Always allow: sh -c "echo x > out.txt"
 *   ┃  3 (●) Yes, proceed
 *   ┃  4 (○) No, reject (type to add feedback)
 *   ┃  5 (○) Never allow: sh -c
 *   ┃    (○) Yes, and don't ask again for anything (always-approve mode)
 *   ┃
 *   1/5:select  │  Tab:next option  │  e:edit pattern  │  Ctrl+c:cancel  │  Esc:scrollback
 * ```
 *
 * 数字键选中并立即提交，编号会跳号，最后一项没有数字。选错一个就写进用户的规则
 * 或打开 always-approve：解析器只在**整张卡的结构都认得**时给出一个数字，任何一处
 * 对不上（页脚不是选择态、多出不认识的选项、选项不连续）都返回 `undefined`，
 * 调用方退回「不代答」。失败是安全的。
 */

export interface GrokCardOption {
  /** 选项前的数字键；最后一项（always-approve）没有。 */
  readonly digit?: string;
  readonly label: string;
  readonly focused: boolean;
}

export interface GrokApprovalCard {
  /** `›` 后面的那行：工具与目标。 */
  readonly title: string;
  /** 标题之后的正文行（去掉卡片边框与 `│` / `┆` 续行记号）。 */
  readonly body: readonly string[];
  readonly options: readonly GrokCardOption[];
  readonly allow: { readonly digit: string; readonly label: string };
  readonly reject: { readonly digit: string; readonly label: string };
  /** 卡片正文的哈希：焦点（`●`）不算，Tab 移焦点不换卡。 */
  readonly hash: string;
}

const BAR = /^\s*┃/;
const BAR_BLANK = /^\s*┃\s*$/;
const OPTION = /^\s*┃\s+(?:(\d)\s+)?\(([○●])\)\s+(\S.*?)\s*$/;
const TITLE = /^\s*┃\s+›\s+(\S.*?)\s*$/;
/** 选择态的页脚：编辑规则（`Enter:save`）、滚动区（`Tab:permission`）都不是它。 */
const FOOTER = /^\s*\d+\/\d+:select\b/;
/** 规则编辑态的正文提示；页脚已经不同，这里再拦一道。 */
const EDITING = /Enter save|Esc cancel/;

const ALLOW_ONCE = /^Yes(?:, proceed)?$/;
const REJECT = /^No, reject \(type to add feedback\)$/;
/** 带持久副作用的选项：认得，但永远不选。 */
const PERSISTENT =
  /^(?:Always allow|Never allow)\b|^Yes, allow\b|^Yes, and don't ask again\b/;

function normalize(line: string): string {
  return line.replace(/●/g, "○").replace(/\s+$/, "");
}

export function parseGrokApprovalCard(
  screen: string,
): GrokApprovalCard | undefined {
  const rows = screen.split("\n").map((row) => row.replace(/\s+$/, ""));
  let at = rows.length - 1;
  while (at >= 0 && rows[at] === "") at -= 1;
  // 页脚必须是最后一个非空行。
  if (at < 0 || !FOOTER.test(rows[at] ?? "")) return undefined;
  at -= 1;
  while (at >= 0 && rows[at] === "") at -= 1;
  // 选项之后的收口行。
  if (at < 0 || !BAR_BLANK.test(rows[at] ?? "")) return undefined;
  const closeAt = at;
  at -= 1;

  // 选项行必须连续；一出现不是选项的行就到头。
  const options: GrokCardOption[] = [];
  while (at >= 0) {
    const match = OPTION.exec(rows[at] ?? "");
    if (match === null) break;
    options.unshift({
      ...(match[1] === undefined ? {} : { digit: match[1] }),
      label: match[3] ?? "",
      focused: match[2] === "●",
    });
    at -= 1;
  }
  if (options.length < 2) return undefined;
  if (options.filter((option) => option.focused).length !== 1) {
    return undefined;
  }
  // 选项上面的分隔行。
  if (at < 0 || !BAR_BLANK.test(rows[at] ?? "")) return undefined;
  const optionsAt = at + 1;
  at -= 1;

  // 正文：连续的 `┃` 行，到非 `┃` 行为止。
  let top = optionsAt - 1;
  while (at >= 0 && BAR.test(rows[at] ?? "")) {
    top = at;
    at -= 1;
  }
  const bodyRows = rows.slice(top, optionsAt - 1);
  const firstText = bodyRows.find((row) => !BAR_BLANK.test(row));
  const title = firstText === undefined ? null : TITLE.exec(firstText);
  if (title === null) return undefined;
  if (bodyRows.some((row) => EDITING.test(row))) return undefined;

  // 每个选项都得是认得的一种；认不得的卡整张不代答。
  let allow: GrokApprovalCard["allow"] | undefined;
  let reject: GrokApprovalCard["reject"] | undefined;
  const digits = new Set<string>();
  for (const option of options) {
    if (option.digit !== undefined) {
      if (digits.has(option.digit)) return undefined;
      digits.add(option.digit);
    }
    if (ALLOW_ONCE.test(option.label)) {
      if (allow !== undefined || option.digit === undefined) return undefined;
      allow = { digit: option.digit, label: option.label };
    } else if (REJECT.test(option.label)) {
      if (reject !== undefined || option.digit === undefined) return undefined;
      reject = { digit: option.digit, label: option.label };
    } else if (!PERSISTENT.test(option.label)) {
      return undefined;
    }
  }
  if (allow === undefined || reject === undefined) return undefined;
  if (allow.digit === reject.digit) return undefined;
  if (!/^[1-9]$/.test(allow.digit) || !/^[1-9]$/.test(reject.digit)) {
    return undefined;
  }

  const inside = rows.slice(top, closeAt + 1).map(normalize);
  const body = bodyRows
    .filter((row) => !BAR_BLANK.test(row))
    .slice(1)
    .map((row) =>
      row
        .replace(/^\s*┃\s*/, "")
        .replace(/^[│┆]\s?/, "")
        .trimEnd(),
    );
  return {
    title: title[1] ?? "",
    body,
    options,
    allow,
    reject,
    hash: createHash("sha256").update(inside.join("\n")).digest("hex"),
  };
}

/** 这个决定在卡上按哪个数字；只会是「允许一次」或「拒绝」那一项的。 */
export function grokCardKey(
  card: GrokApprovalCard,
  decision: string,
): string | undefined {
  if (decision === "allow") return card.allow.digit;
  if (decision === "deny") return card.reject.digit;
  return undefined;
}
