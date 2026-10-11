import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "@armadra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "@/app/preferences-store";
import type { SourceConnection } from "@/sources/connection";
import { SourcesProvider } from "@/sources/context";
import { createSourceRegistry, type SourceRegistry } from "@/sources/registry";
import type { SourceDescriptor } from "@/sources/types";
import { useCanvasStore } from "@/store/canvas-store";
import { CanvasTopBar } from "./CanvasTopBar";

/** 画布右上那一排：别人分享来的工作空间才挂「<主人> 的 <工作空间>」。 */

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
    <QueryClientProvider client={new QueryClient()}>
      <SourcesProvider registry={registry}>
        <CanvasTopBar />
      </SourcesProvider>
    </QueryClientProvider>,
  );

describe("CanvasTopBar（#301 B5）", () => {
  it("别人分享的工作空间：挂上分享标识", () => {
    open("ann");
    mount();
    const bar = document.querySelector("[data-slot=canvas-top-bar]");
    expect(bar?.querySelector("[data-shared-workspace-bar]")).toBeTruthy();
    expect(screen.getByText("Ann's Book")).toBeTruthy();
  });

  it("本机与我自己的电脑：这一排是空的", () => {
    open("local");
    mount();
    expect(document.querySelector("[data-shared-workspace-bar]")).toBeNull();
    open("mine");
    expect(document.querySelector("[data-shared-workspace-bar]")).toBeNull();
  });
});
