import assert from "node:assert/strict";
import test from "node:test";

import {
  networkChangeGate,
  stuckAfterNetworkChange,
} from "./shell-e2e-lib.mjs";

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

test("networkChangeGate: recent 记下触发这次判断的那批变化", () => {
  const gate = networkChangeGate();
  gate.note({
    kind: "network",
    text: "net::ERR_NETWORK_CHANGED https://x/a.js",
  });
  gate.note({
    kind: "network",
    text: "net::ERR_NETWORK_CHANGED https://x/b.js",
  });
  assert.equal(gate.fresh(), true);
  assert.deepEqual(gate.recent, [
    "net::ERR_NETWORK_CHANGED https://x/a.js",
    "net::ERR_NETWORK_CHANGED https://x/b.js",
  ]);
  assert.equal(gate.fresh(), false);
});

// R-89（#356）：只重载真没起来的页面；已起来的页面可能已取走一次性的配对票。
for (const [name, input, reload] of [
  ["根节点空、没有接口应答：重载", { rootChildren: 0, trafficSince: 0 }, true],
  [
    "没有根节点（浏览器错误页）、没有接口应答：重载",
    { rootChildren: null, trafficSince: 0 },
    true,
  ],
  ["根节点有内容：不重载", { rootChildren: 1, trafficSince: 0 }, false],
  [
    "根节点有内容且接口答过：不重载",
    { rootChildren: 3, trafficSince: 12 },
    false,
  ],
  [
    "根节点空但接口答过（入口脚本在跑）：不重载",
    { rootChildren: 0, trafficSince: 2 },
    false,
  ],
]) {
  test(`stuckAfterNetworkChange: ${name}`, () => {
    assert.equal(stuckAfterNetworkChange(input), reload);
  });
}
