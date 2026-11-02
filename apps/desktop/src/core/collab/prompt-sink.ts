/**
 * 一个节点的一轮开始了，提示词是什么（hook 域的 `UserPromptSubmit` 一类事件）：
 * 协作域在装配时挂上一个接收者，hook 域只管投。注入而不是互相 import，免得 hook
 * 域与 agent 域成环。
 */
type PromptSink = (nodeId: string, text: string) => void;

let sink: PromptSink | undefined;

export function setPromptSink(next: PromptSink | undefined): void {
  sink = next;
}

export function notePrompt(nodeId: string, text: string): void {
  sink?.(nodeId, text);
}
