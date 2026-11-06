import assert from "node:assert/strict";
import test from "node:test";

import {
  dropKilledChunkErrors,
  maskFragments,
  networkChangeGate,
  oneTimeFragment,
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

// R-89（#356）：带一次性片段的地址看片段还在不在；不带的只重载真没起来的页面。
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
  [
    "根节点有内容、接口答过，但配对票还在片段里（取票的懒加载块被掐）：重载",
    {
      fragment: "#pair=",
      fragmentPresent: true,
      rootChildren: 2,
      trafficSince: 9,
    },
    true,
  ],
  [
    "配对票已从片段抹掉（页面取走了票）：不重载",
    {
      fragment: "#pair=",
      fragmentPresent: false,
      rootChildren: 2,
      trafficSince: 9,
    },
    false,
  ],
  [
    "票已取走，哪怕根节点是空的：不重载",
    {
      fragment: "#pair=",
      fragmentPresent: false,
      rootChildren: 0,
      trafficSince: 0,
    },
    false,
  ],
  [
    "邀请片段还在：重载",
    {
      fragment: "#invite=",
      fragmentPresent: true,
      rootChildren: 1,
      trafficSince: 3,
    },
    true,
  ],
]) {
  test(`stuckAfterNetworkChange: ${name}`, () => {
    assert.equal(stuckAfterNetworkChange(input), reload);
  });
}

test("oneTimeFragment / maskFragments：认出配对票与邀请片段，记录时抹掉值", () => {
  assert.equal(oneTimeFragment("https://h:1/#pair=abc"), "#pair=");
  assert.equal(oneTimeFragment("https://h:1/#invite=xyz"), "#invite=");
  assert.equal(oneTimeFragment("https://h:1/"), null);
  assert.equal(oneTimeFragment("https://h:1/#canvas"), null);
  assert.equal(oneTimeFragment("about:blank"), null);
  assert.equal(
    maskFragments("open https://h:1/#pair=abc and https://h:1/#invite=xyz"),
    "open https://h:1/#pair=… and https://h:1/#invite=…",
  );
});

test("dropKilledChunkErrors：只拿走被掐地址的动态导入失败，其余错误留着", () => {
  const errors = [
    {
      kind: "exception",
      text: "TypeError: Failed to fetch dynamically imported module: https://h:1/assets/SettingsDialog-x.js",
    },
    {
      kind: "exception",
      text: "TypeError: Failed to fetch dynamically imported module: https://h:1/assets/Other-y.js",
    },
    {
      kind: "console",
      text: "Error: https://h:1/assets/SettingsDialog-x.js 渲染失败",
    },
  ];
  const dropped = dropKilledChunkErrors(errors, [
    "https://h:1/assets/SettingsDialog-x.js",
    "",
  ]);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].text, /SettingsDialog-x/);
  assert.equal(errors.length, 2);
  assert.match(errors[0].text, /Other-y\.js$/);
  assert.match(errors[1].text, /渲染失败$/);
});
