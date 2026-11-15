/**
 * 测试里的跨平台陷阱（#953）：本机 macOS / Linux 跑得过、只在 Windows 的 CI 上红的写法。
 *
 *   node tools/portability-check.mjs [文件…]
 *
 * 不带参数时查全部已跟踪的测试文件（`*.test.*`、`*.spec.*`）。只有一条规则，宁可漏报
 * 也不误报：
 *
 * - **PATH 列表用 `:` 写死**：给 `PATH` 赋的值里有 `"/usr/bin:/bin"`、`` `${bin}:${PATH}` ``、
 *   `.join(":")`，或 `PATH….split(":")`。Windows 的 `path.delimiter` 是 `;`，被测代码按
 *   平台拼、测试按 `:` 拼，两边对不上（#950）。改成 `[a, b].join(delimiter)`、
 *   `` `${bin}${delimiter}${PATH}` ``（`import { delimiter } from "node:path"`）。
 *
 * 显式按 POSIX 目标调用的不算：同一个调用里带 `"linux"` / `"darwin"` 实参或
 * `{ platform: "linux" }`（被测代码按目标平台选分隔符）。
 * 只在 Windows 之外才跑的代码不算：`describe.skipIf(process.platform === "win32")`、
 * `it.runIf(...)` 等门控的回调里，`describeUnix` 这类按 `win32` 选出来的别名，条件里提到
 * `win32` / `isWindows` 的 `if` 与三元，以及前面有 `if (… win32 …) return` 的函数体。
 * 确实只在 POSIX 上成立的值（例如发给远端 Linux 的环境）在同一行或上一行写
 * `// portability-ok: 理由` 放行。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ts = createRequire(join(ROOT, "package.json"))("typescript");

export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const ALLOW = /portability-ok:/;
const WINDOWS_WORDS = /win32|isWindows|IS_WINDOWS/;

/**
 * 字面量里有没有 POSIX 的列表分隔符：`:`，但不算 `C:\`、`C:/` 这样的盘符和 `://`。
 * 已经按 `;` 分隔的 Windows 列表（`C:\\Windows;D:\\bin`）逐段剥掉盘符再看。
 */
export function hasListColon(text) {
  return text
    .split(";")
    .some((part) => /:(?!\/\/)/.test(part.replace(/^[A-Za-z]:[\\/]/, "")));
}

function isColonLiteral(node) {
  return (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    node.text === ":"
  );
}

/** 一个表达式是不是用 `:` 拼出来的 PATH 值；返回问题描述或 null。 */
function colonValue(node) {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return colonValue(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return hasListColon(node.text) ? `"${node.text}"` : null;
  if (ts.isTemplateExpression(node)) {
    const parts = [
      node.head.text,
      ...node.templateSpans.map((s) => s.literal.text),
    ];
    // 盘符只可能在开头；模板中段出现的 `:` 都是在拼列表。
    return parts.some((part, index) =>
      index === 0 ? hasListColon(part) : /:(?!\/\/)/.test(part),
    )
      ? "模板里的 `:`"
      : null;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  )
    return colonValue(node.left) ?? colonValue(node.right);
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join" &&
    node.arguments.length === 1 &&
    isColonLiteral(node.arguments[0])
  )
    return '.join(":")';
  return null;
}

function propertyName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function isPathTarget(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "PATH";
  if (ts.isElementAccessExpression(node))
    return (
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "PATH"
    );
  return false;
}

const POSIX_PLATFORMS = new Set(["linux", "darwin", "freebsd", "openbsd"]);

/** `"linux"` 这样的实参，或带 `platform: "linux"` 的对象实参。 */
function posixTarget(node) {
  if (ts.isStringLiteral(node)) return POSIX_PLATFORMS.has(node.text);
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        propertyName(property.name) === "platform" &&
        ts.isStringLiteral(property.initializer) &&
        POSIX_PLATFORMS.has(property.initializer.text),
    )
  );
}

/** 表达式提到了平台：`win32` 字样，或按 `win32` 算出来的变量（`unix`、`describeUnix`）。 */
function mentionsPlatform(node, source, aliases) {
  if (WINDOWS_WORDS.test(node.getText(source))) return true;
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isIdentifier(child) && aliases.has(child.text)) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** 在 Windows 上压根不会执行到这个节点。 */
function gatedOffWindows(node, source, aliases) {
  const platform = (expression) =>
    mentionsPlatform(expression, source, aliases);
  for (let current = node; current.parent; current = current.parent) {
    const parent = current.parent;
    // 显式按 POSIX 目标调用的：同一个调用里带着 "linux" / "darwin" 实参，或
    // `{ platform: "linux" }`。被测代码按目标平台选分隔符，`:` 正是对的。
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.includes(current) &&
      parent.arguments.some(posixTarget)
    )
      return true;
    // describe.skipIf(cond)(…) / it.runIf(cond)(…)：回调在外层调用的参数里。
    if (ts.isCallExpression(parent) && parent.arguments.includes(current)) {
      const callee = parent.expression;
      if (
        ts.isCallExpression(callee) &&
        ts.isPropertyAccessExpression(callee.expression) &&
        /^(skipIf|runIf)$/.test(callee.expression.name.text) &&
        callee.arguments.some(platform)
      )
        return true;
      const head = ts.isPropertyAccessExpression(callee)
        ? callee.expression
        : callee;
      if (ts.isIdentifier(head) && aliases.has(head.text)) return true;
    }
    if (
      (ts.isIfStatement(parent) || ts.isConditionalExpression(parent)) &&
      platform(ts.isIfStatement(parent) ? parent.expression : parent.condition)
    )
      return true;
    // 同一块里在前面的 `if (… win32 …) return / skip()`。
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      for (const statement of parent.statements) {
        if (statement === current) break;
        if (
          ts.isIfStatement(statement) &&
          platform(statement.expression) &&
          /\b(return|skip\(\))/.test(statement.thenStatement.getText(source))
        )
          return true;
      }
    }
  }
  return false;
}

/**
 * 按 `win32` 算出来的名字：`const unix = process.platform !== "win32"`、
 * `const describeUnix = unix ? describe : describe.skip`（传递一层层算下去）。
 */
function windowsAliases(source) {
  const names = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      !names.has(node.name.text) &&
      mentionsPlatform(node.initializer, source, names)
    ) {
      names.add(node.name.text);
      grew = true;
    }
    ts.forEachChild(node, visit);
  };
  let grew = true;
  while (grew) {
    grew = false;
    visit(source);
  }
  return names;
}

/** 查一个文件的源码，返回 `[{ line, message }]`（行号从 1 起）。 */
export function findProblems(text, fileName) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = text.split("\n");
  const aliases = windowsAliases(source);
  const problems = [];
  const report = (node, what) => {
    const line = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    ).line;
    if (ALLOW.test(lines[line] ?? "") || ALLOW.test(lines[line - 1] ?? ""))
      return;
    if (gatedOffWindows(node, source, aliases)) return;
    problems.push({
      line: line + 1,
      message: `PATH 用 \`:\` 拼（${what}）：Windows 的分隔符是 \`;\`，改用 path.delimiter`,
    });
  };
  const visit = (node) => {
    let value = null;
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "PATH")
      value = node.initializer;
    else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isPathTarget(node.left)
    )
      value = node.right;
    else if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.length === 2 &&
      ts.isStringLiteral(node.elements[0]) &&
      node.elements[0].text === "PATH"
    )
      value = node.elements[1];
    if (value) {
      const what = colonValue(value);
      if (what) report(value, what);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "split" &&
      node.arguments.length === 1 &&
      isColonLiteral(node.arguments[0]) &&
      /\bPATH\b/.test(node.expression.expression.getText(source))
    )
      report(node, 'PATH….split(":")');
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

function trackedTests() {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => TEST_FILE.test(file));
}

function main(argv) {
  const files = (argv.length > 0 ? argv : trackedTests()).filter((file) =>
    TEST_FILE.test(file),
  );
  let count = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue; // 删掉的文件
    }
    for (const problem of findProblems(text, file)) {
      count += 1;
      console.error(`${file}:${problem.line}  ${problem.message}`);
    }
  }
  if (count > 0) {
    console.error(
      `\n${count} 处跨平台问题。确实只在 POSIX 上成立的，在该行或上一行写 // portability-ok: 理由`,
    );
    return 1;
  }
  console.log(`跨平台检查：${files.length} 个测试文件，没有问题`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
