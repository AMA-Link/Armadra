/**
 * Windows 验收里与会话宿主进程本身有关的部分（#659）：并发关闭多个终端时宿主
 * 不能换人，以及收尾时把宿主自己的日志带进产物。与 `windows-acceptance-lib.mjs`
 * 一样只用 Node 自带的东西，拷去 Windows 机器时一起拷。
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { markerLine, waitFor } from "./windows-acceptance-lib.mjs";

/** 一次同时终止的终端数：比验收里原有的三个多，确保几条退出线程撞在一起。 */
export const CLOSE_MANY = 6;

/**
 * `sessionHost.closeMany`：node-pty 1.1.0 在 Windows 上有两处原生崩溃会把宿主和
 * 它手里所有 shell 一起带走、什么日志也不留——退出线程不加锁地删 ConPTY 句柄表、
 * 主线程同时在表里查或追加；以及 shell 退出前第二次 kill 关掉已经释放的伪控制台
 * （core 结束会话是先 `kill` 再 `destroy`，pwsh 这种退出慢的 shell 必中）。这里
 * 在 `shells` 里轮流起 {@link CLOSE_MANY} 个终端，一口气全部终止，同一时刻往原有
 * 的每个终端敲一行（附着会让宿主 resize，就是查表）；之后宿主必须还是原来那个
 * pid，原有终端再敲一行仍要回显。
 *
 * `app` 要有 `api` 与 `terminal`；`alive(pid)` 由调用方给（它走 PowerShell）。
 */
export async function closeManyAtOnce(record, app, options) {
  const id = "sessionHost.closeMany";
  if (options.shells.length === 0) return record.skip(id, "没有可用的 shell");
  if (options.sessions.length === 0 || options.hostPid === undefined) {
    return record.skip(id, "没有起来的终端或会话宿主");
  }
  return await record.check(id, () => runCloseMany(app, options));
}

async function runCloseMany(
  app,
  {
    workspaceId,
    wsDir,
    shells,
    sessions,
    hostPid,
    alive,
    count = CLOSE_MANY,
    settleMs = 3_000,
  },
) {
  const tag = randomBytes(3).toString("hex");
  const echo = (session, label, timeout) => {
    const marker = `ACC-${label}-${session.dialect}-${tag}-OK`;
    return app.terminal(
      session.id,
      [`${markerLine(session.dialect, marker)}\r`],
      marker,
      timeout,
    );
  };

  const extra = [];
  for (let index = 0; index < count; index += 1) {
    const [dialect, shell] = shells[index % shells.length];
    const response = await app.api("POST", "/api/terminals", {
      workspaceId,
      cwd: wsDir,
      shell,
    });
    const session = { id: response.body?.id, pid: response.body?.pid, dialect };
    if (typeof session.id !== "string") {
      return { ok: false, detail: { started: extra.length, response } };
    }
    const typed = await echo(session, `many${index}`, 120_000);
    extra.push({ ...session, ready: typed.ok });
  }

  const [answers, during] = await Promise.all([
    Promise.all(
      extra.map((session) =>
        app.api("POST", `/api/terminals/${session.id}/terminate`, {
          mode: "session",
        }),
      ),
    ),
    Promise.all(sessions.map((session) => echo(session, "during", 45_000))),
  ]);
  let extrasGone = true;
  try {
    await waitFor(
      `${count} 个 shell 退出`,
      () => extra.every((session) => !alive(session.pid)),
      { timeout: 30_000 },
    );
  } catch {
    extrasGone = false;
  }
  // 退出线程在 shell 退出之后才动句柄表；留出余量再看宿主。
  await sleep(settleMs);
  const hostAlive = alive(hostPid);
  const after = {};
  for (const session of sessions) {
    const typed = await echo(session, "after", 45_000);
    after[session.dialect] = {
      echoed: typed.ok,
      ...(typed.ok ? {} : { reason: typed.reason }),
    };
  }
  return {
    ok:
      extra.every((session) => session.ready) &&
      answers.every((answer) => answer.status < 300) &&
      extrasGone &&
      hostAlive &&
      Object.values(after).every((entry) => entry.echoed),
    detail: {
      count,
      shells: extra.map((session) => session.dialect),
      ready: extra.filter((session) => session.ready).length,
      terminated: answers.map((answer) => answer.status),
      extrasGone,
      hostPid,
      hostAlive,
      during: Object.fromEntries(
        sessions.map((session, index) => [session.dialect, during[index].ok]),
      ),
      after,
    },
  };
}

/**
 * `conpty.close`：逐个终止原有的终端，shell 与它的控制台宿主都要退出。会话宿主
 * 在这之后仍要是原来那个进程——它此前每次都在这一步无声地死掉，只是没人看
 * （#659）。`consolesOf(pid)` 与 `alive(pid)` 由调用方给。
 */
export async function conptyClose(
  record,
  app,
  { sessions, hostPid, consoleBaseline, alive, consolesOf },
) {
  if (sessions.length === 0) {
    return record.skip("conpty.close", "没有起来的终端");
  }
  return await record.check("conpty.close", async () => {
    const consolesBefore = hostPid ? consolesOf(hostPid) : [];
    const detail = {
      consoleBaseline: consoleBaseline ?? null,
      consolesBefore: consolesBefore.length,
      sessions: {},
    };
    for (const session of sessions) {
      const answer = await app.api(
        "POST",
        `/api/terminals/${session.id}/terminate`,
        { mode: "session" },
      );
      let gone = false;
      try {
        await waitFor(
          `${session.dialect} 的 shell 退出`,
          () => !alive(session.pid),
          { timeout: 20_000 },
        );
        gone = true;
      } catch {
        gone = false;
      }
      detail.sessions[session.dialect] = {
        status: answer.status,
        shellGone: gone,
        // 逐个记：宿主若在这一步没了，是哪一个终端的关闭带走的它。
        at: new Date().toISOString(),
        hostAlive: hostPid !== undefined && alive(hostPid),
      };
    }
    await sleep(2_000);
    detail.hostAlive = hostPid !== undefined && alive(hostPid);
    const consolesAfter = detail.hostAlive ? consolesOf(hostPid) : [];
    detail.consolesAfter = consolesAfter.length;
    const consolesReleased =
      consoleBaseline === undefined
        ? consolesAfter.length < consolesBefore.length ||
          consolesAfter.length === 0
        : consolesAfter.length <= consoleBaseline;
    return {
      ok:
        Object.values(detail.sessions).every((entry) => entry.shellGone) &&
        consolesReleased &&
        detail.hostAlive,
      detail,
    };
  });
}

/**
 * 会话宿主的日志（core 起宿主时把它的 stderr 接到数据目录的 `session-host.log`，
 * 超过上限时上一份在 `.1`）拷进产物目录：宿主没有控制台，它为什么走只写在这里。
 * 返回拷出来的文件名。
 */
export function collectHostLogs(dataDir, out) {
  const copied = [];
  for (const name of ["session-host.log", "session-host.log.1"]) {
    const from = join(dataDir, name);
    if (!existsSync(from)) continue;
    try {
      copyFileSync(from, join(out, name));
      copied.push(name);
    } catch {
      // 拷不出来不影响结论。
    }
  }
  return copied;
}

/**
 * 这次运行以来 Windows 应用日志里与 Armadra.exe 有关的崩溃记录（Application Error
 * 1000、Windows Error Reporting 1001）。会话宿主无声退出时，异常码与出错的模块
 * 只记在这里。
 */
export function crashEventsCommand(since) {
  return (
    `Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000, 1001; ` +
    `StartTime = [datetime]::Parse('${since}') } -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Message -match 'Armadra' } | Select-Object ` +
    `@{ n = 'time'; e = { $_.TimeCreated.ToString('o') } }, Id, ProviderName, ` +
    `@{ n = 'message'; e = { $_.Message.Substring(0, [Math]::Min(1500, $_.Message.Length)) } }`
  );
}

/** 读崩溃记录；读不到时记下原因，不影响结论。 */
export function crashEvents(powershellJson, since) {
  try {
    return powershellJson(crashEventsCommand(since));
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }];
  }
}

/**
 * 收尾：应用输出、会话宿主日志与崩溃记录写进产物目录，再删临时目录（`keep` 时留着）。
 * 返回留下来的临时目录（留着或删不掉），删掉了返回 `undefined`。
 */
export function closeOut({
  out,
  work,
  dataDir,
  appOutput,
  crashes,
  keep = false,
}) {
  if (dataDir !== undefined) collectHostLogs(dataDir, out);
  if (crashes !== undefined) {
    writeFileSync(
      join(out, "crash-events.json"),
      `${JSON.stringify(crashes, null, 2)}\n`,
    );
  }
  writeFileSync(join(out, "app-output.log"), appOutput);
  if (keep) return work;
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10 });
    return undefined;
  } catch {
    return work;
  }
}
