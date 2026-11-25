import assert from "node:assert/strict";
import { test } from "node:test";

import {
  QUERY,
  REPLY_HEX,
  countQueries,
  parseReport,
  parseReports,
} from "./agy-osc7501.mjs";

const pane = (...parts) => Buffer.from(parts.join(""), "latin1");

test("查询要数出来，上报要读出来，二者不混", () => {
  const buffer = pane(
    "hello",
    QUERY,
    "\u0007",
    "\u001b]7501;state=idle:app=antigravity\u001b\\",
    "x",
    "\u001b]7501;state=working:app=antigravity\u0007",
    "\u001b]7501;state=done:app=antigravity:msg=b2s=\u0007",
  );
  assert.equal(countQueries(buffer), 1);
  assert.deepEqual(parseReports(buffer), [
    "state=idle:app=antigravity",
    "state=working:app=antigravity",
    "state=done:app=antigravity:msg=b2s=",
  ]);
});

test("上报的字段：状态、应用、等待的种类，正文只留有没有", () => {
  assert.deepEqual(
    parseReport("state=blocked:kind=permission:app=antigravity:msg=VHJ1c3Q="),
    {
      state: "blocked",
      app: "antigravity",
      kind: "permission",
      hasMessage: true,
    },
  );
  assert.deepEqual(parseReport("state=idle:app=antigravity"), {
    state: "idle",
    app: "antigravity",
    kind: undefined,
    hasMessage: false,
  });
});

test("应答就是 ESC ] 7501 ; ? ESC \\\\", () => {
  assert.equal(
    Buffer.from(REPLY_HEX.map((hex) => Number.parseInt(hex, 16))).toString(
      "latin1",
    ),
    "\u001b]7501;?\u001b\\",
  );
});
