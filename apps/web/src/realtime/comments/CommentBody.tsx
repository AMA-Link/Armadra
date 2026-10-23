import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/cn";
import { bodyParts } from "./store";

/**
 * 正文按 Markdown 渲染：与编辑器的 Markdown 预览同一条管线
 * （`react-markdown` + GFM、同一套 `sticky-markdown` 样式），对评论再收紧：
 *
 *   * 不渲染裸 HTML（`skipHtml`，也不装 `rehype-raw`），`<script>` 之类整段丢掉；
 *   * 链接只放行 `http(s)`，别的协议画成纯文本；图片不加载，只留替代文字；
 *   * 提及记号先换成 `principal:` 链接，再画成 `@名字`——不让 Markdown 把
 *     记号里的方括号与圆括号读成别的东西。
 */
export function CommentBody({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky-markdown text-body break-words text-foreground",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={commentUrl}
        components={COMPONENTS}
      >
        {markdownSource(body)}
      </Markdown>
    </div>
  );
}

const PRINCIPAL = "principal:";

/** 只留 `http(s)` 与提及；别的地址一律丢掉（`javascript:`、`data:`、相对路径）。 */
export function commentUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith(PRINCIPAL)) return url;
  return "";
}

const MARKDOWN_SPECIAL = /[\\\x60*_{}[\]()<>#+\-.!|~]/g;

/** 提及记号换成指向 principal: 的链接，名字里的 Markdown 记号转义。 */
export function markdownSource(body: string): string {
  return bodyParts(body)
    .map((part) =>
      part.kind === "text"
        ? part.text
        : `[@${part.name.replace(MARKDOWN_SPECIAL, "\\$&")}](${PRINCIPAL}${part.id})`,
    )
    .join("");
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    if (typeof href === "string" && href.startsWith(PRINCIPAL)) {
      return (
        <span
          data-mention={href.slice(PRINCIPAL.length)}
          className="font-medium text-brand-text"
        >
          {children}
        </span>
      );
    }
    if (typeof href === "string" && /^https?:\/\//i.test(href)) {
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    }
    return <span>{children}</span>;
  },
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
};
