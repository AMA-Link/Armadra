// 被测应用的进程与页面：起 Armadra.exe、经 CDP 接上渲染进程、替探针调页面里的助手。
// 从 windows-acceptance.mjs 拆出（#573 第 4 项），逻辑没有改动。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  PAGE_HELPERS,
  attachToRenderer,
  cdp,
  freePort,
  waitFor,
} from "./windows-acceptance-lib.mjs";
import { isolatedEnv } from "./probe-home.mjs";

/**
 * 页面里的工具，没装（页面刚换过一次地址）就先装：每次调用都从页面自己的桥现读
 * 地址。
 */
export const HELPERS = `(globalThis.__acceptance ?? (${PAGE_HELPERS}, globalThis.__acceptance))`;

export class App {
  constructor({ exe, dataDir, home, userDataDir, log }) {
    Object.assign(this, { exe, dataDir, home, userDataDir, log });
    this.child = undefined;
    this.page = undefined;
    this.output = "";
  }

  async start() {
    const port = await freePort();
    this.child = spawn(
      this.exe,
      [
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${this.userDataDir}`,
      ],
      {
        // 临时 HOME（probe-home.mjs：HOME / USERPROFILE、XDG、各 CLI 的配置目录、
        // git 全局配置），并去掉指向真实账号的凭据变量。
        env: isolatedEnv(this.home, { ARMADRA_DATA_DIR: this.dataDir }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      },
    );
    this.child.stdout.on("data", (chunk) => (this.output += chunk));
    this.child.stderr.on("data", (chunk) => (this.output += chunk));
    this.exited = new Promise((done) => this.child.once("exit", done));
    const url = await attachToRenderer(port, () => {
      if (this.child.exitCode !== null)
        return `应用退出了（${this.child.exitCode}）：${this.output.slice(-1500)}`;
      const failed =
        /Runtime process exited before becoming ready|core could not start/.exec(
          this.output,
        );
      return failed ? `core 没起来：${this.output.slice(-1500)}` : undefined;
    });
    this.page = await cdp(url);
    // 页面可能比 core 先到，或换过一次地址：等到经页面问得到 /api/health 为止。
    let last;
    const endpoints = await waitFor(
      "经页面问到 core 的 /api/health",
      async () => {
        try {
          const ready = await this.page.evaluate(
            `(async () => { delete globalThis.__acceptance; const helpers = ${HELPERS}; const health = await helpers.api("GET", "/api/health"); return health.status === 200 ? { httpBase: helpers.httpBase, wsBase: helpers.wsBase } : null; })()`,
          );
          return ready ?? undefined;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
          return undefined;
        }
      },
      { timeout: 90_000, interval: 1_000 },
    ).catch((error) => {
      throw new Error(`${error.message}；最后一次：${last ?? "无"}`);
    });
    return endpoints;
  }

  get pid() {
    return this.child?.pid;
  }

  async api(method, path, body) {
    return await this.page.evaluate(
      `${HELPERS}.api(${JSON.stringify(method)}, ${JSON.stringify(path)}, ${JSON.stringify(body)})`,
    );
  }

  async terminal(sessionId, lines, waitFor, timeoutMs = 30_000) {
    return await this.page.evaluate(
      `${HELPERS}.terminal(${JSON.stringify(sessionId)}, "acceptance", ${JSON.stringify(lines)}, ${JSON.stringify(waitFor)}, ${timeoutMs})`,
    );
  }

  async evaluate(expression) {
    return await this.page.evaluate(expression);
  }

  /** 只杀主进程（模拟崩溃）：渲染、GPU 与 core 随它退出，分离起的会话宿主不该。 */
  async kill() {
    this.page?.close();
    this.page = undefined;
    if (this.child && this.child.exitCode === null) {
      try {
        process.kill(this.child.pid);
      } catch {
        // 已经退了。
      }
      await Promise.race([this.exited, sleep(15_000)]);
    }
  }
}
