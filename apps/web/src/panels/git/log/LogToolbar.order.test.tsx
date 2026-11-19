import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { storedGitPreferences } from "@/app/preferences/git";
import { LogToolbar } from "./LogToolbar";

installDomPolyfills();
afterEach(cleanup);

/** 排序控件（#976）：时间优先 / 拓扑优先，选择写进 `git.logOrder`。 */
describe("日志工具栏的排序", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePreferencesStore.setState({
      locale: "en",
      git: storedGitPreferences(),
    });
  });

  function openOrder() {
    render(
      <TestProviders>
        <LogToolbar
          authors={[]}
          references={[]}
          repositories={[]}
          myEmail={null}
        />
      </TestProviders>,
    );
    const trigger = screen.getByRole("button", { name: "Sort" });
    fireEvent.keyDown(trigger, { key: "Enter" });
  }

  it("缺省时间优先，选拓扑优先后写进偏好并落盘", () => {
    expect(usePreferencesStore.getState().git.logOrder).toBe("date");
    openOrder();
    expect(
      screen
        .getByRole("menuitemradio", { name: "Date first" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Topology first" }),
    );
    expect(usePreferencesStore.getState().git.logOrder).toBe("topo");
    expect(window.localStorage.getItem("armadra.git.logOrder")).toBe("topo");
    expect(storedGitPreferences().logOrder).toBe("topo");
  });
});
