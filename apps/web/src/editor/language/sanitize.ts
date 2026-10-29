/**
 * hover / 补全文档里 Markdown 渲染成的 HTML 的清洗（设计 §1.1、§3.4）。
 *
 * server 返回的 Markdown 可以包含任意 HTML。它跑在用户自己的机器上，但
 * 「正文是可信的」不是一个能维持的假设：正文来自被打开的项目文件，而项目
 * 文件可能是刚 clone 下来的。所以 hover 与 Markdown 预览一样按白名单渲染，
 * 不执行脚本、不发请求。
 *
 * 白名单之外的元素**保留文字、丢掉标签**：一个被整段吞掉的 hover 会让人
 * 以为 server 没回答，而 server 其实回答了。
 */

/** 允许留下的元素。只有排版，没有表单、没有嵌入、没有脚本。 */
const ALLOWED_TAGS = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DD",
  "DEL",
  "DIV",
  "DL",
  "DT",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "I",
  "LI",
  "OL",
  "P",
  "PRE",
  "S",
  "SPAN",
  "STRONG",
  "SUP",
  "SUB",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

/** 每个元素允许留下的属性。`class` 留给代码高亮用的 token 类。 */
const ALLOWED_ATTRIBUTES = new Set(["class", "href", "title", "start"]);

/** 只允许这几种 URL 协议；`javascript:` 与 `data:` 一律去掉。 */
const SAFE_SCHEME = /^(https?:|mailto:|armadra:|#|\/)/i;

/**
 * 只给这里的 `DOMParser` 用的 Trusted Types 策略（`armadra-sanitize`）：解析进惰性文档，
 * 不执行脚本、不发请求，出来的只有白名单里的标签。不导出——别处拿它绕过净化就失去意义。
 */
interface InertPolicy {
  createHTML(input: string): unknown;
}
let inert: InertPolicy | null | undefined;
function inertHTML(html: string): string {
  if (inert === undefined) {
    const factory = (
      globalThis as {
        trustedTypes?: {
          createPolicy(
            name: string,
            rules: { createHTML: (input: string) => string },
          ): InertPolicy;
        };
      }
    ).trustedTypes;
    try {
      inert =
        factory?.createPolicy("armadra-sanitize", {
          createHTML: (input) => input,
        }) ?? null;
    } catch {
      inert = null;
    }
  }
  return (inert === null ? html : inert.createHTML(html)) as string;
}

/** 嵌套超过这么深就不再逐层看：整段压成纯文本（不原样放过）。 */
export const MAX_SANITIZE_DEPTH = 32;

export function sanitizeHTML(html: string): string {
  if (typeof DOMParser === "undefined") return stripTags(html);
  try {
    const document_ = new DOMParser().parseFromString(
      inertHTML(`<body>${html}</body>`),
      "text/html",
    );
    clean(document_.body, 0);
    return document_.body.innerHTML;
  } catch {
    // 解析或清洗出了意外：退回纯文本，宁可丢掉排版也不放过标记。
    return escapeText(stripTags(html));
  }
}

function escapeText(text: string): string {
  // 数字字符引用：`& < > " '` 都转成 `&#NN;`。
  return text.replace(
    /[&<>\u0022\u0027]/g,
    (char) => `&#${char.charCodeAt(0)};`,
  );
}

function clean(node: Element, depth: number): void {
  for (const child of [...node.children]) {
    if (depth >= MAX_SANITIZE_DEPTH) {
      // 太深：这一层以下只留文字（文本节点造不出元素与事件）。
      child.replaceWith(
        child.ownerDocument.createTextNode(child.textContent ?? ""),
      );
      continue;
    }
    if (!ALLOWED_TAGS.has(child.tagName)) {
      // 元素本身不要，里面的文字要。`<script>` 是唯一整块丢掉的：它的
      // 「文字」就是代码。
      if (child.tagName === "SCRIPT" || child.tagName === "STYLE") {
        child.remove();
        continue;
      }
      const text = child.ownerDocument.createTextNode(child.textContent ?? "");
      child.replaceWith(text);
      continue;
    }
    for (const attribute of [...child.attributes]) {
      const name = attribute.name.toLowerCase();
      if (!ALLOWED_ATTRIBUTES.has(name)) {
        child.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" && !SAFE_SCHEME.test(attribute.value.trim())) {
        child.removeAttribute(attribute.name);
      }
    }
    clean(child, depth + 1);
  }
}

/** 没有 DOM 的环境（测试、SSR）：退回到「只留文字」。 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}
