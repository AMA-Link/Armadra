import assert from "node:assert/strict";
import { test } from "node:test";

import { failedItems, nightlyReportBody } from "./nightly-report.mjs";

const allSuccess = {
  RUN_URL: "https://example.invalid/runs/1",
  LINUX_RESULT: "success",
  LINUX_ARM64_RESULT: "success",
  MACOS_RESULT: "success",
  MOBILE_IOS_RESULT: "success",
  MOBILE_ANDROID_RESULT: "success",
  WINDOWS_RESULT: "success",
  WINDOWS_PRIVATE_RESULT: "success",
  HYGIENE_RESULT: "success",
};

const row = (body, job) =>
  body.split("\n").find((line) => line.startsWith(`| ${job} |`));

test("只有 failure 才写条目", () => {
  assert.equal(failedItems("success", "x"), "-");
  assert.equal(failedItems("cancelled", "x"), "-");
  assert.equal(failedItems("skipped", "x"), "-");
  assert.equal(failedItems("failure", "x"), "x");
  assert.equal(failedItems("failure", ""), "-");
  assert.equal(failedItems("failure", undefined), "-");
});

test("成功的 mobile-ios 与 hygiene 不再列出写死的条目（#921 的误报）", () => {
  const body = nightlyReportBody({
    ...allSuccess,
    MOBILE_ANDROID_RESULT: "failure",
  });
  assert.equal(row(body, "mobile-ios"), "| mobile-ios | success | - |");
  assert.equal(row(body, "hygiene"), "| hygiene | success | - |");
  assert.equal(
    row(body, "windows-acceptance"),
    "| windows-acceptance | success | - |",
  );
  assert.equal(
    row(body, "mobile-android"),
    "| mobile-android | failure | mobile-shell-e2e |",
  );
  assert.match(body, /^运行：https:\/\/example\.invalid\/runs\/1$/m);
});

test("失败的作业写具体条目", () => {
  const body = nightlyReportBody({
    ...allSuccess,
    LINUX_RESULT: "failure",
    LINUX_FAILED: "packaged-smoke,deb-install",
    MACOS_RESULT: "failure",
    MOBILE_IOS_RESULT: "failure",
    WINDOWS_RESULT: "failure",
    WINDOWS_PRIVATE_RESULT: "failure",
    HYGIENE_RESULT: "failure",
  });
  assert.equal(
    row(body, "linux"),
    "| linux | failure | packaged-smoke,deb-install |",
  );
  // 没有条目输出（失败在打包）时是 `-`，正文末尾的说明解释这种情况。
  assert.equal(row(body, "macos"), "| macos | failure | - |");
  assert.equal(
    row(body, "mobile-ios"),
    "| mobile-ios | failure | mobile-shell-e2e |",
  );
  assert.match(
    row(body, "windows-acceptance"),
    /windows-acceptance\/result\.json/,
  );
  assert.match(row(body, "windows-private-channels"), /私有通道场景/);
  assert.match(row(body, "hygiene"), /pnpm audit --prod/);
});

test("Android 记模拟器崩溃次数：重跑通过与重跑仍失败", () => {
  const passed = nightlyReportBody({
    ...allSuccess,
    LINUX_RESULT: "failure",
    MOBILE_ANDROID_CRASHES: "1",
  });
  assert.equal(
    row(passed, "mobile-android"),
    "| mobile-android | success | -（模拟器进程中途消失 1 次，重跑通过） |",
  );
  const failed = nightlyReportBody({
    ...allSuccess,
    MOBILE_ANDROID_RESULT: "failure",
    MOBILE_ANDROID_CRASHES: "2",
  });
  assert.match(
    row(failed, "mobile-android"),
    /^\| mobile-android \| failure \| mobile-shell-e2e（模拟器进程中途消失 2 次/,
  );
});

test("没跑的作业结果为空时写 -", () => {
  const body = nightlyReportBody({ RUN_URL: "u", HYGIENE_RESULT: "" });
  assert.equal(row(body, "hygiene"), "| hygiene | - | - |");
});
