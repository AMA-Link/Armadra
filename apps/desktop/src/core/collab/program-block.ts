/**
 * 哪些节点此刻被程序自报的 `blocked` 拦着（契约 §53、§120），以及它解除时叫醒谁。
 *
 * `blocked` 是投递的否决项，它解除时目标那一侧可能什么 `agent.status` 都不会再报，
 * 所以要靠 `terminal.program` 事件叫醒出队泵。只在「这个节点此前被拦着，现在不
 * 拦了（变成别的状态，或记录没了）」那一下触发：进度条每秒刷几十帧，每帧都叫醒
 * 出队泵没有意义。
 *
 * 「被拦着」有两个来源：事件里见到的 `blocked` 帧，以及一次投递真的被它否决了
 * （{@link ProgramBlockTracker.vetoed}）。后一个不能省：帧有 250 ms 的节流，
 * working → blocked → idle 在一个窗口里发生时，帧里一个 `blocked` 都没有，而投递
 * 当时读的是跟踪器的即时值、已经被否决排了队。
 */
export class ProgramBlockTracker {
  private readonly blocked = new Set<string>();

  /** 一次投递被程序自报的 `blocked` 否决了：这个节点解除时要叫醒出队泵。 */
  vetoed(nodeId: string): void {
    if (nodeId !== "") this.blocked.add(nodeId);
  }

  /** 喂一条事件；答「该叫醒出队泵的那个节点」，没有就是 `undefined`。 */
  observe(event: {
    readonly type: string;
    readonly nodeId?: unknown;
    readonly status?: unknown;
  }): string | undefined {
    if (event.type !== "terminal.program") return undefined;
    if (typeof event.nodeId !== "string" || event.nodeId === "")
      return undefined;
    const status = event.status as { state?: unknown } | undefined;
    if (status?.state === "blocked") {
      this.blocked.add(event.nodeId);
      return undefined;
    }
    return this.blocked.delete(event.nodeId) ? event.nodeId : undefined;
  }

  /** 此刻登记着的节点（清扫要逐个核对它们是不是真的还被拦着）。 */
  nodes(): string[] {
    return [...this.blocked];
  }

  /** 清扫发现它已经不被拦了：放掉这条登记。 */
  release(nodeId: string): void {
    this.blocked.delete(nodeId);
  }

  clear(): void {
    this.blocked.clear();
  }
}

/** 整个 core 一份：`send` 登记否决，`agent/index.ts` 的总线处理函数读它。 */
export const programBlocks = new ProgramBlockTracker();
