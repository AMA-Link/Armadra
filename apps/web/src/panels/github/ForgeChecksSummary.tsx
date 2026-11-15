import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { useT } from "@/app/preferences-store";
import { openExternal } from "@/platform";
import {
  type ForgeChecks,
  type ForgeRepo,
  forgePullChecks,
} from "../../api/forge";
import { forgeKeys } from "./forge-keys";

type CheckState = ForgeChecks["checks"][number]["state"];

const DOT: Record<CheckState, string> = {
  success: "bg-success",
  failure: "bg-danger",
  pending: "bg-warn",
  neutral: "bg-muted-foreground",
};

function Dot({ state }: { state: CheckState }) {
  return (
    <span
      aria-hidden
      data-state={state}
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT[state])}
    />
  );
}

/** 链接只收 http(s)；别的协议当没有链接。 */
function safeUrl(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** 「检查 3 / 4 通过」：总览加每项一个圆点，展开看每项。 */
export function ChecksView({
  checks,
  compact = false,
  defaultExpanded = false,
  className,
}: {
  checks: ForgeChecks;
  compact?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  if (checks.checks.length === 0) return null;
  const passed = checks.checks.filter((c) => c.state === "success").length;
  const total = checks.checks.length;
  const label = t("forge.checks.summary", { passed, total });
  const failed = checks.checks.filter((c) => c.state === "failure").length;
  const running = checks.checks.filter((c) => c.state === "pending").length;
  const detail = [
    failed > 0 ? t("forge.checks.failed", { count: failed }) : null,
    running > 0 ? t("forge.checks.running", { count: running }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const rollup = checks.rollup === "none" ? "neutral" : checks.rollup;

  if (compact) {
    return (
      <span
        data-slot="forge-checks"
        data-compact="true"
        title={label}
        className="inline-flex items-center gap-1 text-caption tabular-nums text-muted-foreground"
      >
        <Dot state={rollup} />
        {passed}/{total}
      </span>
    );
  }
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      data-slot="forge-checks"
      className={cn("min-w-0 rounded-card border border-border", className)}
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-body">
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{label}</span>
          {detail && (
            <span
              data-slot="forge-checks-detail"
              className="truncate text-meta text-muted-foreground"
            >
              {detail}
            </span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {checks.checks.map((check, index) => (
            <Dot key={`${check.name}-${index}`} state={check.state} />
          ))}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="min-w-0 divide-y divide-border border-t border-border">
          {checks.checks.map((check, index) => {
            const url = safeUrl(check.url);
            return (
              <li
                key={`${check.name}-${index}`}
                data-slot="forge-check"
                className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-meta"
              >
                <Dot state={check.state} />
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="min-w-0 truncate hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      void openExternal(url);
                    }}
                  >
                    {check.name}
                  </a>
                ) : (
                  <span className="min-w-0 truncate">{check.name}</span>
                )}
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {t(`forge.checks.${check.state}`)}
                </span>
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** PR 的检查汇总：详情页完整，画布框头部紧凑；同一个查询、同一份渲染。 */
export function ForgeChecksSummary({
  repo,
  number,
  compact = false,
  enabled = true,
  defaultExpanded = false,
  className,
}: {
  repo: ForgeRepo;
  number: number;
  compact?: boolean;
  enabled?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}) {
  const checks = useQuery({
    queryKey: forgeKeys.pullChecks(repo, number),
    queryFn: () => forgePullChecks(repo, number),
    enabled,
    retry: false,
  });
  if (!checks.data) return null;
  return (
    <ChecksView
      checks={checks.data}
      compact={compact}
      defaultExpanded={defaultExpanded}
      className={className}
    />
  );
}
