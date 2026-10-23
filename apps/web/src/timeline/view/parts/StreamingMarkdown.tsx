import * as React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/cn";
import { splitMarkdownBlocks } from "../markdown-blocks";
import { CodeBlock } from "./CodeBlock";

const COMPONENTS: Components = { pre: CodeBlock };
const PLUGINS = [remarkGfm];

/** 一块 Markdown。字符串不变就不重渲染，也就不重新解析。 */
export const MarkdownBlock = React.memo(function MarkdownBlock({
  source,
}: {
  source: string;
}) {
  return (
    <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
      {source}
    </Markdown>
  );
});

/**
 * 流式 Markdown（设计 §3.1、§4）：先切成顶层块，已完成的块各自 memo，
 * 一个分块进来只有末尾那一块重新解析，开销与全文长度无关。
 */
export const StreamingMarkdown = React.memo(function StreamingMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string | undefined;
}) {
  const blocks = React.useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <div
      data-slot="timeline-markdown"
      className={cn(
        "sticky-markdown text-body leading-relaxed [overflow-wrap:anywhere]",
        className,
      )}
    >
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} source={block} />
      ))}
    </div>
  );
});
