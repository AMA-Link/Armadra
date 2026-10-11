import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `updates.*`（契约 §64）：这台 core 看到的发布历史与最新版本。
 *
 * core 去问 GitHub 的发布列表（ETag 条件请求，缓存 6 小时），按 `updates.channel`
 * 过滤后答给页面；页面从不直接访问 GitHub。答案里只有公开的发布信息，没有任何
 * 机密，所以任何已认证的设备都能读（`updates:read`；服务器壳上的成员只要被共享
 * 过一块画布也放行，同模型目录）。
 *
 * 取不到时不报错：答上次缓存的那份，`error` 说明为什么（`unreachable` /
 * `rateLimited`）以及多久之后再试才有意义。
 */

export const UPDATES_RELEASES_PATH = "/api/updates/releases";

/** 发布里的一个文件。`sha256` 来自 GitHub 资产的 `digest`；没有就是 `null`。 */
export const releaseAssetSchema = z.object({
  name: z.string(),
  url: z.string(),
  size: z.number().int(),
  sha256: z.string().nullable(),
});

/** 一个发布。`version` 是去掉前导 `v` 的 semver；`notes` 是 Markdown 原文。 */
export const releaseSchema = z.object({
  version: z.string(),
  tag: z.string(),
  publishedAt: z.string(),
  prerelease: z.boolean(),
  notes: z.string(),
  url: z.string(),
  assets: z.array(releaseAssetSchema),
});

export const updateCheckErrorSchema = z.object({
  code: z.enum(["unreachable", "rateLimited"]),
  message: z.string(),
  /** 再过多久 core 才会真的再问一次（毫秒）；`0` = 下一次请求就会问。 */
  retryAfterMs: z.number().int().nonnegative(),
});

export const updateChannelSchema = z.enum(["stable", "beta"]);

export const updateReleasesSchema = z.object({
  /** 这台 core 自己的版本。 */
  current: z.string(),
  channel: updateChannelSchema,
  /** 上一次成功问到 GitHub（含 304）的时刻；从没问到过是 `null`。 */
  checkedAt: z.number().int().nullable(),
  /** 按通道过滤后最高且高于 `current` 的版本；没有是 `null`。 */
  latest: z.string().nullable(),
  /** 按通道过滤，semver 降序，最多 30 条。 */
  releases: z.array(releaseSchema),
  error: updateCheckErrorSchema.nullable(),
});

export type ReleaseAsset = z.infer<typeof releaseAssetSchema>;
export type Release = z.infer<typeof releaseSchema>;
export type UpdateCheckError = z.infer<typeof updateCheckErrorSchema>;
export type UpdateChannel = z.infer<typeof updateChannelSchema>;
export type UpdateReleases = z.infer<typeof updateReleasesSchema>;

export const updates = {
  /**
   * 发布历史（§64）。`refresh` 为真（旧路径 `?refresh=1`）时绕过 6 小时缓存，
   * 但每分钟至多真的问一次 GitHub。
   */
  releases: oc
    .input(
      z
        .object({
          refresh: z.union([z.boolean(), z.string()]).optional(),
        })
        .optional(),
    )
    .output(updateReleasesSchema)
    .errors(errors.pick("unauthenticated", "forbidden"))
    .meta(
      meta({
        scope: "updates:read",
        since: "1.37",
        contract: "§64.1",
        legacy: { method: "GET", path: UPDATES_RELEASES_PATH },
      }),
    ),
};
