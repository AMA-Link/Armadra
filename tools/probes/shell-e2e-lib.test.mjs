import assert from "node:assert/strict";
import test from "node:test";

import { networkChangeGate } from "./shell-e2e-lib.mjs";

test("networkChangeGate: 一次网络变化只触发一次重载，重载说明不算新的变化", () => {
  const gate = networkChangeGate();
  gate.fresh();
  gate.note({
    kind: "network",
    text: "net::ERR_NETWORK_CHANGED https://x/a.js",
  });
  let reloads = 0;
  for (let round = 0; round < 3; round += 1) {
    if (!gate.fresh()) break;
    reloads += 1;
    gate.note({
      kind: "retry",
      text: `ERR_NETWORK_CHANGED，第 ${round + 1} 次重载`,
    });
  }
  assert.equal(reloads, 1);
});

test("networkChangeGate: 重载后又出现网络变化才再重载", () => {
  const gate = networkChangeGate();
  gate.note({ kind: "log", text: "ERR_NETWORK_CHANGED" });
  assert.equal(gate.fresh(), true);
  gate.note({ kind: "retry", text: "ERR_NETWORK_CHANGED，第 1 次重载" });
  gate.note({ kind: "network", text: "net::ERR_NETWORK_CHANGED y" });
  assert.equal(gate.fresh(), true);
  assert.equal(gate.fresh(), false);
});
