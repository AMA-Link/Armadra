import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import type { SourceConnection } from "@/sources/connection";
import { SourcesProvider } from "@/sources/context";
import { createSourceRegistry, type SourceRegistry } from "@/sources/registry";
import type { SourceDescriptor } from "@/sources/types";
import { useCanvasStore } from "@/store/canvas-store";
import { presenceClientId } from "@/store/canvas/presence";
import { SharedWorkspaceBar } from "./SharedWorkspaceBar";

/** 打开别人分享的工作空间：顶栏写主人、工作空间与权限，后面是在线的其他人。 */

const descriptor = (
  sourceId: string,
  patch: Partial<SourceDescriptor> = {},
): SourceDescriptor => ({
  sourceId,
  kind: "relayed",
  label: `${sourceId}-pc`,
  baseUrl: "",
  relayOrigin: "https://relay.test",
  cloudIssuer: "https://relay.test",
  fingerprint: "",
  orderIndex: 1,
  ...patch,
});

const fake = (d: SourceDescriptor) =>
  ({
    descriptor: d,
    status: { state: "ready", via: "relayed", since: 1, lastError: null },
    subscribe: () => () => undefined,
    source: { sourceId: d.sourceId },
    hello: null,
    connect: async () => undefined,
    disconnect: () => undefined,
  }) as unknown as SourceConnection;

let registry: SourceRegistry;
beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  registry = createSourceRegistry({ connect: fake });
  registry.add(
    descriptor("ann", {
      origin: "shared",
      ownerName: "Ann",
      shareRole: "viewer",
    }),
  );
  registry.add(descriptor("mine"));
});
afterEach(() => {
  cleanup();
  registry.dispose();
  act(() => useCanvasStore.getState().setWorkspace(null));
});

const open = (sourceId: string) =>
  act(() =>
    useCanvasStore
      .getState()
      .setWorkspace({ id: "w1", name: "Book" } as Workspace, sourceId),
  );

const mount = () =>
  render(
    <SourcesProvider registry={registry}>
      <SharedWorkspaceBar />
    </SourcesProvider>,
  );

describe("SharedWorkspaceBar", () => {
  it("别人分享的：<主人> 的 <工作空间> · 权限", () => {
    open("ann");
    mount();
    expect(screen.getByText("Ann's Book")).toBeTruthy();
    expect(screen.getByText("View only")).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("我自己的电脑、本机、没打开工作空间：什么也不画", () => {
    mount();
    expect(document.querySelector("[data-shared-workspace-bar]")).toBeNull();
    open("mine");
    expect(document.querySelector("[data-shared-workspace-bar]")).toBeNull();
    open("local");
    expect(document.querySelector("[data-shared-workspace-bar]")).toBeNull();
  });

  it("有在线的其他设备：列出头像，不含自己", () => {
    open("ann");
    act(() =>
      useCanvasStore.setState({
        boardId: "b1",
        presence: {
          boardId: "b1",
          clients: [
            {
              clientId: presenceClientId(),
              deviceName: "Me",
              deviceKey: "",
              lastSeenAt: "",
            },
            {
              clientId: "other",
              deviceName: "Bob",
              deviceKey: "",
              lastSeenAt: "",
            },
          ],
          lease: null,
        },
      }),
    );
    mount();
    const members = screen.getByRole("group", { name: "Online members" });
    expect(members.textContent).toBe("B");
    expect(screen.getByLabelText("Bob")).toBeTruthy();
  });
});
