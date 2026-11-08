import assert from "node:assert/strict";
import { test } from "node:test";

import { planTests } from "./verify.mjs";

const BASE = "abc123";
const ids = (plan) => plan.runs.map((run) => run.id);
const argsOf = (plan, id) => plan.runs.find((run) => run.id === id)?.args;

test("没有改动时一个测试都不跑", () => {
  const plan = planTests([], { base: BASE });
  assert.equal(plan.full, false);
  assert.deepEqual(ids(plan), []);
});

test("只改 web 源码：只跑 web，并交给 vitest --changed 挑文件", () => {
  const plan = planTests(["apps/web/src/store/canvas/writeback.ts"], {
    base: BASE,
  });
  assert.deepEqual(ids(plan), ["web"]);
  assert.deepEqual(argsOf(plan, "web"), [
    "exec",
    "vitest",
    "run",
    "--changed",
    BASE,
    "--passWithNoTests",
  ]);
});

test("改 core：desktop 按改动挑，服务器壳整包跑，脚本测试不跑", () => {
  const plan = planTests(["apps/desktop/src/core/terminal/direct.ts"], {
    base: BASE,
  });
  assert.deepEqual(ids(plan), ["desktop", "desktop-live", "server"]);
  assert.ok(argsOf(plan, "desktop").includes("--changed"));
  assert.ok(!argsOf(plan, "server").includes("--changed"));
});

test("改桌面打包脚本：跑 node:test 的脚本测试", () => {
  const plan = planTests(["apps/desktop/scripts/after-pack.mjs"], {
    base: BASE,
  });
  assert.ok(ids(plan).includes("desktop-scripts"));
});

test("测试夹具或 vitest 配置变了：整包全量", () => {
  const plan = planTests(["apps/web/src/app/test-setup.ts"], { base: BASE });
  assert.ok(!argsOf(plan, "web").includes("--changed"));
});

test("锁文件、根配置、shared 变了：所有包全量", () => {
  for (const file of [
    "pnpm-lock.yaml",
    "package.json",
    "packages/shared/src/x.ts",
  ]) {
    const plan = planTests([file], { base: BASE });
    assert.equal(plan.full, true, file);
    assert.deepEqual(ids(plan), [
      "web",
      "desktop",
      "desktop-live",
      "desktop-scripts",
      "server",
      "mobile",
      "push-relay",
    ]);
    assert.ok(
      plan.runs.every((run) => !run.args.includes("--changed")),
      file,
    );
  }
});

test("拿不到基点或给了 --full：全量", () => {
  assert.equal(planTests(null, { base: null }).full, true);
  assert.equal(
    planTests(["docs/README.md"], { base: BASE, full: true }).full,
    true,
  );
});

test("只改文档与 tools：不跑包测试（tools 的 node:test 在静态阶段）", () => {
  const plan = planTests(["docs/guides/development.md", "tools/ci/e2e.mjs"], {
    base: BASE,
  });
  assert.deepEqual(ids(plan), []);
});
