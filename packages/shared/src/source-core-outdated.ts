import {
  errorCodeSchema,
  type SourceCoreOutdatedDetails as ProtocolDetails,
  sourceCoreOutdatedDetailsSchema,
} from "@armadra/platform-protocol/errors";

/**
 * 远程服务版本门的独立错误码（armadra-cloud#152，协议包 0.11.0 起）：`sources.assertion` 因主机
 * core 低于签断言的门槛而拒签时答 403 `source_core_outdated`，`details` 是 `{ coreVersion, minVersion }`
 * （`coreVersion` 没上报是空串）。码、`details` 的类型与 schema 都取自协议包。
 *
 * 0.11.0 之前的服务端把版本门与访问被收回同答 `source_access_denied`；还在跑旧控制面的环境
 * （自建或没升级的部署）仍会这样答，调用方保留按版本比对的兜底（`console-host.ts`、`relay-login.ts`）。
 */
export const SOURCE_CORE_OUTDATED = errorCodeSchema.enum.source_core_outdated;

/** 门槛按的那台主机的 core 版本（没上报是空串）与签这类断言要求的最低版本。 */
export type SourceCoreOutdatedDetails = Readonly<ProtocolDetails>;

/**
 * 按协议包的 schema 解析，只放宽一处：`coreVersion` 缺省或不是字符串当空串，而不是整条作废
 * （调用方仍能拿到 `minVersion`）；`minVersion` 按包里的规则，必须是非空字符串。
 */
const lenientDetailsSchema = sourceCoreOutdatedDetailsSchema.extend({
  coreVersion: sourceCoreOutdatedDetailsSchema.shape.coreVersion.catch(""),
});

/**
 * `source_core_outdated` 的 `details`；形状不对（缺 `minVersion`）答 `null`，调用方按自己知道的
 * 门槛补。`coreVersion` 缺省或不是字符串当空串。
 */
export function sourceCoreOutdatedDetails(
  details: unknown,
): SourceCoreOutdatedDetails | null {
  const parsed = lenientDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data : null;
}
