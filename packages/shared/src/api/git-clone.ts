import { z } from "zod";

import { workspaceSchema } from "../domain/index.js";

/**
 * `POST /api/git/clone` (plan §20, 克隆仓库). Only `https://`, `ssh://` and
 * `user@host:path` are accepted; `parent` must be an existing directory and
 * `name` defaults to the repository basename without `.git`.
 */
export const gitCloneRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  parent: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
});

/** The clone runs in the background; the dialog polls the job. */
export const gitCloneStartedSchema = z.object({
  jobId: z.string(),
});

export const gitCloneStateSchema = z.enum(["running", "done", "error"]);

/**
 * `GET /api/git/clone/{jobId}`. `lines` is the tail of `git clone --progress`
 * stderr (at most 20 lines); `workspace` only appears once the clone finished
 * and the runtime registered the directory as a workspace.
 */
export const gitCloneStatusSchema = z.object({
  state: gitCloneStateSchema,
  lines: z.array(z.string()).default([]),
  workspace: workspaceSchema.nullish(),
  error: z.string().nullish(),
});

/**
 * `GET /api/git/clone-defaults`（契约 §65.1）：克隆的缺省父目录——家目录下
 * 第一个存在的 `Projects` / `projects` / `Developer` / `code` / `src`，都没有
 * 就是家目录；拿不到家目录是空串。
 */
export const gitCloneDefaultsSchema = z.object({
  parent: z.string(),
});

/** 已连接 GitHub 账号能克隆的一个仓库；`cloneUrl` 是 `https://` 地址。 */
export const gitCloneRepositorySchema = z.object({
  fullName: z.string(),
  cloneUrl: z.string(),
  private: z.boolean(),
  updatedAt: z.string(),
});

/**
 * `GET /api/git/clone-repositories`（契约 §65.2）。没有可用的 GitHub 凭据时
 * `connected` 为假、列表为空，不是错误。
 */
export const gitCloneRepositoriesSchema = z.object({
  connected: z.boolean(),
  account: z.string().nullable(),
  repositories: z.array(gitCloneRepositorySchema),
});

export type GitCloneDefaults = z.infer<typeof gitCloneDefaultsSchema>;
export type GitCloneRepository = z.infer<typeof gitCloneRepositorySchema>;
export type GitCloneRepositories = z.infer<typeof gitCloneRepositoriesSchema>;
export type GitCloneRequest = z.infer<typeof gitCloneRequestSchema>;
export type GitCloneStarted = z.infer<typeof gitCloneStartedSchema>;
export type GitCloneState = z.infer<typeof gitCloneStateSchema>;
export type GitCloneStatus = z.infer<typeof gitCloneStatusSchema>;
