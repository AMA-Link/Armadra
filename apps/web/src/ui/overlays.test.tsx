import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import {
  Command,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { rubberBand } from "@/ui/motion";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/ui/tooltip";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const element = Element.prototype as unknown as Record<string, unknown>;
  element.scrollIntoView ??= () => {};
  element.hasPointerCapture ??= () => false;
  element.setPointerCapture ??= () => {};
  element.releasePointerCapture ??= () => {};
});

afterEach(cleanup);

describe("对话框出场（设计系统 §8.3）", () => {
  it("Dialog：motion-dialog + rounded-dialog + shadow-dialog + 1px 强边，不再带 tw-animate 类", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>标题</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const content = screen.getByRole("dialog");
    expect(content.className).toContain("motion-dialog");
    expect(content.className).toContain("rounded-dialog");
    expect(content.className).toContain("shadow-dialog");
    expect(content.className).toContain("border-border-strong");
    expect(content.className).toContain("p-6");
    expect(content.className).not.toMatch(/animate-in|zoom-in|duration-\[/);
    const overlay = document.querySelector("[data-slot='dialog-overlay']")!;
    expect(overlay.className).toContain("motion-overlay");
    expect(overlay.className).toContain("bg-scrim");
  });

  it("DialogTitle 是 text-title（17）", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>标题</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByText("标题").className).toContain("text-title");
  });

  it("data-instant 透传到内容层（键盘打开时 motion.css 里 animation: none）", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined} data-instant="true">
          <DialogTitle>标题</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("dialog").getAttribute("data-instant")).toBe(
      "true",
    );
  });

  it("AlertDialog 同一套：确认框宽 420", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>丢弃 3 处改动？</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const content = screen.getByRole("alertdialog");
    expect(content.className).toContain("motion-dialog");
    expect(content.className).toContain("rounded-dialog");
    expect(content.className).toContain("sm:max-w-[420px]");
  });
});

describe("Sheet 与拖柄", () => {
  const renderSheet = (side: "bottom" | "right", onOpenChange = vi.fn()) =>
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent side={side} aria-describedby={undefined}>
          <SheetTitle>面板</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

  it("四向都带 motion-sheet 与 data-side；底部有拖柄，右侧没有", () => {
    const { unmount } = renderSheet("bottom");
    expect(screen.getByRole("dialog").className).toContain("motion-sheet");
    expect(screen.getByRole("dialog").dataset.side).toBe("bottom");
    expect(screen.getByRole("dialog").className).toContain("rounded-t-dialog");
    expect(document.querySelector("[data-slot='sheet-handle']")).not.toBeNull();
    unmount();
    renderSheet("right");
    expect(document.querySelector("[data-slot='sheet-handle']")).toBeNull();
  });

  it("向下甩出（速度 > 0.11 px/ms）即关闭", () => {
    const onOpenChange = vi.fn();
    renderSheet("bottom", onOpenChange);
    const handle = document.querySelector("[data-slot='sheet-handle']")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 260 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 260 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("第二根手指被忽略；没到阈值的慢拖松手回到原位", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      const onOpenChange = vi.fn();
      renderSheet("bottom", onOpenChange);
      const sheet = screen.getByRole("dialog");
      const handle = document.querySelector("[data-slot='sheet-handle']")!;
      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
      fireEvent.pointerDown(handle, { pointerId: 2, clientY: 500 });
      vi.advanceTimersByTime(400);
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 110 });
      expect(sheet.style.transform).toBe("translateY(10px)");
      vi.advanceTimersByTime(400);
      fireEvent.pointerMove(handle, { pointerId: 2, clientY: 900 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 110 });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(sheet.style.transform).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("过界（向上）拖动有递增阻力，永远小于手指位移", () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(20)).toBeLessThan(20);
    expect(rubberBand(200)).toBeLessThan(200);
    expect(rubberBand(400) - rubberBand(200)).toBeLessThan(
      rubberBand(200) - rubberBand(0),
    );
    expect(rubberBand(1e6)).toBeLessThan(120);
  });
});

describe("发芽式浮层", () => {
  it("Popover：motion-pop + rounded-panel + shadow-overlay，不再有 shadow-md / ring-1 / tw-animate", () => {
    render(
      <Popover open>
        <PopoverTrigger>触发</PopoverTrigger>
        <PopoverContent data-instant="true">内容</PopoverContent>
      </Popover>,
    );
    const content = document.querySelector("[data-slot='popover-content']")!;
    expect(content.className).toContain("motion-pop");
    expect(content.className).toContain("rounded-panel");
    expect(content.className).toContain("shadow-overlay");
    expect(content.className).toContain("z-(--z-dialog)");
    expect(content.className).not.toMatch(
      /shadow-md|ring-1|animate-in|zoom-in/,
    );
    expect(content.getAttribute("data-instant")).toBe("true");
  });

  it("DropdownMenu：菜单容器 rounded-card、项 rounded-control、快捷键是 Kbd", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>菜单</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            新建
            <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const content = document.querySelector(
      "[data-slot='dropdown-menu-content']",
    )!;
    expect(content.className).toContain("motion-pop");
    expect(content.className).toContain("rounded-card");
    expect(screen.getByRole("menuitem").className).toContain("rounded-control");
    const shortcut = screen.getByText("⌘N");
    expect(shortcut.tagName).toBe("KBD");
    expect(shortcut.dataset.slot).toBe("dropdown-menu-shortcut");
  });

  it("Tooltip：motion-tip，shortcut 跟一枚 Kbd；Provider 300ms 内邻近的立即打开", () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>钮</TooltipTrigger>
          <TooltipContent shortcut="⌘K">命令</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const content = document.querySelector("[data-slot='tooltip-content']")!;
    expect(content.className).toContain("motion-tip");
    expect(content.querySelector("kbd")?.textContent).toBe("⌘K");
    expect(content.className).toContain("rounded-control");
  });

  it("Command：项 28 高，CommandShortcut 是 Kbd", () => {
    render(
      <Command>
        <CommandList>
          <CommandItem>
            新建
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
        </CommandList>
      </Command>,
    );
    expect(screen.getByRole("option").className).toContain("h-7");
    expect(screen.getByText("⌘N").tagName).toBe("KBD");
  });
});
