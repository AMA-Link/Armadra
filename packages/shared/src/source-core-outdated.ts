import type {
  ErrorCode,
  sourceCoreOutdatedDetailsSchema,
} from "@armadra/platform-protocol/errors";
import type { z } from "zod";

/**
 * 远程服务版本门的独立错误码（armadra-cloud#152）：`sources.assertion` 因主机 core 低于签断言的
 * 门槛而拒签时答 403 `source_core_outdated`，`details` 是 `{ coreVersion, minVersion }`
 * （`coreVersion` 没上报是空串）。以前版本门与访问被收回同答 `source_access_denied`，旧服务端
 * 仍然这样答，调用方要保留按版本比对的兜底。
 *
 * 码与 `details` 的形状取自协议包（`ERRORS.source_core_outdated` 与 `sourceCoreOutdatedDetailsSchema`）；
 * 解析留在这里，因为它比包里的 schema 宽：`coreVersion` 缺省或不是字符串时当空串，而不是整条作废。
 */
export const SOURCE_CORE_OUTDATED = "source_core_outdated" satisfies ErrorCode;

/** 门槛按的那台主机的 core 版本（没上报是空串）与签这类断言要求的最低版本。 */
export type SourceCoreOutdatedDetails = Readonly<
  z.infer<typeof sourceCoreOutdatedDetailsSchema>
>;

/**
 * `source_core_outdated` 的 `details`；形状不对（缺 `minVersion`）答 `null`，调用方按自己知道的
 * 门槛补。`coreVersion` 缺省或不是字符串当空串。
 */
export function sourceCoreOutdatedDetails(
  details: unknown,
): SourceCoreOutdatedDetails | null {
  if (typeof details !== "object" || details === null) return null;
  const { coreVersion, minVersion } = details as Record<string, unknown>;
  if (typeof minVersion !== "string" || minVersion === "") return null;
  return {
    coreVersion: typeof coreVersion === "string" ? coreVersion : "",
    minVersion,
  };
}
