import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PATCHED_FILES,
  PINNED_VERSION,
  installedNodePtyDir,
  verifyNodePtySource,
} from "./verify-node-pty.mjs";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "verify-node-pty.mjs",
);

const read = (file) => readFileSync(join(installedNodePtyDir(), file), "utf8");

// dev（electron-rebuild）与 dist（electron-builder 的 @electron/rebuild）都从
// node_modules 里这份源码编 pty.node / conpty.node，所以补丁必须在安装时就在：
// pnpm 的 patchedDependencies 打上 patches/node-pty@1.1.0.patch（#671）。
test("装出来的 node-pty 源码就是打过补丁的那份：版本与每份补丁文件的哈希都对得上", () => {
  verifyNodePtySource();
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

// macOS：pty_posix_spawn 每次 spawn 泄漏 /dev/ptmx 与父进程的 slave（#671）。
test("装出来的 src/unix/pty.cc 在每条出口都关 master、slave 与低位 fd", () => {
  const source = read("src/unix/pty.cc");
  const body = source.slice(source.lastIndexOf("pty_posix_spawn(char** argv"));
  // 原来少关 low_fds[0]、越界读 low_fds[3] 的清理循环没了。
  assert.doesNotMatch(body, /for \(; count > 0; count--\)/);
  assert.match(body, /int low_fds\[3\] = \{ -1, -1, -1 \};/);
  assert.match(
    body,
    /for \(size_t index = 0; index <= count && index < 3; index\+\+\)/,
  );
  // posix_openpt 到 posix_spawn 之间六处早退都改成跳到 fail:，不再带着 fd 返回。
  assert.equal(body.match(/goto fail;/g)?.length, 6);
  assert.doesNotMatch(body.slice(0, body.indexOf("done:")), /\n\s+return;\n/);
  // 成功路径也关父进程那份 slave。
  assert.match(body, /done:[\s\S]*if \(slave != -1\) \{\s+close\(slave\);/);
});

// Windows：同时关闭多个终端时会话宿主崩溃（#659，上游 node-pty#922）。
test("装出来的 src/win/conpty.cc 带着 ptyHandles 的锁（#659）", () => {
  const source = read("src/win/conpty.cc");
  assert.match(source, /static std::mutex g_ptyHandlesMutex;/);
  // 退出线程的删除、spawn 的追加、connect / resize / clear / kill 的查找都在锁里。
  assert.equal(
    source.match(/std::lock_guard<std::mutex> lock\(g_ptyHandlesMutex\);/g)
      ?.length,
    6,
  );
  assert.doesNotMatch(source, /assert\(remove_pty_baton/);
  // 同一个伪控制台不关两次：kill 关过之后置空，resize / clear / kill 都先看它。
  assert.match(
    source,
    /pfnClosePseudoConsole\(handle->hpc\);\s+handle->hpc = nullptr;/,
  );
  assert.equal(source.match(/handle->hpc != nullptr/g)?.length, 3);
});

/** A copy of the installed module's manifest and patched files, to break. */
function copyOfInstalled() {
  const root = mkdtempSync(join(tmpdir(), "armadra-verify-node-pty-"));
  const from = installedNodePtyDir();
  for (const file of ["package.json", ...Object.keys(PATCHED_FILES)])
    cpSync(join(from, file), join(root, file), { recursive: true });
  return root;
}

test("版本不是钉住的那个：拒绝，不放宽", () => {
  const root = copyOfInstalled();
  try {
    verifyNodePtySource(root);
    const manifest = JSON.parse(readFileSync(join(root, "package.json")));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ ...manifest, version: "1.1.1" }),
    );
    assert.throws(
      () => verifyNodePtySource(root),
      new RegExp(`node-pty 1\\.1\\.1 is installed.*${PINNED_VERSION}`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("没打补丁：明说补丁没打上，而不只是哈希不同", () => {
  const root = copyOfInstalled();
  try {
    const file = join(root, "src/unix/pty.cc");
    const { marker } = PATCHED_FILES["src/unix/pty.cc"];
    writeFileSync(file, readFileSync(file, "utf8").replace(marker, ""));
    assert.throws(
      () => verifyNodePtySource(root),
      /src\/unix\/pty\.cc is not patched/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("打了补丁但内容变了：按哈希拒绝", () => {
  const root = copyOfInstalled();
  try {
    const file = join(root, "src/win/conpty.cc");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
    assert.throws(
      () => verifyNodePtySource(root),
      /src\/win\/conpty\.cc hashes [0-9a-f]{64}, expected/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
