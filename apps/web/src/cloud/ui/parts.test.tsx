import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/ui/tooltip";
import { CloudConsoleError } from "../api/errors";
import { ConfirmAction } from "./ConfirmAction";
import { InlineError } from "./InlineError";
import { RelativeTime } from "./RelativeTime";

afterEach(cleanup);

const confirm = (
  onConfirm: () => void | Promise<void>,
  onOpenChange = vi.fn(),
) =>
  render(
    <ConfirmAction
      open
      onOpenChange={onOpenChange}
      title="撤销「周报」？"
      actionLabel="撤销链接"
      consequence="已加入的人一并停用"
      onConfirm={onConfirm}
    />,
  );

describe("ConfirmAction", () => {
  it("标题复述对象，确认按钮复述后果，后果一行；确认后关闭", async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    confirm(onConfirm, onOpenChange);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("撤销「周报」？")).toBeTruthy();
    expect(screen.getByText("已加入的人一并停用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "撤销链接" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("确认抛错：对话框留着，可以重试", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("x"));
    const onOpenChange = vi.fn();
    confirm(onConfirm, onOpenChange);
    fireEvent.click(screen.getByRole("button", { name: "撤销链接" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("取消不执行", () => {
    const onConfirm = vi.fn();
    confirm(onConfirm);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("RelativeTime", () => {
  it("相对时间文字，datetime 给机器读", () => {
    const ms = Date.now() - 3 * 3_600_000;
    render(
      <TooltipProvider>
        <RelativeTime ms={ms} />
      </TooltipProvider>,
    );
    const time = screen.getByText("3 小时前");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe(new Date(ms).toISOString());
  });
});

describe("InlineError", () => {
  it("按错误码出文案，重试回调", () => {
    const onRetry = vi.fn();
    render(
      <InlineError
        error={new CloudConsoleError("rate_limited", 429)}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").textContent).not.toBe("");
  });
});
