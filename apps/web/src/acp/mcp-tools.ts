/**
 * MCP 工具调用怎么显示（#768）：Armadra 自己的工具按 `ARMADRA_MCP_TOOLS`
 * （= `VERB_TOOLS`）每个一条文案（`acp.mcp.tool.<name>`）与图标；别家 MCP
 * 工具写「服务器 · 工具」配插头图标。从不显示 `mcp.armadra.*` 这种原始 id。
 *
 * 来源只看时间线工具条目的 `mcp` 字段（适配器的结构化字段推出，从不看标题）。
 */
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Ban,
  Bell,
  Camera,
  CirclePause,
  CircleQuestionMark,
  Download,
  FileText,
  Flag,
  Globe,
  Hand,
  Hourglass,
  Inbox,
  Keyboard,
  LayoutGrid,
  Link,
  ListChecks,
  ListTodo,
  MailCheck,
  MessageSquare,
  Mailbox,
  MousePointer2,
  MousePointerClick,
  Move,
  PackageOpen,
  Palette,
  PencilLine,
  Plug,
  Printer,
  Scaling,
  ScanText,
  ScrollText,
  Send,
  PanelTop,
  SquareTerminal,
  SquareX,
  StickyNote,
  TextCursorInput,
  Timer,
  Undo2,
  Upload,
  Users,
  Workflow,
  ArrowDownUp,
  ListOrdered,
  Bot,
  type LucideIcon,
} from "lucide-react";
import {
  type AcpMcpTool,
  type ArmadraMcpTool,
  isArmadraMcpTool,
} from "@armadra/shared";

import type { Translate } from "@/app/preferences-store";

/** 每个自家工具的图标；`satisfies` 让漏一项或多一项都编不过。 */
export const ARMADRA_TOOL_ICONS = {
  canvas_help: CircleQuestionMark,
  canvas_post: Send,
  canvas_inbox: Inbox,
  canvas_ack: MailCheck,
  canvas_handoff_read: PackageOpen,
  canvas_list: LayoutGrid,
  canvas_open_terminal: SquareTerminal,
  canvas_open_agent: Bot,
  canvas_open_browser: AppWindow,
  canvas_sticky: StickyNote,
  canvas_link: Link,
  canvas_rename: PencilLine,
  canvas_color: Palette,
  canvas_interrupt: CirclePause,
  canvas_close: SquareX,
  canvas_send: MessageSquare,
  canvas_outbox: Mailbox,
  canvas_cancel: Ban,
  canvas_team: Users,
  canvas_workflow_propose: Workflow,
  canvas_wait: Hourglass,
  canvas_report: Flag,
  canvas_handback: Undo2,
  canvas_items: ListTodo,
  canvas_events: Bell,
  canvas_notify: MessageSquare,
  context_list: ListOrdered,
  context_summary: ScanText,
  context_transcript: ScrollText,
  context_terminal: SquareTerminal,
  browser_navigate: Globe,
  browser_back: ArrowLeft,
  browser_forward: ArrowRight,
  browser_read: FileText,
  browser_click: MousePointerClick,
  browser_hover: MousePointer2,
  browser_drag: Move,
  browser_type: Keyboard,
  browser_fill: TextCursorInput,
  browser_select: ListChecks,
  browser_press: Keyboard,
  browser_scroll: ArrowDownUp,
  browser_wait: Timer,
  browser_capture: Camera,
  browser_pdf: Printer,
  browser_resize: Scaling,
  browser_upload: Upload,
  browser_download: Download,
  browser_tabs: AppWindow,
  browser_close: SquareX,
  browser_dialog: PanelTop,
  browser_lease: Hand,
} satisfies Record<ArmadraMcpTool, LucideIcon>;

/** 别家 MCP 工具的图标。 */
export const FOREIGN_MCP_ICON: LucideIcon = Plug;

export function armadraToolKey(tool: ArmadraMcpTool): string {
  return `acp.mcp.tool.${tool}`;
}

/** 是不是 Armadra 自己那条服务器上的工具（来源，不看标题）。 */
export function isArmadraTool(mcp: AcpMcpTool | undefined): boolean {
  return isArmadraMcpTool(mcp);
}

export interface McpToolDisplay {
  readonly title: string;
  readonly Icon: LucideIcon;
  /** 自家工具：不带「有风险」，不按命令画。 */
  readonly own: boolean;
}

/** MCP 调用的标题与图标；不是 MCP 调用答 `null`（照用工具自己的标题）。 */
export function mcpToolDisplay(
  mcp: AcpMcpTool | undefined,
  t: Translate,
): McpToolDisplay | null {
  if (mcp === undefined) return null;
  if (isArmadraMcpTool(mcp)) {
    return {
      title: t(armadraToolKey(mcp.tool)),
      Icon: ARMADRA_TOOL_ICONS[mcp.tool],
      own: true,
    };
  }
  return {
    title: t("acp.mcp.foreign", { server: mcp.server, tool: mcp.tool }),
    Icon: FOREIGN_MCP_ICON,
    own: false,
  };
}
