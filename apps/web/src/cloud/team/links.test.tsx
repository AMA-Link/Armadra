import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { h1, installConsoleHarness, mount } from "../testkit";

installConsoleHarness();

describe("团队 · 链接", () => {
  it("列出团队主机上的链接：备注、目标、权限、用量；个人主机上的链接不在其中", async () => {
    mount("/t/rd/links", { emailVerified: true });
    expect((await h1()).textContent).toBe("链接");
    const table = await screen.findByRole("table", { name: "链接" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("For Bob")).toBeTruthy();
    expect(
      within(rows[0]!).getByRole("link", { name: "build-01" }),
    ).toBeTruthy();
    expect(screen.queryByText("给小李看进度")).toBeNull();
    // 链接地址只在新建时出现一次：列表里没有地址。
    expect(screen.queryByText(/\/j\//)).toBeNull();
  });

  it("团队 admin 能撤销；撤销后这一行显示「已撤销」", async () => {
    mount("/t/rd/links", { emailVerified: true });
    const trigger = await screen.findByRole("button", {
      name: "For Bob 的操作",
    });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "撤销链接" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销链接" }));
    expect(await screen.findByText("已撤销")).toBeTruthy();
  });

  it("空：「没有链接」", async () => {
    mount("/t/rd/links", { emailVerified: true, without: ["links"] });
    expect(await screen.findByText("没有链接")).toBeTruthy();
  });
});
