import { useEffect } from "react";

/**
 * 「打开 Git 并选中未提交的变更」（#927 B4）。
 *
 * 请求方（Agent 节点的菜单）先把侧边栏打开，再发这个请求；而历史组件可能这时
 * 才刚挂上，事件已经错过。所以请求先记一笔，挂上的组件进来先认领它，之后的
 * 请求再走事件。
 */
const EVENT = "armadra:git-focus-uncommitted";
let pending = false;

export function requestGitUncommitted(): void {
  pending = true;
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useGitUncommittedRequest(onRequest: () => void): void {
  useEffect(() => {
    const take = () => {
      if (!pending) return;
      pending = false;
      onRequest();
    };
    take();
    window.addEventListener(EVENT, take);
    return () => window.removeEventListener(EVENT, take);
  }, [onRequest]);
}
