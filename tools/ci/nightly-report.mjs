// 夜间 B 档失败时 report 作业开的 issue 正文（nightly.yml 的「失败开 issue」）。
//
// 每个作业一行：结果与失败的条目。条目只在作业结果是 failure 时写——以前 mobile-ios 与 hygiene
// 的条目是写死的，作业成功也照样列出「mobile-shell-e2e」「pnpm audit 有漏洞」，读起来像它们也
// 失败了（#921）。Android 另记模拟器进程中途消失（qemu 段错误，#485）的次数：崩过就重启
// 模拟器重跑一次，重跑通过时作业是 success，但崩溃仍记在这一行。
//
// 输入全是环境变量（工作流把 needs.<job>.result / outputs 填进来），输出正文到标准输出。
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 一行的「失败的条目」：只有 failure 才写具体条目，没有条目时是 `-`。 */
export function failedItems(result, items) {
  return result === "failure" && items ? items : "-";
}

function androidItems(result, crashes) {
  const count = Number.parseInt(crashes ?? "", 10) || 0;
  if (result === "failure")
    return count > 0
      ? `mobile-shell-e2e（模拟器进程中途消失 ${count} 次，见产物 mobile-android 的 attempt-*/ 与 host-watch*.log）`
      : "mobile-shell-e2e";
  return count > 0 ? `-（模拟器进程中途消失 ${count} 次，重跑通过）` : "-";
}

/** 由环境变量拼出 issue 正文。 */
export function nightlyReportBody(env) {
  const rows = [
    [
      "linux",
      env.LINUX_RESULT,
      failedItems(env.LINUX_RESULT, env.LINUX_FAILED),
    ],
    [
      "linux-arm64",
      env.LINUX_ARM64_RESULT,
      failedItems(env.LINUX_ARM64_RESULT, env.LINUX_ARM64_FAILED),
    ],
    [
      "macos",
      env.MACOS_RESULT,
      failedItems(env.MACOS_RESULT, env.MACOS_FAILED),
    ],
    [
      "mobile-ios",
      env.MOBILE_IOS_RESULT,
      failedItems(env.MOBILE_IOS_RESULT, "mobile-shell-e2e"),
    ],
    [
      "mobile-android",
      env.MOBILE_ANDROID_RESULT,
      androidItems(env.MOBILE_ANDROID_RESULT, env.MOBILE_ANDROID_CRASHES),
    ],
    [
      "windows-acceptance",
      env.WINDOWS_RESULT,
      failedItems(env.WINDOWS_RESULT, "见产物 windows-acceptance/result.json"),
    ],
    [
      "windows-private-channels",
      env.WINDOWS_PRIVATE_RESULT,
      failedItems(env.WINDOWS_PRIVATE_RESULT, "私有通道场景"),
    ],
    [
      "hygiene",
      env.HYGIENE_RESULT,
      failedItems(env.HYGIENE_RESULT, "pnpm audit --prod 有 high 及以上漏洞"),
    ],
  ];
  return [
    `运行：${env.RUN_URL ?? ""}`,
    "",
    "| 作业 | 结果 | 失败的条目 |",
    "| --- | --- | --- |",
    ...rows.map(
      ([job, result, items]) => `| ${job} | ${result || "-"} | ${items} |`,
    ),
    "",
    "结果是 failure 而条目是 `-` 时，失败在打包或 glibc 校验，看运行日志；结果是 cancelled 是作业超时或整次运行被取消。",
    "",
  ].join("\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.stdout.write(nightlyReportBody(process.env));
