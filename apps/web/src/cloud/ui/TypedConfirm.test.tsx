import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TypedConfirm } from "./TypedConfirm";

afterEach(cleanup);

function setup(onConfirm = vi.fn(), onOpenChange = vi.fn()) {
  render(
    <TypedConfirm
      open
      onOpenChange={onOpenChange}
      title="删除「研发组」？"
      expected="rd"
      actionLabel="删除团队"
      onConfirm={onConfirm}
    />,
  );
  return {
    onConfirm,
    onOpenChange,
    input: screen.getByLabelText("输入 rd 确认") as HTMLInputElement,
    confirm: () =>
      fireEvent.click(screen.getByRole("button", { name: "删除团队" })),
  };
}

describe("TypedConfirm", () => {
  it("确认按钮不预先禁用；输入不一致时点击 → aria-invalid、报错一行、聚焦，不调用确认", () => {
    const { input, confirm, onConfirm } = setup();
    const button = screen.getByRole("button", {
      name: "删除团队",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "r" } });
    confirm();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByText("与 rd 不一致");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(document.activeElement).toBe(input);
  });

  it("继续输入就清掉错误", () => {
    const { input, confirm } = setup();
    confirm();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "rd" } });
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("与 rd 不一致")).toBeNull();
  });

  it("一致才确认，成功后关闭；回车同样提交", async () => {
    const { input, onConfirm, onOpenChange } = setup();
    fireEvent.change(input, { target: { value: "rd" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("确认抛错时对话框留着", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("x"));
    const { input, confirm, onOpenChange } = setup(onConfirm);
    fireEvent.change(input, { target: { value: "rd" } });
    confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "删除团队" })
          .getAttribute("aria-busy"),
      ).toBe("false"),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("取消在左、确认在右", () => {
    setup();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["取消", "删除团队"]);
  });
});
