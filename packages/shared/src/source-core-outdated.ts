/**
 * 远程服务版本门的独立错误码（armadra-cloud#152）：`sources.assertion` 因主机 core 低于签断言的
 * 门槛而拒签时答 403 `source_core_outdated`，`details` 是 `{ coreVersion, minVersion }`
 * （`coreVersion` 没上报是空串）。以前版本门与访问被收回同答 `source_access_denied`，旧服务端
 * 仍然这样答，调用方要保留按版本比对的兜底。
 *
 * 依赖里的协议包（`tools/vendor/armadra-platform-protocol-0.10.0.tgz`）还没有这个码：随协议包
 * 0.11 发布后改为从包里取（`ERRORS.source_core_outdated` 与 `sourceCoreOutdatedDetailsSchema`），
 * 删掉这个文件。
 */
export const SOURCE_CORE_OUTDATED = "source_core_outdated";

export interface SourceCoreOutdatedDetails {
  /** 门槛按的那台主机的 core 版本；没上报是空串。 */
  readonly coreVersion: string;
  /** 签这类断言要求的最低版本。 */
  readonly minVersion: string;
}

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
