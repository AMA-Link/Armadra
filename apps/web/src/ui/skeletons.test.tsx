import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Skeleton } from "@/ui/skeleton";
import {
  SKELETON_ROW,
  SkeletonCard,
  SkeletonForm,
  SkeletonList,
  SkeletonNodeBody,
  SkeletonRow,
  SkeletonSettings,
  SkeletonTable,
  SkeletonTurns,
} from "@/ui/skeletons";

afterEach(cleanup);

describe("Skeleton", () => {
  it("脉冲在 prefers-reduced-motion 下停掉", () => {
    const { container } = render(<Skeleton className="h-3" />);
    const node = container.firstElementChild as HTMLElement;
    expect(node.className).toContain("animate-pulse");
    expect(node.className).toContain("motion-reduce:animate-none");
  });
});

describe("通用骨架", () => {
  it("每个骨架是 status 区域并标 aria-busy；给了 label 才可被朗读", () => {
    const { container } = render(
      <>
        <SkeletonList label="加载" />
        <SkeletonCard label="加载" />
        <SkeletonTable label="加载" />
        <SkeletonForm label="加载" />
        <SkeletonSettings label="加载" />
        <SkeletonNodeBody label="加载" />
        <SkeletonTurns label="加载" />
      </>,
    );
    const regions = container.querySelectorAll("[role=status]");
    expect(regions).toHaveLength(7);
    for (const region of regions) {
      expect(region.getAttribute("aria-busy")).toBe("true");
      expect(region.getAttribute("aria-label")).toBe("加载");
    }
    const { container: silent } = render(<SkeletonList />);
    expect(silent.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("行高取自统一档位，与真实行同高（不跳动）", () => {
    for (const size of ["compact", "default", "tall"] as const) {
      const { container } = render(<SkeletonRow size={size} />);
      const row = container.firstElementChild as HTMLElement;
      expect(row.className).toContain(SKELETON_ROW[size]);
      cleanup();
    }
    const { container } = render(<SkeletonRow secondary />);
    expect((container.firstElementChild as HTMLElement).className).toContain(
      SKELETON_ROW.tall,
    );
  });

  it("行数 / 列数 / 回合数与参数一致，宽度序列固定（两次渲染一样）", () => {
    const html = () =>
      render(<SkeletonTable rows={4} columns={3} />).container.innerHTML;
    const first = html();
    cleanup();
    expect(html()).toBe(first);
    cleanup();
    const { container } = render(<SkeletonTable rows={4} columns={3} />);
    expect(container.querySelectorAll("[data-slot=skeleton-table-row]")).toHaveLength(4);
    expect(
      container.querySelectorAll("[data-slot=skeleton-table-row]")[0]!.querySelectorAll(
        "[data-slot=skeleton]",
      ),
    ).toHaveLength(3);
    cleanup();
    const turns = render(<SkeletonTurns turns={2} />).container;
    expect(turns.querySelectorAll("[data-slot=skeleton]")).toHaveLength(6);
  });
});
