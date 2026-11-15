/**
 * 识别前的预热（平台探测、读本机登录）有整体时限：内网主机不可达时一次探测
 * 最多要三个端点各 5 秒，面板不能跟着等。超时只是不再等，工作照常在后台完成
 * 并写进缓存，下一次读取就用得上。
 */

/** 面板一次读取里，所有预热加起来最多等这么久。 */
export const WARM_DEADLINE_MS = 4_000;

/**
 * 等 `work` 最多 `ms` 毫秒：按时完成为 `true`，超时为 `false`。不会抛（`work`
 * 的失败当作已完成）；超时后 `work` 继续跑，不取消。
 */
export async function settleWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
