// personal-roundtrip 的 `--issuer` 与取证小件：账号清理、把中继托管的网页换成本地构建、
// 页面网络记录与人为延迟（#865、#866）。拆出来是为了主脚本不超过单文件行数上限。
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const listed = (body, key) =>
  Array.isArray(body) ? body : (body?.[key] ?? body?.items ?? []);

/**
 * 账号上现有的源、设备与未撤销链接的 id；登录本身多出的设备也算在里面，清理时一并撤掉。
 * `secret` 登记令牌，最后的日志扫描据此查泄露。
 */
export async function accountIds(call, account, password, secret) {
  const login = await call("POST", "/v1/auth/login", {
    body: {
      account,
      password,
      device: { platform: "server", name: "personal-roundtrip-cleanup" },
    },
  });
  if (login.status !== 200) throw new Error(`清理用的登录答 ${login.status}`);
  const session = login.body.session;
  const token = secret("清理会话令牌", session.accessToken);
  secret("清理会话刷新令牌", session.refreshToken);
  const sources = await call("GET", "/v1/sources", { token });
  const devices = await call("GET", "/v1/me/devices", { token });
  const links = await call("GET", "/v1/links", { token });
  return {
    token,
    refreshToken: session.refreshToken,
    sources: listed(sources.body, "sources").map(
      (one) => one.sourceId ?? one.id,
    ),
    devices: listed(devices.body, "devices").map(
      (one) => one.deviceId ?? one.id,
    ),
    links: listed(links.body, "links")
      .filter((one) => !one.revokedAtMs)
      .map((one) => one.linkId ?? one.id),
  };
}

/** 撤掉 before 之后新出现的链接、源与设备，再登出两次清理会话；答撤掉的个数。 */
export async function restoreAccount(call, account, password, secret, before) {
  const now = await accountIds(call, account, password, secret);
  const revoke = async (ids, path) => {
    let count = 0;
    for (const id of ids) {
      const answer = await call("DELETE", `${path}/${id}`, {
        token: now.token,
      });
      if (answer.status < 300) count += 1;
    }
    return count;
  };
  const fresh = (key) => now[key].filter((one) => !before[key].includes(one));
  const links = await revoke(fresh("links"), "/v1/links");
  const sources = await revoke(fresh("sources"), "/v1/sources");
  const devices = await revoke(fresh("devices"), "/v1/me/devices");
  for (const session of [before, now])
    await call("POST", "/v1/auth/logout", {
      token: session.token,
      body: { refreshToken: session.refreshToken },
    }).catch(() => undefined);
  return { links, sources, devices };
}

const CONTENT_TYPES = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/**
 * 中继托管的 /app/ 是它部署的那一版；想对线上中继验证本地的网页改动，就在浏览器里把
 * /app/ 与 /assets/ 换成本地构建（`ARMADRA_PROBE_WEB_ROOT=apps/web/dist`，#865）。
 */
export async function serveLocalWeb(browser, page, issuer, webRoot) {
  const rootDir = resolve(webRoot);
  await page.call("Fetch.enable", {
    patterns: [{ urlPattern: `${issuer}/*`, requestStage: "Request" }],
  });
  browser.on((message) => {
    if (
      message.sessionId !== page.sessionId ||
      message.method !== "Fetch.requestPaused"
    )
      return;
    const { requestId, request } = message.params;
    const path = new URL(request.url).pathname;
    const file = /^\/app\/?$/.test(path)
      ? join(rootDir, "index.html")
      : path.startsWith("/assets/") && !path.includes("..")
        ? join(rootDir, path)
        : null;
    if (file && existsSync(file)) {
      void page
        .call("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [
            {
              name: "content-type",
              value: CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
            },
            { name: "cache-control", value: "no-store" },
          ],
          body: readFileSync(file).toString("base64"),
        })
        .catch(() => undefined);
    } else {
      void page
        .call("Fetch.continueRequest", { requestId })
        .catch(() => undefined);
    }
  });
}

/**
 * 记下页面发往 /v1、/s、/api 的请求与结局（只记路径，不带查询串），ACP 一步失败时判断
 * 请求到底发没发、答了什么。答这份记录（最多 400 条）。
 */
export async function recordNetwork(browser, page) {
  const log = [];
  const pending = new Map();
  await page.call("Network.enable", {});
  browser.on((message) => {
    if (message.sessionId !== page.sessionId) return;
    const { method, params } = message;
    if (method === "Network.requestWillBeSent") {
      const url = new URL(params.request.url);
      if (!/^\/(v1|s|api)\//.test(url.pathname)) return;
      const entry = {
        t: Date.now(),
        method: params.request.method,
        path: url.pathname,
        ...(/acp|rpc/.test(url.pathname) && params.request.postData
          ? { body: params.request.postData.slice(0, 300) }
          : {}),
      };
      pending.set(params.requestId, entry);
      log.push(entry);
      if (log.length > 400) log.shift();
    } else if (method === "Network.responseReceived") {
      const entry = pending.get(params.requestId);
      if (entry) {
        entry.status = params.response.status;
        entry.doneAt = Date.now();
      }
    } else if (method === "Network.loadingFailed") {
      const entry = pending.get(params.requestId);
      if (entry) {
        entry.failed = params.errorText;
        entry.doneAt = Date.now();
      }
    }
  });
  return log;
}

/** 高延迟中继的复现（#865）：给页面的每个请求加 latency 毫秒。 */
export async function addLatency(page, latency) {
  if (!(latency > 0)) return;
  await page.call("Network.enable", {});
  await page.call("Network.emulateNetworkConditions", {
    offline: false,
    latency,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}

/** ACP 一步失败时的现场：页面状态与取证轨迹、页面请求、core 侧会话行与时间线（#865）。 */
export async function diagnoseAcpStep({
  page,
  node,
  nodeId,
  log,
  owner,
  workspaceId,
}) {
  const out = {};
  const safe = async (name, job) => {
    try {
      out[name] = await job();
    } catch (error) {
      out[name] = `读不到：${String(error).slice(0, 200)}`;
    }
  };
  await safe("page", () =>
    page.evaluate(`
        const node = document.querySelector(${JSON.stringify(node)});
        const field = node?.querySelector('[data-slot="acp-session-view"] textarea');
        return {
          fieldValue: field?.value ?? null,
          fieldDisabled: field?.disabled ?? null,
          loading: !!node?.querySelector('[data-slot="acp-loading"]'),
          starting: node?.querySelector('[data-slot="acp-starting"]')?.innerText ?? null,
          trace: (window.__armadraAcpTrace ?? []).map((entry) => ({
            ...entry,
            at: new Date(entry.at).toISOString().slice(11, 23),
          })),
          store: Object.fromEntries(
            Object.entries(window.__armadraAcpStore?.getState().sessions ?? {}).map(
              ([key, view]) => [
                key.slice(-12),
                { ...view, pending: view.pending ? { clientTurnId: view.pending.clientTurnId } : null },
              ],
            ),
          ),
          sameField: field === window.__probeAcpField,
          mounts: window.__probeAcpMounts ?? null,
          text: (node?.innerText ?? "").slice(0, 800),
        };`),
  );
  await safe("pageRequests", async () =>
    log
      .filter((entry) => /acp|rpc|sessions|timeline|canvas/.test(entry.path))
      .slice(-80)
      .map((entry) => ({
        ...entry,
        t: new Date(entry.t).toISOString().slice(11, 23),
        doneAt:
          entry.doneAt === undefined
            ? undefined
            : new Date(entry.doneAt).toISOString().slice(11, 23),
      })),
  );
  let row;
  await safe("coreSession", async () => {
    row = (await owner(`/api/workspaces/${workspaceId}/sessions`)).find(
      (one) => one.nodeId === nodeId,
    );
    return row ?? null;
  });
  await safe("coreTimeline", async () => {
    if (!row) return null;
    const opened = await owner("/api/rpc/timeline/open", {
      method: "POST",
      body: JSON.stringify({
        json: { timelineId: row.sessionId, tailTurns: 50 },
      }),
    });
    return (opened.json?.items ?? []).map((item) => ({
      kind: item.kind,
      turn: item.turn,
      text: typeof item.text === "string" ? item.text.slice(0, 80) : undefined,
      clientTurnId: item.clientTurnId,
      endedAt: item.endedAt,
      stopReason: item.stopReason,
    }));
  });
  return out;
}

/**
 * 终端节点经中继起好后，节点数据里要有 `sessionId`（#868）：实时板放行写入之前
 * 的系统写回由 store 层排队补写，不能丢。读 core 里这块板的文档，与会话行对照。
 */
export async function terminalSessionWrittenBack({
  owner,
  until,
  workspaceId,
  boardId,
  nodeId,
}) {
  const sessionId = await until(
    async () => {
      const document = await owner(
        `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
      );
      const node = (document.nodes ?? document.document?.nodes ?? []).find(
        (one) => one.id === nodeId,
      );
      return node?.data?.sessionId || undefined;
    },
    "终端节点数据里写回了 sessionId",
    { timeout: 30_000 },
  );
  const rows = await owner(`/api/workspaces/${workspaceId}/sessions`);
  return { sessionId, row: rows.find((one) => one.nodeId === nodeId) };
}
