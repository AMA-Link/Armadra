/**
 * 时间线里的审批与 elicitation 条目 → 现有的 `PermissionCard` / `ElicitationCard`。
 *
 * 条目只带 `pendingId`、选项与关联的 `toolCallId`；卡片的标题、差异预览要的是工具
 * 条目（同一条时间线里按 `tool:<toolCallId>` 取），经 {@link ToolLookupProvider}
 * 给进来。已答复 / 已取消的条目收成一行结局。
 */
import * as React from "react";
import { Check, X } from "lucide-react";
import type {
  AcpElicitationForm,
  AcpPermissionOption,
  AcpToolKind,
  TimelineApprovalItem,
  TimelineElicitationItem,
  TimelineItem,
  TimelineToolItem,
} from "@armadra/shared";
import { acpElicitationFormSchema, acpToolKindSchema } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { useAnsweredStore } from "./answered";
import type { AcpElicitationView, AcpPermissionView } from "./approval-views";
import { ElicitationCard } from "./ElicitationCard";
import { isAllowOption, PermissionCard } from "./PermissionCard";

const ToolLookup = React.createContext<Readonly<Record<string, TimelineItem>>>(
  {},
);

export const ToolLookupProvider = ToolLookup.Provider;

function toolOf(
  byId: Readonly<Record<string, TimelineItem>>,
  toolCallId: string | undefined,
): TimelineToolItem | undefined {
  if (toolCallId === undefined) return undefined;
  const item = byId[`tool:${toolCallId}`];
  return item?.kind === "tool" ? item : undefined;
}

/** 审批条目 → 卡片要的视图。 */
export function permissionViewOf(
  approval: TimelineApprovalItem,
  tool: TimelineToolItem | undefined,
): AcpPermissionView {
  return {
    pendingId: approval.pendingId,
    toolCall: {
      toolCallId: approval.toolCallId ?? approval.pendingId,
      title: tool?.title ?? "",
      ...(tool === undefined
        ? {}
        : {
            ...(acpToolKindSchema.safeParse(tool.toolKind).success
              ? { kind: tool.toolKind as AcpToolKind }
              : {}),
            locations: tool.locations.map((location) => ({
              path: location.path,
              ...(location.line === undefined ? {} : { line: location.line }),
            })),
            content: tool.content.flatMap((content) =>
              content.type === "diff" && content.newText !== undefined
                ? [
                    {
                      type: "diff" as const,
                      path: content.path,
                      oldText: content.oldText ?? null,
                      newText: content.newText,
                    },
                  ]
                : [],
            ),
            ...(tool.input === undefined ? {} : { rawInput: tool.input }),
          }),
    },
    options: approval.options as readonly AcpPermissionOption[],
  };
}

/** elicitation 条目 → 卡片要的视图（表单 schema 是 JSON 文本）。 */
export function elicitationViewOf(
  item: TimelineElicitationItem,
): AcpElicitationView {
  let form: AcpElicitationForm | undefined;
  if (item.requestedSchema !== undefined) {
    try {
      const parsed = acpElicitationFormSchema.safeParse(
        JSON.parse(item.requestedSchema),
      );
      if (parsed.success) form = parsed.data;
    } catch {
      form = undefined;
    }
  }
  return {
    pendingId: item.pendingId,
    elicitation: {
      message: item.message,
      mode: item.mode,
      ...(form === undefined ? {} : { requestedSchema: form }),
      ...(item.url === undefined ? {} : { url: item.url }),
    },
  };
}

function OutcomeLine({
  slot,
  label,
  by,
  tone,
}: {
  slot: string;
  label: string;
  by: string | undefined;
  tone?: "allow" | "reject";
}) {
  return (
    <div
      data-slot={slot}
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Badge variant="outline">
        {tone === "allow" ? (
          <Check aria-hidden className="text-[var(--success-text)]" />
        ) : tone === "reject" ? (
          <X aria-hidden className="text-[var(--danger-text)]" />
        ) : null}
        {label}
      </Badge>
      {by !== undefined && by !== "" && <span className="truncate">{by}</span>}
    </div>
  );
}

const OUTCOME_KEYS: Record<AcpPermissionOption["kind"], string> = {
  allow_once: "acp.permission.outcome.allowOnce",
  allow_always: "acp.permission.outcome.allowAlways",
  reject_once: "acp.permission.outcome.reject",
  reject_always: "acp.permission.outcome.rejectAlways",
};

export function ApprovalCard({
  approval,
  canAnswer,
  pinned,
  className,
  onAnswered,
}: {
  approval: TimelineApprovalItem;
  canAnswer: boolean;
  pinned?: boolean;
  className?: string;
  onAnswered?: () => void;
}) {
  const t = useT();
  const byId = React.useContext(ToolLookup);
  const answeredHere = useAnsweredStore((state) =>
    state.ids.has(approval.pendingId),
  );
  if (approval.state === "cancelled") {
    return (
      <OutcomeLine
        slot="timeline-approval-outcome"
        label={t("acp.permission.outcome.cancelled")}
        by={undefined}
      />
    );
  }
  if (approval.state === "answered") {
    const option = approval.options.find(
      (item) => item.optionId === approval.answer?.optionId,
    );
    return (
      <OutcomeLine
        slot="timeline-approval-outcome"
        label={t(
          option === undefined
            ? "acp.permission.outcome.allowOnce"
            : OUTCOME_KEYS[option.kind],
        )}
        by={approval.answeredBy}
        tone={
          option === undefined || isAllowOption(option) ? "allow" : "reject"
        }
      />
    );
  }
  if (answeredHere) return null;
  return (
    <PermissionCard
      permission={permissionViewOf(approval, toolOf(byId, approval.toolCallId))}
      canAnswer={canAnswer}
      {...(pinned === undefined ? {} : { pinned })}
      {...(className === undefined ? {} : { className })}
      {...(onAnswered === undefined ? {} : { onAnswered })}
    />
  );
}

export function ElicitationItemCard({
  item,
  canAnswer,
  className,
  onAnswered,
}: {
  item: TimelineElicitationItem;
  canAnswer: boolean;
  className?: string;
  onAnswered?: () => void;
}) {
  const t = useT();
  const answeredHere = useAnsweredStore((state) =>
    state.ids.has(item.pendingId),
  );
  const view = React.useMemo(() => elicitationViewOf(item), [item]);
  if (item.state !== "pending") {
    const action =
      item.state === "cancelled" ? "cancel" : (item.answer?.action ?? "accept");
    return (
      <OutcomeLine
        slot="timeline-elicitation-outcome"
        label={t(`acp.elicitation.outcome.${action}`)}
        by={item.answeredBy}
        {...(action === "accept" ? { tone: "allow" as const } : {})}
      />
    );
  }
  if (answeredHere) return null;
  return (
    <ElicitationCard
      view={view}
      canAnswer={canAnswer}
      {...(className === undefined ? {} : { className })}
      {...(onAnswered === undefined ? {} : { onAnswered })}
    />
  );
}
