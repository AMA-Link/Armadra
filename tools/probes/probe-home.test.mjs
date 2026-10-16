import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { killTmuxServer } from "./probe-home.mjs";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test(
  "killTmuxServer 结束数据目录自己的 tmux server，没有 server 时是空操作",
  { skip: !hasTmux },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "armadra-probe-tmux-"));
    const socket = join(dir, "tmux.sock");
    try {
      killTmuxServer(dir);
      const started = spawnSync(
        "tmux",
        [
          "-S",
          socket,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "probe",
          "sleep",
          "30",
        ],
        { stdio: "ignore" },
      );
      assert.equal(started.status, 0);
      assert.equal(
        spawnSync("tmux", ["-S", socket, "ls"], { stdio: "ignore" }).status,
        0,
      );
      killTmuxServer(dir);
      assert.notEqual(
        spawnSync("tmux", ["-S", socket, "ls"], { stdio: "ignore" }).status,
        0,
      );
    } finally {
      spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
