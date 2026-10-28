import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Check } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import { IconButton } from "@/ui/icon-button";
import { Kbd, KbdGroup } from "@/ui/kbd";
import { ariaKeyShortcuts } from "@/ui/kbd-format";
import { Shimmer } from "@/ui/shimmer";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { STATUS_PILL_LABELS, StatusPill } from "@/ui/status-pill";
import { Switch } from "@/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/ui/accordion";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { ButtonGroup } from "@/ui/button-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { InputGroup, InputGroupInput } from "@/ui/input-group";
import { Select, SelectTrigger, SelectValue } from "@/ui/select";
import { Textarea } from "@/ui/textarea";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/ui/input-otp";
import { Item, ItemContent, ItemTitle } from "@/ui/item";
import { Label } from "@/ui/label";
import { MemberDot, memberColorVar } from "@/ui/member-dot";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { EmptyState, ErrorState } from "@/ui/state";
import { IndicatorGroup, Indicator } from "@/ui/indicator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

beforeAll(() => {
  // Radix 的定位层（floating-ui）在 jsdom 下需要这两个 API
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const element = Element.prototype as unknown as Record<string, unknown>;
  if (!("hasPointerCapture" in element)) {
    element.hasPointerCapture = () => false;
    element.setPointerCapture = () => {};
    element.releasePointerCapture = () => {};
  }
});

afterEach(cleanup);

describe("Button（shadcn 生成）", () => {
  it("默认是 type=button 之外的原生按钮，variant/size 落到 data 属性上", () => {
    render(
      <Button variant="destructive" size="sm">
        删除
      </Button>,
    );
    const button = screen.getByRole("button", { name: "删除" });
    expect(button.dataset.slot).toBe("button");
    expect(button.dataset.variant).toBe("destructive");
    expect(button.dataset.size).toBe("sm");
  });

  it("className 通过 twMerge 覆盖内置尺寸而不是叠加", () => {
    render(<Button className="h-12">高</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("h-12");
    expect(cls).not.toMatch(/\bh-8\b/);
  });

  it("asChild 把样式套到子元素上", () => {
    render(
      <Button asChild>
        <a href="#a">链接</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "链接" }).dataset.slot).toBe(
      "button",
    );
  });
});

describe("StatusPill", () => {
  it("按 tone 打标记并显示文案", () => {
    render(
      <StatusPill tone="attention" label={STATUS_PILL_LABELS.attention} />,
    );
    const pill = screen
      .getByText("Needs you")
      .closest("[data-slot='status-pill']");
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute("data-tone")).toBe("attention");
  });

  it("working / attention 默认脉冲，failed 不脉冲", () => {
    const { container, rerender } = render(
      <StatusPill tone="working" label="Running" />,
    );
    const dot = () => container.querySelector("[data-slot='status-pill-dot']")!;
    expect(dot().className).toContain("anim-dot-pulse");

    rerender(<StatusPill tone="failed" label="Turn failed" />);
    expect(dot().className).not.toContain("anim-dot-pulse");
  });

  it("pulse 可以显式关掉", () => {
    const { container } = render(
      <StatusPill tone="working" label="Running" pulse={false} />,
    );
    expect(
      container.querySelector("[data-slot='status-pill-dot']")!.className,
    ).not.toContain("anim-dot-pulse");
  });

  it("支持尾随内容（队列的 ▶）", () => {
    const { container } = render(
      <StatusPill tone="queued" label="Queued" trailing="▶" />,
    );
    expect(
      container.querySelector("[data-slot='status-pill']")!.textContent,
    ).toBe("Queued▶");
  });
});

describe("ColorDot", () => {
  it("supports semantic status indicators and whiteboard colour swatches", () => {
    const { container } = render(<ColorDot color="#0a84ff" size={8} />);
    const dot = container.querySelector(
      "[data-slot='color-dot']",
    ) as HTMLElement;
    expect(dot.style.width).toBe("8px");
    expect(dot.style.backgroundColor).toBe("rgb(10, 132, 255)");
  });
});

describe("IconButton", () => {
  it("label 变成无障碍名称", () => {
    render(<IconButton label="整理画布" />);
    expect(screen.getByRole("button", { name: "整理画布" })).toBeTruthy();
  });

  it("cluster 是 34×34，inline 是 26×26", () => {
    const { rerender } = render(<IconButton label="设置" size="cluster" />);
    expect(screen.getByRole("button").className).toContain("size-[28px]");
    rerender(<IconButton label="关闭" size="inline" />);
    expect(screen.getByRole("button").className).toContain("size-[24px]");
  });

  it("active 同时反映在 data-active 和 aria-pressed 上", () => {
    render(<IconButton label="固定侧栏" active />);
    const button = screen.getByRole("button", { name: "固定侧栏" });
    expect(button.dataset.active).toBe("true");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("激活态是强调淡底 + 正文色，图标不着强调色", () => {
    render(<IconButton label="固定侧栏" active />);
    const cls = screen.getByRole("button", { name: "固定侧栏" }).className;
    expect(cls).toContain("data-[active=true]:bg-brand-soft");
    expect(cls).toContain("data-[active=true]:text-foreground");
    expect(cls).not.toContain("text-brand-text");
  });
});

describe("其余生成组件的冒烟测试", () => {
  it("Badge 渲染内容", () => {
    render(<Badge variant="secondary">Claude</Badge>);
    expect(screen.getByText("Claude").dataset.slot).toBe("badge");
  });

  it("Kbd 渲染成 <kbd>", () => {
    render(
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>,
    );
    expect(screen.getByText("⌘").tagName).toBe("KBD");
  });

  it("Switch 可以用键盘切换", () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="启用消息" onCheckedChange={onCheckedChange} />);
    const toggle = screen.getByRole("switch", { name: "启用消息" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("Popover 由触发器控制开合", () => {
    render(
      <Popover>
        <PopoverTrigger>打开</PopoverTrigger>
        <PopoverContent>内容</PopoverContent>
      </Popover>,
    );
    expect(screen.queryByText("内容")).toBeNull();
    fireEvent.click(screen.getByText("打开"));
    expect(screen.getByText("内容")).toBeTruthy();
  });
});

describe("设计系统 §3.2 新增的生成组件", () => {
  it("每个组件都能渲染并带 data-slot", () => {
    const { container } = render(
      <div>
        <Avatar>
          <AvatarFallback>A</AvatarFallback>
        </Avatar>
        <Card>
          <CardHeader>
            <CardTitle>卡片</CardTitle>
          </CardHeader>
          <CardContent>正文</CardContent>
        </Card>
        <Alert variant="destructive">
          <AlertTitle>离线</AlertTitle>
          <AlertDescription>重连中</AlertDescription>
        </Alert>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>没有会话</EmptyTitle>
          </EmptyHeader>
        </Empty>
        <Skeleton className="h-4 w-20" />
        <Spinner aria-label="加载中" />
        <Label htmlFor="name">名称</Label>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>行</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Item>
          <ItemContent>
            <ItemTitle>设备</ItemTitle>
          </ItemContent>
        </Item>
        <ButtonGroup>
          <Button variant="outline">允许</Button>
          <Button variant="outline">拒绝</Button>
        </ButtonGroup>
      </div>,
    );
    for (const slot of [
      "avatar",
      "card",
      "alert",
      "empty",
      "skeleton",
      "spinner",
      "label",
      "table",
      "item",
      "button-group",
    ]) {
      expect(
        container.querySelector(`[data-slot='${slot}']`),
        slot,
      ).not.toBeNull();
    }
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("status", { name: "加载中" })).toBeTruthy();
  });

  it("Checkbox 与 RadioGroup 可以点选", () => {
    const onChecked = vi.fn();
    const onValue = vi.fn();
    render(
      <>
        <Checkbox aria-label="记住" onCheckedChange={onChecked} />
        <RadioGroup aria-label="角色" onValueChange={onValue}>
          <RadioGroupItem value="driver" aria-label="驱动" />
          <RadioGroupItem value="editor" aria-label="编辑" />
        </RadioGroup>
      </>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "记住" }));
    expect(onChecked).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("radio", { name: "编辑" }));
    expect(onValue).toHaveBeenCalledWith("editor");
  });

  it("Collapsible 与 Accordion 由触发器展开", () => {
    render(
      <>
        <Collapsible>
          <CollapsibleTrigger>工具调用</CollapsibleTrigger>
          <CollapsibleContent>参数</CollapsibleContent>
        </Collapsible>
        <Accordion type="single" collapsible>
          <AccordionItem value="a">
            <AccordionTrigger>第一组</AccordionTrigger>
            <AccordionContent>记录</AccordionContent>
          </AccordionItem>
        </Accordion>
      </>,
    );
    expect(screen.queryByText("参数")).toBeNull();
    fireEvent.click(screen.getByText("工具调用"));
    expect(screen.getByText("参数")).toBeTruthy();
    const trigger = screen.getByRole("button", { name: "第一组" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("InputOTP 渲染六个格子", () => {
    const { container } = render(
      <InputOTP maxLength={6} aria-label="验证码">
        <InputOTPGroup>
          {Array.from({ length: 6 }, (_, index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </InputOTP>,
    );
    expect(
      container.querySelectorAll("[data-slot='input-otp-slot']"),
    ).toHaveLength(6);
  });

  it("Field 把标签、控件、错误组成一组", () => {
    render(
      <Field data-invalid="true">
        <FieldLabel htmlFor="workspace">工作空间</FieldLabel>
        <Input id="workspace" aria-invalid="true" />
        <FieldError>不能为空</FieldError>
      </Field>,
    );
    const input = screen.getByLabelText("工作空间");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("不能为空");
  });
});

describe("§3.4 状态矩阵", () => {
  it.each([
    ["Button", () => <Button>动作</Button>, "button"],
    ["Checkbox", () => <Checkbox aria-label="动作" />, "checkbox"],
    [
      "RadioGroupItem",
      () => (
        <RadioGroup>
          <RadioGroupItem value="a" aria-label="动作" />
        </RadioGroup>
      ),
      "radio",
    ],
    ["Input", () => <Input aria-label="动作" />, "textbox"],
  ] as const)(
    "%s：focus-visible 3px 50% 环、disabled 50% 不透明、aria-invalid 危险边 + 20% 环",
    (_, make, role) => {
      render(make());
      const cls = screen.getByRole(role, { name: "动作" }).className;
      expect(cls).toContain("focus-visible:ring-3");
      expect(cls).toContain("focus-visible:ring-ring/50");
      expect(cls).toContain("disabled:opacity-50");
      expect(cls).toContain("aria-invalid:border-destructive");
      expect(cls).toContain("aria-invalid:ring-destructive/20");
    },
  );

  it("disabled 真的不可交互", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        保存
      </Button>,
    );
    const button = screen.getByRole("button", { name: "保存" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.className).toContain("disabled:pointer-events-none");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("loading：Spinner 替换图标，按钮仍是同一个元素", () => {
    const { rerender } = render(
      <Button size="sm">
        <Check data-testid="icon" />
        保存
      </Button>,
    );
    const button = screen.getByRole("button", { name: "保存" });
    rerender(
      <Button size="sm" disabled>
        <Spinner aria-label="保存中" />
        保存
      </Button>,
    );
    expect(screen.getByRole("button")).toBe(button);
    expect(screen.queryByTestId("icon")).toBeNull();
    expect(button.querySelector("[data-slot='spinner']")).not.toBeNull();
  });
});

describe("AgentAvatar", () => {
  it("内置 Agent：首字母、标识色底、--on-agent 字", () => {
    render(<AgentAvatar agentId="codex" />);
    const avatar = screen.getByRole("img", { name: "Codex" });
    expect(avatar.dataset.avatarSize).toBe("24");
    expect(avatar.dataset.size).toBe("sm");
    const fallback = avatar.querySelector(
      "[data-slot='avatar-fallback']",
    ) as HTMLElement;
    expect(fallback.textContent).toBe("C");
    expect(fallback.style.backgroundColor).toBe("var(--agent-codex)");
    expect(fallback.style.color).toBe("var(--on-agent)");
  });

  it("20 / 32 两档尺寸", () => {
    const { rerender } = render(<AgentAvatar agentId="claude" size={20} />);
    expect(screen.getByRole("img").className).toContain("size-5");
    rerender(<AgentAvatar agentId="claude" size={32} />);
    expect(screen.getByRole("img").dataset.size).toBe("default");
  });
});

describe("MemberDot", () => {
  it("按序号取 --member-n，带 title", () => {
    const { container } = render(<MemberDot index={3} name="Ada" />);
    const dot = container.querySelector(
      "[data-slot='color-dot']",
    ) as HTMLElement;
    expect(dot.style.backgroundColor).toBe("var(--member-3)");
    expect(dot.title).toBe("Ada");
  });

  it("超过八个按环回绕", () => {
    expect(memberColorVar(1)).toBe("var(--member-1)");
    expect(memberColorVar(8)).toBe("var(--member-8)");
    expect(memberColorVar(9)).toBe("var(--member-1)");
    expect(memberColorVar(18)).toBe("var(--member-2)");
  });
});

describe("Button 变体与尺寸（设计系统 §9）", () => {
  it.each([
    "default",
    "outline",
    "secondary",
    "ghost",
    "destructive",
    "destructive-solid",
    "link",
  ] as const)("variant=%s 落到 data-variant", (variant) => {
    render(<Button variant={variant}>动作</Button>);
    expect(screen.getByRole("button").dataset.variant).toBe(variant);
  });

  it("destructive-solid 是危险实底 + 反白字，不借品牌蓝", () => {
    render(<Button variant="destructive-solid">删除</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("bg-danger-solid");
    expect(cls).toContain("text-primary-foreground");
    expect(cls).not.toContain("bg-primary");
  });

  it.each([
    ["xs", "h-6"],
    ["sm", "h-7"],
    ["default", "h-8"],
    ["lg", "h-9"],
    ["touch", "h-11"],
  ] as const)("size=%s 高度档 %s，圆角统一 rounded-control", (size, height) => {
    render(<Button size={size}>动作</Button>);
    const button = screen.getByRole("button");
    expect(button.dataset.size).toBe(size);
    expect(button.className).toMatch(new RegExp(`\\b${height}\\b`));
    expect(button.className).toContain("rounded-control");
  });

  it("过渡点名属性、按下反馈由 motion-press 给，不用 transition-all", () => {
    render(<Button>动作</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("motion-press");
    expect(cls).not.toContain("transition-all");
  });

  it("static 关掉按下缩放（data-static）", () => {
    render(<Button static>动作</Button>);
    expect(screen.getByRole("button").dataset.static).toBe("true");
  });

  it("loading：aria-busy、不 disabled、Spinner 顶替 data-icon=inline-start 的图标、标签微光、点击被吞", () => {
    const onClick = vi.fn();
    render(
      <Button size="sm" loading onClick={onClick}>
        <Check data-icon="inline-start" data-testid="icon" />
        保存
      </Button>,
    );
    const button = screen.getByRole("button", { name: "保存" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("icon")).toBeNull();
    const spinner = button.querySelector("[data-slot='spinner']");
    expect(spinner).not.toBeNull();
    expect(spinner!.getAttribute("class")).toContain("size-3");
    expect(button.querySelector("[data-slot='shimmer']")).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("loading 结束后恢复图标与点击", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button loading onClick={onClick}>
        <Check data-icon="inline-start" data-testid="icon" />
        保存
      </Button>,
    );
    rerender(
      <Button onClick={onClick}>
        <Check data-icon="inline-start" data-testid="icon" />
        保存
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(screen.getByTestId("icon")).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shortcut：尾部 Kbd 与 aria-keyshortcuts", () => {
    render(<Button shortcut="⌘↵">发送</Button>);
    const button = screen.getByRole("button");
    expect(button.querySelector("kbd")?.textContent).toBe("⌘↵");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
  });
});

describe("ariaKeyShortcuts", () => {
  it.each([
    ["⌘K", "Meta+K"],
    ["⌘⇧P", "Meta+Shift+P"],
    ["Ctrl+Shift+K", "Control+Shift+K"],
    ["↵", "Enter"],
    ["Esc", "Escape"],
    ["⌃⌥↓", "Control+Alt+ArrowDown"],
  ])("%s → %s", (display, expected) => {
    expect(ariaKeyShortcuts(display)).toBe(expected);
  });
});

describe("Badge 尺寸与变体（设计系统 §9）", () => {
  it("sm 18 / md 20，默认 md；圆角 pill、等宽数字", () => {
    const { rerender } = render(<Badge>3</Badge>);
    const badge = () => screen.getByText("3");
    expect(badge().dataset.size).toBe("md");
    expect(badge().className).toContain("h-5");
    rerender(<Badge size="sm">3</Badge>);
    expect(badge().dataset.size).toBe("sm");
    expect(badge().className).toContain("h-[18px]");
    expect(badge().className).toContain("rounded-pill");
    expect(badge().className).toContain("tabular-nums");
  });

  it.each([
    ["success", "bg-success-soft", "text-success-text"],
    ["warn", "bg-warn-soft", "text-warn-text"],
    ["brand", "bg-brand-soft", "text-brand-text"],
    ["destructive", "bg-danger-soft", "text-danger-text"],
  ] as const)("%s 用软底 + 文字色", (variant, bg, text) => {
    render(<Badge variant={variant}>状态</Badge>);
    const cls = screen.getByText("状态").className;
    expect(cls).toContain(bg);
    expect(cls).toContain(text);
  });

  it("九个变体都有 data-variant", () => {
    const variants = [
      "default",
      "secondary",
      "outline",
      "ghost",
      "destructive",
      "link",
      "success",
      "warn",
      "brand",
    ] as const;
    render(
      <>
        {variants.map((variant) => (
          <Badge key={variant} variant={variant}>
            {variant}
          </Badge>
        ))}
      </>,
    );
    for (const variant of variants)
      expect(screen.getByText(variant).dataset.variant).toBe(variant);
  });
});

describe("Kbd / Spinner / Shimmer", () => {
  it("Kbd 在按钮与 Tooltip 内收成 16 高（样式由祖先 data-slot 决定）", () => {
    render(<Kbd>⌘K</Kbd>);
    const cls = screen.getByText("⌘K").className;
    expect(cls).toContain("h-5");
    expect(cls).toContain("in-data-[slot=button]:h-4");
    expect(cls).toContain("in-data-[slot=tooltip-content]:h-4");
    expect(cls).toContain("rounded-tight");
  });

  it("Kbd 的实底按钮配色只认外层按钮自己的变体，不认带 data-variant 的祖先", () => {
    render(<Kbd>↵</Kbd>);
    const cls = screen.getByText("↵").className;
    expect(cls).toContain(
      "group-data-[variant=default]/button:text-primary-foreground",
    );
    expect(cls).toContain(
      "group-data-[variant=destructive-solid]/button:text-primary-foreground",
    );
    expect(cls).not.toContain("in-data-[variant=");
  });

  it("Kbd 与 KbdGroup 在只有粗指针时隐藏，有精细指针（触控板、鼠标）时照常显示", () => {
    render(
      <KbdGroup data-testid="group">
        <Kbd>⌘</Kbd>
      </KbdGroup>,
    );
    for (const element of [screen.getByText("⌘"), screen.getByTestId("group")])
      expect(element.className).toContain(
        "pointer-coarse:not-any-pointer-fine:hidden",
      );
  });

  it("Spinner 两档尺寸与三种状态；done 画对勾，failed 是 ×", () => {
    const { container, rerender } = render(<Spinner size={12} />);
    const spinner = () =>
      container.querySelector("[data-slot='spinner']") as SVGElement;
    expect(spinner().getAttribute("class")).toContain("size-3");
    expect(spinner().getAttribute("class")).toContain("anim-spin");
    rerender(<Spinner />);
    expect(spinner().getAttribute("class")).toContain("size-4");
    rerender(<Spinner state="done" />);
    expect(spinner().dataset.state).toBe("done");
    expect(spinner().querySelector(".anim-check-draw")).not.toBeNull();
    expect(spinner().getAttribute("class")).not.toContain("anim-spin");
    rerender(<Spinner state="failed" />);
    expect(spinner().dataset.state).toBe("failed");
  });

  it("Spinner 有 aria-label 时是 role=status，否则装饰", () => {
    const { container, rerender } = render(<Spinner />);
    expect(
      container
        .querySelector("[data-slot='spinner']")!
        .getAttribute("aria-hidden"),
    ).toBe("true");
    rerender(<Spinner aria-label="保存中" />);
    expect(screen.getByRole("status", { name: "保存中" })).not.toBeNull();
  });

  it("Shimmer：active 时带遮罩类，关掉后原样输出", () => {
    const { rerender } = render(<Shimmer>保存</Shimmer>);
    expect(screen.getByText("保存").className).toContain("anim-shimmer");
    rerender(<Shimmer active={false}>保存</Shimmer>);
    expect(screen.getByText("保存").className).not.toContain("anim-shimmer");
  });
});

describe("Input / Textarea / Select / InputGroup 四档高度（设计系统 §2.13）", () => {
  it.each([
    ["xs", "h-6"],
    ["sm", "h-7"],
    ["default", "h-8"],
    ["touch", "h-11"],
  ] as const)("Input size=%s → %s，圆角 rounded-control", (size, height) => {
    render(<Input aria-label="名称" size={size} />);
    const input = screen.getByRole("textbox");
    expect(input.dataset.size).toBe(size);
    expect(input.className).toMatch(new RegExp(`\\b${height}\\b`));
    expect(input.className).toContain("rounded-control");
  });

  it("Input 手机上 16px（text-base），桌面落回正文档；touch 档任何视口都是 16", () => {
    const { rerender } = render(<Input aria-label="名称" />);
    const cls = () => screen.getByRole("textbox").className;
    expect(cls()).toContain("text-base");
    expect(cls()).toContain("md:text-body");
    rerender(<Input aria-label="名称" size="touch" />);
    expect(cls()).toContain("text-base");
    expect(cls()).not.toContain("md:text-body");
  });

  it("Input 不再把 size 当成原生数字属性，过渡点名属性", () => {
    render(<Input aria-label="名称" />);
    const input = screen.getByRole("textbox");
    expect(input.getAttribute("size")).toBeNull();
    expect(input.className).not.toContain("transition-all");
    expect(input.className).toContain(
      "transition-[color,background-color,border-color]",
    );
  });

  it.each([
    ["xs", "px-1.5"],
    ["sm", "px-2"],
    ["default", "px-2.5"],
    ["touch", "px-3"],
  ] as const)("Textarea size=%s → %s", (size, padding) => {
    render(<Textarea aria-label="备注" size={size} />);
    const area = screen.getByRole("textbox");
    expect(area.dataset.size).toBe(size);
    expect(area.className).toContain(padding);
  });

  it.each([
    ["xs", "data-[size=xs]:h-6"],
    ["sm", "data-[size=sm]:h-7"],
    ["default", "data-[size=default]:h-8"],
    ["touch", "data-[size=touch]:h-11"],
  ] as const)(
    "SelectTrigger size=%s 带 data-size 并有对应高度类",
    (size, cls) => {
      render(
        <Select>
          <SelectTrigger size={size} aria-label="选择">
            <SelectValue placeholder="选择" />
          </SelectTrigger>
        </Select>,
      );
      const trigger = screen.getByRole("combobox");
      expect(trigger.dataset.size).toBe(size);
      expect(trigger.className).toContain(cls);
      expect(trigger.className).toContain("rounded-control");
    },
  );

  it.each([
    ["xs", "h-6"],
    ["sm", "h-7"],
    ["default", "h-8"],
    ["touch", "h-11"],
  ] as const)("InputGroup size=%s → %s", (size, height) => {
    render(
      <InputGroup size={size}>
        <InputGroupInput aria-label="搜索" />
      </InputGroup>,
    );
    const group = screen.getByRole("group");
    expect(group.dataset.size).toBe(size);
    expect(group.className).toMatch(new RegExp(`\\b${height}\\b`));
  });
});

describe("动效 CSS 约定落在组件上（设计系统 §8）", () => {
  it("Switch 与 Checkbox 过渡点名属性、不用 transition-all，Checkbox 圆角 tight", () => {
    render(
      <>
        <Switch aria-label="开关" />
        <Checkbox aria-label="勾选" />
      </>,
    );
    const toggle = screen.getByRole("switch");
    const box = screen.getByRole("checkbox");
    expect(toggle.className).not.toContain("transition-all");
    expect(toggle.className).toContain(
      "transition-[background-color,border-color]",
    );
    expect(box.className).not.toContain("transition-all");
    expect(box.className).toContain("rounded-tight");
  });
});

describe("Tabs segmented / line 与共享指示器（设计系统 §9）", () => {
  const renderTabs = (variant: "segmented" | "line" | "default") =>
    render(
      <Tabs defaultValue="a">
        <TabsList variant={variant} aria-label="范围">
          <TabsTrigger value="a">全部</TabsTrigger>
          <TabsTrigger value="b">本机</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
        <TabsContent value="b">B</TabsContent>
      </Tabs>,
    );

  it("segmented：raised 底、rounded-card、p-[3px]；当前项里有一块指示器，点另一项后移过去", () => {
    renderTabs("segmented");
    const list = screen.getByRole("tablist");
    expect(list.dataset.variant).toBe("segmented");
    expect(list.className).toContain("bg-raised");
    expect(list.className).toContain("rounded-card");
    expect(list.className).toContain("p-[3px]");
    const [first, second] = screen.getAllByRole("tab");
    expect(first!.querySelector("[data-slot='indicator']")).not.toBeNull();
    expect(second!.querySelector("[data-slot='indicator']")).toBeNull();
    fireEvent.mouseDown(second!, { button: 0 });
    expect(second!.getAttribute("aria-selected")).toBe("true");
    expect(second!.querySelector("[data-slot='indicator']")).not.toBeNull();
    expect(first!.querySelector("[data-slot='indicator']")).toBeNull();
    expect(screen.getAllByRole("tab")[1]!.className).toContain(
      "rounded-control",
    );
  });

  it("segmented 触发器 28 高，sm 档 24", () => {
    const { unmount } = renderTabs("segmented");
    expect(screen.getAllByRole("tab")[0]!.className).toContain(
      "group-data-[variant=segmented]/tabs-list:h-7",
    );
    unmount();
    render(
      <Tabs defaultValue="a">
        <TabsList variant="segmented" size="sm">
          <TabsTrigger value="a">全部</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole("tablist").dataset.size).toBe("sm");
    expect(screen.getByRole("tab").className).toContain(
      "group-data-[size=sm]/tabs-list:group-data-[variant=segmented]/tabs-list:h-6",
    );
  });

  it("line：下划线就是指示器，不再用每项的 after 伪元素；default 不画指示器", () => {
    const { unmount } = renderTabs("line");
    const first = screen.getAllByRole("tab")[0]!;
    expect(first.querySelector("[data-slot='indicator']")).not.toBeNull();
    expect(first.className).not.toContain("after:");
    unmount();
    renderTabs("default");
    expect(document.querySelector("[data-slot='indicator']")).toBeNull();
  });

  it("受控的 value 也驱动指示器", () => {
    const { rerender } = render(
      <Tabs value="b">
        <TabsList variant="segmented">
          <TabsTrigger value="a">全部</TabsTrigger>
          <TabsTrigger value="b">本机</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(
      screen.getAllByRole("tab")[1]!.querySelector("[data-slot='indicator']"),
    ).not.toBeNull();
    rerender(
      <Tabs value="a">
        <TabsList variant="segmented">
          <TabsTrigger value="a">全部</TabsTrigger>
          <TabsTrigger value="b">本机</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(
      screen.getAllByRole("tab")[0]!.querySelector("[data-slot='indicator']"),
    ).not.toBeNull();
  });

  it("IndicatorGroup 之外的 Indicator 也能渲染（不平移）", () => {
    render(
      <>
        <Indicator data-testid="solo" />
        <IndicatorGroup id="g">
          <Indicator kind="hover" data-testid="hover" />
        </IndicatorGroup>
      </>,
    );
    expect(screen.getByTestId("solo").dataset.kind).toBe("active");
    expect(screen.getByTestId("hover").dataset.kind).toBe("hover");
    expect(screen.getByTestId("hover").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});

describe("Card 变体（设计系统 §9）", () => {
  it("default：1px 边、rounded-card、无阴影也无 ring", () => {
    render(<Card data-testid="card">内容</Card>);
    const card = screen.getByTestId("card");
    expect(card.dataset.variant).toBe("default");
    expect(card.className).toContain("rounded-card");
    expect(card.className).toContain("border-border");
    expect(card.className).not.toMatch(/\bshadow|ring-1/);
  });

  it("tray 与 table 打 data-variant；table 去掉内边距", () => {
    render(
      <>
        <Card variant="tray" data-testid="tray" />
        <Card variant="table" data-testid="table" />
      </>,
    );
    expect(screen.getByTestId("tray").dataset.variant).toBe("tray");
    expect(screen.getByTestId("table").className).toContain(
      "data-[variant=table]:py-0",
    );
  });
});

describe("Table 与空态", () => {
  it("表头 raised 32 高 text-caption，行 36（sm 28），单元格 px-3", () => {
    const { rerender } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>行</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByText("名称").className).toContain("h-8");
    expect(screen.getByText("名称").className).toContain("bg-raised");
    expect(screen.getByText("名称").className).toContain("text-caption");
    expect(screen.getByText("行").className).toContain("px-3");
    const row = () => screen.getByText("行").closest("tr")!;
    expect(row().className).toContain("h-9");
    expect(document.querySelector("table")!.dataset.size).toBe("default");
    rerender(
      <Table size="sm">
        <TableBody>
          <TableRow>
            <TableCell>行</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(document.querySelector("table")!.dataset.size).toBe("sm");
    expect(row().className).toContain("group-data-[size=sm]/table:h-7");
  });

  it("EmptyState 整块是虚线 1px 框，inline 去掉边框", () => {
    const { rerender } = render(<EmptyState title="暂无记录" />);
    const box = () =>
      document.querySelector("[data-state-kind='empty']") as HTMLElement;
    expect(box().className).toContain("border-dashed");
    expect(box().className).toMatch(/\bborder\b/);
    rerender(<EmptyState title="暂无记录" inline />);
    expect(box().className).toContain("border-0");
  });

  it("ErrorState 行内带重试", () => {
    const retry = vi.fn();
    render(<ErrorState title="加载失败" retryLabel="重试" onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalled();
  });
});
