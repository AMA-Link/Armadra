import assert from "node:assert/strict";
import { test } from "node:test";

import { PROBE_CORE_ENV, isolatedEnv, probeHome } from "./probe-home.mjs";

test("探针起的 core 在停止时连 tmux 会话一起结束，否则删掉数据目录后 tmux server 会一直留着", () => {
  assert.equal(PROBE_CORE_ENV.ARMADRA_REAP_ON_STOP, "1");
  assert.equal(PROBE_CORE_ENV.ARMADRA_LOOPBACK_OWNER, "1");
  const home = probeHome();
  try {
    const env = isolatedEnv(home);
    assert.equal(env.ARMADRA_REAP_ON_STOP, "1");
    assert.equal(env.HOME, home.path);
    // 调用方自己的键最后叠上，仍能覆盖。
    assert.equal(
      isolatedEnv(home, { ARMADRA_REAP_ON_STOP: "0" }).ARMADRA_REAP_ON_STOP,
      "0",
    );
  } finally {
    home.remove();
  }
});
