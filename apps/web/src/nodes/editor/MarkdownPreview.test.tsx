import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { setControlPlanePage } from "@/api/runtime-url";
import { MarkdownPreview } from "./MarkdownPreview";

/**
 * 主机内容进同一个来源（控制台 `/h/`，设计 saas-host-open §5.4 Q13）：Markdown 里注入的
 * HTML 不成为元素、不执行；控制台来源上不替主机内容去拉外站图片。
 */

afterEach(() => {
  cleanup();
  setControlPlanePage(false);
  delete (globalThis as { pwned?: unknown }).pwned;
});

const view = (source: string) =>
  render(
    <MarkdownPreview
      source={source}
      workspaceId="ws-1"
      path="docs/readme.md"
      bordered={false}
    />,
  );

describe("Markdown 预览里的主机内容", () => {
  it("<img onerror> 与 <script> 只以文本出现，不执行", () => {
    const { container } = view(
      [
        "# 标题",
        "",
        '<img src="x" onerror="globalThis.pwned = 1">',
        "",
        "<script>globalThis.pwned = 2</script>",
        "",
        '<iframe src="javascript:globalThis.pwned=3"></iframe>',
        "",
        "[链接](javascript:globalThis.pwned=4)",
      ].join("\n"),
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBeNull();
    expect((globalThis as { pwned?: unknown }).pwned).toBeUndefined();
  });

  it("控制台来源上外站图片不加载；别处照常", () => {
    const md = "![外站](https://tracker.example/p.png)";
    setControlPlanePage(true);
    const first = view(md);
    expect(
      first.container.querySelector("img")?.getAttribute("src"),
    ).toBeNull();
    first.unmount();
    setControlPlanePage(false);
    const second = view(md);
    expect(second.container.querySelector("img")?.getAttribute("src")).toBe(
      "https://tracker.example/p.png",
    );
  });
});
