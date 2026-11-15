import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  Copy,
  FileDiff,
  Folder,
  Rows3,
} from "lucide-react";
import type { GitLogCommit } from "@armadra/shared";

import { useT, usePreferencesStore } from "../../../app/preferences-store";
import { gitGateway, type GitTarget } from "../../../git/gateway";
import { writeClipboard } from "../../../terminal/TerminalSurface";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "../../ResponsiveDialog";
import { EmptyState } from "../../../ui/state";
import { Input } from "../../../ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../../ui/resizable";
import { ReadError } from "../forms";
import { GitLoadable } from "../git-loading";
import { refBadges } from "../CommitGraph";
import { buildFileRows } from "./file-tree";
import { agentName } from "./CommitAuthor";
import { commitAgents } from "./people";
import { AgentAvatar } from "../../../ui/agent-avatar";
import { cn } from "../../../lib/cn";
import { sideBySideRows } from "../../../lib/side-by-side";
import { PatchBody, SideBySideBody } from "../../../nodes/DiffNode";
import { IconButton } from "../../../ui/icon-button";
import { sk } from "../../../sources/scope";

/**
 * 详情栏（#935 C2，组件规格 §7）：上「变更文件」、下「提交详情」，中间可拖。
 *
 * - 文件区顶部始终说清**哪个仓库、从哪个提交比到哪个提交**；合并提交在这里
 *   切换与哪个父比（规格 §7.7）。
 * - 单击文件只选中；双击、回车或「打开 Diff」才打开差异查看器（规格 §7.3）。
 *   差异在对话框里看，不挤占这一栏。
 * - 提交详情只读：标题、指向此处的引用、仓库、哈希、作者 / 提交时间、父提交、
 *   协作的 Agent。点父提交在日志里定位它。
 */

export interface CommitDetailsProps {
  workspaceId: string;
  /** 这个提交所在的检出；读写走同一条归属判定。 */
  target: GitTarget;
  commit: GitLogCommit;
  /**
   * 与哪个基线比。`null` = 服务端的缺省（第一父）；合并提交的父切换与右键
   * 菜单的「与本地比较 / 与分支比较」写的是同一个值，所以两处不会打架。
   */
  base: string | null;
  onBaseChange: (base: string | null) => void;
  /** 仓库名（多仓库时）；单仓库不显示仓库这一行。 */
  repositoryName?: string | null;
  /** 点父提交：在日志里定位它。 */
  onSelectParent?: (oid: string) => void;
  /** 手机上没有上下分栏：两块依次排开。 */
  stacked?: boolean;
  /** 两个提交比较时交换方向（规格 §7.7）；不在比较时不给。 */
  onSwapCompare?: () => void;
}

export function CommitDetails({
  workspaceId,
  target,
  commit,
  base,
  onBaseChange,
  repositoryName = null,
  onSelectParent,
  stacked = false,
  onSwapCompare,
}: CommitDetailsProps) {
  const t = useT();
  const flat = usePreferencesStore((state) => state.git.flatFiles);
  const filesHeight = usePreferencesStore((state) => state.git.filesHeight);
  const setPreference = usePreferencesStore((state) => state.setGitPreference);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  /** 文件搜索只过滤右侧文件列表，不碰日志的筛选（规格 §7.2）。 */
  const [query, setQuery] = useState("");
  const merge = commit.parents.length > 1;
  const repositoryKey = `${target.repositoryPath}:${commit.repositoryPath}`;

  const detail = useQuery({
    queryKey: sk(
      "git-log-commit",
      workspaceId,
      repositoryKey,
      commit.oid,
      base,
    ),
    queryFn: ({ signal }) =>
      gitGateway.commitDetail(target, commit.oid, base, signal),
    retry: false,
  });
  const needle = query.trim().toLowerCase();
  const matched = useMemo(
    () =>
      (detail.data?.files ?? []).filter(
        (file) => needle === "" || file.path.toLowerCase().includes(needle),
      ),
    [detail.data, needle],
  );
  const rows = useMemo(() => buildFileRows(matched, flat), [matched, flat]);
  const filePaths = useMemo(
    () => rows.flatMap((row) => (row.kind === "file" ? [row.path] : [])),
    [rows],
  );
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of detail.data?.files ?? []) {
      additions += file.additions ?? 0;
      deletions += file.deletions ?? 0;
    }
    return { additions, deletions };
  }, [detail.data]);
  const baseOid = detail.data?.baseOid ?? base ?? commit.parents[0] ?? null;

  const files = (
    <section
      data-slot="git-log-changed-files"
      aria-label={t("gitLog.details.files")}
      className="flex h-full min-h-0 min-w-0 flex-col text-meta"
    >
      <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5">
        <h3 className="min-w-0 flex-1 truncate font-medium">
          {t("gitLog.details.files")}
        </h3>
        <IconButton
          label={t(flat ? "gitLog.details.tree" : "gitLog.details.flat")}
          active={flat}
          onClick={() => setPreference("flatFiles", !flat)}
        >
          <Folder />
        </IconButton>
        {onSwapCompare && (
          <IconButton
            label={t("gitLog.details.swapCompare")}
            onClick={onSwapCompare}
          >
            <ArrowLeftRight />
          </IconButton>
        )}
        <IconButton
          label={t("gitLog.details.openDiff")}
          disabled={selectedFile === null}
          onClick={() => selectedFile && setDiffFile(selectedFile)}
        >
          <FileDiff />
        </IconButton>
      </div>
      {/* 比较方向始终写明（规格 §7.1）：哪个仓库，从哪个提交比到哪个提交。 */}
      <p
        data-slot="git-log-compare"
        className="flex shrink-0 flex-wrap items-center gap-x-1.5 px-2 pb-1 text-caption text-muted-foreground"
      >
        {repositoryName && <span>{repositoryName} ·</span>}
        <span>
          {baseOid
            ? t("gitLog.details.compare", {
                base: baseOid.slice(0, 7),
                target: commit.oid.slice(0, 7),
              })
            : t("gitLog.details.compareRoot", {
                target: commit.oid.slice(0, 7),
              })}
        </span>
        {detail.data && (
          <span data-numeric>
            ·{" "}
            {t("gitLog.details.fileCount", { count: detail.data.files.length })}{" "}
            <span className="text-success-text">+{totals.additions}</span>{" "}
            <span className="text-danger-text">−{totals.deletions}</span>
          </span>
        )}
      </p>
      {detail.data && detail.data.files.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 px-2 pb-1">
          <Input
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("gitLog.details.searchFiles")}
            aria-label={t("gitLog.details.searchFiles")}
            className="min-w-0 flex-1"
          />
          {needle !== "" && (
            <span
              data-slot="git-log-file-matches"
              data-numeric
              className="shrink-0 text-caption text-muted-foreground"
            >
              {matched.length}/{detail.data.files.length}
            </span>
          )}
        </div>
      )}
      {merge && !onSwapCompare && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 pb-1">
          <span className="text-caption text-muted-foreground">
            {t("gitLog.details.parent")}
          </span>
          {commit.parents.map((oid, index) => (
            <Button
              key={oid}
              size="xs"
              variant="ghost"
              aria-pressed={base === oid || (base === null && index === 0)}
              className="font-mono aria-pressed:bg-muted"
              onClick={() => {
                onBaseChange(index === 0 ? null : oid);
                setSelectedFile(null);
              }}
            >
              {t("gitLog.details.parentIndex", { index: String(index + 1) })}
            </Button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        <GitLoadable loading={detail.isPending} size={4} />
        {detail.error && (
          <ReadError error={detail.error} retry={() => void detail.refetch()} />
        )}
        {detail.data?.truncated && (
          <p className="px-1 text-muted-foreground">
            {t("gitRepo.filesTruncated")}
          </p>
        )}
        {detail.data && detail.data.files.length === 0 && (
          <EmptyState inline title={t("gitLog.details.noChanges")} />
        )}
        <ul className="min-w-0">
          {rows.map((row) =>
            row.kind === "directory" ? (
              <li
                key={`dir:${row.path}`}
                className="flex min-w-0 items-center gap-1 py-0.5 text-muted-foreground"
                style={{ paddingLeft: `${row.depth * 12 + 4}px` }}
              >
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span data-numeric className="shrink-0 pr-1">
                  {row.count}
                </span>
              </li>
            ) : (
              <li key={`file:${row.path}`} className="min-w-0">
                <Button
                  type="button"
                  variant="ghost"
                  aria-pressed={selectedFile === row.path}
                  title={row.path}
                  onClick={() => setSelectedFile(row.path)}
                  onDoubleClick={() => setDiffFile(row.path)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      setDiffFile(row.path);
                    }
                  }}
                  style={{ paddingLeft: `${row.depth * 12 + 4}px` }}
                  className="h-auto w-full min-w-0 justify-start gap-2 rounded-tight border-0 py-0.5 pr-1 text-left font-normal hover:bg-muted aria-pressed:bg-muted"
                >
                  <span
                    className={cn(
                      "w-3 shrink-0 font-mono",
                      statusTone(row.file?.status),
                    )}
                    title={row.file?.status}
                  >
                    {row.file?.status.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {row.label}
                    {row.renamedFrom && (
                      <span className="text-muted-foreground">
                        {" ← "}
                        {row.renamedFrom}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-caption text-muted-foreground">
                    {row.file?.additions === null ||
                    row.file?.deletions === null
                      ? t("gitRepo.binaryFile")
                      : `+${row.file?.additions} −${row.file?.deletions}`}
                  </span>
                </Button>
              </li>
            ),
          )}
        </ul>
      </div>
    </section>
  );

  const info = (
    <CommitInfo
      commit={commit}
      repositoryName={repositoryName}
      onSelectParent={onSelectParent}
      message={detail.data ?? null}
    />
  );

  return (
    <div
      data-slot="git-log-details"
      className="flex min-h-0 min-w-0 flex-1 flex-col text-meta"
    >
      {stacked ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {info}
          <div className="border-t border-border">{files}</div>
        </div>
      ) : (
        <ResizablePanelGroup
          orientation="vertical"
          className="min-h-0 flex-1"
          onLayoutChanged={(layout) => {
            const top = layout.files;
            if (typeof top === "number")
              setPreference("filesHeight", Math.round(top));
          }}
        >
          <ResizablePanel
            id="files"
            defaultSize={`${filesHeight}`}
            minSize="20"
            maxSize="85"
            className="flex min-h-0 flex-col"
          >
            {files}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel
            id="info"
            minSize="15"
            className="flex min-h-0 flex-col overflow-auto"
          >
            {info}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
      <DiffDialog
        workspaceId={workspaceId}
        target={target}
        repositoryKey={repositoryKey}
        commit={commit}
        base={base}
        files={filePaths}
        file={diffFile}
        onFileChange={setDiffFile}
      />
    </div>
  );
}

/** 完整时间：本地时区，带时区名（规格 §7.5）；读不出来时原样给出。 */
function fullTime(iso: string, locale: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(at);
}

/** 文件状态的颜色：只是辅助，字母本身已经说明状态（规格 §7.3）。 */
function statusTone(status: string | undefined): string {
  switch (status?.slice(0, 1)) {
    case "A":
      return "text-success-text";
    case "D":
      return "text-danger-text";
    case "R":
    case "C":
      return "text-brand";
    default:
      return "text-warning-text";
  }
}

/** 下半「提交详情」（规格 §7.5 的本地可得部分）。 */
function CommitInfo({
  commit,
  repositoryName,
  onSelectParent,
  message,
}: {
  commit: GitLogCommit;
  repositoryName: string | null;
  onSelectParent?: (oid: string) => void;
  /** 详情读取的结果：正文与提交者（协议 1.51 起有）。 */
  message: {
    body?: string;
    committerName?: string;
    committerEmail?: string;
  } | null;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const body = message?.body ?? "";
  const long = body.split("\n").length > 4 || body.length > 320;
  const sameCommitter =
    message?.committerName === undefined ||
    (message.committerName === commit.authorName &&
      message.committerEmail === commit.authorEmail);
  const badges = useMemo(() => refBadges(commit.refs), [commit.refs]);
  const agents = useMemo(() => commitAgents(commit), [commit]);
  return (
    <section
      data-slot="git-log-commit-info"
      aria-label={t("gitLog.details.info")}
      className="min-w-0 p-2 text-meta"
    >
      <div className="flex items-start gap-1">
        <p className="min-w-0 flex-1 font-medium break-words whitespace-pre-wrap text-foreground">
          {commit.subject}
        </p>
        <IconButton
          label={t("gitLog.details.copyMessage")}
          onClick={() =>
            writeClipboard(
              body ? `${commit.subject}\n\n${body}` : commit.subject,
            )
          }
        >
          <Copy />
        </IconButton>
      </div>
      {body && (
        // 正文按纯文本显示，保留换行与尾注；长的先收起（规格 §7.5）。
        <div data-slot="git-log-commit-body" className="mt-1">
          <p
            className={cn(
              "break-words whitespace-pre-wrap text-muted-foreground",
              long && !expanded && "line-clamp-4",
            )}
          >
            {body}
          </p>
          {long && (
            <Button
              size="xs"
              variant="ghost"
              className="mt-0.5 px-1"
              onClick={() => setExpanded((value) => !value)}
            >
              {t(
                expanded
                  ? "gitLog.details.collapseBody"
                  : "gitLog.details.expandBody",
              )}
            </Button>
          )}
        </div>
      )}
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {repositoryName && (
          <>
            <dt className="text-muted-foreground">
              {t("gitLog.author.repository")}
            </dt>
            <dd className="truncate" title={commit.repositoryPath}>
              {repositoryName}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">{t("gitLog.author.commit")}</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-mono" title={commit.oid}>
            {commit.oid}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("gitLog.details.copyHash")}
            onClick={() => {
              writeClipboard(commit.oid);
              setCopied(true);
            }}
          >
            {copied ? (
              <Check className="size-3" />
            ) : (
              <Copy className="size-3" />
            )}
          </Button>
        </dd>
        <dt className="text-muted-foreground">{t("gitRepo.author")}</dt>
        <dd className="break-words">
          {commit.authorName} &lt;{commit.authorEmail}&gt;
          <span className="block text-caption text-muted-foreground">
            {fullTime(commit.authorTime, locale)}
          </span>
        </dd>
        <dt className="text-muted-foreground">
          {t("gitLog.details.committer")}
        </dt>
        <dd className="break-words" data-slot="git-log-committer">
          {sameCommitter ? (
            <span className="text-muted-foreground">
              {t("gitLog.details.sameAsAuthor")}
            </span>
          ) : (
            <>
              {message?.committerName} &lt;{message?.committerEmail}&gt;
            </>
          )}
          <span className="block text-caption text-muted-foreground">
            {fullTime(commit.committerTime, locale)}
          </span>
        </dd>
        {agents.length > 0 && (
          <>
            <dt className="text-muted-foreground">
              {t("gitLog.author.agents")}
            </dt>
            <dd
              data-slot="git-log-details-agents"
              className="flex flex-wrap gap-2"
            >
              {agents.map((mark) => (
                <span
                  key={mark.id ?? mark.label}
                  className="inline-flex items-center gap-1"
                >
                  {mark.id && <AgentAvatar agentId={mark.id} size={20} />}
                  {agentName(mark)}
                </span>
              ))}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">{t("gitLog.details.parents")}</dt>
        <dd className="flex flex-wrap gap-1">
          {commit.parents.length === 0 ? (
            <span className="text-muted-foreground">
              {t("gitLog.details.noParents")}
            </span>
          ) : (
            commit.parents.map((oid) => (
              <Button
                key={oid}
                size="xs"
                variant="ghost"
                className="font-mono"
                title={t("gitLog.details.jumpParent")}
                onClick={() => onSelectParent?.(oid)}
              >
                {oid.slice(0, 7)}
              </Button>
            ))
          )}
        </dd>
        {badges.length > 0 && (
          <>
            <dt className="text-muted-foreground">
              {t("gitLog.details.refs")}
            </dt>
            <dd className="flex flex-wrap gap-1">
              {badges.map((badge) => (
                <Badge
                  key={`${badge.kind}:${badge.label}`}
                  size="sm"
                  variant={
                    badge.kind === "tag"
                      ? "brand"
                      : badge.kind === "head"
                        ? "default"
                        : "outline"
                  }
                >
                  {badge.label}
                </Badge>
              ))}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

/**
 * 差异查看器（规格 §8）：对话框里看一个文件，统一 / 并排，上一个 / 下一个
 * 文件。历史差异只读。
 */
function DiffDialog({
  workspaceId,
  target,
  repositoryKey,
  commit,
  base,
  files,
  file,
  onFileChange,
}: {
  workspaceId: string;
  target: GitTarget;
  repositoryKey: string;
  commit: GitLogCommit;
  base: string | null;
  files: readonly string[];
  file: string | null;
  onFileChange: (file: string | null) => void;
}) {
  const t = useT();
  const split = usePreferencesStore((state) => state.git.diffSplit);
  const setPreference = usePreferencesStore((state) => state.setGitPreference);
  const index = file === null ? -1 : files.indexOf(file);
  const patch = useQuery({
    queryKey: sk(
      "git-log-commit-file",
      workspaceId,
      repositoryKey,
      commit.oid,
      base,
      file,
    ),
    queryFn: ({ signal }) =>
      gitGateway.commitFile(target, commit.oid, base, file!, signal),
    enabled: file !== null,
    retry: false,
  });
  const splitRows = useMemo(
    () => (split && patch.data ? sideBySideRows(patch.data.patch) : []),
    [split, patch.data],
  );
  return (
    <ResponsiveDialog
      open={file !== null}
      onOpenChange={(open) => {
        if (!open) onFileChange(null);
      }}
    >
      <ResponsiveDialogContent
        data-slot="git-log-diff"
        className="flex h-[85vh] max-w-[min(1200px,94vw)] flex-col gap-2 sm:max-w-[min(1200px,94vw)]"
      >
        <ResponsiveDialogHeader className="flex-row items-center gap-1 pr-8">
          <FileDiff aria-hidden className="size-3.5 shrink-0" />
          <ResponsiveDialogTitle className="min-w-0 flex-1 truncate font-mono text-meta">
            {file}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            {t("gitLog.details.compare", {
              base: (base ?? commit.parents[0] ?? "").slice(0, 7),
              target: commit.oid.slice(0, 7),
            })}
          </ResponsiveDialogDescription>
          <IconButton
            label={t(split ? "diff.unified" : "diff.sideBySide")}
            active={split}
            onClick={() => setPreference("diffSplit", !split)}
          >
            {split ? <Rows3 /> : <Columns2 />}
          </IconButton>
          <IconButton
            label={t("gitLog.details.previousFile")}
            disabled={index <= 0}
            onClick={() => onFileChange(files[index - 1]!)}
          >
            <ChevronUp />
          </IconButton>
          <IconButton
            label={t("gitLog.details.nextFile")}
            disabled={index < 0 || index >= files.length - 1}
            onClick={() => onFileChange(files[index + 1]!)}
          >
            <ChevronDown />
          </IconButton>
        </ResponsiveDialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded-control border border-border">
          <GitLoadable loading={patch.isPending} kind="code" size={8} />
          {patch.error && (
            <ReadError error={patch.error} retry={() => void patch.refetch()} />
          )}
          {patch.data && (
            <>
              {patch.data.truncated && (
                <p className="px-2 text-muted-foreground">
                  {t("gitRepo.patchTruncated")}
                </p>
              )}
              <div aria-label={t("gitRepo.filePatch")} role="region">
                {split ? (
                  <SideBySideBody rows={splitRows} />
                ) : (
                  <PatchBody patch={patch.data.patch} />
                )}
              </div>
            </>
          )}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
