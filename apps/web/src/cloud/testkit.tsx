import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

import { ConsoleRoot } from "./ConsoleRoot";
import {
  createMockApi,
  type MockApi,
  type MockOptions,
} from "./mock/create-mock-client";

/** 页面测试的公共装置：宽屏 / 窄屏的 `matchMedia`、挂载控制台、清理。 */
export const visit = (path: string) =>
  window.history.replaceState(null, "", path);

/** `narrow` = ≤767（`DataList` 画成 Item）；否则 ≥1024 固定侧栏、表格。 */
export function viewport(narrow: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: narrow
        ? query.includes("max-width: 767px")
        : query.includes("min-width: 1024px"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

export function installConsoleHarness() {
  beforeEach(() => viewport(false));
  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    visit("/");
  });
}

export function mount(path: string, options: MockOptions = {}): MockApi {
  visit(path);
  const api = createMockApi(options);
  render(<ConsoleRoot api={api} />);
  return api;
}

export const h1 = () => screen.findByRole("heading", { level: 1 });
