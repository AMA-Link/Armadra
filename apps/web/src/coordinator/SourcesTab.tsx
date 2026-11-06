import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { SkeletonList } from "@/ui/skeletons";
import { Switch } from "@/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { toast } from "@/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  type IntakeSource,
  type SaveSourceInput,
  type SourceKind,
  type SourceMode,
  SOURCE_KINDS,
  SOURCE_MODES,
  coordinatorApi,
  coordinatorKeys,
} from "./api";
import {
  type CoordinatorOption,
  type RulesState,
  parseAllow,
  rulesState,
  sourceInput,
} from "./model";

/**
 * 分派抽屉的「来源」页（契约 §104.7）：协调者盯着的仓库——种类、模式、允许名单、
 * 规则文件的确认状态、最近判定的统计、启用与删除。只有人能改（`agent:launch`）；
 * 只读访客看得到、改不了。切 auto 的前置不满足时 core 拒绝，选择器保持原值，
 * 提示是 core 的原话。
 */

const RULES_TONE: Record<RulesState, "success" | "warn" | "outline"> = {
  confirmed: "success",
  changed: "warn",
  unconfirmed: "outline",
  missing: "outline",
};

export interface SourcesViewProps {
  readonly sources: readonly IntakeSource[];
  /** 这块画板上的协调者；添加时选其一（只有一个时不画选择器）。 */
  readonly coordinators: readonly CoordinatorOption[];
  /** 添加时默认选哪个协调者。 */
  readonly defaultCoordinator?: string | null;
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly offline?: boolean;
  /** 能不能改（`agent:launch`）。 */
  readonly canEdit?: boolean;
  /** 正在保存的来源 id（添加时是 `"new"`）。 */
  readonly saving?: string | null;
  readonly onReload?: () => void;
  readonly onSave?: (input: SaveSourceInput) => void;
  readonly onDelete?: (id: string) => void;
}

/** 纯展示：真抽屉与展示页共用。 */
export function SourcesView({
  sources,
  coordinators,
  defaultCoordinator = null,
  loading = false,
  error = false,
  offline = false,
  canEdit = true,
  saving = null,
  onReload,
  onSave,
  onDelete,
}: SourcesViewProps) {
  const t = useT();
  const [adding, setAdding] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<IntakeSource | null>(
    null,
  );
  const locked = offline || !canEdit;

  return (
    <div
      data-slot="sources-view"
      className="flex min-w-0 flex-col gap-(--space-block) p-(--space-page)"
    >
      {error ? (
        <Alert variant="destructive" data-slot="sources-error">
          <AlertTitle className="text-meta">
            {t("coordinator.error")}
          </AlertTitle>
          {onReload ? (
            <AlertAction>
              <Button size="xs" variant="outline" onClick={onReload}>
                {t("coordinator.reload")}
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      ) : null}

      {loading ? (
        <div data-slot="sources-loading">
          <SkeletonList rows={3} size="tall" label={t("state.loading")} />
        </div>
      ) : sources.length === 0 && !adding && !error ? (
        <Empty className="border-0 p-6" data-slot="sources-empty">
          <EmptyHeader>
            <EmptyTitle className="text-body font-normal text-muted-foreground">
              {t("coordinator.sources.empty")}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : sources.length > 0 ? (
        <Table size="sm" data-slot="sources-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("coordinator.sources.repo")}</TableHead>
              <TableHead>{t("coordinator.sources.kinds")}</TableHead>
              <TableHead>{t("coordinator.sources.mode")}</TableHead>
              <TableHead>{t("coordinator.sources.allow")}</TableHead>
              <TableHead>{t("coordinator.sources.rules")}</TableHead>
              <TableHead>{t("coordinator.sources.stats")}</TableHead>
              <TableHead>{t("coordinator.sources.enabled")}</TableHead>
              <TableHead>
                <span className="sr-only">
                  {t("coordinator.sources.delete")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                locked={locked}
                saving={saving === source.id}
                {...(onSave ? { onSave } : {})}
                onDelete={() => setPendingDelete(source)}
              />
            ))}
          </TableBody>
        </Table>
      ) : null}

      {adding ? (
        <AddSource
          coordinators={coordinators}
          defaultCoordinator={defaultCoordinator}
          saving={saving === "new"}
          onCancel={() => setAdding(false)}
          onSave={(input) => {
            onSave?.(input);
            setAdding(false);
          }}
        />
      ) : canEdit && coordinators.length > 0 ? (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={offline}
            data-slot="sources-add"
            onClick={() => setAdding(true)}
          >
            <Plus data-icon="inline-start" />
            {t("coordinator.sources.add")}
          </Button>
        </div>
      ) : null}

      <ResponsiveAlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("coordinator.sources.deleteTitle", {
                repo: pendingDelete?.repo ?? "",
              })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("dialog.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive-solid"
              onClick={() => {
                if (pendingDelete) onDelete?.(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              {t("coordinator.sources.delete")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  );
}

function SourceRow({
  source,
  locked,
  saving,
  onSave,
  onDelete,
}: {
  source: IntakeSource;
  locked: boolean;
  saving: boolean;
  onSave?: (input: SaveSourceInput) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const state = rulesState(source);
  const shown = source.allow.join(", ");
  const [allow, setAllow] = React.useState(shown);
  // core 的值变了（保存成功、别处改了）就跟着变。
  React.useEffect(() => setAllow(shown), [shown]);
  const commitAllow = () => {
    const next = parseAllow(allow);
    if (next.join(",") === source.allow.join(",")) {
      setAllow(shown);
      return;
    }
    onSave?.(sourceInput(source, { allow: next }));
  };
  const { stats } = source;

  return (
    <TableRow data-slot="source-row" data-source-id={source.id}>
      <TableCell className="max-w-40 truncate" title={source.repo}>
        {source.repo}
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          {source.kinds.map((kind) => (
            <Badge key={kind} variant="secondary" size="sm">
              {t(`coordinator.sources.kind.${kind}`)}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <Select
          value={source.mode}
          disabled={locked || saving}
          onValueChange={(mode) =>
            onSave?.(sourceInput(source, { mode: mode as SourceMode }))
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={t("coordinator.sources.mode")}
            data-slot="source-mode"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {SOURCE_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`coordinator.sources.mode.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Input
          size="sm"
          className="min-w-32"
          aria-label={t("coordinator.sources.allow")}
          placeholder={t("coordinator.sources.allow.placeholder")}
          data-slot="source-allow"
          value={allow}
          readOnly={locked}
          disabled={saving}
          onChange={(event) => setAllow(event.target.value)}
          onBlur={commitAllow}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Badge
            variant={RULES_TONE[state]}
            size="sm"
            data-slot="source-rules"
            data-state={state}
          >
            {t(`coordinator.sources.rules.${state}`)}
          </Badge>
          {state !== "confirmed" && state !== "missing" && !locked ? (
            <Button
              size="xs"
              variant="outline"
              disabled={saving}
              data-slot="source-confirm"
              onClick={() =>
                onSave?.(sourceInput(source, { confirmRules: true }))
              }
            >
              {t("coordinator.sources.rules.confirm")}
            </Button>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="tabular-nums"
              data-slot="source-stats"
            >
              {stats.decided} · {stats.agreed} · {stats.disagreed}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("coordinator.sources.stats.tip")}</TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell>
        <Switch
          size="sm"
          aria-label={t("coordinator.sources.enabled")}
          checked={source.enabled}
          disabled={locked || saving}
          onCheckedChange={(enabled) =>
            onSave?.(sourceInput(source, { enabled }))
          }
        />
      </TableCell>
      <TableCell>
        {locked ? null : (
          <IconButton
            label={t("coordinator.sources.delete")}
            disabled={saving}
            onClick={onDelete}
          >
            <Trash2 />
          </IconButton>
        )}
      </TableCell>
    </TableRow>
  );
}

function AddSource({
  coordinators,
  defaultCoordinator,
  saving,
  onCancel,
  onSave,
}: {
  coordinators: readonly CoordinatorOption[];
  defaultCoordinator: string | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: SaveSourceInput) => void;
}) {
  const t = useT();
  const first = coordinators.find((one) => one.nodeId === defaultCoordinator);
  const [coordinator, setCoordinator] = React.useState(
    (first ?? coordinators[0])?.nodeId ?? "",
  );
  const [repo, setRepo] = React.useState("");
  const [kinds, setKinds] = React.useState<readonly SourceKind[]>(["issue"]);
  const ready = repo.trim() !== "" && kinds.length > 0 && coordinator !== "";
  const submit = () => {
    if (!ready) return;
    onSave({
      coordinatorNodeId: coordinator,
      repo: repo.trim(),
      kinds,
      mode: "observe",
      allow: [],
      enabled: true,
    });
  };

  return (
    <form
      data-slot="sources-add-form"
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        size="sm"
        aria-label={t("coordinator.sources.repo")}
        placeholder={t("coordinator.sources.repo.placeholder")}
        value={repo}
        onChange={(event) => setRepo(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-3">
        {SOURCE_KINDS.map((kind) => (
          <Label key={kind} className="gap-1.5 font-normal">
            <Checkbox
              checked={kinds.includes(kind)}
              onCheckedChange={(checked) =>
                setKinds((current) =>
                  checked === true
                    ? SOURCE_KINDS.filter(
                        (one) => one === kind || current.includes(one),
                      )
                    : current.filter((one) => one !== kind),
                )
              }
            />
            {t(`coordinator.sources.kind.${kind}`)}
          </Label>
        ))}
        {coordinators.length > 1 ? (
          <Select value={coordinator} onValueChange={setCoordinator}>
            <SelectTrigger
              size="sm"
              aria-label={t("coordinator.sources.coordinator")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {coordinators.map((one) => (
                <SelectItem key={one.nodeId} value={one.nodeId}>
                  {one.title || t("coordinator.untitled")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={!ready} loading={saving}>
          {t("dialog.save")}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          {t("dialog.cancel")}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------- 真页面 ------------------------------- */

/** 一次保存失败：core 的原话（auto 缺什么前置、仓库认不出……）原样提示。 */
export function failureMessage(error: unknown, fallback: string): string {
  const core = (error as { coreMessage?: unknown } | null)?.coreMessage;
  if (typeof core === "string" && core !== "") return core;
  return error instanceof Error && error.message !== ""
    ? error.message
    : fallback;
}

export function SourcesTab({
  boardId,
  coordinators,
  defaultCoordinator,
  offline,
  canEdit,
  active,
}: {
  boardId: string;
  coordinators: readonly CoordinatorOption[];
  defaultCoordinator: string | null;
  offline: boolean;
  canEdit: boolean;
  active: boolean;
}) {
  const t = useT();
  const client = useQueryClient();
  const sources = useQuery({
    queryKey: coordinatorKeys.sources(boardId),
    queryFn: () => coordinatorApi.sources(boardId),
    enabled: active,
    retry: false,
  });
  const reload = () =>
    void client.invalidateQueries({
      queryKey: coordinatorKeys.sources(boardId),
    });
  const save = useMutation({
    mutationFn: (input: SaveSourceInput) => coordinatorApi.saveSource(input),
    onSuccess: reload,
    // 选择器 / 输入框显示 core 的值：失败后重读一次，把本地改动收回去。
    onError: (error) => {
      toast.error(failureMessage(error, t("coordinator.sources.saveFailed")));
      reload();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => coordinatorApi.deleteSource(id),
    onSuccess: reload,
    onError: (error) =>
      toast.error(failureMessage(error, t("coordinator.sources.saveFailed"))),
  });
  const saving = save.isPending ? (save.variables?.id ?? "new") : null;

  return (
    <SourcesView
      sources={sources.data ?? []}
      coordinators={coordinators}
      defaultCoordinator={defaultCoordinator}
      loading={sources.isPending && sources.fetchStatus !== "idle"}
      error={sources.isError}
      offline={offline}
      canEdit={canEdit}
      saving={saving}
      onReload={() => void sources.refetch()}
      onSave={(input) => save.mutate(input)}
      onDelete={(id) => remove.mutate(id)}
    />
  );
}
