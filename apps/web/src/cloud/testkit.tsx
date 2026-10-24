import { cleanup, configure, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { toast } from "@/ui/toast";

import { ConsoleRoot } from "./ConsoleRoot";
import type { HostEndorser } from "./trust/endorser";
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

/**
 * 异步查询（`findBy*` / `waitFor`）的等待上限。页面从挂载到可见要经过会话、空间、数据几跳调度，
 * 安静时约 50ms；整机满载（并行跑多个 vitest）时同一件事会慢到 1 秒以上，默认的 1000ms
 * 就成了偶发超时（team.test.tsx 在负载均值 270 下复现）。上限放宽只影响失败时的等待，不改变通过时的耗时。
 */
const ASYNC_UTIL_TIMEOUT_MS = 5000;
/** 用例整体的上限要高于查询的等待上限，否则先超时的是用例而不是查询。 */
const TEST_TIMEOUT_MS = 20_000;

export function installConsoleHarness() {
  vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });
  beforeEach(() => {
    viewport(false);
    configure({ asyncUtilTimeout: ASYNC_UTIL_TIMEOUT_MS });
  });
  afterEach(() => {
    // 卸载之前清提示（全局 setup 在每条用例前也会清）。
    toast.dismiss();
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    visit("/");
  });
}

export function mount(
  path: string,
  options: MockOptions = {},
  endorser: HostEndorser | null = null,
  prepare?: (api: MockApi) => void,
): MockApi {
  visit(path);
  const api = createMockApi(options);
  prepare?.(api);
  render(<ConsoleRoot api={api} endorser={endorser} />);
  return api;
}

export const h1 = () => screen.findByRole("heading", { level: 1 });
