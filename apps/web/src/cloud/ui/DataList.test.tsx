import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DataList, type DataColumn } from "./DataList";

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  status: string;
  seen: string;
  count: number;
}
const rows: Row[] = [
  { id: "1", name: "build-01", status: "在线", seen: "刚刚", count: 3 },
  { id: "2", name: "mac-studio", status: "离线", seen: "3 小时前", count: 12 },
];
const columns: DataColumn<Row>[] = [
  { id: "name", header: "名称", role: "primary", cell: (row) => row.name },
  { id: "status", header: "状态", role: "trailing", cell: (row) => row.status },
  { id: "seen", header: "最近在线", cell: (row) => row.seen },
  { id: "count", header: "数量", numeric: true, cell: (row) => row.count },
];
const props = {
  caption: "主机列表",
  rows,
  columns,
  rowKey: (row: Row) => row.id,
  actions: (row: Row) => <button type="button">打开 {row.name}</button>,
  actionsHeader: "操作",
};

describe("DataList", () => {
  it("≥768 画表格：每列一格，列头与 caption 在，数字列右对齐等宽", () => {
    render(<DataList {...props} layout="table" />);
    const table = screen.getByRole("table", { name: "主机列表" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["名称", "状态", "最近在线", "数量", "操作"]);
    const body = within(table).getAllByRole("row").slice(1);
    expect(body).toHaveLength(2);
    expect(within(body[1]!).getByText("12").className).toContain(
      "tabular-nums",
    );
    expect(within(body[0]!).getByText("打开 build-01")).toBeTruthy();
  });

  it("≤767 画列表：名字与状态在第一行，次要列折进第二行，同一组动作", () => {
    render(<DataList {...props} layout="list" />);
    expect(screen.queryByRole("table")).toBeNull();
    const list = screen.getByRole("list", { name: "主机列表" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const second = items[1]!;
    expect(second.textContent).toContain("mac-studio");
    expect(second.textContent).toContain("离线");
    expect(second.textContent).toContain("3 小时前");
    expect(second.textContent).toContain("12");
    expect(within(second).getByText("打开 mac-studio")).toBeTruthy();
    // 次要列之间只有一个「·」，不重复列头。
    expect(second.textContent).not.toContain("最近在线");
    expect(within(second).getAllByText("·")).toHaveLength(1);
  });

  it("列表里空的次要列不占位，也不留孤立的「·」", () => {
    const sparse: DataColumn<Row>[] = [
      ...columns.slice(0, 2),
      { id: "empty", header: "空", cell: () => null },
      columns[2]!,
    ];
    render(<DataList {...props} columns={sparse} layout="list" />);
    expect(screen.queryByText("·")).toBeNull();
  });

  it("缺省按视口：窄屏列表、宽屏表格", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query === "(max-width: 767px)",
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const narrow = render(<DataList {...props} />);
    expect(narrow.queryByRole("table")).toBeNull();
    expect(narrow.getByRole("list")).toBeTruthy();
    narrow.unmount();
    window.matchMedia = original;
    const wide = render(<DataList {...props} />);
    expect(wide.getByRole("table")).toBeTruthy();
  });

  it("没有行什么也不画", () => {
    const { container } = render(<DataList {...props} rows={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
