import { afterEach, expect, it } from "vitest";
import { cardNoticeOf, setCardNotice } from "../agent/pending-cards";
import { type HookFixture, hookFixture } from "../hook/fixture";
import { forgetNodes } from "./orphans";

const open: HookFixture[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

it("a deleted node takes its terminal-card header line with it (contract §127)", () => {
  const it_ = hookFixture();
  open.push(it_);
  setCardNotice(it_.nodeId, "unconfirmed");
  setCardNotice("other-node", "mismatch");
  forgetNodes(it_.core.database, [it_.nodeId]);
  expect(cardNoticeOf(it_.nodeId)).toBeUndefined();
  // Another node's line is not touched.
  expect(cardNoticeOf("other-node")).toBe("mismatch");
});
