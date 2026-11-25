import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AGENT_IDS } from "@armadra/shared";

import { agentMark } from "@/agent/launch";
import { NodeTypeMark } from "./NodeTypeMark";

describe("NodeTypeMark (#969)", () => {
  it("每家内置 Agent 的类型标记互不相同", () => {
    const marks = AGENT_IDS.map((id) => agentMark(id));
    expect(new Set(marks).size).toBe(AGENT_IDS.length);
    expect(agentMark("codex")).toBe("CX");
    expect(agentMark("agy")).toBe("AG");
  });

  it("Agent 画两字符标记，悬停是全名", () => {
    const { container } = render(<NodeTypeMark agentId="claude" />);
    const mark = container.querySelector('[data-slot="node-type-mark"]')!;
    expect(mark.getAttribute("aria-label")).toBe("Claude Code");
    expect(mark.textContent).toBe("CC");
  });

  it("普通终端画终端图标", () => {
    const { container } = render(<NodeTypeMark agentId={undefined} />);
    const mark = container.querySelector('[data-slot="node-type-mark"]');
    expect(mark?.querySelector("svg")).not.toBeNull();
    expect(mark?.getAttribute("role")).toBe("img");
  });
});
