import * as React from "react";
import { lk } from "../local-key";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderInput, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { sshHostSchema, type SshHost } from "@armadra/shared";

import { localRuntimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { useOpenWorkspace } from "../../../app/workspace-actions";
import { useCompactLayout } from "@/platform/layout";
import { SettingsGroup } from "../SettingsGroup";
import { Loadable } from "@/loading/Loadable";
import { TableCardSkeleton } from "../SettingsLoadable";
import { SettingsRow } from "../SettingsRow";
import { useSubpage } from "../subpage";
import { useRuntimeSettings } from "../use-runtime-settings";
import { MachinesTable } from "./execution-hosts/MachinesTable";
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
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";

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
 * 设置 → SSH：主机表（名称 · 地址 · 验证），点名称进子页编辑。
 *
 * 「验证」一步问完两件事——`ssh` 通不通、配了 Worker 时那台机器上的 Worker
 * 是不是这个构建——结果一句话。当前工作区跑在哪台、怎么切换在「工作空间」页。
 *
 * 主机表存在 Runtime 的 `settings.json` 里：PATCH 对数组是整段替换，所以增删
 * 改都是「读整段、改一条、写整段」。
 */
export function MachinesPage() {
  const t = useT();
  const compact = useCompactLayout();
  const subpage = useSubpage();
  const { settings, save } = useRuntimeSettings({ scope: "local" });
  const ssh = React.useMemo(
    () => settings.data?.ssh?.hosts ?? [],
    [settings.data],
  );

  const validate = useMutation({
    mutationFn: (hostId: string) =>
      localRuntimeApi.validateExecutionHost(hostId),
    onSuccess: (result) => {
      if (result.workerOk) {
        toast.success(
          t("executionHosts.valid", {
            version: result.runtimeVersion ?? "",
            platform: result.platform ?? "",
            architecture: result.architecture ?? "",
          }),
        );
        return;
      }
      // 只跑终端的机器没有 Worker 是正常的：连得上就是答案。
      if (result.reachable && result.reason === "noWorkerConfigured") {
        toast.success(t("executionHosts.noWorkerConfigured"));
        return;
      }
      // `reason` 是 Runtime 给的稳定键；没有的话显示脱敏后的诊断尾巴。
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

  function write(next: SshHost[]) {
    save.mutate({ ssh: { hosts: next } });
    subpage.close();
  }

  if (subpage.current?.startsWith("ssh:")) {
    const reference = subpage.current.slice("ssh:".length);
    const existing = ssh.find((host) => host.id === reference);
    return (
      <>
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
        />
        {existing && <MachineActions host={existing} />}
      </>
    );
  }

  const add = (
    <Button
      size="sm"
      disabled={!settings.data}
      onClick={() => subpage.open("ssh", "new")}
    >
      <Plus />
      {t("ssh.add")}
    </Button>
  );

  return (
    <Loadable
      loading={settings.isLoading}
      skeleton={<TableCardSkeleton rows={3} columns={3} />}
    >
      {ssh.length === 0 ? (
        <SettingsGroup>
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyTitle className="text-[13px] font-normal text-muted-foreground">
                {t("ssh.empty")}
              </EmptyTitle>
            </EmptyHeader>
            <EmptyContent>{add}</EmptyContent>
          </Empty>
        </SettingsGroup>
      ) : (
        <MachinesTable
          hosts={ssh}
          compact={compact}
          validating={validate.isPending ? (validate.variables ?? null) : null}
          onValidate={(hostId) => validate.mutate(hostId)}
          onOpen={(hostId) => subpage.open("ssh", hostId)}
        />
      )}
      {ssh.length > 0 && <div>{add}</div>}
    </Loadable>
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
      toast.success(t("ssh.remote.opened", { name: workspace.name }));
    },
    onError: (cause: Error) =>
      toast.error(t("ssh.remote.failed"), { description: cause.message }),
  });
  return (
    <SettingsRow label={t("ssh.remote.path")}>
      <Input
        className="h-8 w-[280px] text-xs"
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
}: {
  existing: SshHost | undefined;
  disabled: boolean;
  onSubmit: (host: SshHost) => void;
  onDelete: () => void;
  onCancel: () => void;
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
        className="h-8 w-[280px] text-xs"
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
                className="-ml-2 text-[13px] font-normal text-muted-foreground"
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

      <div className="flex items-center justify-between gap-2">
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
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("ssh.delete.title", { name: existing?.name ?? "" })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("ssh.dialog.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={onDelete}>
              {t("ssh.delete")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}
