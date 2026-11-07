/**
 * 会话视图的投递轨迹（#865 的取证用）。默认什么都不做；页面的 localStorage 里有
 * `armadra.diag = "1"` 时，把起会话、排队、发送、结局这些节点记进
 * `globalThis.__armadraAcpTrace`（最近 200 条，不带提问正文），探针失败时据此判断
 * 一句话丢在页面哪一步。
 */
const LIMIT = 200;

export function diagEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem("armadra.diag") === "1";
  } catch {
    return false;
  }
}

export interface TraceEntry {
  readonly at: number;
  readonly event: string;
  readonly detail?: Record<string, unknown>;
}

export function trace(event: string, detail?: Record<string, unknown>): void {
  if (!diagEnabled()) return;
  const scope = globalThis as { __armadraAcpTrace?: TraceEntry[] };
  const log = (scope.__armadraAcpTrace ??= []);
  log.push({ at: Date.now(), event, ...(detail ? { detail } : {}) });
  if (log.length > LIMIT) log.shift();
}
