// Antigravity 在 tmux 下的 OSC 7501（Program Status Protocol）探针（契约 §53）。
//
// agy 1.4.0 起经 OSC 7501 上报「工作中 / 等输入 / 完成 / 失败」；它先发一条
// `ESC ] 7501 ; ?` 查终端支不支持，应答了才上报。tmux 认不得 7501、会把它吞掉，
// 所以 Armadra 用 `pipe-pane -O` 抄一份 pane 的输出（`core/terminal/tmux/
// program-tap.ts`），看到查询后往 pane 的输入里写回 `ESC ] 7501 ; ? ESC \\`。
// 这里在一个私有 tmux 服务器里复现这一条路，证明：查询到得了 agy、应答到得了、
// 应答之后 agy 真的开始上报。**只启动 TUI、不发提示、不发模型请求**；用
// `--settings` 临时信任工作目录（不落盘），免得停在信任框。
//
// 用法：node tools/probes/agent-e2e/agy-osc7501.mjs
// 前提：tmux、agy 在 PATH 上，且 `~/.gemini` 里已有登录（探针不读凭据）。缺任何
// 一样记 skipped 并以 0 退出；查询没到或应答后没有上报以 1 退出。
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** 程序发的查询与 Armadra 的应答（`core/terminal/program-status.ts::QUERY_REPLY`）。 */
export const QUERY = "\u001b]7501;?";
export const REPLY_HEX = [
  "1b",
  "5d",
  "37",
  "35",
  "30",
  "31",
  "3b",
  "3f",
  "1b",
  "5c",
];

/** pane 输出里的 7501 上报（不含查询），按出现顺序；以 BEL 或 `ESC \\` 结尾。 */
export function parseReports(buffer) {
  const text = Buffer.from(buffer).toString("latin1");
  const out = [];
  // eslint-disable-next-line no-control-regex -- 终端控制序列本来就是控制字符
  const pattern = /\u001b\]7501;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[1] !== "?") out.push(match[1]);
  }
  return out;
}

/** `state=idle:app=x` → `{ state, app }`；`msg` 是 base64，只留是否带。 */
export function parseReport(report) {
  const fields = Object.fromEntries(
    report.split(":").map((part) => {
      const at = part.indexOf("=");
      return at < 0 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)];
    }),
  );
  return {
    state: fields.state,
    app: fields.app,
    kind: fields.kind,
    hasMessage: fields.msg !== undefined,
  };
}

export function countQueries(buffer) {
  return Buffer.from(buffer).toString("latin1").split(QUERY).length - 1;
}

function which(program) {
  const found = spawnSync("sh", ["-c", `command -v ${program}`], {
    encoding: "utf8",
  });
  return found.stdout.trim() || undefined;
}

export async function main() {
  const tmux = which("tmux");
  const agy = which("agy");
  if (tmux === undefined || agy === undefined) {
    console.log("agy OSC 7501：没有 tmux 或 agy，跳过（skipped）");
    return 0;
  }
  const scratch = mkdtempSync(join("/tmp", "agy-osc-"));
  const sock = join(scratch, "t.sock");
  const tap = join(scratch, "tap.bin");
  const project = join(scratch, "project");
  mkdirSync(project);
  const tm = (...args) =>
    spawnSync(tmux, ["-S", sock, "-f", "/dev/null", ...args], {
      encoding: "utf8",
    });
  try {
    tm(
      "new-session",
      "-d",
      "-x",
      "120",
      "-y",
      "40",
      "-s",
      "e",
      "-c",
      project,
      "sh",
    );
    tm("pipe-pane", "-O", "-t", "e", `cat >> '${tap}'`);
    await new Promise((r) => setTimeout(r, 500));
    const settings = JSON.stringify({ trustedWorkspaces: [project] });
    tm("send-keys", "-t", "e", "-l", `exec '${agy}' --settings '${settings}'`);
    tm("send-keys", "-t", "e", "Enter");
    let answered = 0;
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      const buffer = existsSync(tap) ? readFileSync(tap) : Buffer.alloc(0);
      for (; answered < countQueries(buffer); answered += 1)
        tm("send-keys", "-t", "e", "-H", ...REPLY_HEX);
      if (answered > 0 && parseReports(buffer).length > 0) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const buffer = existsSync(tap) ? readFileSync(tap) : Buffer.alloc(0);
    const reports = parseReports(buffer).map(parseReport);
    console.log(
      `agy OSC 7501：查询 ${countQueries(buffer)} 条，应答 ${answered} 条，上报 ${reports.length} 条`,
      reports.map((r) => r.state).join(" → "),
    );
    if (answered === 0) {
      console.log(
        "  FAIL 查询没有到 agy（或 agy 没有发）；可在启动行设 AGY_CLI_OSC7501=on",
      );
      return 1;
    }
    if (reports.length === 0 || reports.some((r) => r.app !== "antigravity")) {
      console.log("  FAIL 应答之后没有来自 antigravity 的上报");
      return 1;
    }
    return 0;
  } finally {
    tm("kill-server");
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
