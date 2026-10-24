import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { installDomPolyfills } from "../../app/test-harness";
import { MOCK_PERSONAL, MOCK_TEAMS } from "../mock/fixtures";
import { h1, installConsoleHarness, mount } from "../testkit";
import { addPendingIds } from "../mock/pending-ids";
import type { HostEndorser } from "./endorser";

installConsoleHarness();
installDomPolyfills();

const OPTIONS = { emailVerified: true, moreTrust: true } as const;

/** 受信设备上的端到端实现：`trusted` 里的主机能背书。 */
function endorser(
  trusted: readonly string[],
  approve: HostEndorser["approve"] = async () => undefined,
): HostEndorser & { approve: ReturnType<typeof vi.fn> } {
  return {
    canEndorse: async (sourceId) => trusted.includes(sourceId),
    approve: vi.fn(approve),
  };
}

const rows = async () => {
  const table = await screen.findByRole("table", { name: "设备信任" });
  return within(table).getAllByRole("row").slice(1);
};

async function openDialog(row: HTMLElement) {
  fireEvent.click(await within(row).findByRole("button", { name: "信任" }));
  return screen.findByRole("dialog");
}

const typeCode = (dialog: HTMLElement, code: string) =>
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: code },
  });

describe("团队 · 设备信任", () => {
  it("列：成员、设备、平台、主机、请求时间；没有校验码", async () => {
    const api = mount("/t/rd/trust", OPTIONS);
    expect((await h1()).textContent).toBe("设备信任");
    const list = await rows();
    expect(list).toHaveLength(2);
    // 最近的请求在后（按云端返回的顺序），逐行核对。
    const text = list.map((row) => row.textContent ?? "").join("|");
    expect(text).toContain("李四");
    expect(text).toContain("iPad");
    expect(text).toContain("iOS");
    expect(text).toContain("赵六");
    expect(text).toContain("Pixel 9");
    expect(text).toContain("Android");
    expect(text).toContain("build-01");
    // 访客的请求只给主机所有者：别人主机（mac-studio）上的访客请求本人看不到。
    expect(text).not.toContain("Galaxy S");
    // 列表里没有 6 位数字（校验码）；云端的答复里也没有 `sas` 字段。
    expect(text).not.toMatch(/\d{6}/);
    const answer = await api.client.trust.list({
      space: { kind: "team", teamId: "team_mock_rd" },
    });
    expect(JSON.stringify(answer)).not.toMatch(/sas/i);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("不是该主机的受信设备：行尾是「在已信任的设备上处理」，不渲染按钮", async () => {
    mount("/t/rd/trust", OPTIONS, endorser([]), addPendingIds);
    const list = await rows();
    for (const row of list) {
      await waitFor(() =>
        expect(within(row).getByText("在已信任的设备上处理")).toBeTruthy(),
      );
      expect(within(row).queryByRole("button")).toBeNull();
    }
  });

  it("没有端到端实现时同样不给按钮", async () => {
    mount("/t/rd/trust", OPTIONS);
    const [first] = await rows();
    expect(within(first!).getByText("在已信任的设备上处理")).toBeTruthy();
    expect(within(first!).queryByRole("button")).toBeNull();
  });

  it("请求不带 core 的 pendingId（现契约）：即使这台浏览器是受信设备也不可背书", async () => {
    mount("/t/rd/trust", OPTIONS, endorser([MOCK_PERSONAL.linkHost]));
    const [first] = await rows();
    expect(within(first!).getByText("在已信任的设备上处理")).toBeTruthy();
    expect(within(first!).queryByRole("button")).toBeNull();
  });

  it("是受信设备：按主机判定，只有那台主机的行有「拒绝 / 信任」", async () => {
    // 李四的请求在 laptop 号那台主机，赵六的在 build-01。
    mount(
      "/t/rd/trust",
      OPTIONS,
      endorser([MOCK_PERSONAL.linkHost]),
      addPendingIds,
    );
    const list = await rows();
    const byName = (name: string) =>
      list.find((row) => row.textContent?.includes(name))!;
    await within(byName("李四")).findByRole("button", { name: "信任" });
    expect(
      within(byName("李四")).getByRole("button", { name: "拒绝" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        within(byName("赵六")).getByText("在已信任的设备上处理"),
      ).toBeTruthy(),
    );
    expect(within(byName("赵六")).queryByRole("button")).toBeNull();
  });

  it("信任：输入 6 位码交给端到端通道，成功后关闭；码不进地址与本地存储", async () => {
    const host = endorser(["any"]);
    host.canEndorse = async () => true;
    mount("/t/rd/trust", OPTIONS, host, addPendingIds);
    const list = await rows();
    const ipad = list.find((row) => row.textContent?.includes("李四"))!;
    const dialog = await openDialog(ipad);
    expect(within(dialog).getByText("信任 李四 的 iPad？")).toBeTruthy();
    const input = within(dialog).getByRole("textbox") as HTMLInputElement;
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    const confirm = within(dialog).getByRole("button", { name: "信任" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    typeCode(dialog, "482916");
    // 输入过程中码不出现在地址与存储里。
    expect(window.location.href).not.toContain("482916");
    expect(JSON.stringify({ ...localStorage })).not.toContain("482916");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("482916");
    fireEvent.click(confirm);
    await waitFor(() => expect(host.approve).toHaveBeenCalledTimes(1));
    const [request, sas] = host.approve.mock.calls[0] as [
      { requestId: string; pendingId: string },
      string,
    ];
    expect(request.requestId).toBe("trust_ipad");
    // 交给主机的是 core 的 pendingId，不是云端的请求号。
    expect(request.pendingId).toBe("pending_trust_ipad");
    expect(sas).toBe("482916");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.href).not.toContain("482916");
  });

  it("校验码不一致：留在对话框里提示，改码后可再试", async () => {
    const host = endorser([], async (_request, sas) => {
      if (sas === "000000")
        throw Object.assign(new Error("sas_mismatch"), {
          code: "sas_mismatch",
        });
    });
    host.canEndorse = async () => true;
    mount("/t/rd/trust", OPTIONS, host, addPendingIds);
    const ipad = (await rows()).find((row) =>
      row.textContent?.includes("李四"),
    )!;
    const dialog = await openDialog(ipad);
    typeCode(dialog, "000000");
    fireEvent.click(within(dialog).getByRole("button", { name: "信任" }));
    expect(await within(dialog).findByText("校验码不一致")).toBeTruthy();
    typeCode(dialog, "123456");
    expect(within(dialog).queryByText("校验码不一致")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "信任" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("主机说这台浏览器不是受信设备：改成「在已信任的设备上处理」，不再给「信任」", async () => {
    const host = endorser([], async () => {
      throw Object.assign(new Error("device_untrusted"), {
        code: "device_untrusted",
      });
    });
    host.canEndorse = async () => true;
    mount("/t/rd/trust", OPTIONS, host, addPendingIds);
    const ipad = (await rows()).find((row) =>
      row.textContent?.includes("李四"),
    )!;
    const dialog = await openDialog(ipad);
    typeCode(dialog, "111111");
    fireEvent.click(within(dialog).getByRole("button", { name: "信任" }));
    expect(
      await within(dialog).findByText("在已信任的设备上处理"),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "信任" })).toBeNull();
  });

  it("主机答 forbidden：只这一条请求记成不可背书，同一台主机的另一条仍可信任", async () => {
    const host = endorser([], async (request) => {
      if (request.pendingId === "pending_trust_ipad")
        throw Object.assign(new Error("forbidden"), { code: "forbidden" });
    });
    const probe = vi.fn(async () => true);
    host.canEndorse = probe;
    // goldenTrust 多一条与 iPad 同一台主机的请求。
    mount(
      "/t/rd/trust",
      { ...OPTIONS, goldenTrust: true },
      host,
      addPendingIds,
    );
    const lisi = async () =>
      (await rows()).filter((row) => row.textContent?.includes("李四"));
    expect(await lisi()).toHaveLength(2);
    const dialog = await openDialog((await lisi())[0]!);
    // 同一台主机只判一次受信（两条李四 + 赵六，两台主机）。
    expect(probe).toHaveBeenCalledTimes(2);
    typeCode(dialog, "222222");
    fireEvent.click(within(dialog).getByRole("button", { name: "信任" }));
    expect(
      await within(dialog).findByText("在已信任的设备上处理"),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "信任" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 最终状态：被拒的那条是徽标、没有按钮；没有重判把按钮请回来。
    const [refused, sibling] = await lisi();
    expect(within(refused!).getByText("在已信任的设备上处理")).toBeTruthy();
    expect(within(refused!).queryByRole("button")).toBeNull();
    await new Promise((done) => setTimeout(done, 30));
    expect(within((await lisi())[0]!).queryByRole("button")).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
    // 同一台主机的另一条请求不受影响，还能信任。
    expect(within(sibling!).getByRole("button", { name: "信任" })).toBeTruthy();
    const second = await openDialog(sibling!);
    typeCode(second, "333333");
    fireEvent.click(within(second).getByRole("button", { name: "信任" }));
    await waitFor(() => expect(host.approve).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("主机答 device_untrusted：这台主机的受信判定作废重判，被拒的那条仍不可背书", async () => {
    const host = endorser([], async () => {
      throw Object.assign(new Error("device_untrusted"), {
        code: "device_untrusted",
      });
    });
    const probe = vi.fn(async () => true);
    host.canEndorse = probe;
    mount("/t/rd/trust", OPTIONS, host, addPendingIds);
    const ipad = (await rows()).find((row) =>
      row.textContent?.includes("李四"),
    )!;
    const dialog = await openDialog(ipad);
    typeCode(dialog, "222222");
    fireEvent.click(within(dialog).getByRole("button", { name: "信任" }));
    expect(
      await within(dialog).findByText("在已信任的设备上处理"),
    ).toBeTruthy();
    await waitFor(() => expect(probe.mock.calls.length).toBeGreaterThan(2));
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const after = (await rows()).find((row) =>
      row.textContent?.includes("李四"),
    )!;
    expect(within(after).queryByRole("button")).toBeNull();
  });

  it("通道一时开不了（判定抛错）：这一行按不可背书画，不渲染按钮", async () => {
    const host = endorser([]);
    host.canEndorse = vi.fn(async () => {
      throw Object.assign(new Error("e"), { code: "e2e_device_unavailable" });
    });
    mount("/t/rd/trust", OPTIONS, host, addPendingIds);
    for (const row of await rows()) {
      await waitFor(() =>
        expect(within(row).getByText("在已信任的设备上处理")).toBeTruthy(),
      );
      expect(within(row).queryByRole("button")).toBeNull();
    }
  });

  it("受信判定缓存：同一台主机重复进页面不再重开通道（窗口聚焦也不重判）", async () => {
    const host = endorser([]);
    const probe = vi.fn(async () => true);
    host.canEndorse = probe;
    mount("/t/rd/trust", OPTIONS, host, addPendingIds);
    await rows();
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((done) => setTimeout(done, 30));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("拒绝：先二次确认；只调 trust.reject（请求号，不带码），这一行消失", async () => {
    const host = endorser([]);
    host.canEndorse = async () => true;
    const api = mount("/t/rd/trust", OPTIONS, host, addPendingIds);
    const reject = vi.spyOn(api.client.trust, "reject");
    const ipad = (await rows()).find((row) =>
      row.textContent?.includes("李四"),
    )!;
    fireEvent.click(await within(ipad).findByRole("button", { name: "拒绝" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("拒绝 李四 的 iPad？")).toBeTruthy();
    expect(reject).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(reject).toHaveBeenCalledWith({ requestId: "trust_ipad" }),
    );
    await waitFor(() => expect(screen.queryByText("李四")).toBeNull());
    expect(host.approve).not.toHaveBeenCalled();
  });

  it("deviceTrustRequested / Resolved 只让列表过期，不触发受信判定重判（免得判定与事件回环）", async () => {
    const host = endorser([]);
    const probe = vi.fn(async () => true);
    host.canEndorse = probe;
    let listed = 0;
    const api = mount("/t/rd/trust", OPTIONS, host, (made) => {
      addPendingIds(made);
      const list = made.client.trust.list;
      made.client.trust.list = (async (...args: Parameters<typeof list>) => {
        listed += 1;
        return list(...args);
      }) as typeof list;
    });
    await rows();
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(listed).toBe(1);
    // 带团队页实际的 teamId（rd 团队）：走的是团队空间的失效路径，不是个人空间的。
    const teamId = MOCK_TEAMS[0]!.teamId;
    act(() =>
      api.emit({
        type: "deviceTrustRequested",
        requestId: "trust_new",
        sourceId: "s",
        teamId,
        atMs: 1,
      } as never),
    );
    await waitFor(() => expect(listed).toBe(2));
    act(() =>
      api.emit({
        type: "deviceTrustResolved",
        requestId: "trust_new",
        outcome: "trusted",
        teamId,
        atMs: 1,
      } as never),
    );
    await waitFor(() => expect(listed).toBe(3));
    await new Promise((done) => setTimeout(done, 50));
    await rows();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("deviceTrustResolved 让列表重拉；空：「没有待信任的设备」", async () => {
    const api = mount("/t/rd/trust", { emailVerified: true });
    await rows();
    await api.client.trust.reject({ requestId: "trust_ipad" });
    act(() =>
      api.emit({
        type: "deviceTrustResolved",
        requestId: "trust_ipad",
      } as never),
    );
    expect(await screen.findByText("没有待信任的设备")).toBeTruthy();
  });

  it("取数失败：整页错误状态可重试", async () => {
    mount("/t/rd/trust", {
      ...OPTIONS,
      fail: { "trust.list": "rate_limited" },
    });
    await screen.findByRole("button", { name: "重试" });
  });
});
