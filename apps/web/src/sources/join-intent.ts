/**
 * 分享链接加入（客户端包 §6.2）在页面里的两件待办，跨组件、跨一次重载传递：
 *
 * - **待填的链接**：桌面壳收到 `armadra://join` 深链、或页面带着 `#join=` 打开
 *   时，设置 → 远程服务里的「通过链接加入」对话框预填它，人点「加入」才挂载。
 *   只在内存里（链接带着秘密，不落存储）。
 * - **加入后打开**：挂载成功之后打开那个源的工作空间。桌面壳为放行新来源会重载
 *   页面（CSP），所以这一项记在 `sessionStorage`，重载后接着做；只存源标识。
 */

import { LOCAL_SOURCE_ID } from "../api/source";
import { markJoinedByLink } from "./origin";

const OPEN_KEY = "armadra.sources.openAfterJoin";
/** 要打开的是那个源上的哪一个工作空间（`/h/<host>?ws=`）；没有就开第一个。 */
const OPEN_WORKSPACE_KEY = "armadra.sources.openWorkspace";

type Listener = () => void;
const listeners = new Set<Listener>();
let offered: string | null = null;

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/** 订阅两件待办的变化；返回退订。 */
export function onJoinIntent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 交来一条待填的分享链接（深链或 `#join=`）。 */
export function offerJoinLink(url: string): void {
  offered = url;
  announce();
}

/** 取走待填的链接（只取一次）。 */
export function takeJoinLink(): string | null {
  const url = offered;
  offered = null;
  return url;
}

export function hasOfferedJoinLink(): boolean {
  return offered !== null;
}

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 挂载成功：记下这个源是经链接加入的（归到「他人分享」），再等它连上打开。
 */
export function openAfterJoin(sourceId: string): void {
  if (sourceId !== LOCAL_SOURCE_ID) markJoinedByLink(sourceId);
  openWhenReady(sourceId);
}

/**
 * 记下要打开的源（连上、列出工作空间后打开给的那个，没给就第一个），重载之后也还在。
 */
export function openWhenReady(sourceId: string, workspaceId?: string): void {
  try {
    session()?.setItem(OPEN_KEY, sourceId);
    if (workspaceId === undefined) session()?.removeItem(OPEN_WORKSPACE_KEY);
    else session()?.setItem(OPEN_WORKSPACE_KEY, workspaceId);
  } catch {
    /* 记不下就停在设置页，侧栏里点一下即可。 */
  }
  announce();
}

/** 等着打开的源；没有是 `null`。 */
export function pendingJoinOpen(): string | null {
  try {
    return session()?.getItem(OPEN_KEY) ?? null;
  } catch {
    return null;
  }
}

/** 等着打开的那个工作空间；没指定是 `null`。 */
export function pendingWorkspaceOpen(): string | null {
  try {
    return session()?.getItem(OPEN_WORKSPACE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function clearJoinOpen(): void {
  try {
    session()?.removeItem(OPEN_KEY);
    session()?.removeItem(OPEN_WORKSPACE_KEY);
  } catch {
    /* 同上 */
  }
}
