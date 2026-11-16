/**
 * 改动的文件可能碰到哪条 A 档探针（#953）。只给提示，不替人决定跑不跑。
 *
 * 两类依据，都是逐字相同的字符串，不按目录猜：
 *
 * 1. **探针自己**：探针脚本与它（经相对 import）用到的模块改了，或
 *    `tools/ci/e2e.d/<id>.json` 改了。
 * 2. **界面锚点**：`apps/web/src/` 里改动的非测试源文件，取出它
 *    - 写出的组件标识 `data-slot` / `data-testid` / `data-showcase-section` 的值，探针以
 *      `[data-slot="x"]` 这样的选择器引用；
 *    - 引用到的 i18n 键在词表里的文案，只取全词表里独一无二、足够长（含汉字至少 3 个字，
 *      纯英文至少 8 个字符）、不带占位符的那些，探针以带引号的字面量按文字点它。
 *    探针源码里出现同一个锚点，就算相关。「取消」「刷新」这类到处都有的词不参与。
 *
 * 界面行为变了而锚点没变（例如同一个按钮挪到另一个页签里）认不出来；所以对改了
 * `apps/web/src/` 却一条都没对上的情况，钩子另给一句「需要时自己挑」的提示。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ANCHOR_ATTRIBUTES = ["slot", "testid", "showcase-section"];
const WEB_SOURCE = /^apps\/web\/src\/.*\.tsx?$/;
const TEST_SOURCE = /\.(test|spec)\.[cm]?[jt]sx?$|\/test-setup\.ts$/;
const CJK = /[\u3400-\u9fff]/;

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** i18n 词表：键 → 各语言的文案；同时数每条文案在整个词表里出现几次。 */
export function readDictionary(root) {
  const directory = join(root, "apps/web/src/i18n");
  const keys = new Map();
  const counts = new Map();
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".ts") || TEST_SOURCE.test(file)) continue;
    const text = readFileSync(join(directory, file), "utf8");
    for (const match of text.matchAll(
      /^\s*"([a-zA-Z][\w-]*(?:\.[\w-]+)+)":\s*"((?:[^"\\]|\\.)*)"/gm,
    )) {
      keys.set(match[1], [...(keys.get(match[1]) ?? []), match[2]]);
      counts.set(match[2], (counts.get(match[2]) ?? 0) + 1);
    }
  }
  return { keys, counts };
}

/** 一条文案够不够独特，能当锚点。 */
export function distinctive(value, counts) {
  if ((counts.get(value) ?? 0) !== 1 || /[{}]/.test(value)) return false;
  return CJK.test(value) ? [...value].length >= 3 : value.length >= 8;
}

/** 一个界面源文件的锚点：`{ kind: "attr", name, value }` 或 `{ kind: "text", value }`。 */
export function anchorsOf(text, dictionary) {
  const anchors = new Map();
  for (const name of ANCHOR_ATTRIBUTES)
    for (const match of text.matchAll(
      new RegExp(`data-${name}=["'{\`]*([a-z][a-z0-9-]{2,})`, "g"),
    ))
      anchors.set(`${name}=${match[1]}`, {
        kind: "attr",
        name,
        value: match[1],
      });
  for (const match of text.matchAll(/["'`]([a-zA-Z][\w-]*(?:\.[\w-]+)+)["'`]/g))
    for (const value of dictionary.keys.get(match[1]) ?? [])
      if (distinctive(value, dictionary.counts))
        anchors.set(`text=${value}`, { kind: "text", value });
  return [...anchors.values()];
}

function anchorPattern(anchor) {
  return anchor.kind === "attr"
    ? new RegExp(`data-${anchor.name}=\\\\?["']?${escape(anchor.value)}\\b`)
    : new RegExp(`["'\`]${escape(anchor.value)}["'\`]`);
}

/** 探针脚本经相对 import 用到的全部文件（含自己），相对仓库根。 */
export function probeFiles(root, script) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g,
    ))
      walk(resolve(dirname(file), match[1]));
  };
  walk(join(root, script));
  return [...seen].map((file) => relative(root, file).split("\\").join("/"));
}

/**
 * 对每条 A 档探针给出相关的理由。`entries` 是 tools/ci/e2e.d 的条目，`changed` 是改动的
 * 文件（相对仓库根，`/` 分隔）。返回 `[{ id, reasons: [string] }]`，按 id 排序；另返回
 * `webChanged`：有没有改界面源码（用来决定要不要给通用提示）。
 */
export function mapProbes({ root, entries, changed, read = readText }) {
  const tierA = entries.filter((entry) => entry.tier === "a");
  const probes = tierA.map((entry) => {
    const files = probeFiles(root, entry.script);
    return {
      id: entry.id,
      files,
      text: files.map((file) => read(root, file) ?? "").join("\n"),
    };
  });
  const reasons = new Map();
  const add = (id, reason) => {
    const list = reasons.get(id) ?? [];
    if (!list.includes(reason)) list.push(reason);
    reasons.set(id, list);
  };
  for (const probe of probes) {
    for (const file of changed) {
      if (probe.files.includes(file)) add(probe.id, `改了 ${file}`);
      if (file === `tools/ci/e2e.d/${probe.id}.json`)
        add(probe.id, `改了 ${file}`);
    }
  }
  const webFiles = changed.filter(
    (file) => WEB_SOURCE.test(file) && !TEST_SOURCE.test(file),
  );
  if (webFiles.length > 0) {
    const dictionary = readDictionary(root);
    for (const file of webFiles) {
      const text = read(root, file);
      if (text === null) continue;
      for (const anchor of anchorsOf(text, dictionary)) {
        const pattern = anchorPattern(anchor);
        const label =
          anchor.kind === "attr"
            ? `data-${anchor.name}="${anchor.value}"`
            : `「${anchor.value}」`;
        for (const probe of probes)
          if (pattern.test(probe.text))
            add(probe.id, `${file.replace("apps/web/src/", "")} 的 ${label}`);
      }
    }
  }
  return {
    webChanged: webFiles.length > 0,
    probes: [...reasons]
      .map(([id, list]) => ({ id, reasons: list }))
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
  };
}

function readText(root, file) {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null;
  }
}
