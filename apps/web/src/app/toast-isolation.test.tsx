import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Toaster } from "@/ui/sonner";
import { toast } from "@/ui/toast";

/** 全局 setup 清提示：文件自己的 afterEach(cleanup) 先卸了 Toaster 也不漏。 */
afterEach(cleanup);

describe("提示在用例之间隔离", () => {
  it("第 1 条弹出的提示", async () => {
    render(<Toaster />);
    toast.success("LEAKME");
    expect(await screen.findByText("LEAKME")).toBeTruthy();
  });

  it("第 2 条看不到上一条的提示", async () => {
    render(<Toaster />);
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByText("LEAKME")).toBeNull();
  });
});
