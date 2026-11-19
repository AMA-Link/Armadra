import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useBareLaunch } from "./use-bare-launch";

function Probe({ id }: { id: string }) {
  return <span data-testid="out">{String(useBareLaunch(id))}</span>;
}

afterEach(cleanup);

describe("useBareLaunch（#975）", () => {
  it("没有查询客户端或设置还没到：关", () => {
    render(<Probe id="claude" />);
    expect(screen.getByTestId("out").textContent).toBe("false");
    cleanup();
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <Probe id="claude" />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("out").textContent).toBe("false");
  });

  it("设置到了跟着变，只认这一家，写回关就撤掉", () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <Probe id="claude" />
      </QueryClientProvider>,
    );
    act(() =>
      client.setQueryData(["settings"], {
        agents: { claude: { bareLaunch: true } },
      }),
    );
    expect(screen.getByTestId("out").textContent).toBe("true");
    cleanup();
    render(
      <QueryClientProvider client={client}>
        <Probe id="codex" />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("out").textContent).toBe("false");
    act(() =>
      client.setQueryData(["settings"], {
        agents: { claude: { bareLaunch: false }, codex: { bareLaunch: true } },
      }),
    );
    expect(screen.getByTestId("out").textContent).toBe("true");
  });
});
