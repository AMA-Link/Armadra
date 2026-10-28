import { MIN_BOUNDED_SESSION_TTL_MS, SAAS_SESSION_TTL_MS } from "../service";

/**
 * 只给测试的 SaaS 会话寿命（设计 Q9，契约 §88.3）：服务器壳认 `ARMADRA_TEST_SAAS_SESSION_TTL_MS`，
 * 把 Armadra 云来源会话的一小时寿命调短，端到端验「跨寿命续期不断」用。桌面壳不听它。
 *
 * 只认 `[5 分钟, 一小时]` 之间的整数毫秒：只能调短、不能调长。设了却不在这个范围（或不是
 * 整数）就抛错，core 起不来——不悄悄退回缺省，也不放宽。
 */
export const TEST_SAAS_SESSION_TTL_ENV = "ARMADRA_TEST_SAAS_SESSION_TTL_MS";

export function testSaasSessionTtl(
  shell: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (shell !== "server") return undefined;
  const raw = env[TEST_SAAS_SESSION_TTL_ENV]?.trim() ?? "";
  if (raw === "") return undefined;
  const value = /^\d{1,12}$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_BOUNDED_SESSION_TTL_MS ||
    value > SAAS_SESSION_TTL_MS
  )
    throw new Error(
      `${TEST_SAAS_SESSION_TTL_ENV} 要在 ${MIN_BOUNDED_SESSION_TTL_MS}–${SAAS_SESSION_TTL_MS} 毫秒之间`,
    );
  return value;
}
