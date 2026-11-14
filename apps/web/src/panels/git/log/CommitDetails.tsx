import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
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
import { EmptyState } from "../../../ui/state";
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
 * 详情栏（Git 工具窗口设计 §2.2「详情」）。
 *
 * hash、作者 / 提交者、ref 徽标、完整信息，下面是变更文件树；点一个文件在
 * **同一栏里**展开差异，而不是弹一个新面板——三栏已经把宽度分完了，第四块
 * 面板只会把每一块都挤到没法读。
 *
 * 合并提交多一个「与哪个父比」的切换。合并提交对第一父的差异是「这次合并带
 * 进来了什么」，对第二父的差异是「主线上多了什么」，两句话都要能问得出来，
 * 所以这里不替用户选一个。
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
  /** 手机上第四级（文件差异）由外面驱动，桌面上留空即可。 */
  onOpenFile?: (path: string) => void;
}

export function CommitDetails({
  workspaceId,
  target,
  commit,
  base,
  onBaseChange,
  onOpenFile,
}: CommitDetailsProps) {
  const t = useT();
  const flat = usePreferencesStore((state) => state.git.flatFiles);
  const setPreference = usePreferencesStore((state) => state.setGitPreference);
  const [copied, setCopied] = useState(false);
  const split = usePreferencesStore((state) => state.git.diffSplit);
  /**
   * 选中的文件。`undefined` = 还没点过：桌面上自动看第一个文件（差异占满
   * 右栏下半，空着等人点反而多一步）；手机上文件差异是单独一级，由外面驱动，
   * 不自动打开。`null` = 用户把差异关了。
   */
  const [picked, setFile] = useState<string | null | undefined>(undefined);
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
  const badges = useMemo(() => refBadges(commit.refs), [commit.refs]);
  const agents = useMemo(() => commitAgents(commit), [commit]);
  const rows = useMemo(
    () => buildFileRows(detail.data?.files ?? [], flat),
    [detail.data, flat],
  );
  const filePaths = useMemo(
    () => rows.flatMap((row) => (row.kind === "file" ? [row.path] : [])),
    [rows],
  );
  const file =
    picked === undefined
      ? onOpenFile
        ? null
        : (filePaths[0] ?? null)
      : picked;
  const fileIndex = file === null ? -1 : filePaths.indexOf(file);
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
    <div
      data-slot="git-log-details"
      className="flex min-h-0 min-w-0 flex-1 flex-col text-meta"
    >
      {/* 上半：提交信息与文件；有差异时限高可滚，差异占满下半（#927 B2）。 */}
      <div
        className={cn(
          "min-w-0 overflow-auto p-2",
          file !== null ? "max-h-[45%] shrink-0" : "min-h-0 flex-1",
        )}
      >
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono">
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
        </div>
        {badges.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
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
          </div>
        )}
        <dl className="mt-2 space-y-1">
          <div>
            <dt className="text-muted-foreground">{t("gitRepo.author")}</dt>
            <dd className="break-words">
              {commit.authorName} &lt;{commit.authorEmail}&gt; ·{" "}
              {commit.authorTime}
            </dd>
          </div>
          {agents.length > 0 && (
            <div data-slot="git-log-details-agents">
              <dt className="text-muted-foreground">
                {t("gitLog.author.agents")}
              </dt>
              <dd className="mt-0.5 flex flex-wrap gap-2">
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
            </div>
          )}
          <div>
            <dt className="text-muted-foreground">
              {t("gitLog.details.committer")}
            </dt>
            <dd className="break-words">{commit.committerTime}</dd>
          </div>
        </dl>
        <p className="mt-2 whitespace-pre-wrap break-words">{commit.subject}</p>

        {merge && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">
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
                  setFile(undefined);
                }}
              >
                {t("gitLog.details.parentIndex", { index: String(index + 1) })}
              </Button>
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center gap-1 border-t border-border pt-2">
          <h3 className="min-w-0 flex-1 truncate font-medium">
            {t("gitLog.details.files")}
          </h3>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-pressed={flat}
            aria-label={t(flat ? "gitLog.details.tree" : "gitLog.details.flat")}
            onClick={() => setPreference("flatFiles", !flat)}
          >
            <Folder className="size-3" />
          </Button>
        </div>
        <GitLoadable loading={detail.isPending} size={4} />
        {detail.error && (
          <ReadError error={detail.error} retry={() => void detail.refetch()} />
        )}
        {detail.data?.truncated && (
          <p className="text-muted-foreground">{t("gitRepo.filesTruncated")}</p>
        )}
        {detail.data && detail.data.files.length === 0 && (
          <EmptyState inline title={t("gitRepo.noChangedFiles")} />
        )}
        <ul className="min-w-0">
          {rows.map((row) =>
            row.kind === "directory" ? (
              <li
                key={`dir:${row.path}`}
                className="flex min-w-0 items-center gap-1 py-0.5 text-muted-foreground"
                style={{ paddingLeft: `${row.depth * 12}px` }}
              >
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span data-numeric className="shrink-0">
                  {row.count}
                </span>
              </li>
            ) : (
              <li key={`file:${row.path}`} className="min-w-0">
                <Button
                  type="button"
                  variant="ghost"
                  aria-pressed={file === row.path}
                  onClick={() => {
                    setFile(row.path);
                    onOpenFile?.(row.path);
                  }}
                  style={{ paddingLeft: `${row.depth * 12}px` }}
                  className="h-auto w-full min-w-0 justify-start gap-2 rounded-tight border-0 py-0.5 pr-1 text-left font-normal hover:bg-muted aria-pressed:bg-muted"
                >
                  <span className="w-3 shrink-0 font-mono">
                    {row.file?.status.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={row.path}>
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

      {file !== null && (
        <section
          data-slot="git-log-diff"
          className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-border"
        >
          <div className="flex shrink-0 items-center gap-1 px-2 py-1">
            <FileDiff aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono" title={file}>
              {file}
            </span>
            <IconButton
              label={t(split ? "diff.unified" : "diff.sideBySide")}
              active={split}
              onClick={() => setPreference("diffSplit", !split)}
            >
              {split ? <Rows3 /> : <Columns2 />}
            </IconButton>
            <IconButton
              label={t("gitLog.details.previousFile")}
              disabled={fileIndex <= 0}
              onClick={() => setFile(filePaths[fileIndex - 1]!)}
            >
              <ChevronUp />
            </IconButton>
            <IconButton
              label={t("gitLog.details.nextFile")}
              disabled={fileIndex < 0 || fileIndex >= filePaths.length - 1}
              onClick={() => setFile(filePaths[fileIndex + 1]!)}
            >
              <ChevronDown />
            </IconButton>
            <Button size="xs" variant="ghost" onClick={() => setFile(null)}>
              {t("gitLog.details.closeDiff")}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
            <GitLoadable loading={patch.isPending} kind="code" size={6} />
            {patch.error && (
              <ReadError
                error={patch.error}
                retry={() => void patch.refetch()}
              />
            )}
            {patch.data && (
              <>
                {patch.data.truncated && (
                  <p className="px-1 text-muted-foreground">
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
        </section>
      )}
    </div>
  );
}
