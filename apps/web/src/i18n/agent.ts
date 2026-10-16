import type { MessageModule } from "./index";

/**
 * Agent 文案（v3）。ACP 已删除；Agent 就是终端里跑的 CLI，
 * 这里只剩启动/权限/状态几个词（计划书 §5.1、§3.4）。
 */
const zh = {
  "agent.restart": "重启 Agent",
  "agent.amaKeys": "Armadra Agent 的模型密钥",
  "agent.amaKeys.provider": "供应商",
  "agent.amaKeys.key": "API Key",
  "agent.amaKeys.save": "保存",
  "agent.amaKeys.clear": "清除",
  "agent.amaKeys.set": "已设置",
  "agent.amaKeys.saved": "已保存",
  "agent.amaKeys.failed": "保存失败",
  "agent.permissionMode": "权限模式",
  "agent.mode.default": "默认",
  "agent.mode.auto-edit": "自动编辑",
  "agent.mode.full-auto": "全自动",
  "agent.mode.plan": "计划",
  "agent.recycle": "回收会话",
  "agent.model": "模型",
  "agent.modelDefault": "CLI 默认",
  "agent.modelHint":
    "仅对下一次启动的会话生效；当前会话保持不变，也不会被重启。",
  "agent.modelQueued": "下一次启动使用 {model}；当前会话不受影响。",

  /* 状态胶囊文案（§24.3-3：11px medium，不再全大写；中文界面就说中文） */
  "agent.state.working": "运行中",
  "agent.state.waiting": "需要你",
  "agent.state.blocked": "需要你",
  "agent.state.done": "已完成",
  "agent.state.errored": "已失败",
  "agent.state.interrupted": "已暂停",
  /* 程序自报（契约 §53）：进度跟在胶囊后面，出错不叫「回合失败」。 */
  "agent.program.progress": "{percent}%",
  "agent.program.error": "出错",
  /* 启动闸门（契约 §52）：自动重试一次之后仍没起来。 */
  "agent.launch.failed": "启动失败",
  "agent.launch.retry": "重试",
} as const;

const en: Record<keyof typeof zh, string> = {
  "agent.restart": "Restart agent",
  "agent.amaKeys": "Armadra Agent model keys",
  "agent.amaKeys.provider": "Provider",
  "agent.amaKeys.key": "API key",
  "agent.amaKeys.save": "Save",
  "agent.amaKeys.clear": "Clear",
  "agent.amaKeys.set": "Set",
  "agent.amaKeys.saved": "Saved",
  "agent.amaKeys.failed": "Could not save",
  "agent.permissionMode": "Permission mode",
  "agent.mode.default": "Default",
  "agent.mode.auto-edit": "Auto edit",
  "agent.mode.full-auto": "Full auto",
  "agent.mode.plan": "Plan",
  "agent.recycle": "Recycle session",
  "agent.model": "Model",
  "agent.modelDefault": "CLI default",
  "agent.modelHint":
    "Applies to the next session this node starts. The running session is unchanged and is not restarted.",
  "agent.modelQueued":
    "The next session will use {model}. The running one is unaffected.",

  "agent.state.working": "Running",
  "agent.state.waiting": "Needs you",
  "agent.state.blocked": "Needs you",
  "agent.state.done": "Done",
  "agent.state.errored": "Turn failed",
  "agent.state.interrupted": "Paused",
  "agent.program.progress": "{percent}%",
  "agent.program.error": "Failed",
  "agent.launch.failed": "Launch failed",
  "agent.launch.retry": "Retry",
};

export const agent: MessageModule = { "zh-CN": zh, en };
