import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { requestGitUncommitted, useGitUncommittedRequest } from "./focus";

function Probe({ onRequest }: { onRequest: () => void }) {
  useGitUncommittedRequest(onRequest);
  return null;
}

afterEach(cleanup);

describe("「Git：未提交的变更」请求（#927 B4）", () => {
  it("请求早于组件挂上：挂上时认领，只认领一次", () => {
    requestGitUncommitted();
    const first = vi.fn();
    render(<Probe onRequest={first} />);
    expect(first).toHaveBeenCalledTimes(1);
    cleanup();
    const second = vi.fn();
    render(<Probe onRequest={second} />);
    expect(second).not.toHaveBeenCalled();
  });

  it("已经挂着时请求经事件到达", () => {
    const onRequest = vi.fn();
    render(<Probe onRequest={onRequest} />);
    requestGitUncommitted();
    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});
