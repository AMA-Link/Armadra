import * as React from "react";
import { lk } from "../local-key";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderInput, Plus, RefreshCw } from "lucide-react";
import {
  sshHostSchema,
  type SshHost,
  type ExecutionHostValidation,
} from "@armadra/shared";

import { localRuntimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { useOpenWorkspace } from "../../../app/workspace-actions";
import { useCompactLayout } from "@/platform/layout";
import { SettingsGroup } from "../SettingsGroup";
import { Loadable } from "@/loading/Loadable";
import { SettingsPageHeader } from "../SettingsPageHeader";
import { SettingsTableCard } from "../SettingsTableCard";
import { SettingsRow } from "../SettingsRow";
import { useSubpage } from "../subpage";
import { useRuntimeSettings } from "../use-runtime-settings";
import {
  MachinesTable,
  type WorkerStatus,
} from "./execution-hosts/MachinesTable";
import { HostKeyDialog } from "./ssh/HostKeyDialog";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";
import { toast } from "@/ui/toast";

/** 执行主机的显示名；一台配置被删掉的主机不显示成「本机」。 */
export function executionHostLabel(
  host: { kind: string; name: string } | undefined,
  id: string,
  t: (key: string) => string,
): string {
  if (!host) return id || t("executionHosts.local");
  return host.kind === "local" ? t("executionHosts.local") : host.name || id;
}

/**
 * 一次验证的结论 → 表格里的 Worker 胶囊：握手成功 done（带版本），只跑终端的机器
 * 连得上 paused，其余 failed（文案取 Runtime 给的稳定 `reason`）。
 */
export function workerStatusOf(
  result: ExecutionHostValidation,
  t: (key: string, values?: Record<string, string | number>) => string,
): WorkerStatus {
  if (result.workerOk)
    return {
      tone: "done",
      label: t("executionHosts.valid", {
        version: result.runtimeVersion ?? "",
        platform: result.platform ?? "",
        architecture: result.architecture ?? "",
      }),
    };
  if (result.reachable && result.reason === "noWorkerConfigured")
    return { tone: "paused", label: t("executionHosts.noWorkerConfigured") };
  return {
    tone: "failed",
    label: t(
      result.reason
        ? `executionHosts.${result.reason}`
        : "executionHosts.handshakeRefused",
    ),
  };
}

/**
 * 设置 → SSH：主机表卡（名称 · 地址 · Worker · 操作），点名称进子页编辑。
 *
 * 「验证」一步问完两件事——`ssh` 通不通、配了 Worker 时那台机器上的 Worker
 * 是不是这个构建——结论落在那一行的 Worker 胶囊上，失败再弹一条带原因的提示。当前
 * 工作区跑在哪台、怎么切换在「工作空间」页。
 *
 * 主机表存在 Runtime 的 `settings.json` 里：PATCH 对数组是整段替换，所以增删
 * 改都是「读整段、改一条、写整段」。
 */
export function MachinesPage() {
  const t = useT();
  const client = useQueryClient();
  const compact = useCompactLayout();
  const subpage = useSubpage();
  const { settings, save } = useRuntimeSettings({ scope: "local" });
  const ssh = React.useMemo(
    () => settings.data?.ssh?.hosts ?? [],
    [settings.data],
  );
  const [results, setResults] = React.useState<
    Readonly<Record<string, ExecutionHostValidation>>
  >({});

  const validate = useMutation({
    mutationFn: (hostId: string) =>
      localRuntimeApi.validateExecutionHost(hostId),
    onSuccess: (result, hostId) => {
      setResults((current) => ({ ...current, [hostId]: result }));
      // 握手成功与「只跑终端」在胶囊上看得见；失败才弹，带 Runtime 的诊断尾巴。
      if (result.workerOk) return;
      if (result.reachable && result.reason === "noWorkerConfigured") return;
      const key = result.reason
        ? `executionHosts.${result.reason}`
        : "executionHosts.handshakeRefused";
      toast.error(t(key), { description: result.detail || undefined });
    },
    onError: (cause: Error) =>
      toast.error(t("executionHosts.handshakeRefused"), {
        description: cause.message,
      }),
  });
  const resync = useMutation({
    mutationFn: (hostId: string) => localRuntimeApi.resyncExecutionHost(hostId),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: lk("execution-hosts") });
      void client.invalidateQueries({ queryKey: lk("agent-integration") });
      toast.success(
        t("executionHosts.resynced", {
          name: result.name || result.executionHostId,
        }),
      );
    },
    onError: (cause: Error) =>
      toast.error(t("executionHosts.resyncFailed"), {
        description: cause.message,
      }),
  });

  function write(next: SshHost[]) {
    save.mutate({ ssh: { hosts: next } });
    subpage.close();
  }

  if (subpage.current?.startsWith("ssh:")) {
    const reference = subpage.current.slice("ssh:".length);
    const existing = ssh.find((host) => host.id === reference);
    return (
      <>
        <SettingsPageHeader />
        <HostForm
          existing={existing}
          disabled={!settings.data}
          onSubmit={(host) =>
            write(
              existing
                ? ssh.map((entry) => (entry.id === host.id ? host : entry))
                : [...ssh, host],
            )
          }
          onDelete={() =>
            write(ssh.filter((entry) => entry.id !== existing?.id))
          }
          onCancel={subpage.close}
          extra={existing && <MachineActions host={existing} />}
        />
      </>
    );
  }

  const workerStatus = Object.fromEntries(
    Object.entries(results).map(([hostId, result]) => [
      hostId,
      workerStatusOf(result, t),
    ]),
  );

  return (
    <>
      <SettingsPageHeader
        actions={
          <Button
            size="sm"
            disabled={!settings.data}
            onClick={() => subpage.open("ssh", "new")}
          >
            <Plus data-icon="inline-start" />
            {t("ssh.dialog.add")}
          </Button>
        }
      />
      <Loadable
        loading={settings.isLoading}
        skeleton={
          <SettingsTableCard
            title={t("executionHosts.table")}
            loading
            skeleton={{ rows: 3, columns: 4 }}
          />
        }
      >
        {ssh.length === 0 ? (
          <SettingsTableCard
            title={t("executionHosts.table")}
            empty={{ title: t("ssh.empty") }}
          />
        ) : (
          <MachinesTable
            hosts={ssh}
            compact={compact}
            workerStatus={workerStatus}
            validating={
              validate.isPending ? (validate.variables ?? null) : null
            }
            resyncing={resync.isPending ? (resync.variables ?? null) : null}
            onValidate={(hostId) => validate.mutate(hostId)}
            onResync={(hostId) => resync.mutate(hostId)}
            onOpen={(hostId) => subpage.open("ssh", hostId)}
          />
        )}
      </Loadable>
    </>
  );
}

/**
 * 一台主机子页的下半：在那台机器上打开项目（配了 Worker 时）、主机密钥、
 * 重新同步（配了 Worker 时：重连 Worker、重新握手，再把画布注入同步一次，
 * 契约 §21.2；Worker 升级后靠它对齐）。
 */
function MachineActions({ host }: { host: SshHost }) {
  const t = useT();
  const client = useQueryClient();
  const resync = useMutation({
    mutationFn: () => localRuntimeApi.resyncExecutionHost(host.id),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: lk("execution-hosts") });
      void client.invalidateQueries({ queryKey: lk("agent-integration") });
      toast.success(
        t("executionHosts.resynced", {
          name: result.name || result.executionHostId,
        }),
      );
    },
    onError: (cause: Error) =>
      toast.error(t("executionHosts.resyncFailed"), {
        description: cause.message,
      }),
  });
  return (
    <SettingsGroup>
      {host.worker && <OpenRemoteProject host={host} />}
      <SettingsRow label={null}>
        <HostKeyDialog host={host} />
        {host.worker && (
          <Button
            size="sm"
            variant="secondary"
            disabled={resync.isPending}
            onClick={() => resync.mutate()}
          >
            {resync.isPending ? <Spinner aria-hidden /> : <RefreshCw />}
            {t("executionHosts.resync")}
          </Button>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * 在执行主机上打开一个项目（H02）。
 *
 * 路径是那台机器上的路径，本机不做任何解析：Runtime 通过远端 Worker 的根注册
 * 把它规范化并冻结，主机不可达或 Worker 不匹配时这里失败，而不是悄悄打开一个
 * 读本机文件的工作区。
 */
function OpenRemoteProject({ host }: { host: SshHost }) {
  const t = useT();
  const client = useQueryClient();
  const openWorkspace = useOpenWorkspace();
  const [path, setPath] = React.useState("");
  const open = useMutation({
    mutationFn: (rootPath: string) =>
      localRuntimeApi.openRemoteWorkspace({
        name: rootPath.split("/").filter(Boolean).at(-1) ?? host.name,
        executionHostId: host.id,
        rootPath,
      }),
    onSuccess: (workspace) => {
      setPath("");
      // 根已在那台机器上证明过，直接切过去，而不是让人再去列表里找一遍。
      openWorkspace(workspace);
      void client.invalidateQueries({ queryKey: lk("workspaces") });
      // 切换发生在设置对话框背后，结果在当前视图里看不见：这里要有成功提示。
      toast.success(t("ssh.remote.opened", { name: workspace.name }));
    },
    onError: (cause: Error) =>
      toast.error(t("ssh.remote.failed"), { description: cause.message }),
  });
  return (
    <SettingsRow label={t("ssh.remote.path")}>
      <Input
        className="w-72"
        aria-label={t("ssh.remote.path")}
        placeholder="/srv/project"
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={open.isPending || path.trim().length === 0}
        onClick={() => open.mutate(path.trim())}
      >
        <FolderInput />
        {t("ssh.remote.open")}
      </Button>
    </SettingsRow>
  );
}

/* --------------------------------- 编辑子页 -------------------------------- */

interface HostForm {
  name: string;
  host: string;
  user: string;
  port: string;
  identityFile: string;
  extraArgs: string;
  /** Where the Armadra Worker is on the far end; empty = terminals only. */
  workerPath: string;
  workerStateDir: string;
}

const EMPTY: HostForm = {
  name: "",
  host: "",
  user: "",
  port: "",
  identityFile: "",
  extraArgs: "",
  workerPath: "",
  workerStateDir: "",
};

function toForm(host: SshHost | undefined): HostForm {
  if (!host) return EMPTY;
  return {
    name: host.name,
    host: host.host,
    user: host.user ?? "",
    port: host.port === undefined ? "" : String(host.port),
    identityFile: host.identityFile ?? "",
    extraArgs: (host.extraArgs ?? []).join(" "),
    workerPath: host.worker?.path ?? "",
    workerStateDir: host.worker?.stateDir ?? "",
  };
}

/**
 * 表单 → 主机。空字符串代表「没填」，要整个字段省掉而不是发空串；
 * 额外参数按空白切分，因为命令是 argv，一个参数就是一个元素。
 */
export function parseHostForm(form: HostForm, id: string): SshHost | null {
  const extraArgs = form.extraArgs.trim().split(/\s+/).filter(Boolean);
  const candidate = {
    id,
    name: form.name.trim(),
    host: form.host.trim(),
    ...(form.user.trim() ? { user: form.user.trim() } : {}),
    ...(form.port.trim() ? { port: Number(form.port) } : {}),
    ...(form.identityFile.trim()
      ? { identityFile: form.identityFile.trim() }
      : {}),
    ...(extraArgs.length > 0 ? { extraArgs } : {}),
    // No Worker path means this host runs terminals and nothing else, which
    // is a different thing from a Worker at an empty path.
    ...(form.workerPath.trim()
      ? {
          worker: {
            path: form.workerPath.trim(),
            ...(form.workerStateDir.trim()
              ? { stateDir: form.workerStateDir.trim() }
              : {}),
          },
        }
      : {}),
  };
  const parsed = sshHostSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function HostForm({
  existing,
  disabled,
  onSubmit,
  onDelete,
  onCancel,
  extra,
}: {
  existing: SshHost | undefined;
  disabled: boolean;
  onSubmit: (host: SshHost) => void;
  onDelete: () => void;
  onCancel: () => void;
  /** 表单下面、固定栏上面的内容（已有主机的打开项目、主机密钥）。 */
  extra?: React.ReactNode;
}) {
  const t = useT();
  const [form, setForm] = React.useState<HostForm>(() => toForm(existing));
  const [pendingDelete, setPendingDelete] = React.useState(false);

  // 常用的五项平铺；额外参数与 Worker 只在要用时展开，已填过的默认展开。
  const basic: Array<{ key: keyof HostForm; label: string }> = [
    { key: "name", label: t("ssh.field.name") },
    { key: "host", label: t("ssh.field.host") },
    { key: "user", label: t("ssh.field.user") },
    { key: "port", label: t("ssh.field.port") },
    { key: "identityFile", label: t("ssh.field.identity") },
  ];
  const advanced: Array<{ key: keyof HostForm; label: string }> = [
    { key: "extraArgs", label: t("ssh.field.extraArgs") },
    { key: "workerPath", label: t("ssh.field.workerPath") },
    { key: "workerStateDir", label: t("ssh.field.workerStateDir") },
  ];
  const row = (field: { key: keyof HostForm; label: string }) => (
    <SettingsRow key={field.key} label={field.label}>
      <Input
        className="w-72"
        aria-label={field.label}
        value={form[field.key]}
        onChange={(event) =>
          setForm((current) => ({
            ...current,
            [field.key]: event.target.value,
          }))
        }
      />
    </SettingsRow>
  );

  return (
    <>
      <SettingsGroup>
        {basic.map(row)}
        <Collapsible
          className="group/advanced"
          defaultOpen={advanced.some((field) => form[field.key].trim() !== "")}
        >
          <div className="px-4 py-1.5">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 font-normal text-muted-foreground"
              >
                <ChevronRight className="transition-transform group-data-[state=open]/advanced:rotate-90" />
                {t("ssh.advanced")}
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="divide-y divide-border/60 border-t border-border/60">
            {advanced.map(row)}
          </CollapsibleContent>
        </Collapsible>
      </SettingsGroup>

      {extra}

      <div className="sticky bottom-0 z-10 -mx-(--space-section) -mb-(--space-section) flex items-center justify-between gap-2 border-t border-border bg-card px-(--space-section) py-3">
        <div>
          {existing && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setPendingDelete(true)}
            >
              {t("ssh.delete")}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("ssh.dialog.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              const host = parseHostForm(
                form,
                existing?.id ?? crypto.randomUUID(),
              );
              if (!host) {
                toast.error(t("ssh.dialog.invalid"));
                return;
              }
              onSubmit(host);
            }}
          >
            {t("ssh.dialog.save")}
          </Button>
        </div>
      </div>

      <ResponsiveAlertDialog
        open={pendingDelete}
        onOpenChange={setPendingDelete}
      >
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("ssh.delete.title", { name: existing?.name ?? "" })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("ssh.dialog.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive-solid"
              onClick={onDelete}
            >
              {t("ssh.delete")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}
