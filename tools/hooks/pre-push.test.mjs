import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  isDocsOnly,
  parsePushLines,
  parseSkip,
  planChecks,
  refsToCheck,
} from "./pre-push.mjs";
import { anchorsOf, distinctive, mapProbes } from "./probe-map.mjs";

const SHA = "a".repeat(40);
const ZERO = "0".repeat(40);
const ids = (steps) => steps.map((step) => step.id);

describe("推送的 ref", () => {
  it("删除分支与 tag 不查", () => {
    const updates = parsePushLines(
      [
        `refs/heads/x ${SHA} refs/heads/x ${ZERO}`,
        `(delete) ${ZERO} refs/heads/gone ${SHA}`,
        `refs/tags/v1 ${SHA} refs/tags/v1 ${ZERO}`,
        "",
      ].join("\n"),
    );
    assert.equal(updates.length, 3);
    assert.deepEqual(
      refsToCheck(updates).map((update) => update.remoteRef),
      ["refs/heads/x"],
    );
  });

  it("ARMADRA_SKIP_PREPUSH：1 跳过全部，逗号列表跳过指定步骤", () => {
    assert.equal(parseSkip("1").all, true);
    assert.equal(parseSkip(undefined).all, false);
    assert.deepEqual(
      [...parseSkip("lint, test:web").steps],
      ["lint", "test:web"],
    );
  });
});

describe("挑检查", () => {
  it("只改文档与 CI 的判定一致：契约与第三方声明不算文档", () => {
    assert.equal(isDocsOnly(["docs/guides/a.md", "README.md"]), true);
    assert.equal(isDocsOnly(["docs/contracts/core-json-api.md"]), false);
    assert.equal(isDocsOnly(["THIRD_PARTY_NOTICES.md"]), false);
    assert.equal(isDocsOnly(["apps/web/src/a.ts"]), false);
  });

  it("只改文档：改动文件的 prettier 与 repo:check", () => {
    const plan = planChecks(["docs/guides/a.md"], { base: SHA });
    assert.equal(plan.docsOnly, true);
    assert.deepEqual(ids(plan.statics), ["format", "repo:check"]);
    assert.ok(plan.statics[0].args.includes("docs/guides/a.md"));
    assert.equal(plan.libs, null);
  });

  it("改 core：lint 与格式只看改动文件，desktop 构建，desktop 与 server 的单测", () => {
    const file = "apps/desktop/src/core/forge/exec.ts";
    const plan = planChecks([file], { base: SHA });
    const lint = plan.statics.find((step) => step.id === "lint");
    assert.ok(lint.args.includes(file));
    assert.ok(ids(plan.statics).includes("portability:check"));
    assert.ok(!ids(plan.statics).includes("release:test"));
    assert.deepEqual(ids(plan.builds), ["build:desktop"]);
    assert.ok(ids(plan.tests).includes("test:desktop"));
    assert.ok(ids(plan.tests).includes("test:server"));
    assert.ok(!ids(plan.tests).includes("test:web"));
  });

  it("只改测试文件不构建", () => {
    const plan = planChecks(["apps/web/src/a.test.tsx"], { base: SHA });
    assert.deepEqual(plan.builds, []);
  });

  it("改 workflow 跑 release:test；删掉的文件不交给 prettier", () => {
    const plan = planChecks([".github/workflows/ci.yml", "tools/gone.mjs"], {
      base: SHA,
      exists: (file) => file !== "tools/gone.mjs",
    });
    assert.ok(ids(plan.statics).includes("release:test"));
    const format = plan.statics.find((step) => step.id === "format");
    assert.ok(!format.args.includes("tools/gone.mjs"));
  });

  it("根 package.json 变了：格式与 lint 全量，node:test 组全跑", () => {
    const plan = planChecks(["package.json"], { base: SHA });
    const byId = new Map(plan.statics.map((step) => [step.id, step.args]));
    assert.deepEqual(byId.get("format"), ["format:check"]);
    assert.deepEqual(byId.get("lint"), ["lint"]);
    for (const id of [
      "repo:test",
      "release:test",
      "plugin:test",
      "controller:real:test",
    ])
      assert.ok(byId.has(id), id);
  });
});

describe("探针映射", () => {
  const root = mkdtempSync(join(tmpdir(), "armadra-probe-map-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  put(
    "apps/web/src/i18n/git.ts",
    [
      "export const git = {",
      '  "zh-CN": {',
      '    "git.expand": "展开分支栏",',
      '    "git.cancel": "取消",',
      '    "other.cancel": "取消",',
      '    "git.count": "共 {n} 个",',
      "  },",
      "};",
    ].join("\n"),
  );
  put(
    "apps/web/src/panels/Git.tsx",
    'export const G = () => <div data-slot="git-workbench">{t("git.expand")}{t("git.cancel")}</div>;',
  );
  put(
    "apps/web/src/panels/Other.tsx",
    'export const O = () => t("git.count");',
  );
  put("tools/probes/lib/page.mjs", "export const page = {};");
  put(
    "tools/probes/remote-e2e.mjs",
    'import { page } from "./lib/page.mjs";\nawait page.click(\'[data-slot="git-workbench"] button\', "取消");',
  );
  put(
    "tools/probes/ui-e2e.mjs",
    'await page.click("button", "展开分支栏");\nawait page.click("button", "取消");',
  );
  put("tools/probes/other-e2e.mjs", 'await page.click("button", "取消");');
  const entries = [
    { id: "remote-e2e", tier: "a", script: "tools/probes/remote-e2e.mjs" },
    { id: "ui-e2e", tier: "a", script: "tools/probes/ui-e2e.mjs" },
    { id: "other-e2e", tier: "a", script: "tools/probes/other-e2e.mjs" },
    { id: "nightly", tier: "b", script: "tools/probes/ui-e2e.mjs" },
  ];

  it("只认独特的文案：重复的词、带占位符的、太短的都不算", () => {
    const counts = new Map([
      ["展开分支栏", 1],
      ["取消", 2],
      ["日志", 1],
      ["Refresh the list", 1],
      ["Refresh", 1],
    ]);
    assert.equal(distinctive("展开分支栏", counts), true);
    assert.equal(distinctive("取消", counts), false);
    assert.equal(distinctive("日志", counts), false);
    assert.equal(distinctive("Refresh the list", counts), true);
    assert.equal(distinctive("Refresh", counts), false);
    const dictionary = {
      keys: new Map([["git.expand", ["展开分支栏"]]]),
      counts,
    };
    assert.deepEqual(
      anchorsOf(
        '<a data-slot="git-workbench">{t("git.expand")}</a>',
        dictionary,
      ),
      [
        { kind: "attr", name: "slot", value: "git-workbench" },
        { kind: "text", value: "展开分支栏" },
      ],
    );
  });

  it("界面锚点与探针自己的改动都能对上，B 档与无关探针不报", () => {
    const result = mapProbes({
      root,
      entries,
      changed: ["apps/web/src/panels/Git.tsx", "tools/probes/lib/page.mjs"],
    });
    assert.equal(result.webChanged, true);
    assert.deepEqual(
      result.probes.map((probe) => probe.id),
      ["remote-e2e", "ui-e2e"],
    );
    const remote = result.probes[0].reasons.join(" ");
    assert.match(remote, /tools\/probes\/lib\/page\.mjs/);
    assert.match(remote, /data-slot="git-workbench"/);
  });

  it("改了界面却没有锚点对上：空列表，交给通用提示", () => {
    const result = mapProbes({
      root,
      entries,
      changed: ["apps/web/src/panels/Other.tsx"],
    });
    assert.deepEqual(result, { webChanged: true, probes: [] });
  });
});
