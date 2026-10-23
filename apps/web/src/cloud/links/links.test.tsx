import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CloudConsoleError, describeFailure } from "../api/errors";
import { MOCK_PERSONAL } from "../mock/fixtures";
import { h1, mount, installConsoleHarness } from "../testkit";

installConsoleHarness();

async function openMenu(name: string) {
  const trigger = await screen.findByRole("button", { name });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

const typeInto = (label: string, value: string, within_?: HTMLElement) =>
  fireEvent.change(
    within_
      ? within(within_).getByLabelText(label)
      : screen.getByLabelText(label),
    { target: { value } },
  );

describe("个人 · 链接", () => {
  it("列：备注、目标、权限、用量、到期；过期的有徽标，没有备注的显示「未命名链接」", async () => {
    mount("/me/links");
    expect((await h1()).textContent).toBe("链接");
    const table = await screen.findByRole("table", { name: "链接" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("给小李看进度")).toBeTruthy();
    expect(
      within(rows[0]!)
        .getByRole("link", { name: "laptop" })
        .getAttribute("href"),
    ).toBe(`/me/hosts/${MOCK_PERSONAL.linkHost}`);
    expect(within(rows[0]!).getByText("只读")).toBeTruthy();
    expect(within(rows[0]!).getByText("2 / 5")).toBeTruthy();
    expect(within(rows[0]!).getByText("7 天后到期")).toBeTruthy();
    expect(within(rows[1]!).getByText("未命名链接")).toBeTruthy();
    expect(within(rows[1]!).getByText("可编辑")).toBeTruthy();
    expect(within(rows[1]!).getByText("已过期")).toBeTruthy();
    // 链接地址只在新建时出现一次：列表里没有复制与地址。
    expect(screen.queryByText(/\/j\/link_one/)).toBeNull();
  });

  it("编辑备注：保存后换成新备注", async () => {
    mount("/me/links");
    await openMenu("给小李看进度 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑备注" }));
    const dialog = await screen.findByRole("dialog");
    typeInto("备注", "给小王看进度", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("给小王看进度")).toBeTruthy();
    expect(screen.queryByText("给小李看进度")).toBeNull();
  });

  it("撤销链接：标题带备注、后果一行；确认后这一行变「已撤销」且不能再撤销", async () => {
    const api = mount("/me/links");
    const revoke = vi.spyOn(api.client.links, "revoke");
    await openMenu("给小李看进度 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "撤销链接" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("撤销「给小李看进度」？")).toBeTruthy();
    expect(within(dialog).getByText("已加入的人一并停用")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销链接" }));
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith({ linkId: "link_one" }),
    );
    expect(await screen.findByText("已撤销")).toBeTruthy();
    await openMenu("给小李看进度 的操作");
    expect(screen.queryByRole("menuitem", { name: "撤销链接" })).toBeNull();
  });

  it("撤销失败：按错误码出文案，对话框留着", async () => {
    mount("/me/links", { fail: { "links.revoke": "forbidden" } });
    await openMenu("给小李看进度 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "撤销链接" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销链接" }));
    expect(
      await screen.findByText(
        describeFailure(new CloudConsoleError("forbidden", 403)),
      ),
    ).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("空：「没有链接」", async () => {
    mount("/me/links", { without: ["links"] });
    expect(await screen.findByText("没有链接")).toBeTruthy();
  });

  it("加载：先画骨架", async () => {
    mount("/me/links", { latencyMs: 80 });
    await h1();
    expect(document.querySelector("[data-slot='skeleton-table']")).toBeTruthy();
    await screen.findByText("给小李看进度");
  });

  it("错与没有权限：整页状态", async () => {
    mount("/me/links", { fail: { "links.list": "rate_limited" } });
    await screen.findByRole("button", { name: "重试" });
    expect(document.querySelector("[data-page-state='error']")).toBeTruthy();
  });

  it("没有权限：整页「没有权限」", async () => {
    mount("/me/links", { fail: { "links.list": "forbidden" } });
    await screen.findByRole("button", { name: "回到概览" });
    expect(
      document.querySelector("[data-page-state='forbidden']"),
    ).toBeTruthy();
  });
});
