import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CloudConsoleError, describeFailure } from "../api/errors";
import { h1, mount, installConsoleHarness } from "../testkit";

installConsoleHarness();

const typeInto = (label: string, value: string, within_?: HTMLElement) =>
  fireEvent.change(
    within_
      ? within(within_).getByLabelText(label)
      : screen.getByLabelText(label),
    { target: { value } },
  );

describe("账号 · 资料", () => {
  it("名字失焦保存，成功提示「已保存」", async () => {
    const api = mount("/me/account");
    const update = vi.spyOn(api.client.me, "update");
    expect((await h1()).textContent).toBe("账号");
    const name = await screen.findByRole("textbox", { name: "名字" });
    expect((name as HTMLInputElement).value).toBe("张三");
    fireEvent.change(name, { target: { value: "张三丰" } });
    fireEvent.blur(name);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ displayName: "张三丰" }),
    );
    expect((await screen.findAllByText("已保存")).length).toBeGreaterThan(0);
  });

  it("更改邮箱：口令不对贴在口令下，邮箱已注册贴在邮箱下，成功后出现「待验证」", async () => {
    mount("/me/account");
    fireEvent.click(await screen.findByRole("button", { name: "更改邮箱" }));
    const dialog = await screen.findByRole("dialog");
    typeInto("新邮箱", "new@example.com", dialog);
    typeInto("当前口令", "wrong", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    const passwordError = await within(dialog).findByText(
      describeFailure(new CloudConsoleError("credentials_invalid", 401)),
    );
    expect(
      within(dialog)
        .getByLabelText("当前口令")
        .getAttribute("aria-describedby"),
    ).toBe(passwordError.id);

    typeInto("当前口令", "right", dialog);
    typeInto("新邮箱", "taken@example.com", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    const emailError = await within(dialog).findByText(
      describeFailure(new CloudConsoleError("email_taken", 409)),
    );
    expect(
      within(dialog).getByLabelText("新邮箱").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(emailError).toBeTruthy();

    typeInto("新邮箱", "new@example.com", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("待验证：new@example.com")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // 旧邮箱照常显示。
    expect(screen.getByText("zhangsan@example.com")).toBeTruthy();
  });

  it("取不到账号：整页状态带重试", async () => {
    mount("/me/account", { fail: { "me.get": "rate_limited" } });
    // 外壳要 me.get，取不到时是整页错误而不是账号页。
    await screen.findByRole("button", { name: "重试" });
  });
});

describe("账号 · 安全", () => {
  it("改口令：当前口令不对贴在当前口令下，新口令太短贴在新口令下，成功后关闭并提示", async () => {
    mount("/me/account?tab=security");
    fireEvent.click(await screen.findByRole("button", { name: "更改口令" }));
    const dialog = await screen.findByRole("dialog");
    const current = within(dialog).getByLabelText("当前口令");
    expect(current.getAttribute("autocomplete")).toBe("current-password");
    expect(
      within(dialog).getByLabelText("新口令").getAttribute("autocomplete"),
    ).toBe("new-password");

    typeInto("当前口令", "wrong", dialog);
    typeInto("新口令", "long enough password", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await within(dialog).findByText(
      describeFailure(new CloudConsoleError("credentials_invalid", 401)),
    );
    expect(document.activeElement).toBe(current);

    typeInto("当前口令", "right", dialog);
    typeInto("新口令", "short", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await within(dialog).findByText(
      describeFailure(new CloudConsoleError("password_too_short", 400)),
    );
    expect(document.activeElement).toBe(
      within(dialog).getByLabelText("新口令"),
    );

    typeInto("新口令", "long enough password", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("口令已更新，其他设备已退出")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("账号 · 设备", () => {
  it("列出设备：当前设备有徽标、没有退出；退出一台后那一行消失", async () => {
    const api = mount("/me/account?tab=devices");
    const revoke = vi.spyOn(api.client.me, "deviceRevoke");
    const table = await screen.findByRole("table", { name: "设备" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("当前")).toBeTruthy();
    expect(
      within(rows[0]!).queryByRole("button", { name: /^退出/ }),
    ).toBeNull();
    expect(within(rows[1]!).getByText("iOS")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "退出 iPad" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("退出「iPad」？")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "退出" }));
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith({ deviceId: "dev_ipad" }),
    );
    await waitFor(() => expect(screen.queryByText("iPad")).toBeNull());
    expect(screen.getByText("build-01")).toBeTruthy();
  });

  it("退出其他全部：只剩当前设备，按钮随之消失", async () => {
    mount("/me/account?tab=devices");
    fireEvent.click(
      await screen.findByRole("button", { name: "退出其他全部" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("退出其他全部设备？")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "退出" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "退出其他全部" })).toBeNull(),
    );
    const table = screen.getByRole("table", { name: "设备" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });

  it("加载与错", async () => {
    mount("/me/account?tab=devices", { latencyMs: 80 });
    await h1();
    expect(document.querySelector("[data-slot='skeleton-table']")).toBeTruthy();
    await screen.findByRole("table", { name: "设备" });
  });

  it("取不到设备：区块内错误带重试，页签还在", async () => {
    mount("/me/account?tab=devices", {
      fail: { "me.devices": "rate_limited" },
    });
    expect(await screen.findByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });
});

describe("账号 · 安全日志", () => {
  it("事件名走文案，设备与 IP 前缀分列；游标分页", async () => {
    mount("/me/account?tab=log", { extraLog: 60 });
    const table = await screen.findByRole("table", { name: "安全日志" });
    const first = within(table).getAllByRole("row")[1]!;
    expect(within(first).getByText("登录")).toBeTruthy();
    expect(within(first).getByText("Chrome")).toBeTruthy();
    expect(within(first).getByText("203.0.113.0/24")).toBeTruthy();
    expect(screen.getByText("新设备登录")).toBeTruthy();
    expect(screen.getByText("更改口令")).toBeTruthy();
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 50);
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() =>
      expect(within(table).getAllByRole("row")).toHaveLength(1 + 64),
    );
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("空：「没有记录」", async () => {
    mount("/me/account?tab=log", { without: ["log"] });
    expect(await screen.findByText("没有记录")).toBeTruthy();
  });

  it("页签进地址，不认识的页签回到资料", async () => {
    mount("/me/account?tab=nope");
    expect(await screen.findByRole("textbox", { name: "名字" })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "安全日志" }));
    fireEvent.click(screen.getByRole("tab", { name: "安全日志" }));
    await waitFor(() => expect(window.location.search).toBe("?tab=log"));
  });
});
