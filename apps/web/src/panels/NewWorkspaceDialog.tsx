import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { FolderOpen, Lock } from "lucide-react";
import type { Workspace } from "@armadra/shared";
import { runtimeApi } from "../api/client";
import { forgeAccounts, forgeRepositories } from "../api/forge";
import { isDesktop, pickDirectory } from "../platform";
import { useT } from "../app/preferences-store";
import { useCreateWorkspace } from "../app/workspace-actions";
import { isCloneUrl } from "../app/workspace-create";
import { sk } from "../sources/scope";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/command";
import { Input } from "@/ui/input";
import { Progress } from "@/ui/progress";
import { Spinner } from "@/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "./ResponsiveDialog";
import { COMMAND_INPUT_FOCUS } from "./tabs-focus";

/** `git clone --progress` 每 500ms 至少写一行，比这更快地问没有意义。 */
const POLL_MS = 500;

export type NewWorkspaceMode = "repository" | "local" | "url";

/**
 * 从 `Receiving objects:  45% (12/34)` 这类行里取百分比：最近一行里的最后一个
 * 百分号（速率不含 `%`，扫全行是安全的）。
 */
export function cloneProgress(lines: readonly string[]): number | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const matches = [...(lines[index] ?? "").matchAll(/(\d{1,3})%/g)];
    const last = matches[matches.length - 1];
    if (last) return Math.min(100, Number(last[1]));
  }
  return null;
}

export interface NewWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspace: Workspace) => void;
}

/**
 * 添加项目（契约 §65）：一个对话框、三种来源。
 *
 *   * 仓库：代码托管账号（契约 §29.7，GitHub / Gitea / GitLab）里的仓库，克隆到
 *     父目录下再打开；账号多于一个时先选账号，列表按游标加载更多；
 *   * 本地：已存在的文件夹，直接登记成工作空间；
 *   * 地址：粘贴的 Git 地址，克隆到父目录下再打开。
 *
 * 两种克隆共用父目录（缺省值由 core 给）、进度与错误。克隆是 core 的后台任务，
 * 完成时 core 已经把目录登记成工作空间并带在答案里；目标目录已存在时 core 拒绝，
 * 不覆盖。凭据只走用户自己的 Git 设置。
 */
export function NewWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: NewWorkspaceDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const createWorkspace = useCreateWorkspace();
  const [mode, setMode] = useState<NewWorkspaceMode>("repository");
  const [accountHost, setAccountHost] = useState<string | null>(null);
  const [repository, setRepository] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [parent, setParent] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const jobRef = useRef<string | null>(null);

  useEffect(() => {
    jobRef.current = jobId;
  }, [jobId]);

  useEffect(() => {
    if (!open) return;
    setMode("repository");
    setAccountHost(null);
    setRepository(null);
    setUrl("");
    setPath("");
    setParent("");
    setJobId(null);
    setFailure(null);
  }, [open]);

  const defaults = useQuery({
    queryKey: ["git-clone-defaults"],
    queryFn: () => runtimeApi.cloneDefaults(),
    enabled: open,
    staleTime: Infinity,
    retry: false,
  });
  const defaultParent = defaults.data?.parent ?? "";
  useEffect(() => {
    if (open && defaultParent !== "") {
      setParent((current) => (current === "" ? defaultParent : current));
    }
  }, [defaultParent, open]);

  const accounts = useQuery({
    queryKey: ["forge-accounts"],
    queryFn: () => forgeAccounts(),
    enabled: open && mode === "repository",
    staleTime: 60_000,
    retry: false,
  });
  const accountList = accounts.data ?? [];
  const host = accountHost ?? accountList[0]?.host ?? null;

  const repositories = useInfiniteQuery({
    queryKey: ["forge-repositories", host],
    queryFn: ({ pageParam }) => forgeRepositories(host as string, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open && mode === "repository" && host !== null,
    staleTime: 60_000,
    retry: false,
  });
  const listed = repositories.data?.pages.flatMap((page) => page.items) ?? [];

  const finish = (workspace: Workspace) => {
    void queryClient.invalidateQueries({ queryKey: sk("workspaces") });
    onOpenChange(false);
    onCreated?.(workspace);
  };

  const source = mode === "url" ? url.trim() : (repository ?? "");
  const start = useMutation({
    mutationFn: () =>
      runtimeApi.cloneRepository({ url: source, parent: parent.trim() }),
    onSuccess: (started) => {
      setFailure(null);
      setJobId(started.jobId);
    },
    onError: (cause: Error) => setFailure(cause.message),
  });

  const local = useMutation({
    mutationFn: () => createWorkspace(path),
    onSuccess: finish,
    onError: (cause: Error) => setFailure(cause.message),
  });

  const status = useQuery({
    queryKey: ["git-clone", jobId],
    queryFn: () => runtimeApi.gitCloneStatus(jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data?.state === "running" || query.state.data === undefined
        ? POLL_MS
        : false,
    retry: false,
    gcTime: 0,
  });

  const cloned = status.data?.workspace;
  useEffect(() => {
    if (!cloned) return;
    setJobId(null);
    finish(cloned);
    // `finish` 每次渲染都是新的；只在克隆完成那一刻跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloned]);

  const errored = status.data?.state === "error" ? status.data : null;
  useEffect(() => {
    if (!errored) return;
    setJobId(null);
    setFailure(
      errored.error ?? errored.lines[errored.lines.length - 1] ?? null,
    );
  }, [errored]);

  useEffect(() => {
    if (!status.error) return;
    setJobId(null);
    setFailure((status.error as Error).message);
  }, [status.error]);

  // 对话框被关掉（Esc / 点外面 / 取消）时不留后台任务。
  useEffect(() => {
    if (open) return;
    const running = jobRef.current;
    if (running) {
      void runtimeApi.cancelClone(running).catch(() => undefined);
      jobRef.current = null;
    }
  }, [open]);

  const lines = status.data?.lines ?? [];
  const lastLine = lines[lines.length - 1] ?? "";
  const percent = cloneProgress(lines);
  const running = jobId !== null;
  const busy = running || start.isPending || local.isPending;
  const urlInvalid = url.trim() !== "" && !isCloneUrl(url);
  const ready =
    mode === "local"
      ? path.trim() !== ""
      : parent.trim() !== "" &&
        (mode === "url" ? isCloneUrl(url) : repository !== null);

  const choose = (apply: (picked: string) => void) => {
    void pickDirectory().then((picked) => {
      if (picked) apply(picked);
    });
  };

  const submit = () => {
    setFailure(null);
    if (mode === "local") local.mutate();
    else start.mutate();
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="z-[var(--z-dialog)]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("sidebar.addProject")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <Tabs
          value={mode}
          onValueChange={(next) => {
            setMode(next as NewWorkspaceMode);
            setFailure(null);
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="repository" disabled={busy}>
              {t("newWorkspace.repository")}
            </TabsTrigger>
            <TabsTrigger value="local" disabled={busy}>
              {t("newWorkspace.local")}
            </TabsTrigger>
            <TabsTrigger value="url" disabled={busy}>
              {t("newWorkspace.url")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="repository">
            {accounts.isPending || (host !== null && repositories.isPending) ? (
              <div className="flex h-40 items-center justify-center">
                <Spinner aria-label={t("newWorkspace.loading")} />
              </div>
            ) : host === null ? (
              <div className="flex h-40 items-center justify-center text-muted-foreground">
                {accounts.isError
                  ? (accounts.error as Error).message
                  : t("newWorkspace.notConnected")}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {accountList.length > 1 && (
                  <Select
                    value={host}
                    disabled={busy}
                    onValueChange={(next) => {
                      setAccountHost(next);
                      setRepository(null);
                    }}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t("newWorkspace.account")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[var(--z-dialog)]">
                      {accountList.map((account) => (
                        <SelectItem key={account.host} value={account.host}>
                          {account.accountLogin
                            ? `${account.host} · ${account.accountLogin}`
                            : account.host}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Command className="rounded-[var(--r-card)]! border border-border bg-[var(--card)]">
                  <CommandInput
                    className={COMMAND_INPUT_FOCUS}
                    placeholder={t("newWorkspace.search")}
                    aria-label={t("newWorkspace.search")}
                    disabled={busy}
                  />
                  <CommandList className="h-56 max-h-56">
                    <CommandEmpty>
                      {repositories.isError
                        ? (repositories.error as Error).message
                        : t("newWorkspace.noRepositories")}
                    </CommandEmpty>
                    {listed.map((entry) => (
                      <CommandItem
                        key={`${entry.owner}/${entry.name}`}
                        value={`${entry.owner}/${entry.name}`}
                        disabled={busy || entry.cloneUrl === ""}
                        data-checked={entry.cloneUrl === repository}
                        onSelect={() => setRepository(entry.cloneUrl)}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {entry.owner}/{entry.name}
                        </span>
                        {entry.private && (
                          <Lock
                            aria-label={t("newWorkspace.private")}
                            className="size-3.5 text-muted-foreground"
                          />
                        )}
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
                {repositories.hasNextPage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || repositories.isFetchingNextPage}
                    onClick={() => void repositories.fetchNextPage()}
                  >
                    {repositories.isFetchingNextPage ? (
                      <Spinner aria-label={t("newWorkspace.loading")} />
                    ) : (
                      t("forge.more")
                    )}
                  </Button>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="local">
            <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 rounded-[var(--r-card)] border border-border bg-[var(--card)] p-4">
              <label className="text-muted-foreground" htmlFor="workspace-path">
                {t("workspace.path")}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="workspace-path"
                  value={path}
                  disabled={busy}
                  onChange={(event) => setPath(event.target.value)}
                />
                {isDesktop() && (
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={busy}
                    aria-label={t("folder.choose")}
                    onClick={() => choose(setPath)}
                  >
                    <FolderOpen />
                  </Button>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="url">
            <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 rounded-[var(--r-card)] border border-border bg-[var(--card)] p-4">
              <label className="text-muted-foreground" htmlFor="clone-url">
                {t("clone.url")}
              </label>
              <Input
                id="clone-url"
                value={url}
                disabled={busy}
                aria-invalid={urlInvalid || undefined}
                placeholder="https://"
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
          </TabsContent>
        </Tabs>

        {mode !== "local" && (
          <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 rounded-[var(--r-card)] border border-border bg-[var(--card)] p-4">
            <label className="text-muted-foreground" htmlFor="clone-parent">
              {t("folder.parent")}
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                id="clone-parent"
                value={parent}
                disabled={busy}
                onChange={(event) => setParent(event.target.value)}
              />
              {isDesktop() && (
                <Button
                  variant="outline"
                  size="icon"
                  disabled={busy}
                  aria-label={t("folder.choose")}
                  onClick={() => choose(setParent)}
                >
                  <FolderOpen />
                </Button>
              )}
            </div>
          </div>
        )}

        {running && (
          <div className="flex flex-col gap-1.5">
            <Progress
              value={percent ?? 0}
              aria-label={t("clone.progress")}
              className={percent === null ? "animate-pulse" : undefined}
            />
            <span className="truncate font-mono text-[length:var(--text-caption)] text-muted-foreground">
              {lastLine}
            </span>
          </div>
        )}

        {failure && (
          <Badge variant="destructive" className="max-w-full justify-start">
            <span className="truncate" title={failure}>
              {failure}
            </span>
          </Badge>
        )}

        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("dialog.cancel")}
          </Button>
          <Button disabled={!ready || busy} onClick={submit}>
            {t(mode === "local" ? "newWorkspace.open" : "clone.start")}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
