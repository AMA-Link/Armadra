import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const resume = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../api/identity", async (original) => ({
  ...(await original<typeof import("../api/identity")>()),
  resumeIdentity: resume,
}));
// 登录表单本身另有测试：这里只要「登录成功」那一下。
vi.mock("../session/SignIn", () => ({
  SignIn: ({
    onSignedIn,
  }: {
    onSignedIn: (session: unknown, mfa: boolean) => void;
  }) => (
    <>
      <button type="button" onClick={() => onSignedIn({}, false)}>
        signed-in
      </button>
      <button type="button" onClick={() => onSignedIn({}, true)}>
        signed-in-mfa
      </button>
    </>
  ),
}));

import { installDomPolyfills } from "./test-harness";
import { IdentityGate } from "./IdentityGate";

installDomPolyfills();
afterEach(() => cleanup());

function mount(reloadAfterSignIn: (section: string | null) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <IdentityGate server reloadAfterSignIn={reloadAfterSignIn}>
        <div>画布</div>
      </IdentityGate>
    </QueryClientProvider>,
  );
}

describe("服务器壳页内登录成功：整页重载一次（契约 §88.1）", () => {
  it("重载一次，不在本页直接进壳；要登记第二因素的重载后打开「安全」", async () => {
    const reload = vi.fn();
    mount(reload);
    fireEvent.click(await screen.findByRole("button", { name: "signed-in" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText("画布")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "signed-in-mfa" }));
    expect(reload).toHaveBeenLastCalledWith("security");
  });
});
