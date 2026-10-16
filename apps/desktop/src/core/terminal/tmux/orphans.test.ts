import { describe, expect, it } from "vitest";

import { orphanServerPids } from "./orphans";

const SOCKET = "/Users/me/Library/Application Support/Armadra/tmux.sock";
const row = (parent: number, argv: string) => ({ parent, argv });

describe("orphanServerPids", () => {
  it("names the daemonized servers on the socket path other than the live one", () => {
    const table = new Map([
      [10, row(1, `tmux -u -S ${SOCKET} -f /x/tmux.conf new-session -d -s a`)],
      [20, row(1, `tmux -u -S ${SOCKET} -f /x/tmux.conf new-session -d -s b`)],
      [30, row(1, `tmux -u -S ${SOCKET} -f /x/tmux.conf new-session -d -s c`)],
    ]);
    expect(orphanServerPids(table, SOCKET, 20)).toEqual([10, 30]);
  });

  it("leaves the clients of the live server alone", () => {
    const table = new Map([
      [20, row(1, `tmux -u -S ${SOCKET} -f /x/tmux.conf new-session -d -s b`)],
      [
        21,
        row(500, `tmux -u -S ${SOCKET} -f /x/tmux.conf attach-session -t b`),
      ],
    ]);
    expect(orphanServerPids(table, SOCKET, 20)).toEqual([]);
  });

  it("with no live server every match is an orphan", () => {
    const table = new Map([
      [10, row(1, `tmux -u -S ${SOCKET} -f /x/tmux.conf new-session -d -s a`)],
    ]);
    expect(orphanServerPids(table, SOCKET, undefined)).toEqual([10]);
  });

  it("recognises the title Linux gives a server", () => {
    const table = new Map([[10, row(777, `tmux: server (${SOCKET})`)]]);
    expect(orphanServerPids(table, SOCKET, undefined)).toEqual([10]);
  });

  it("never touches another socket, another program or the caller", () => {
    const table = new Map([
      [10, row(1, "tmux -u -S /tmp/other/tmux.sock new-session -d")],
      [11, row(1, "tmux new-session -d -s mine")],
      [12, row(1, `vim ${SOCKET}`)],
      [13, row(1, `tmux-resurrect -S ${SOCKET}`)],
      [14, row(1, `tmux -u -S ${SOCKET} new-session -d`)],
    ]);
    expect(orphanServerPids(table, SOCKET, undefined, 14)).toEqual([]);
  });
});
