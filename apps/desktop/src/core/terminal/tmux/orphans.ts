import type { ProcessRow } from "../process";

/**
 * tmux servers that still hold this data directory's socket path in their
 * command line but are not the one the socket reaches.
 *
 * Two servers end up on one path when the socket file is replaced under a
 * running server (an older build, a data directory copied or restored): the
 * new server binds the path, the old one keeps running unreachable with its
 * panes, and nothing ever ends it. It is a server, not a client, when its
 * parent is init (a daemonized tmux) or its title says so (`tmux: server`,
 * which is how Linux shows it); an `attach-session` client of the live server
 * names the same socket and must be left alone.
 *
 * `live` is the pid the socket answers for, if anything answers. With no live
 * server, every match is an orphan.
 */
export function orphanServerPids(
  table: ReadonlyMap<number, ProcessRow>,
  socket: string,
  live: number | undefined,
  self: number = process.pid,
): number[] {
  const found: number[] = [];
  for (const [pid, row] of table) {
    if (pid === live || pid === self) continue;
    const argv = row.argv;
    const program = argv.split(/\s+/, 1)[0] ?? "";
    const isTmux = /(^|\/)tmux:?$/.test(program);
    if (!isTmux || !argv.includes(socket)) continue;
    const daemonized = row.parent === 1;
    const titled = argv.startsWith("tmux: server");
    if (daemonized || titled) found.push(pid);
  }
  return found;
}
