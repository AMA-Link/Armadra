import { sanitizeHTML } from "../editor/language/sanitize";

/**
 * Trusted Types（设计 saas-host-open §5.4 Q13）：控制台来源上 `/h/` 把主机内容放进同一个
 * 来源，CSP 要求 `require-trusted-types-for 'script'` 之后，页面里所有写 HTML、写脚本地址
 * 的地方都要交一个策略造出来的值。页面有三个策略：
 *
 * - `armadra`：HTML 一律经白名单净化（`editor/language/sanitize.ts`）；脚本地址只认本源与
 *   挑战组件的来源。
 * - `armadra-sanitize`：只给净化器自己用，把待净化的文本交给 `DOMParser`（惰性文档，不执行
 *   脚本、不发请求）；不导出。
 * - `default`：第三方组件直接写的字符串（见 {@link installDefaultTrustedTypesPolicy}）。
 *
 * 浏览器没有 Trusted Types（Firefox、Safari、测试环境）时原样返回字符串。
 */

export interface TrustedTypePolicyLike {
  createHTML(input: string): unknown;
  createScriptURL(input: string): unknown;
}

interface TrustedTypesFactory {
  createPolicy(
    name: string,
    rules: {
      createHTML?: (input: string) => string;
      createScriptURL?: (input: string) => string;
    },
  ): TrustedTypePolicyLike;
}

/** 页面的 HTML / 脚本地址策略名（CSP `trusted-types` 名单里的那几个）。 */
export const TRUSTED_TYPES_POLICY = "armadra";
export const SANITIZER_POLICY = "armadra-sanitize";

function factory(): TrustedTypesFactory | null {
  const found = (globalThis as { trustedTypes?: TrustedTypesFactory })
    .trustedTypes;
  return found !== undefined && typeof found.createPolicy === "function"
    ? found
    : null;
}

/** 按名字建一次策略（同名再建会被浏览器拒绝）；没有 Trusted Types 是 `null`。 */
export function policyOnce(
  name: string,
  rules: Parameters<TrustedTypesFactory["createPolicy"]>[1],
): () => TrustedTypePolicyLike | null {
  let made: TrustedTypePolicyLike | null | undefined;
  return () => {
    if (made !== undefined) return made;
    try {
      made = factory()?.createPolicy(name, rules) ?? null;
    } catch {
      made = null;
    }
    return made;
  };
}

/** 认得的脚本来源：本源，与挑战组件。 */
const SCRIPT_ORIGINS = new Set(["https://challenges.cloudflare.com"]);

export function allowedScriptURL(input: string): string {
  const url = new URL(input, globalThis.location?.href);
  if (
    url.origin !== globalThis.location?.origin &&
    !SCRIPT_ORIGINS.has(url.origin)
  )
    throw new TypeError(`script URL not allowed: ${url.origin}`);
  return url.href;
}

const policy = policyOnce(TRUSTED_TYPES_POLICY, {
  createHTML: sanitizeHTML,
  createScriptURL: allowedScriptURL,
});

/**
 * 写进 `innerHTML` / `dangerouslySetInnerHTML` 的 HTML：经白名单净化。有 Trusted Types 时
 * 答 `TrustedHTML`（React 与 DOM 都接受它），没有时答净化后的字符串。
 */
export function trustedHTML(html: string): string {
  const made = policy();
  return (made === null ? sanitizeHTML(html) : made.createHTML(html)) as string;
}

/** 写进 `script.src` 的地址：只认本源与挑战组件；别的抛。 */
export function trustedScriptURL(url: string): string {
  const made = policy();
  return (
    made === null ? allowedScriptURL(url) : made.createScriptURL(url)
  ) as string;
}

/**
 * `default` 策略：没有经过上面两个策略、直接写进 HTML 接收点的字符串（第三方组件，如 Radix
 * ScrollArea 给 `<style>` 的那段 CSS）。只放行不含 `<`、`&` 的纯文本——它写进 `innerHTML`
 * 只能成为一个文本节点，造不出元素与事件；其余一律经白名单净化。脚本（`eval` 一类）一律拒绝，
 * 脚本地址同 {@link allowedScriptURL}。入口挂载之前装上（`main.tsx`）。
 */
export function installDefaultTrustedTypesPolicy(): void {
  const made = policyOnce("default", {
    createHTML: (input) => (/[<&]/.test(input) ? sanitizeHTML(input) : input),
    createScriptURL: allowedScriptURL,
  });
  made();
}
