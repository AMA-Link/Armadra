import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";
import { RuntimeRequestError } from "@/api/request";

const api = vi.hoisted(() => ({
  listSources: vi.fn(),
  shareStatus: vi.fn(),
  cloudAccess: vi.fn(),
  cloudGrantCreate: vi.fn(),
  cloudGrantUpdate: vi.fn(),
  cloudGrantRevoke: vi.fn(),
  cloudInvite: vi.fn(),
  notifyShellSourcesChanged: vi.fn(),
}));
vi.mock("@/api/remote-services", async (original) => ({
  ...(await original<typeof import("@/api/remote-services")>()),
  ...api,
}));
vi.mock("@/agent/sessions", async (original) => ({
  ...(await original<typeof import("@/agent/sessions")>()),
  sessionsQuery: (workspaceId: string | null) => ({
    queryKey: ["test-sessions", workspaceId],
    queryFn: async () => [],
  }),
}));
const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@/ui/toast", () => ({ toast: toasts }));

import { ShareDialog } from "./ShareDialog";
import { openShare, useShareStore } from "./share-store";

const ISSUER = "https://cloud.test";
const local = {
  sourceId: "h".repeat(32),
  kind: "local",
  label: "this-mac",
  baseUrl: "",
  relayOrigin: "",
  fingerprint: "",
  cloudIssuer: "",
  principalHint: "owner",
  addedAtMs: 1,
  lastOkAtMs: 1,
  orderIndex: 0,
  hasCredentials: true,
};
const cloud = {
  serviceId: "cloud",
  kind: "saas",
  issuer: ISSUER,
  label: "cloud.test",
  accountHint: "ada@example.test",
  fingerprint: "",
  addedAtMs: 1,
  lastOkAtMs: 1,
  registered: true,
  hasCredentials: true,
  guest: false,
};
const members = [
  { accountId: "a2", email: "bo@x.test", displayName: "Bo", role: "member" },
  { accountId: "a3", email: "cy@x.test", displayName: "Cy", role: "guest" },
];
const baseAccess = {
  sourceId: local.sourceId,
  space: { kind: "team", teamId: "t1" },
  allowGuests: true,
  canManage: true,
  members,
  grants: [],
};

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  api.notifyShellSourcesChanged.mockResolvedValue(false);
  api.listSources.mockResolvedValue({ sources: [local], remotes: [cloud] });
  api.shareStatus.mockResolvedValue({
    sourceId: local.sourceId,
    registrations: [],
  });
  api.cloudAccess.mockResolvedValue(baseAccess);
  api.cloudGrantCreate.mockResolvedValue({ grant: {} });
  api.cloudInvite.mockResolvedValue({
    invitation: { invitationId: "i1", email: "new@x.test", expiresAtMs: 9 },
  });
});
afterEach(() => {
  cleanup();
  for (const spy of [...Object.values(api), ...Object.values(toasts)])
    spy.mockReset();
  act(() => useShareStore.getState().close());
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ShareDialog />
    </QueryClientProvider>,
  );
  act(() => openShare({ workspaceId: "w1", workspaceName: "Project" }));
}

async function section() {
  const dialog = await screen.findByTestId("share-dialog");
  await waitFor(() =>
    expect(dialog.querySelector("[data-slot=share-cloud]")).not.toBeNull(),
  );
  return within(dialog.querySelector("[data-slot=share-cloud]") as HTMLElement);
}

function choose(
  scope: ReturnType<typeof within>,
  trigger: string,
  option: string,
) {
  fireEvent.pointerDown(scope.getByRole("combobox", { name: trigger }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(screen.getByRole("option", { name: option }));
}

async function pickMember(scope: ReturnType<typeof within>, name: string) {
  fireEvent.click(scope.getByRole("combobox", { name: "Member" }));
  fireEvent.click(
    await screen.findByRole("option", { name: new RegExp(name) }),
  );
}

describe("分享弹层：Armadra 云的授予与邀请（云端控制台 §3.5.2）", () => {
  it("没登记到 Armadra 云：不出现", async () => {
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [{ ...cloud, registered: false }],
    });
    mount();
    const dialog = await screen.findByTestId("share-dialog");
    await waitFor(() => expect(api.listSources).toHaveBeenCalled());
    expect(dialog.querySelector("[data-slot=share-cloud]")).toBeNull();
    expect(api.cloudAccess).not.toHaveBeenCalled();
  });

  it("个人中转不出现这一组", async () => {
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [{ ...cloud, kind: "personal" }],
    });
    mount();
    const dialog = await screen.findByTestId("share-dialog");
    await waitFor(() => expect(api.listSources).toHaveBeenCalled());
    expect(dialog.querySelector("[data-slot=share-cloud]")).toBeNull();
  });

  it("管不了这台主机（canManage = false）：整组收起", async () => {
    api.cloudAccess.mockResolvedValue({
      ...baseAccess,
      canManage: false,
      members: [],
    });
    mount();
    const dialog = await screen.findByTestId("share-dialog");
    await waitFor(() => expect(api.cloudAccess).toHaveBeenCalled());
    expect(dialog.querySelector("[data-slot=share-cloud]")).toBeNull();
  });

  it("授予给团队成员：缺省只读、此工作空间、7 天", async () => {
    mount();
    const scope = await section();
    await pickMember(scope, "Bo");
    fireEvent.click(scope.getByRole("button", { name: "Grant" }));
    await waitFor(() => expect(api.cloudGrantCreate).toHaveBeenCalled());
    const call = api.cloudGrantCreate.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      serviceId: "cloud",
      subject: { kind: "member", accountId: "a2" },
      role: "viewer",
      workspaceIds: ["w1"],
    });
    expect(call.expiresAtMs - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(call.expiresAtMs - Date.now()).toBeLessThan(7.1 * 86_400_000);
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Granted Bo"),
    );
  });

  it("访客按 guest 授予，且限定工作空间（团队主机上不能整台）", async () => {
    mount();
    const scope = await section();
    choose(scope, "Scope", "Whole computer");
    choose(scope, "Role", "Can edit");
    await pickMember(scope, "Cy");
    fireEvent.click(scope.getByRole("button", { name: "Grant" }));
    await waitFor(() =>
      expect(api.cloudGrantCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: { kind: "guest", accountId: "a3" },
          role: "editor",
          workspaceIds: ["w1"],
        }),
      ),
    );
  });

  it("成员可以整台：workspaceIds 为空", async () => {
    mount();
    const scope = await section();
    choose(scope, "Scope", "Whole computer");
    await pickMember(scope, "Bo");
    fireEvent.click(scope.getByRole("button", { name: "Grant" }));
    await waitFor(() =>
      expect(api.cloudGrantCreate).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceIds: [] }),
      ),
    );
  });

  it("成员已有授予：主按钮是「更新」，改成表单里的值（云端对新建一律 conflict）", async () => {
    api.cloudAccess.mockResolvedValue({
      ...baseAccess,
      grants: [
        {
          grantId: "g1",
          subject: { kind: "member", accountId: "a2" },
          role: "viewer",
          workspaceIds: ["w1"],
          expiresAtMs: null,
        },
      ],
    });
    api.cloudGrantUpdate.mockResolvedValue({ grant: {} });
    mount();
    const scope = await section();
    choose(scope, "Role", "Can edit");
    choose(scope, "Scope", "Whole computer");
    await pickMember(scope, "Bo");
    expect(scope.queryByRole("button", { name: "Grant" })).toBeNull();
    fireEvent.click(scope.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(api.cloudGrantUpdate).toHaveBeenCalled());
    expect(api.cloudGrantUpdate.mock.calls[0]?.[0]).toMatchObject({
      serviceId: "cloud",
      grantId: "g1",
      role: "editor",
      workspaceIds: [],
    });
    expect(api.cloudGrantCreate).not.toHaveBeenCalled();
  });

  it("更新成更低的角色：先提示会降低有效角色，确认后才发", async () => {
    api.cloudAccess.mockResolvedValue({
      ...baseAccess,
      grants: [
        {
          grantId: "g1",
          subject: { kind: "member", accountId: "a2" },
          role: "driver",
          workspaceIds: ["w1"],
          expiresAtMs: null,
        },
      ],
    });
    api.cloudGrantUpdate.mockResolvedValue({ grant: {} });
    mount();
    const scope = await section();
    await pickMember(scope, "Bo");
    fireEvent.click(scope.getByRole("button", { name: "Update" }));
    expect(
      await scope.findByText(
        "This would lower Bo's role, narrow the scope or shorten the expiry",
      ),
    ).toBeTruthy();
    expect(api.cloudGrantUpdate).not.toHaveBeenCalled();
    fireEvent.click(scope.getByRole("button", { name: "Update anyway" }));
    await waitFor(() =>
      expect(api.cloudGrantUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ role: "viewer", grantId: "g1" }),
      ),
    );
  });

  it("邀请的邮箱是已有授予的成员，且更宽而更低：先提示（合成规则 #112），确认后才发", async () => {
    api.cloudAccess.mockResolvedValue({
      ...baseAccess,
      grants: [
        {
          grantId: "g1",
          subject: { kind: "member", accountId: "a2" },
          role: "driver",
          workspaceIds: ["w1"],
          expiresAtMs: null,
        },
      ],
    });
    mount();
    const scope = await section();
    choose(scope, "Scope", "Whole computer");
    fireEvent.change(scope.getByRole("textbox", { name: "Email" }), {
      target: { value: "BO@x.test" },
    });
    fireEvent.click(scope.getByRole("button", { name: "Invite" }));
    expect(
      await scope.findByText(
        "Wider scope with a lower role may lower Bo's effective role. The cloud rejects it when they accept",
      ),
    ).toBeTruthy();
    expect(api.cloudInvite).not.toHaveBeenCalled();
    fireEvent.click(scope.getByRole("button", { name: "Invite anyway" }));
    await waitFor(() =>
      expect(api.cloudInvite).toHaveBeenCalledWith(
        expect.objectContaining({ email: "BO@x.test", workspaceIds: [] }),
      ),
    );
  });

  it("邀请的邮箱不降低已有的有效角色：直接发", async () => {
    api.cloudAccess.mockResolvedValue({
      ...baseAccess,
      grants: [
        {
          grantId: "g1",
          subject: { kind: "member", accountId: "a2" },
          role: "viewer",
          workspaceIds: [],
          expiresAtMs: null,
        },
      ],
    });
    mount();
    const scope = await section();
    choose(scope, "Scope", "Whole computer");
    fireEvent.change(scope.getByRole("textbox", { name: "Email" }), {
      target: { value: "bo@x.test" },
    });
    fireEvent.click(scope.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(api.cloudInvite).toHaveBeenCalledTimes(1));
    expect(scope.queryByRole("button", { name: "Invite anyway" })).toBeNull();
  });

  it("授予的错误按 code 取文案", async () => {
    api.cloudGrantCreate.mockRejectedValueOnce(
      new RuntimeRequestError(403, "x", "guests_disabled"),
    );
    mount();
    const scope = await section();
    await pickMember(scope, "Cy");
    fireEvent.click(scope.getByRole("button", { name: "Grant" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(
        "Guests are off. Turn them on in settings",
      ),
    );
    api.cloudGrantCreate.mockRejectedValueOnce(
      new RuntimeRequestError(409, "x", "conflict"),
    );
    fireEvent.click(scope.getByRole("button", { name: "Grant" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenLastCalledWith(
        "They already have a grant on this computer. Adjust it in the list",
      ),
    );
  });

  it("按邮箱邀请：范围与到期同上，邮箱不像样时不能点", async () => {
    mount();
    const scope = await section();
    const invite = scope.getByRole("button", { name: "Invite" });
    expect(invite.hasAttribute("disabled")).toBe(true);
    fireEvent.change(scope.getByRole("textbox", { name: "Email" }), {
      target: { value: "new@x.test" },
    });
    choose(scope, "Expires in", "30 days");
    fireEvent.click(invite);
    await waitFor(() => expect(api.cloudInvite).toHaveBeenCalled());
    const call = api.cloudInvite.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      serviceId: "cloud",
      email: "new@x.test",
      role: "viewer",
      workspaceIds: ["w1"],
    });
    expect(call.expiresAtMs - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Invited new@x.test"),
    );
  });

  it("团队关了访客：邀请整行不渲染", async () => {
    api.cloudAccess.mockResolvedValue({ ...baseAccess, allowGuests: false });
    mount();
    const scope = await section();
    expect(scope.queryByRole("textbox", { name: "Email" })).toBeNull();
    expect(scope.getByRole("combobox", { name: "Member" })).toBeTruthy();
  });

  it("个人空间的主机：没有成员选择，只有邀请", async () => {
    api.cloudAccess.mockResolvedValue({
      ...baseAccess,
      space: { kind: "personal" },
      members: [],
    });
    mount();
    const scope = await section();
    expect(scope.queryByRole("combobox", { name: "Member" })).toBeNull();
    expect(scope.getByRole("textbox", { name: "Email" })).toBeTruthy();
  });

  it("已授予的人：改权限与移除", async () => {
    api.cloudAccess.mockResolvedValue({
      ...baseAccess,
      grants: [
        {
          grantId: "g1",
          subject: { kind: "member", accountId: "a2" },
          role: "viewer",
          workspaceIds: ["w1"],
          expiresAtMs: null,
        },
        {
          grantId: "g2",
          subject: { kind: "member", accountId: "a3" },
          role: "editor",
          workspaceIds: ["other"],
          expiresAtMs: null,
        },
      ],
    });
    api.cloudGrantUpdate.mockResolvedValue({ grant: {} });
    api.cloudGrantRevoke.mockResolvedValue({});
    mount();
    const scope = await section();
    const list = scope.getByRole("list", { name: "Granted" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    choose(within(list), "Bo · Role", "Can edit");
    await waitFor(() =>
      expect(api.cloudGrantUpdate).toHaveBeenCalledWith({
        serviceId: "cloud",
        grantId: "g1",
        role: "editor",
      }),
    );
    fireEvent.click(within(list).getByRole("button", { name: "Remove Bo" }));
    expect(api.cloudGrantRevoke).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(api.cloudGrantRevoke).toHaveBeenCalledWith("cloud", "g1"),
    );
  });

  it("更新只放宽范围：已有部分范围时并上当前工作空间，到期没改就不传", async () => {
    api.cloudAccess.mockResolvedValue({
      ...baseAccess,
      grants: [
        {
          grantId: "g1",
          subject: { kind: "member", accountId: "a2" },
          role: "viewer",
          workspaceIds: ["other"],
          expiresAtMs: Date.now() + 86_400_000,
        },
      ],
    });
    api.cloudGrantUpdate.mockResolvedValue({ grant: {} });
    mount();
    const scope = await section();
    choose(scope, "Role", "Can edit");
    await pickMember(scope, "Bo");
    fireEvent.click(scope.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(api.cloudGrantUpdate).toHaveBeenCalled());
    const call = api.cloudGrantUpdate.mock.calls[0]?.[0];
    expect(call.workspaceIds).toEqual(["other", "w1"]);
    expect("expiresAtMs" in call).toBe(false);
  });

  it("已有整台授予：更新保持整台；明确改了到期才传，缩短到期要确认", async () => {
    api.cloudAccess.mockResolvedValue({
      ...baseAccess,
      grants: [
        {
          grantId: "g1",
          subject: { kind: "member", accountId: "a2" },
          role: "viewer",
          workspaceIds: [],
          expiresAtMs: Date.now() + 20 * 86_400_000,
        },
      ],
    });
    api.cloudGrantUpdate.mockResolvedValue({ grant: {} });
    mount();
    const scope = await section();
    choose(scope, "Expires in", "1 day");
    await pickMember(scope, "Bo");
    fireEvent.click(scope.getByRole("button", { name: "Update" }));
    expect(
      await scope.findByRole("button", { name: "Update anyway" }),
    ).toBeTruthy();
    expect(api.cloudGrantUpdate).not.toHaveBeenCalled();
    fireEvent.click(scope.getByRole("button", { name: "Update anyway" }));
    await waitFor(() => expect(api.cloudGrantUpdate).toHaveBeenCalled());
    const call = api.cloudGrantUpdate.mock.calls[0]?.[0];
    expect(call.workspaceIds).toEqual([]);
    expect(call.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("行里降级走同一确认", async () => {
    api.cloudAccess.mockResolvedValue({
      ...baseAccess,
      grants: [
        {
          grantId: "g1",
          subject: { kind: "member", accountId: "a2" },
          role: "editor",
          workspaceIds: ["w1"],
          expiresAtMs: null,
        },
      ],
    });
    api.cloudGrantUpdate.mockResolvedValue({ grant: {} });
    mount();
    const scope = await section();
    const list = scope.getByRole("list", { name: "Granted" });
    choose(within(list), "Bo · Role", "View only");
    expect(api.cloudGrantUpdate).not.toHaveBeenCalled();
    fireEvent.click(
      await scope.findByRole("button", { name: "Update anyway" }),
    );
    await waitFor(() =>
      expect(api.cloudGrantUpdate).toHaveBeenCalledWith({
        serviceId: "cloud",
        grantId: "g1",
        role: "viewer",
      }),
    );
  });

  it("团队主机：访客的授予与非成员的邀请不能选「整台主机」", async () => {
    mount();
    const scope = await section();
    await pickMember(scope, "Cy");
    fireEvent.pointerDown(scope.getByRole("combobox", { name: "Scope" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(
      screen
        .getByRole("option", { name: "Whole computer" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
  });

  it("邀请的 409 是「已有待接受的邀请」，和授予的文案分开", async () => {
    api.cloudInvite.mockRejectedValueOnce(
      new RuntimeRequestError(409, "x", "conflict"),
    );
    mount();
    const scope = await section();
    fireEvent.change(scope.getByRole("textbox", { name: "Email" }), {
      target: { value: "bo@x.test" },
    });
    fireEvent.click(scope.getByRole("button", { name: "Invite" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(
        "An invitation is already pending, or it conflicts with their grant",
      ),
    );
  });
});
