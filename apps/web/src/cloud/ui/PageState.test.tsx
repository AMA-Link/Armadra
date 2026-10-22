import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageState, pageStateKind } from "./PageState";

afterEach(cleanup);

describe("pageStateKind", () => {
  it("错误码落到四种之一", () => {
    expect(pageStateKind("not_found")).toBe("notFound");
    expect(pageStateKind("unavailable")).toBe("maintenance");
    expect(pageStateKind("storage_unavailable")).toBe("maintenance");
    for (const code of [
      "unauthenticated",
      "session_expired",
      "session_revoked",
    ])
      expect(pageStateKind(code)).toBe("sessionExpired");
    expect(pageStateKind("forbidden")).toBe("error");
    expect(pageStateKind()).toBe("error");
  });
});

describe("PageState", () => {
  it("按 code 的错误：标题是该码的文案，一个「重试」", () => {
    const onRetry = vi.fn();
    render(<PageState code="forbidden" onRetry={onRetry} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "没有权限执行这个操作",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("认不出的码退到通用错误句，没给回调就没有按钮", () => {
    render(<PageState code="nonsense" />);
    expect(screen.getByRole("heading").textContent).toBe(
      "核心处理这个请求时失败",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("找不到 + 回到概览", () => {
    const onHome = vi.fn();
    render(<PageState kind="notFound" onHome={onHome} />);
    expect(screen.getByRole("heading").textContent).toBe("找不到这个页面");
    fireEvent.click(screen.getByRole("button", { name: "回到概览" }));
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("维护中（unavailable）+ 重试", () => {
    const onRetry = vi.fn();
    render(<PageState code="unavailable" onRetry={onRetry} />);
    expect(screen.getByRole("heading").textContent).toBe("服务维护中");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("登录已过期 + 重新登录", () => {
    const onSignIn = vi.fn();
    render(<PageState code="session_expired" onSignIn={onSignIn} />);
    expect(screen.getByRole("heading").textContent).toBe("登录已过期");
    fireEvent.click(screen.getByRole("button", { name: "重新登录" }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });
});
