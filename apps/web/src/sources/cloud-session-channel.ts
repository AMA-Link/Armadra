import { browserSessionStorage } from "./relay-vault";

/**
 * 控制台会话的跨标签页约定（设计 saas-host-open §2.2）：`/h/` 标签页的会话记录记在
 * `sessionStorage` 的 `armadra.host.<控制台账号>.<主机>`；控制台登出、换账号时经
 * `BroadcastChannel("armadra.cloud.session")` 告诉各 `/h/` 标签页，复制出的标签页也用它
 * 认领同一份记录。控制台只用这一个小模块，不拉进 `/h/` 的连接代码。
 */

/** 记录键前缀：`armadra.host.<账号>.<主机>`。 */
export const HOST_KEY_PREFIX = "armadra.host.";
/** 控制台会话的跨标签页广播（登出、换账号、认领）。 */
export const CLOUD_SESSION_CHANNEL = "armadra.cloud.session";

export function hostSessionKey(accountId: string, sourceId: string): string {
  return `${HOST_KEY_PREFIX}${accountId}.${sourceId}`;
}

export type CloudSessionMessage =
  /** 控制台要登出了：`/h/` 标签页趁通道还在先吊销主机侧会话（登出后中继会断开通道、断言也要不到）。 */
  | { readonly type: "signingOut" }
  /** `/h/` 标签页收到 `signingOut`：正在登出（`loggedOut` 是登出完了）。 */
  | { readonly type: "loggingOut"; readonly tabId: string }
  | { readonly type: "loggedOut"; readonly tabId: string }
  | { readonly type: "signedOut" }
  | { readonly type: "accountChanged"; readonly accountId: string }
  | { readonly type: "claim"; readonly key: string; readonly tabId: string }
  | { readonly type: "claimed"; readonly key: string; readonly tabId: string };

export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  close?(): void;
}

export function openCloudSessionChannel(): ChannelLike | null {
  try {
    return typeof BroadcastChannel === "function"
      ? new BroadcastChannel(CLOUD_SESSION_CHANNEL)
      : null;
  } catch {
    return null;
  }
}

/** 丢掉 `armadra.host.*` 记录（`keep` 认的留下）。 */
export function clearHostSessions(
  storage: Storage | null,
  keep: (key: string) => boolean = () => false,
): void {
  if (storage === null) return;
  try {
    const keys: string[] = [];
    for (let at = 0; at < storage.length; at += 1) {
      const key = storage.key(at);
      if (key?.startsWith(HOST_KEY_PREFIX) && !keep(key)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* 清不掉：进入时还会按账号与主体核对。 */
  }
}

/**
 * 控制台这一侧（`ConsoleRoot`）：登出，或这个标签页看到的账号变了——清掉本标签页的
 * `armadra.host.*`（换账号时只留新账号的），并告诉别的 `/h/` 标签页。
 */
export function announceConsoleSession(
  message: Extract<
    CloudSessionMessage,
    { type: "signedOut" | "accountChanged" }
  >,
  storage: Storage | null = browserSessionStorage(),
  channel: ChannelLike | null = openCloudSessionChannel(),
): void {
  clearHostSessions(storage, (key) =>
    message.type === "accountChanged"
      ? key.startsWith(`${HOST_KEY_PREFIX}${message.accountId}.`)
      : false,
  );
  try {
    channel?.postMessage(message);
  } finally {
    channel?.close?.();
  }
}

/** 等 `/h/` 标签页应声的时间，与它们登出的上限。 */
export const SIGN_OUT_ACK_MS = 200;
export const SIGN_OUT_WAIT_MS = 3_000;

/**
 * 控制台登出之前：告诉各 `/h/` 标签页先经通道吊销主机侧会话，等它们登出完（最多
 * {@link SIGN_OUT_WAIT_MS}；{@link SIGN_OUT_ACK_MS} 内没人应声就不等）。之后调用方再登出云端、
 * 再 {@link announceConsoleSession} `signedOut`（错过这一轮的标签页由它收尾）。
 */
export async function signOutHostTabs(
  channel: ChannelLike | null = openCloudSessionChannel(),
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  if (channel === null) return;
  const busy = new Set<string>();
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  channel.addEventListener("message", ({ data }) => {
    if (!isCloudSessionMessage(data)) return;
    if (data.type === "loggingOut") busy.add(data.tabId);
    if (data.type === "loggedOut") {
      busy.delete(data.tabId);
      if (busy.size === 0) settle();
    }
  });
  try {
    channel.postMessage({ type: "signingOut" });
    await wait(SIGN_OUT_ACK_MS);
    if (busy.size > 0) await Promise.race([done, wait(SIGN_OUT_WAIT_MS)]);
  } finally {
    channel.close?.();
  }
}

export function isCloudSessionMessage(
  data: unknown,
): data is CloudSessionMessage {
  const type = (data as { type?: unknown } | null)?.type;
  return (
    type === "signingOut" ||
    type === "loggingOut" ||
    type === "loggedOut" ||
    type === "signedOut" ||
    type === "accountChanged" ||
    type === "claim" ||
    type === "claimed"
  );
}
