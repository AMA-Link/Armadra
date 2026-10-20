/**
 * `timeline.*` 四条 procedure 与 blob 的 HTTP 路径（契约 §82.1）。
 *
 * 授权在路由门里（`identity/route-access.ts`）：时间线以会话行 id 为键，门按会话行
 * 查出画布再判 `terminal:read`；这里只管取数。没有时间线（会话没写过）答 `not_found`，
 * 页面据此退回旧的 `acp.log` 路径。
 */

import {
  type SessionActivity,
  type TimelineSnapshot,
  TIMELINE_BLOB_PATH,
} from "@armadra/shared";

import { CoreFailure, fail } from "../http/errors";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import { MAX_FRAME_BYTES } from "../identity/protocol";
import type { CoreContext } from "../main";
import type { TimelineDomain } from "./index";
import { CursorAheadError } from "./store";

/**
 * `timeline.blob` 经 JSON 返回 base64：一帧不能超过 `maxFrameBytes`（经控制面 /
 * 中转时一个 RPC 应答就是一帧），所以只放得下原始字节不超过这个数的 blob；更大的走
 * `GET /api/timelines/{id}/blobs/{blobId}`（流式，不受这个限制，上限 8 MiB）。
 */
export const MAX_RPC_BLOB_BYTES = Math.floor((MAX_FRAME_BYTES - 1024) / 4) * 3;

/** 以这些类型原样回给浏览器；其余一律当不透明字节（防止内嵌资源当文档运行）。 */
const INLINE_MIME =
  /^(image\/(png|jpeg|gif|webp|avif|bmp)|audio\/[a-z0-9.+-]+)$/i;

function need(domain: TimelineDomain, timelineId: string) {
  const row = domain.store.get(timelineId);
  if (row === undefined) throw fail("not_found", "这条会话没有时间线");
  return row;
}

export function installRoutes(
  context: CoreContext,
  domain: TimelineDomain,
): void {
  const { store, blobs } = domain;

  const open = (input: { timelineId: string; tailTurns?: number }) => {
    need(domain, input.timelineId);
    const snapshot = store.snapshot(input.timelineId, input.tailTurns);
    if (snapshot === undefined) throw fail("not_found", "这条会话没有时间线");
    const activity: SessionActivity | undefined = domain.activityOf(
      input.timelineId,
    );
    const result: TimelineSnapshot = {
      ...snapshot,
      ...(activity === undefined ? {} : { activity }),
    };
    return result;
  };

  const sync = (input: { timelineId: string; after: number }) => {
    need(domain, input.timelineId);
    try {
      const result = store.sync(input.timelineId, input.after);
      if (result === undefined) throw fail("not_found", "这条会话没有时间线");
      return result;
    } catch (error) {
      if (error instanceof CursorAheadError) {
        throw fail("cursor_ahead", "这个位置比时间线的序号还新", {
          headSeq: error.headSeq,
        });
      }
      throw error;
    }
  };

  const page = (input: {
    timelineId: string;
    beforeTurn: number;
    turns?: number;
  }) => {
    need(domain, input.timelineId);
    const items = store.page(input.timelineId, input.beforeTurn, input.turns);
    if (items === undefined) throw fail("not_found", "这条会话没有时间线");
    return { items };
  };

  const blob = (input: { timelineId: string; blobId: string }) => {
    need(domain, input.timelineId);
    const found = blobs.read(input.timelineId, input.blobId);
    if (found === undefined) throw fail("not_found", "没有这个附件");
    if (found.data.length > MAX_RPC_BLOB_BYTES) {
      throw fail(
        "bad_request",
        "附件超过一帧能装下的大小，改用 GET /api/timelines/{id}/blobs/{blobId}",
        { bytes: found.data.length, maxBytes: MAX_RPC_BLOB_BYTES },
      );
    }
    return {
      mimeType: found.mimeType,
      bytes: found.data.length,
      data: found.data.toString("base64"),
    };
  };

  registerProcedures(context.server, "timeline", {
    open,
    sync,
    page,
    blob,
  } satisfies DomainHandlers<"timeline">);

  context.server.router.handle(
    "GET",
    TIMELINE_BLOB_PATH,
    (match: RouteMatch, _request: CoreRequest): HandlerResult => {
      try {
        const timelineId = match.params.timelineId ?? "";
        const blobId = match.params.blobId ?? "";
        need(domain, timelineId);
        const found = blobs.read(timelineId, blobId);
        if (found === undefined) throw fail("not_found", "没有这个附件");
        const inline = INLINE_MIME.test(found.mimeType);
        return {
          status: 200,
          raw: found.data,
          headers: {
            "content-type": inline
              ? found.mimeType
              : "application/octet-stream",
            // 内容寻址：同一个 blobId 的字节永远不变。
            "cache-control": "private, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
            ...(inline ? {} : { "content-disposition": "attachment" }),
          },
        };
      } catch (error) {
        if (error instanceof CoreFailure) {
          const { status, body } = error.response();
          return { status, body };
        }
        throw error;
      }
    },
  );
}
