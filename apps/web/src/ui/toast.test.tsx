import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast as sonner } from "sonner";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "@/app/preferences-store";
import { Toaster } from "@/ui/sonner";
import { TOAST_DURATION_MS, toast, toastDuration } from "@/ui/toast";

beforeAll(() => {
  // sonner 读 matchMedia / 在 jsdom 下需要的几个 API
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

afterEach(() => {
  act(() => {
    sonner.dismiss();
  });
  cleanup();
  vi.restoreAllMocks();
});

describe("ui/toast 的五种调用（设计系统 §3.3）", () => {
  it.each([
    ["success", "已保存", "done"],
    ["error", "保存失败", "failed"],
    ["info", "已更新", "unread"],
    ["warning", "接近上限", "attention"],
  ] as const)(
    "toast.%s 渲染 role=status 的壳，前导 StatusDot tone=%s",
    async (kind, text, tone) => {
      render(<Toaster />);
      act(() => {
        toast[kind](text);
      });
      const shell = await screen.findByRole("status");
      expect(shell.textContent).toContain(text);
      expect(shell.dataset.kind).toBe(kind);
      const dot = shell.querySelector(
        "[data-slot='status-dot']",
      ) as HTMLElement;
      expect(dot.dataset.tone).toBe(tone);
      expect(dot.dataset.size).toBe("6");
    },
  );

  it("toast.loading：前导是 Spinner 12", async () => {
    render(<Toaster />);
    act(() => {
      toast.loading("正在导出");
    });
    const shell = await screen.findByRole("status");
    expect(shell.dataset.kind).toBe("loading");
    expect(shell.querySelector("[data-slot='spinner']")).not.toBeNull();
    expect(shell.querySelector("[data-slot='status-dot']")).toBeNull();
  });

  it("壳用设计系统的类：overlay 底、1px 强边、rounded-panel、shadow-overlay", async () => {
    render(<Toaster />);
    act(() => {
      toast("提示");
    });
    const shell = await screen.findByRole("status");
    for (const cls of [
      "bg-overlay",
      "border-border-strong",
      "rounded-panel",
      "shadow-overlay",
    ])
      expect(shell.className).toContain(cls);
  });

  it("description 是第二行 text-meta 灰字", async () => {
    render(<Toaster />);
    act(() => {
      toast.error("没有放到画板上", { description: "磁盘已满" });
    });
    const shell = await screen.findByRole("status");
    expect(screen.getByText("磁盘已满").className).toContain("text-meta");
    expect(shell.textContent).toContain("没有放到画板上");
  });

  it("动作是 Button xs outline，点击执行并关闭这一条", async () => {
    render(<Toaster />);
    const retry = vi.fn();
    act(() => {
      toast.error("没有放到画板上", {
        action: { label: "重试", onClick: retry },
      });
    });
    const button = await screen.findByRole("button", { name: "重试" });
    expect(button.dataset.variant).toBe("outline");
    expect(button.dataset.size).toBe("xs");
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("同一个 id 原地更新，不叠第二条", async () => {
    render(<Toaster />);
    let id: string | number = "";
    act(() => {
      id = toast.loading("正在导出");
    });
    await screen.findByText("正在导出");
    act(() => {
      toast.success("已导出", { id });
    });
    await waitFor(() => expect(screen.queryByText("正在导出")).toBeNull());
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").dataset.kind).toBe("success");
  });

  it("promise：加载 → 成功，返回原结果", async () => {
    render(<Toaster />);
    const { result } = toast.promise(Promise.resolve(7), {
      loading: "保存中",
      success: (value) => `已保存 ${value}`,
      error: "失败",
    });
    await screen.findByText("保存中");
    await expect(result).resolves.toBe(7);
    await screen.findByText("已保存 7");
  });

  it("promise：失败后原样抛出，toast 变成错误", async () => {
    render(<Toaster />);
    const { result } = toast.promise(Promise.reject(new Error("坏了")), {
      loading: "保存中",
      success: "已保存",
      error: "保存失败",
      description: (error) => (error as Error).message,
    });
    await expect(result).rejects.toThrow("坏了");
    await screen.findByText("保存失败");
    expect(screen.getByText("坏了")).not.toBeNull();
    expect(screen.getByRole("status").dataset.kind).toBe("error");
  });
});

describe("关闭按钮（常驻提示）", () => {
  const closeName = "关闭提示";

  it.each([
    ["错误", () => toast.error("保存失败")],
    [
      "带动作",
      () =>
        toast.info("已归档", {
          action: { label: "撤销", onClick: () => undefined },
        }),
    ],
    ["加载中", () => toast.loading("正在导出")],
  ] as const)(
    "%s的提示有关闭按钮，是 IconButton，可 Tab 到",
    async (_name, open) => {
      render(<Toaster />);
      act(() => {
        open();
      });
      const shell = await screen.findByRole("status");
      const close = within(shell).getByRole("button", { name: closeName });
      expect(close.dataset.slot).toBe("icon-button");
      expect(close.tabIndex).toBeGreaterThanOrEqual(0);
      close.focus();
      expect(document.activeElement).toBe(close);
    },
  );

  it("点击关闭按钮：这一条消失，并触发 onDismiss", async () => {
    render(<Toaster />);
    const onDismiss = vi.fn();
    act(() => {
      toast.error("保存失败", { onDismiss });
    });
    fireEvent.click(await screen.findByRole("button", { name: closeName }));
    await waitFor(() => expect(screen.queryByText("保存失败")).toBeNull());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("焦点在壳内按 Esc 关闭", async () => {
    render(<Toaster />);
    act(() => {
      toast.error("保存失败");
    });
    const close = await screen.findByRole("button", { name: closeName });
    close.focus();
    fireEvent.keyDown(close, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("保存失败")).toBeNull());
  });

  it("带动作时，动作按钮与关闭按钮并存，动作仍可用", async () => {
    render(<Toaster />);
    const undo = vi.fn();
    act(() => {
      toast.error("已删除", { action: { label: "撤销", onClick: undo } });
    });
    const shell = await screen.findByRole("status");
    expect(within(shell).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(within(shell).getByRole("button", { name: "撤销" }));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("自动消失的提示不加关闭按钮，外观不变", async () => {
    render(<Toaster />);
    act(() => {
      toast.success("已保存");
      toast.info("已更新", { duration: 2000 });
    });
    await screen.findByText("已更新");
    expect(screen.queryByRole("button", { name: closeName })).toBeNull();
  });

  it("promise 失败变成常驻提示后出现关闭按钮；成功（2 秒）没有", async () => {
    render(<Toaster />);
    const ok = toast.promise(Promise.resolve(1), {
      loading: "保存中",
      success: "已保存",
      error: "失败",
    });
    await ok.result;
    await screen.findByText("已保存");
    expect(screen.queryByRole("button", { name: closeName })).toBeNull();
    act(() => {
      sonner.dismiss();
    });
    const bad = toast.promise(Promise.reject(new Error("x")), {
      loading: "保存中",
      success: "已保存",
      error: "保存失败",
    });
    await expect(bad.result).rejects.toThrow("x");
    await screen.findByText("保存失败");
    expect(screen.getByRole("button", { name: closeName })).not.toBeNull();
  });

  it("英文界面的名称是 Dismiss notification", async () => {
    usePreferencesStore.setState({ locale: "en" });
    try {
      render(<Toaster />);
      act(() => {
        toast.error("Save failed");
      });
      await screen.findByRole("button", { name: "Dismiss notification" });
    } finally {
      usePreferencesStore.setState({ locale: "zh-CN" });
    }
  });
});

describe("时长约定", () => {
  it("错误与带动作的不自动消失，其余 4 秒，调用方可覆盖", () => {
    const action = { label: "撤销", onClick: () => undefined };
    expect(toastDuration("error")).toBe(Infinity);
    expect(toastDuration("success", { action })).toBe(Infinity);
    expect(toastDuration("info", { action })).toBe(Infinity);
    expect(toastDuration("loading")).toBe(Infinity);
    expect(toastDuration("success")).toBe(TOAST_DURATION_MS);
    expect(toastDuration("info")).toBe(4000);
    expect(toastDuration("error", { duration: 1000 })).toBe(1000);
  });

  it("传给 sonner 的 duration 就是这个值", () => {
    const custom = vi.spyOn(sonner, "custom");
    toast.error("坏了");
    toast.success("好了", {
      action: { label: "撤销", onClick: () => undefined },
    });
    toast.info("嗯");
    expect(custom.mock.calls.map((call) => call[1]?.duration)).toEqual([
      Infinity,
      Infinity,
      4000,
    ]);
  });
});

describe("Toaster 配置固定", () => {
  it("最多 3 层、间距 8、边距 16、不用 richColors", async () => {
    render(<Toaster />);
    act(() => {
      toast("一");
    });
    const region = await waitFor(() => {
      const found = document.querySelector(
        "[data-sonner-toaster]",
      ) as HTMLElement | null;
      expect(found).not.toBeNull();
      return found!;
    });
    const item = region.querySelector("[data-sonner-toast]") as HTMLElement;
    expect(item.getAttribute("data-rich-colors")).toBe("false");
    // 外观由 toast.custom 的壳给，sonner 自己的底色与边距不介入
    expect(item.getAttribute("data-styled")).toBe("false");
    expect(region.style.getPropertyValue("--gap")).toBe("8px");
    expect(region.style.getPropertyValue("--offset-bottom")).toBe("16px");
    expect(region.style.zIndex).toBe("var(--z-toast)");
  });

  it("最多同时显示 3 条", async () => {
    render(<Toaster />);
    act(() => {
      for (const text of ["一", "二", "三", "四", "五"]) toast(text);
    });
    await screen.findByText("五");
    const visible = document.querySelectorAll(
      "[data-sonner-toast][data-visible='true']",
    );
    expect(visible.length).toBeLessThanOrEqual(3);
  });
});
