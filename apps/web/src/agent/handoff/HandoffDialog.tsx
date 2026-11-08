import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  supportedPermissionModes,
  type HandoffPrepare,
  type HandoffView,
  type PermissionMode,
} from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";
import { t, useT } from "@/app/preferences-store";
import { useEnabledAgents } from "@/app/use-agents";
import {
  agentAcpInfo,
  agentLabel,
  customAgentFor,
  permissionModeLabel,
} from "@/agent/launch";
import { useAgentModels } from "@/agent/models";
import { formatTokens } from "@/lib/cost";
import { useCanvasStore } from "@/store/canvas-store";
import { Loadable } from "@/loading/Loadable";
import { SkeletonCard } from "@/ui/skeletons";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { sk } from "../../sources/scope";
import { ScrollArea } from "@/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import { toast } from "@/ui/toast";
import {
  handoffTargets,
  onHandoffRequest,
  type HandoffRequestDetail,
  type HandoffTarget,
} from "./handoff-targets";

/**
 * 交接预览与确认（docs/design/agent-automation-design.md §7.3）。
 *
 * 三步走，界面上也是三步，因为它们的授权含义完全不同：
 *
 *  1. **编辑**：选目标、选预算、填模板。此时什么都还没发生。
 *  2. **预览**：`prepare` 冻结了材料并算好指纹。仍然没有通知任何人；
 *     「返回编辑」会把这份冻结的包撤掉，不留悬空记录。
 *  3. **确认**：`accept` 是唯一的用户授权，带上预览那一份的 `digest`——
 *     看到的和批准的必须是同一份。之后只能等目标空闲，或者撤回。
 *
 * 界面从不替用户确认，也从不把「通知已写入」说成「对方已经在做了」。
 */

const BUDGETS = [8192, 16384, 32768] as const;
/** 目标下拉里「新开 Agent…」那一项的值；节点 id 是 UUID，不会撞。 */
const NEW_TARGET = "new";
/** 模型与权限模式「不指定」的值：Radix 的选项值不能是空串。 */
const UNSET = "default";
type Surface = "terminal" | "acp";
const SECTION_KEYS = [
  "goal",
  "constraints",
  "acceptance",
  "completed",
  "pending",
  "decisions",
  "toolSummary",
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

/** 还能撤回的状态：收件箱那条还在，目标尚未确认。 */
export function canWithdraw(state: string): boolean {
  return state === "prepared" || state === "queued";
}
/** 还会变的状态：值得继续轮询。等的是目标自己去确认那条收件箱消息。 */
export function isSettled(state: string): boolean {
  return ["acknowledged", "cancelled"].includes(state);
}

export function HandoffDialog() {
  const t = useT();
  const client = useQueryClient();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const document = useCanvasStore((state) => state.document);
  const [source, setSource] = React.useState<HandoffRequestDetail | null>(null);
  const [targetNodeId, setTargetNodeId] = React.useState("");
  const [newAgentId, setNewAgentId] = React.useState("");
  const [newModel, setNewModel] = React.useState(UNSET);
  const [newPermission, setNewPermission] = React.useState(UNSET);
  const [newSurface, setNewSurface] = React.useState<Surface>("terminal");
  const [budget, setBudget] = React.useState<number>(BUDGETS[0]);
  const [includeTranscript, setIncludeTranscript] = React.useState(true);
  const [filePaths, setFilePaths] = React.useState("");
  const [sections, setSections] = React.useState<Record<SectionKey, string>>(
    () => blankSections(),
  );
  const [view, setView] = React.useState<HandoffView | null>(null);

  React.useEffect(
    () =>
      onHandoffRequest((detail) => {
        setSource(detail);
        setView(null);
        setTargetNodeId("");
        setNewAgentId("");
        setNewModel(UNSET);
        setNewPermission(UNSET);
        setNewSurface("terminal");
        setBudget(BUDGETS[0]);
        setIncludeTranscript(true);
        setFilePaths("");
        setSections(blankSections());
      }),
    [],
  );

  const agents = useEnabledAgents();
  const { models } = useAgentModels(newAgentId || undefined);
  const baseOf = (id: string) =>
    customAgentFor(id)?.baseAgent ??
    agents.find((agent) => agent.id === id)?.baseAgent ??
    id;
  const permissionModes: readonly PermissionMode[] = newAgentId
    ? supportedPermissionModes(baseOf(newAgentId))
    : [];
  const acpAvailable = Boolean(newAgentId && agentAcpInfo(newAgentId));
  const creating = targetNodeId === NEW_TARGET;
  /** 换 Agent：模型、权限模式与形态都是它自己的，不带着上一家的值。 */
  const pickAgent = (id: string) => {
    setNewAgentId(id);
    setNewModel(UNSET);
    setNewPermission(UNSET);
    setNewSurface("terminal");
  };

  const targets: HandoffTarget[] = React.useMemo(
    () => (source ? handoffTargets(document, source.nodeId) : []),
    [document, source],
  );

  // 冻结之后状态还会变（排队 → 写入 → 结果），所以跟着投递事件重取；
  // 事件可能因为断线漏掉，未定状态再补一个 3 秒的轮询兜底。
  const tracked = view?.bundle.handoffId ?? source?.handoffId ?? null;
  const status = useQuery({
    queryKey: sk("handoff", workspaceId, tracked),
    enabled: Boolean(workspaceId && tracked),
    queryFn: ({ signal }) => runtimeApi.handoff(workspaceId!, tracked!, signal),
    refetchInterval: view && !isSettled(view.state) ? 3_000 : false,
    retry: false,
  });
  React.useEffect(() => {
    if (status.data) setView(status.data);
  }, [status.data]);
  React.useEffect(
    () =>
      onWorkspaceEvent("agent.delivery", (event) => {
        if (!tracked || !view) return;
        if (
          event.targetNodeId !==
          (view.createdTargetNodeId ?? view.bundle.target.nodeId)
        )
          return;
        void client.invalidateQueries({
          queryKey: sk("handoff", workspaceId, tracked),
        });
      }),
    [client, tracked, view, workspaceId],
  );

  const prepare = useMutation({
    mutationFn: async () => {
      const target = targets.find((entry) => entry.nodeId === targetNodeId);
      if (!workspaceId || !source || (!target && !creating))
        throw new Error(t("handoff.noTargets"));
      // 新开目标不要会话身份：规格在预览时只校验，节点批准时才建。
      const wanted: HandoffPrepare["target"] =
        creating || !target
          ? {
              kind: "new",
              agentId: newAgentId,
              surface: newSurface,
              ...(newModel === UNSET ? {} : { model: newModel }),
              ...(newPermission === UNSET
                ? {}
                : { permissionMode: newPermission }),
            }
          : {
              kind: "node",
              nodeId: target.nodeId,
              ...(await resolveBinding(target.nodeId, workspaceId)),
            };
      return runtimeApi.prepareHandoff(workspaceId, {
        sourceNodeId: source.nodeId,
        sourceSessionId: source.sessionId,
        sourceGeneration: source.generation,
        target: wanted,
        sections: { ...sections },
        filePaths: filePaths
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        byteBudget: budget as 8192 | 16384 | 32768,
        includeTranscript,
      });
    },
    onSuccess: setView,
    onError: (cause: Error) => toast.error(cause.message),
  });

  const accept = useMutation({
    mutationFn: () =>
      runtimeApi.acceptHandoff(
        workspaceId!,
        view!.bundle.handoffId,
        view!.digest,
      ),
    onSuccess: setView,
    onError: (cause: Error) => toast.error(cause.message),
  });

  const withdraw = useMutation({
    mutationFn: (back: boolean) =>
      runtimeApi
        .cancelHandoff(workspaceId!, view!.bundle.handoffId, view!.digest)
        .then((next) => ({ next, back })),
    onSuccess: ({ next, back }) => {
      if (back) setView(null);
      else setView(next);
    },
    onError: (cause: Error) => toast.error(cause.message),
  });

  const busy = prepare.isPending || accept.isPending || withdraw.isPending;
  const open = source !== null;
  const close = () => {
    setSource(null);
    setView(null);
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={(next) => !next && close()}>
      <ResponsiveDialogContent className="z-(--z-dialog) sm:max-w-[560px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("handoff.title")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ScrollArea className="max-h-[52vh] pr-3">
          {view ? (
            <HandoffPreview view={view} />
          ) : source?.handoffId ? (
            <Loadable
              loading={status.isLoading}
              skeleton={<SkeletonCard lines={3} label={t("state.loading")} />}
              error={status.isError}
              onRetry={() => void status.refetch()}
              inline
            >
              {null}
            </Loadable>
          ) : (
            <div className="flex flex-col gap-(--space-block)">
              <div className="flex flex-col gap-2">
                <label
                  className="text-muted-foreground"
                  htmlFor="handoff-target"
                >
                  {t("handoff.target")}
                </label>
                <Select
                  value={targetNodeId}
                  onValueChange={(next) => {
                    setTargetNodeId(next);
                    if (next === NEW_TARGET && newAgentId === "") {
                      pickAgent(agents[0]?.id ?? "");
                    }
                  }}
                >
                  <SelectTrigger id="handoff-target">
                    <SelectValue placeholder={t("handoff.target")} />
                  </SelectTrigger>
                  <SelectContent className="z-[var(--z-dialog)]">
                    {targets.map((target) => (
                      <SelectItem key={target.nodeId} value={target.nodeId}>
                        {target.title} · {agentLabel(target.agentId)}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_TARGET}>
                      {t("handoff.targetNew")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {creating && (
                <>
                  <div className="flex flex-col gap-2">
                    <label
                      className="text-muted-foreground"
                      htmlFor="handoff-new-agent"
                    >
                      {t("handoff.newAgent")}
                    </label>
                    <Select value={newAgentId} onValueChange={pickAgent}>
                      <SelectTrigger id="handoff-new-agent">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[var(--z-dialog)]">
                        {agents.map((agent) => (
                          <SelectItem key={agent.id} value={agent.id}>
                            {agentLabel(agent.id)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label
                      className="text-muted-foreground"
                      htmlFor="handoff-new-model"
                    >
                      {t("agent.model")}
                    </label>
                    <Select value={newModel} onValueChange={setNewModel}>
                      <SelectTrigger id="handoff-new-model">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[var(--z-dialog)]">
                        <SelectItem value={UNSET}>
                          {t("handoff.modelDefault")}
                        </SelectItem>
                        {models.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label
                      className="text-muted-foreground"
                      htmlFor="handoff-new-permission"
                    >
                      {t("agent.permissionMode")}
                    </label>
                    <Select
                      value={newPermission}
                      onValueChange={setNewPermission}
                    >
                      <SelectTrigger id="handoff-new-permission">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[var(--z-dialog)]">
                        {permissionModes.map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {permissionModeLabel(mode)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label
                      className="text-muted-foreground"
                      htmlFor="handoff-new-surface"
                    >
                      {t("handoff.newSurface")}
                    </label>
                    <Select
                      value={newSurface}
                      onValueChange={(next) => setNewSurface(next as Surface)}
                    >
                      <SelectTrigger id="handoff-new-surface">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[var(--z-dialog)]">
                        <SelectItem value="terminal">
                          {t("handoff.surface.terminal")}
                        </SelectItem>
                        {acpAvailable && (
                          <SelectItem value="acp">
                            {t("handoff.surface.acp")}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
              <div className="flex flex-col gap-2">
                <label
                  className="text-muted-foreground"
                  htmlFor="handoff-budget"
                >
                  {t("handoff.budget")}
                </label>
                <Select
                  value={String(budget)}
                  onValueChange={(next) => setBudget(Number(next))}
                >
                  <SelectTrigger id="handoff-budget">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[var(--z-dialog)]">
                    {BUDGETS.map((tier) => (
                      <SelectItem key={tier} value={String(tier)}>
                        {tier}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <label
                  className="text-muted-foreground"
                  htmlFor="handoff-transcript"
                >
                  {t("handoff.includeTranscript")}
                </label>
                <Switch
                  id="handoff-transcript"
                  checked={includeTranscript}
                  onCheckedChange={setIncludeTranscript}
                />
              </div>
              {SECTION_KEYS.map((key) => (
                <div className="flex flex-col gap-2" key={key}>
                  <label
                    className="text-muted-foreground"
                    htmlFor={`handoff-${key}`}
                  >
                    {t(`handoff.${key}`)}
                  </label>
                  <Textarea
                    id={`handoff-${key}`}
                    rows={key === "goal" ? 3 : 2}
                    value={sections[key]}
                    onChange={(event) =>
                      setSections((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                </div>
              ))}
              <div className="flex flex-col gap-2">
                <label
                  className="text-muted-foreground"
                  htmlFor="handoff-files"
                >
                  {t("handoff.filePaths")}
                </label>
                <Textarea
                  id="handoff-files"
                  rows={3}
                  value={filePaths}
                  onChange={(event) => setFilePaths(event.target.value)}
                />
              </div>
            </div>
          )}
        </ScrollArea>
        <ResponsiveDialogFooter>
          {!view && !source?.handoffId && (
            <Button
              disabled={
                busy ||
                !targetNodeId ||
                (creating && !newAgentId) ||
                sections.goal.trim().length === 0
              }
              onClick={() => prepare.mutate()}
            >
              {t("handoff.preview")}
            </Button>
          )}
          {view?.state === "prepared" && (
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => withdraw.mutate(true)}
              >
                {t("handoff.back")}
              </Button>
              <Button disabled={busy} onClick={() => accept.mutate()}>
                {t("handoff.accept")}
              </Button>
            </>
          )}
          {view && view.state !== "prepared" && (
            <>
              {canWithdraw(view.state) && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => withdraw.mutate(false)}
                >
                  {t("handoff.cancel")}
                </Button>
              )}
              <Button variant="outline" onClick={close}>
                {t("handoff.close")}
              </Button>
            </>
          )}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function HandoffPreview({ view }: { view: HandoffView }) {
  const t = useT();
  const { bundle } = view;
  return (
    <div className="flex flex-col gap-(--space-block) text-caption">
      <section className="flex flex-col gap-2">
        <span className="font-medium">{t("handoff.target")}</span>
        <span className="text-muted-foreground">
          {t("handoff.targetSummary", {
            agent: agentLabel(bundle.target.agentId),
            model: bundle.target.modelId ?? t("handoff.unknownModel"),
            directory: bundle.target.workingDirectory,
          })}
        </span>
        {bundle.targetSpec && (
          <span className="text-muted-foreground">
            {t("handoff.newTargetSpec", {
              surface: t(`handoff.surface.${bundle.targetSpec.surface}`),
              permission: permissionModeLabel(
                (bundle.targetSpec.permissionMode ??
                  "default") as PermissionMode,
              ),
            })}
          </span>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <span className="font-medium">{t("handoff.status")}</span>
        <span className="flex items-center gap-2">
          <Badge variant="outline">{t(`handoff.${view.state}`)}</Badge>
          {view.state === "queued" && (
            <span className="text-muted-foreground">
              {t(
                bundle.targetSpec
                  ? "handoff.queuedNoteNew"
                  : "handoff.queuedNote",
              )}
            </span>
          )}
        </span>
        {view.errorCode !== null && (
          <span className="text-muted-foreground">
            {t("handoff.reason", { code: view.errorCode })}
          </span>
        )}
        {view.sourceHasNewActivity && (
          <span className="text-muted-foreground">
            {t("handoff.newActivity")}
          </span>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <span className="font-medium">{t("handoff.budget")}</span>
        <span className="text-muted-foreground">
          {t("handoff.budgetUsed", {
            used: bundle.budget.usedBytes,
            limit: bundle.budget.byteLimit,
          })}
          {bundle.budget.truncated ? ` ${t("handoff.truncated")}` : ""}
        </span>
        {bundle.budget.capacityTokens !== null &&
          bundle.budget.availableTokens !== null && (
            <span className="text-muted-foreground">
              {t("handoff.tokenBudget", {
                estimate: formatTokens(bundle.budget.tokenEstimate ?? 0),
                available: formatTokens(bundle.budget.availableTokens),
                capacity: formatTokens(bundle.budget.capacityTokens),
                reserved: formatTokens(bundle.budget.reservedTokens ?? 0),
              })}
            </span>
          )}
      </section>
      <section className="flex flex-col gap-2">
        <span className="font-medium">{t("handoff.files")}</span>
        {bundle.files.length === 0 ? (
          <span className="text-muted-foreground">{t("handoff.noFiles")}</span>
        ) : (
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {bundle.files.map((file) => (
              <li key={file.path} className="truncate">
                {file.path} — {t(`handoff.fileStatus.${file.status}`)}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <span className="font-medium">{t("handoff.git")}</span>
        <span className="text-muted-foreground">
          {bundle.git.status === "observed" && bundle.git.headOid
            ? t("handoff.gitHead", { oid: bundle.git.headOid.slice(0, 12) })
            : t("handoff.gitUnavailable")}
        </span>
      </section>
      <section className="flex flex-col gap-2">
        <span className="font-medium">{t("handoff.omitted")}</span>
        <ul className="flex flex-col gap-0.5 text-muted-foreground">
          {bundle.budget.omitted.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <span className="font-medium">{t("handoff.excerpt")}</span>
        {bundle.transcriptExcerpt.trim().length === 0 ? (
          <span className="text-muted-foreground">
            {t("handoff.noExcerpt")}
          </span>
        ) : (
          <pre className="max-h-40 overflow-auto rounded-control bg-sunken p-2 whitespace-pre-wrap text-muted-foreground">
            {bundle.transcriptExcerpt}
          </pre>
        )}
      </section>
    </div>
  );
}

function blankSections(): Record<SectionKey, string> {
  return {
    goal: "",
    constraints: "",
    acceptance: "",
    completed: "",
    pending: "",
    decisions: "",
    toolSummary: "",
  };
}

/**
 * 目标那条 PTY 的身份。只有挂载着的终端组件知道自己的 generation，所以这里
 * 向 Runtime 问一次：目标节点未必在视口里，不能指望它的组件正好活着。
 */
async function resolveBinding(
  nodeId: string,
  workspaceId: string,
): Promise<{ sessionId: string; generation: number }> {
  const sessions = await runtimeApi.sessions(workspaceId);
  const session = sessions.find((entry) => entry.nodeId === nodeId);
  if (!session) throw new Error(t("handoff.noTargets"));
  const terminal = await runtimeApi.getTerminal(session.sessionId);
  if (terminal.status !== "running" || terminal.generation === undefined)
    throw new Error(t("handoff.noTargets"));
  return { sessionId: session.sessionId, generation: terminal.generation };
}
