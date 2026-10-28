import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAssetUrl } from "@/api/assets";
import { runtimeApi } from "@/api/client";
import { isControlPlanePage } from "@/api/runtime-url";
import { cn } from "@/lib/cn";
import { ScrollArea } from "@/ui/scroll-area";

/**
 * Markdown 预览（编辑器设计 §4：不执行脚本，HTML 经清理）。
 *
 * `react-markdown` 默认就不渲染裸 HTML——这里刻意不装 `rehype-raw`，所以
 * 文档里的 `<script>` / `<img onerror>` 只会以文本出现。另外两条：
 *
 *  * 图片的相对路径经 Runtime 的文件读取接口取，不让页面直接摸文件系统，
 *    也不让一份 Markdown 把绝对路径变成外部请求；
 *  * 链接一律 `noreferrer`，且只放行 http/https 与文档内锚点——`javascript:`
 *    在这里就是一段没用的文本。
 *
 * 与设计 saas-host-open §5.4（Q13）的偏离：设计要求主机内容的预览放进 sandbox `iframe`。这里没有——
 * Markdown 由 `react-markdown` 生成 React 元素，没有任何写 HTML 的接收点（不装 `rehype-raw`），注入的
 * 标记只会是文本，`MarkdownPreview.test.tsx` 守着；放进框架反而要经 `srcdoc`（又一个 HTML 接收点）
 * 并在框架里重做主题与相对图片。真要渲染主机给的 HTML / 文档的地方（PDF）在控制台来源上只给下载。
 */
export function MarkdownPreview({
  source,
  workspaceId,
  path,
  bordered,
}: {
  source: string;
  workspaceId: string | undefined;
  path: string;
  bordered: boolean;
}) {
  const directory = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/"))
    : "";

  const resolve = React.useCallback(
    (source: string | undefined): string | undefined => {
      if (!source || !workspaceId) return undefined;
      // 控制台来源（`/h/`）上不替主机内容去拉外站图片：CSP 也不放行，留着只是一次被拦的
      // 请求与一条违规（设计 saas-host-open §5.4）。
      if (/^https?:/i.test(source))
        return isControlPlanePage() ? undefined : source;
      if (/^data:/i.test(source)) return source;
      // `/a.png` 在工作区里就是根下的 a.png；`../` 交给 Runtime 拒绝。
      const relative = source.replace(/^\/+/, "");
      const joined =
        source.startsWith("/") || !directory
          ? relative
          : `${directory}/${relative}`;
      return runtimeApi.fileDownloadUrl(workspaceId, joined);
    },
    [directory, workspaceId],
  );

  return (
    <ScrollArea
      className={cn(
        "min-w-0 flex-1 bg-sunken",
        bordered && "border-l border-border",
      )}
    >
      <div className="sticky-markdown p-3 text-meta leading-relaxed">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            img: ({ src, alt }) => (
              <PreviewImage
                src={resolve(typeof src === "string" ? src : undefined)}
                alt={alt ?? ""}
              />
            ),
            a: ({ href, children }) => (
              <a
                href={
                  typeof href === "string" && /^(https?:|#)/i.test(href)
                    ? href
                    : undefined
                }
                target="_blank"
                rel="noreferrer noopener"
              >
                {children}
              </a>
            ),
          }}
        >
          {source}
        </Markdown>
      </div>
    </ScrollArea>
  );
}

/** 预览里的图：原生 App 里经 `useAssetUrl` 带上 Bearer（R-55）。 */
function PreviewImage({ src, alt }: { src: string | undefined; alt: string }) {
  const resolved = useAssetUrl(src);
  return <img src={resolved ?? undefined} alt={alt} />;
}
